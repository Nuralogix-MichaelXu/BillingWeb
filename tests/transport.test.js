/* 传输层测试
 *
 * 背景（2026-09-18 海外账号频繁 429）：
 *   跨域直连的每个业务请求，浏览器都要先发一次 OPTIONS 预检（服务端计限流），
 *   被拦时还要回退中继重发一次 → 服务端看到的请求量是 iOS 的 2~3 倍，
 *   于是海外接口频繁 429「请求过于频繁」，而 iOS 用原生 URLSession 无预检，从不触发。
 *
 * 契约：
 *   · 本机页面（node server.js 的 127.0.0.1 / localhost，含 Live Preview 的 :3000）→
 *     中继优先（绝对地址 http://127.0.0.1:4173/__proxy）
 *   · 线上页面（Vercel 等部署域名）→ 中继优先（同源相对路径 /__proxy，靠 rewrite 打到 api/proxy.js）
 *   · file:// → 中继优先（绝对地址，且永远保留中继：直连必失败）
 *   · 线上没配 /__proxy（404 / HTML 兜底页）→ 当成中继不可用，降级直连并记住 5s
 *   · 中继响应带 X-Billing-Relay 标记头：有标记 = 上游状态码原样透传（含上游自己的 HTML 404），
 *     无标记 = 这个地址上不是我们的中继 → 换通道并记不可用
 *   · 中继「地址连不上 / 404」→ 记住不可用 5s，期间不再逐请求去撞（避免白撞几十次）
 *   · 中继 502 PROXY_ERROR（上游抖动）→ 不当成中继不可用，仅本请求回退
 *   · 接口自身错误（401/400/429）绝不换通道；中继自身故障（404 / PROXY_ERROR）必须换通道
 *   · 429：不触发重新登录、不进入 100 次重试风暴；幂等 GET 做 4 次退避重试
 *   · 401 / token 过期：**不自动续期**，直接按会话失效抛出（零登录请求）
 *   · 全失败时的文案：中继试过且不可用 → 直说「未检测到本地中继服务」+ node server.js
 *   · 跨域直连（中继不可用 / rewrite 失效时被迫走的路）：接口没有 Access-Control-Max-Age，
 *     预检结果不缓存 → 一个业务请求 = 服务端 2 次命中（预检 + 业务）。对**有限流层的主机**
 *     （海外，实测 x-ratelimit-limit: 5,5;w=1）把速率上限压到 2 req/s，否则 24 次/秒
 *     打 5 次/秒 的接口，预检 429 会让浏览器把业务请求判死成 net::ERR_FAILED（单次即致命）；
 *     国内接口无限流层 → 不压（压了纯亏：实测 8.9s → 29.7s）
 *   · 传输层全失败 → 退避后整体重试（共 3 轮），兜住上面那种一次性失败
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const APP = path.resolve(__dirname, "../app");

const results = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : `  (期望 ${expected})`}`);
};

const AUTH_DIRECT = "https://api.prod.deepaffex.cn/organizations/auth";
// 海外主机：只有它装在限流层后面（x-ratelimit-limit: 5,5;w=1）
const AUTH_INTL = "https://api.as-east.deepaffex.ai/organizations/auth";
const AUTH_RELAY = "/__proxy?url=" + encodeURIComponent(AUTH_DIRECT);
const AUTH_RELAY_ABS = "http://127.0.0.1:4173" + AUTH_RELAY;
const LOCAL = "http://127.0.0.1:4173";
const REMOTE = "https://preview.example.com";

function makeSandbox(protocol, origin, handler) {
  const calls = [];
  const store = {};
  const ctx = {
    location: { protocol, origin },
    console,
    setTimeout,
    clearTimeout,
    AbortSignal,
    AbortController,
    URL, // 浏览器内置，vm 沙箱需显式注入
    JSON,
    Promise,
    Error,
    TypeError,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    fetch: async (u, o) => {
      calls.push(u);
      return handler(u, o, calls.length);
    },
  };
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  const load = (f) =>
    vm.runInContext(fs.readFileSync(path.join(APP, f), "utf8"), sandbox, { filename: f });
  load("model.js");
  load("api.js");
  return { sandbox, calls, get: (expr) => vm.runInContext(expr, sandbox) };
}

const API_ERR = {
  Code: "INVALID_CREDENTIALS",
  Message: "Invalid Credentials",
};
const apiErrResponse = { status: 401, text: async () => JSON.stringify(API_ERR) };
const tooMany = { status: 429, text: async () => "" };
const authOk = (token) => ({ status: 200, text: async () => JSON.stringify({ Token: token }) });

/**
 * 真实的中继响应都带 `X-Billing-Relay` 标记头（api/_lib/proxy.js 的 RELAY_HEADERS）。
 * 桩必须带上它，否则会被判成「这个地址不是我们的中继」→ 误触发换通道 + 记不可用。
 */
const relayHeaders = { get: (k) => (String(k).toLowerCase() === "x-billing-relay" ? "1" : null) };
const relayRes = (status, body) => ({ status, headers: relayHeaders, text: async () => body });

(async function main() {
  /* ================= A. 本机页面（node server.js）→ 中继优先 ================= */

  /* ---------- A1. 同源单跳：第 1 个请求就是中继，且只发 1 次 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async () => apiErrResponse);
    const msg = await s.get(`APIClient.login("a","b","c",Region.china)`).then(
      () => "",
      (e) => e.message
    );
    check("A1 本机页面第 1 个请求走同源中继", s.calls[0], AUTH_RELAY);
    check("A1 只发 1 次请求（无跨域预检、无回退重发）", s.calls.length, 1);
    check("A1 401 报文解析与 iOS 一致", msg, "Invalid Credentials");
  }

  /* ---------- A2. 中继传输层失败 → 回退直连 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async (u, o, n) => {
      if (n === 1) throw new TypeError("Load failed");
      return apiErrResponse;
    });
    const msg = await s.get(`APIClient.login("a","b","c",Region.china)`).then(
      () => "",
      (e) => e.message
    );
    check("A2 中继失败后回退直连", s.calls[1], AUTH_DIRECT);
    check("A2 回退后共 2 次请求", s.calls.length, 2);
    check("A2 回退命中的仍是接口错误", msg, "Invalid Credentials");
  }

  /* ---------- A3. 中继自身故障（server.js 没在跑 → 404）必须换通道 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async (u) => {
      if (u.includes("/__proxy")) return { status: 404, text: async () => "not found" };
      return apiErrResponse;
    });
    const msg = await s.get(`APIClient.login("a","b","c",Region.china)`).then(
      () => "",
      (e) => e.message
    );
    check("A3 中继 404 视为传输失败并回退直连", s.calls[1], AUTH_DIRECT);
    check("A3 不会把中继故障当成接口错误", msg, "Invalid Credentials");
  }

  /* ---------- A4. 接口错误（401）绝不触发换通道 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async () => apiErrResponse);
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("A4 接口错误只请求 1 次（未误触发回退）", s.calls.length, 1);
  }

  /* ---------- A5. 中继传输层失败 → 本会话记「不可用」，不再逐请求去撞 ----------
   * 现场故障（2026-09-18）：页面不是中继提供的，4173 无监听 → 旧逻辑每个请求都先撞一次死端口，
   * 一次列表刷新白撞 68 次。现在第一次撞到就记下来（5s 自愈窗口），后续请求直接走直连。 */
  {
    const s = makeSandbox("http:", LOCAL, async (u, o, n) => {
      if (n === 1) throw new TypeError("Load failed"); // 中继失败 → 记「不可用」+ 回退直连
      return apiErrResponse;
    });
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("A5 第 2 个请求不再去撞已判死的中继（直接走直连）", s.calls[2], AUTH_DIRECT);
    check("A5 第 2 个请求只发 1 次", s.calls.length, 3);
  }

  /* ---------- A6. 中继不可用 + 两条通道都失败 → 文案直指「中继没起」 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async () => {
      throw new TypeError("Load failed");
    });
    s.get(`_throttle.cooldownScale = 0.01`); // 压缩重试等待，断言逻辑不变
    const msg = await s.get(`APIClient.login("a","b","c",Region.china)`).then(
      () => "",
      (e) => e.message
    );
    // 首轮「中继 + 直连」两次，之后中继已判死 → 每轮只撞直连 1 次
    check("A6 两条通道都试过且整体重试（1 轮 2 次 + 2 轮 1 次）", s.calls.length, 4);
    check("A6 点明「未检测到本地中继服务」", msg.includes("未检测到本地中继服务"), true);
    check("A6 给出 node server.js 处置办法", msg.includes("node server.js"), true);
    // 事实纠正：跨端口访问中继是通的（实测 3000 页面 → 4173 中继 18.4s 成功），
    // 不能再让用户以为「必须换成 4173 打开」，更不能说跨域策略会拦截。
    check("A6 不再谎称跨端口被跨域拦截", msg.includes("跨域策略拦截"), false);
    check("A6 明确页面地址不用换", msg.includes("页面地址不用换"), true);
    check("A6 给出中继地址便于排查", msg.includes(LOCAL), true);
    const before = s.calls.length;
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("A6 中继不可用被记住：后续只撞直连（3 轮）", s.calls.length - before, 3);
  }

  /* ---------- A8. 502 PROXY_ERROR（中继活着、上游抖动）不得被记成「中继不可用」 ----------
   * 否则会把一次上游抖动升级成「放弃中继」→ 直连请求量翻倍 → 海外更容易撞限流。 */
  {
    const s = makeSandbox("http:", LOCAL, async (u) => {
      if (u.includes("/__proxy")) {
        return relayRes(502, JSON.stringify({ Code: "PROXY_ERROR", Message: "boom" }));
      }
      return apiErrResponse;
    });
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("A8 第 2 个请求仍优先走中继", s.calls[2], AUTH_RELAY);
    check("A8 每个请求仍是「中继→直连」两次尝试", s.calls.length, 4);
  }
  {
    /* ---------- A9. 中继的 404（上游接口自己的 404 页面）不能被误判成「中继不存在」 ----------
     * 实测接口对未知路径返回 HTML（`Cannot GET /xxx`）：中继只是原样透传，
     * 带上标记头就必须当成接口响应，否则会把上游 404 升级成「放弃中继 → 直连」。 */
    const s = makeSandbox("http:", LOCAL, async (u) =>
      u.includes("/__proxy")
        ? relayRes(404, "<!DOCTYPE html><html><body><pre>Cannot GET /x</pre></body></html>")
        : apiErrResponse
    );
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("A9 带标记的上游 404 不换通道", s.calls.length, 1);
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("A9 也不会被记成「中继不可用」", s.calls[1], AUTH_RELAY);
  }

  /* ================= B. file:// 页面：中继优先 + 绝对地址 ================= */
  {
    const s = makeSandbox("file:", "null", async () => apiErrResponse);
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("B1 file 页面第 1 个请求走中继", s.calls[0], AUTH_RELAY_ABS);
    check("B1 file 页面不必尝试直连", s.calls.length, 1);
  }
  {
    const s = makeSandbox("file:", "null", async () => {
      throw new TypeError("Load failed");
    });
    s.get(`_throttle.cooldownScale = 0.01`);
    const msg = await s.get(`APIClient.login("a","b","c",Region.china)`).then(
      () => "",
      (e) => e.message
    );
    // file:// 的中继是唯一出路，即使已判死也保留 → 每轮都是「中继 + 直连」2 次
    check("B2 两条通道各试 3 轮", s.calls.length, 6);
    check("B2 提示中包含处理办法", msg.includes("node server.js"), true);
    check("B2 提示中点明 file:// 来源问题", msg.includes("file://"), true);
  }

  /* ===== C. 线上部署页面（Vercel）→ 同源相对 /__proxy 中继优先 ===== */
  {
    const s = makeSandbox("https:", REMOTE, async () => apiErrResponse);
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("C1 线上页面第 1 个请求走同源相对 /__proxy", s.calls[0], AUTH_RELAY);
    check("C1 只发 1 次请求（同源不发预检、不回退）", s.calls.length, 1);
  }
  {
    // rewrite 没配 → /__proxy 404 → 本请求回退直连，并记住 5s
    const s = makeSandbox("https:", REMOTE, async (u, o, n) =>
      n === 1 ? { status: 404, text: async () => "not found" } : apiErrResponse
    );
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("C2 /__proxy 404 → 本请求回退直连", s.calls[1], AUTH_DIRECT);
    const before = s.calls.length;
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("C2 404 被记住：后续请求直接走直连（不再白撞）", s.calls.length - before, 1);
  }
  {
    // 静态托管把 /__proxy 当成缺失页面回了 HTML 兜底页（200）→ 不是接口响应，必须换通道
    const s = makeSandbox("https:", REMOTE, async (u, o, n) =>
      n === 1
        ? { status: 200, text: async () => "<!DOCTYPE html><html><body>Not Found</body></html>" }
        : apiErrResponse
    );
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("C3 HTML 兜底页 → 判定没有中继并回退直连", s.calls[1], AUTH_DIRECT);
    check("C3 不会被当成接口错误弹给用户", s.calls.length, 2);
  }
  {
    // 平台级故障（函数超时）→ 换通道 + 记不可用，避免每个请求都白付一次往返
    const s = makeSandbox("https:", REMOTE, async (u, o, n) =>
      n === 1
        ? { status: 504, text: async () => '{"error":{"code":"FUNCTION_INVOCATION_TIMEOUT"}}' }
        : apiErrResponse
    );
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("C4 平台级 504 → 本请求回退直连", s.calls[1], AUTH_DIRECT);
    const before = s.calls.length;
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("C4 平台级故障被记住（后续不再白撞）", s.calls.length - before, 1);
  }
  {
    // 线上中继连不上 → 文案必须指向「部署自查」，不能让线上用户去运行 node server.js
    const s = makeSandbox("https:", REMOTE, async () => {
      throw new TypeError("Failed to fetch");
    });
    s.get(`_throttle.cooldownScale = 0.01`);
    const msg = await s.get(`APIClient.login("a","b","c",Region.china)`).then(
      () => "",
      (e) => e.message
    );
    check("C5 线上文案点明中转地址", msg.includes("https://preview.example.com/__proxy"), true);
    check("C5 给出部署自查办法", msg.includes("api/proxy.js"), true);
    check("C5 不让线上用户去运行 node server.js", msg.includes("node server.js"), false);
  }

  /* ---------- D. POST body / 头与原逻辑保持一致 ---------- */
  {
    let seen = null;
    const s = makeSandbox("http:", LOCAL, async (u, o) => {
      seen = o;
      return apiErrResponse;
    });
    await s.get(`APIClient.login("user@x.com","pwd","support",Region.china)`).catch(() => {});
    check("D1 POST 方法", seen.method, "POST");
    check("D1 Content-Type 正确", seen.headers["Content-Type"], "application/json");
    check(
      "D1 Body 字段与 iOS 一致",
      seen.body,
      JSON.stringify({ Email: "user@x.com", Password: "pwd", Identifier: "support", TokenExpiresIn: 86400 })
    );
    check("D1 不带 cookie", seen.credentials, "omit");
    check("D1 有超时信号", typeof seen.signal !== "undefined", true);
  }

  /* ================= E. 429 限流：不重登、不风暴、可退避 ================= */

  /* ---------- E1. login 遇 429 空体 → 显式接口错误 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async () => tooMany);
    const err = await s
      .get(`APIClient.login("a","b","c",Region.china)`)
      .then(() => null, (e) => e);
    check("E1 429 空体按接口错误抛出", err instanceof s.get("APIError"), true);
    check("E1 apiCode 为 TOO_MANY_REQUESTS", err && err.apiCode, "TOO_MANY_REQUESTS");
    check("E1 提示语非空", typeof (err && err.message) === "string" && err.message.length > 5, true);
    check("E1 只发 1 次请求", s.calls.length, 1);
  }

  /* ---------- E2. getMeasurements 持续 429 → 4 次退避后失败，不进 100 次风暴 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async () => tooMany);
    s.get(`_throttle.cooldownScale = 0.01`); // 压缩冷却时长（降速逻辑本身不变）
    s.get(`SharedUsers = [{ key: "support0", email: "a@b.c", password: "p", orgName: "support", region: 0, token: "tok" }]`);
    await s.get(
      `APIClient.getMeasurements("support", Region.china, "study-1")` +
        `.then(() => (globalThis.__e = null), (e) => (globalThis.__e = e))`
    );
    check("E2a 最终抛限流错误", s.get(`__e && __e.apiCode`), "TOO_MANY_REQUESTS");
    check("E2b 不标记会话失效", s.get(`__e && isSessionExpiredError(__e)`), false);
    check("E2c 429 不触发重新登录（请求数 = 1 次原请求 + 4 次退避）", s.calls.length, 5);
    check("E2d 持续限流 → 速率降到最低档 2 req/s", s.get("_throttle.rate"), 2);
    check("E2e 已设置冷却窗口", s.get("_throttle.cooldownUntil > 0"), true);
  }

  /* ---------- E3. 429 退避后成功 → 用户无感 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async (u, o, n) => {
      if (n === 1) return tooMany;
      return { status: 200, text: async () => JSON.stringify([{ TotalCount: 7 }]) };
    });
    s.get(`_throttle.cooldownScale = 0.01`);
    s.get(`SharedUsers = [{ key: "support0", email: "a@b.c", password: "p", orgName: "support", region: 0, token: "tok" }]`);
    const info = await s
      .get(`APIClient.getMeasurements("support", Region.china, "study-1")`)
      .then((v) => v, (e) => ({ error: e.message }));
    check("E3a 退避重试后拿到数据", Array.isArray(info) && info[0].TotalCount, 7);
    check("E3b 共 2 次请求（原请求 + 退避重试）", s.calls.length, 2);
  }

  /* ---------- E4. 401 不续期：直接按会话失效抛出，不发登录请求 ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async () => ({
      status: 401,
      text: async () => JSON.stringify({ Code: "INVALID_TOKEN", Message: "Invalid token" }),
    }));
    s.get(`SharedUsers = [{ key: "support0", email: "a@b.c", password: "p", orgName: "support", region: 0, token: "tok" }]`);
    await s.get(
      `APIClient.getMeasurements("support", Region.china, "study-1")` +
        `.then(() => (globalThis.__e = null), (e) => (globalThis.__e = e))`
    );
    check("E4a 保留接口 Code", s.get(`__e && __e.apiCode`), "INVALID_TOKEN");
    check("E4b 标记会话失效", s.get(`__e && __e.isSessionExpired === true`), true);
    check("E4c 判定函数认同", s.get(`__e && isSessionExpiredError(__e)`), true);
    check("E4d 只发 1 次请求（不重新登录、不重试）", s.calls.length, 1);
  }

  /* ---------- E5. 并发 401：零登录请求（旧版会为每个失败请求各发一次 login） ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async () => ({
      status: 401,
      text: async () => JSON.stringify({ Code: "INVALID_TOKEN", Message: "Invalid token" }),
    }));
    s.get(`SharedUsers = [{ key: "support0", email: "a@b.c", password: "p", orgName: "support", region: 0, token: "tok" }]`);
    await s.get(
      `Promise.all([0,1,2].map(function(i){` +
        ` return APIClient.getMeasurements("support", Region.china, "study-"+i).catch(function(){ return null; }); }))`
    );
    const authCalls = s.calls.filter((u) => decodeURIComponent(u).includes("/organizations/auth")).length;
    check("E5a 3 个并发失败零登录请求", authCalls, 0);
    check("E5b 请求数 = 3 个业务请求", s.calls.length, 3);
  }

  /* ============ G. 限流自适应降速：速率收紧 → 回升 ============ */
  {
    const s = makeSandbox("http:", LOCAL, async () => apiErrResponse);
    check("G1 初始速率 12 req/s（≈不限速，不影响国内体验）", s.get("_throttle.rate"), 12);
    s.get("_noteRateLimited()");
    check("G2 撞限流 → 降到 4 req/s（低于接口的 5/s）", s.get("_throttle.rate"), 4);
    s.get("_noteRateLimited(); _noteRateLimited();");
    check("G3 持续撞限流 → 降到最低档 2 req/s", s.get("_throttle.rate"), 2);
    check("G4 penalty 封顶（速率不会无限下降）", s.get("_throttle.penalty"), 3);
    s.get("for (var i = 0; i < 10; i++) _noteSuccess();");
    check("G5 连续 10 次成功后回升到 3 req/s", s.get("_throttle.rate"), 3);
    s.get("for (var j = 0; j < 10; j++) _noteSuccess();");
    check("G6 再连续 10 次成功后回升到 4 req/s", s.get("_throttle.rate"), 4);
  }

  /* ===== H. 跨域直连：有限流层的主机才压速 + 传输层整体重试 =====
   * 现场故障（2026-09-18，本地没开 server.js）：
   *   全部回落跨域直连 → 接口没有 Access-Control-Max-Age，预检结果不缓存，
   *   每个业务请求都额外带一次 OPTIONS，服务端命中数翻倍。
   *   闸门只按业务请求计数，于是 12 req/s 实际是 24 次/秒 → 第一波预检就 429；
   *   而 **预检被限流时浏览器会把业务请求判死**（net::ERR_FAILED），
   *   单次传输失败又是致命错误 → 7 秒整页报「无法连接接口服务」。
   * 但压速只对有限流层的主机有意义：国内接口压了纯亏（实测 8.9s → 29.7s）。 */
  {
    const s = makeSandbox("http:", LOCAL, async (u, o, n) => {
      if (n === 1) throw new TypeError("Load failed"); // 中继（死）→ 回退直连
      return apiErrResponse;
    });
    check("H1 尚不知要走直连时仍是 12 req/s", s.get("_throttle.rate"), 12);
    await s.get(`APIClient.login("a","b","c",Region.international)`).catch(() => {});
    check("H2 第 2 个请求确实是跨域直连（海外主机）", s.calls[1], AUTH_INTL);
    check("H2 跨域直连 + 有限流层 → 压到 2 req/s", s.get("_throttle.rate"), 2);
    check("H2 上限被记住", s.get("_throttle.cap"), 2);
    // 预检开销恒在，连续成功也不能让它升回去
    s.get("for (var i = 0; i < 30; i++) _noteSuccess();");
    check("H3 连续成功也不会回升超过 2 req/s", s.get("_throttle.rate"), 2);
  }
  {
    // 国内主机没有限流层（实测无 x-ratelimit-limit）→ 不压速
    const s = makeSandbox("http:", LOCAL, async (u, o, n) => {
      if (n === 1) throw new TypeError("Load failed");
      return apiErrResponse;
    });
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("H4 国内主机跨域直连不压速（仍 12 req/s）", s.get("_throttle.rate"), 12);
    check("H4 确实走的是直连", s.calls[1], AUTH_DIRECT);
  }
  {
    // 同源中继没有预检开销 → 哪个主机都不压速
    const s = makeSandbox("http:", LOCAL, async () => apiErrResponse);
    await s.get(`APIClient.login("a","b","c",Region.international)`).catch(() => {});
    check("H5 同源中继不受影响（仍 12 req/s）", s.get("_throttle.rate"), 12);
  }
  {
    // 线上 rewrite 没生效 → 回落跨域直连 → 海外主机同样压速
    const s = makeSandbox("https:", REMOTE, async (u, o, n) =>
      n === 1 ? { status: 404, text: async () => "not found" } : apiErrResponse
    );
    await s.get(`APIClient.login("a","b","c",Region.international)`).catch(() => {});
    check("H6 线上 /__proxy 失效回落直连时同样压速", s.get("_throttle.rate"), 2);
  }
  {
    // 被豁免的主机一旦真出现 429 也要压速（限流层可能是后来才加的）
    const s = makeSandbox("https:", REMOTE, async (u, o, n) =>
      n === 1 ? { status: 404, text: async () => "not found" } : tooMany
    );
    s.get(`_throttle.cooldownScale = 0.01`);
    await s.get(`APIClient.login("a","b","c",Region.china)`).catch(() => {});
    check("H7 直连真撞 429 → 同样压速", s.get("_throttle.rate"), 2);
  }
  {
    // 传输层全失败 → 整体退避重试；跨域直连下被预检 429 判死的请求靠这层兜住
    const s = makeSandbox("http:", LOCAL, async (u, o, n) => {
      if (n === 1) throw new TypeError("Load failed"); // 中继死
      if (n === 2) throw new TypeError("Failed to fetch"); // 直连被中止（预检 429）
      return apiErrResponse; // 重试成功
    });
    s.get(`_throttle.cooldownScale = 0.01`);
    const msg = await s.get(`APIClient.login("a","b","c",Region.china)`).then(
      () => "",
      (e) => e.message
    );
    check("H8 传输层失败后重试成功（拿到接口报文）", msg, "Invalid Credentials");
    check("H8 共 3 次请求（中继 → 直连 → 重试直连）", s.calls.length, 3);
  }

  /* ---------- F. DecodingError 重试路径仍可用（带防护性间隔后成功） ---------- */
  {
    const s = makeSandbox("http:", LOCAL, async (u, o, n) => {
      if (n === 1) return { status: 200, text: async () => "not-json" };
      return { status: 200, text: async () => JSON.stringify([{ TotalCount: 5 }]) };
    });
    s.get(`SharedUsers = [{ key: "support0", email: "a@b.c", password: "p", orgName: "support", region: 0, token: "tok" }]`);
    const info = await s
      .get(`APIClient.getMeasurements("support", Region.china, "study-1")`)
      .then((v) => v, (e) => ({ error: e.message }));
    check("F1 解码失败重试后拿到数据", Array.isArray(info) && info[0].TotalCount, 5);
    check("F1 重试只补发了 1 次请求", s.calls.length, 2);
  }

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
