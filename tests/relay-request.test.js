#!/usr/bin/env node
/* ============================================================================
 * 中继（lib/proxy.js 的 handleProxy）服务端行为回归
 *
 * 为什么单独一个套件：`transport.test.js` 测的是**浏览器侧**的通道选择（app/api.js），
 * 而 handleProxy 是**服务端**那一跳 —— 它对「原样透传」的实现从来没被测过。
 * 而它正是登录 POST 的必经之路，一旦把正文弄坏，登录会整体失效且现象很难归因。
 *
 * 这里用「打桩 https.request」的办法离线测：把 Node 的发请求函数换成一个记录器，
 * 于是可以逐字段断言**真正发出去的请求**长什么样（头、正文、长度），不碰网络。
 *
 * 钉住的不变量：
 *   · 没有正文的请求（GET/HEAD）**绝不能**被加上 content-length，也**绝不能**带正文。
 *     —— 平台对无正文的 GET 也会给出 `req.body = {}`，若采信它就会被序列化成 2 字节，
 *        凭空造出一个 body（上游要么等这 2 字节等到超时、要么直接断连）。
 *   · 正文来源由 `resolveBody` 按「手上到底有没有这些字节」判定，而不是按头判定：
 *       platform 平台已解析出真正文 → 用重算长度发它
 *       stream   平台没给、流仍可读   → 沿用浏览器声明的长度，逐字节转发
 *       none     本请求没有正文       → 一个字节都不发
 *       lost     声明了正文却两边都拿不到 → **绝不照抄长度发空流**，直接回可归因的 502
 *       （曾经的做法是嗅探 `content-length` 就照抄一个长度再 pipe 一个已消费的流 ——
 *        结果是「声明 N 字节、实际发 0 字节」，上游等到超时或断连，中继 502 且 Message 为空）
 *   · 逐跳头（transfer-encoding / connection / te / …）**绝不能**转发给上游 ——
 *     它只对「客户端↔本进程」这一跳有意义；转发了 transfer-encoding 又另设 content-length，
 *     是一个请求同时带两个互斥头，上游会直接断连（只有带正文的 POST 会中招）。
 *   · 鉴权头必须转发（接口靠它鉴权），平台注入头必须剥掉。
 *   · 出错时的 502 响应体只能回**头名**，绝不能回头的值（Authorization 不得泄漏）。
 * ==========================================================================*/
const path = require("path");
const https = require("https");
const { Readable } = require("stream");

const PROXY = require(path.resolve(__dirname, "../lib/proxy"));
const { handleProxy } = PROXY;

const results = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : `  (期望 ${expected})`}`);
};
const checkTrue = (label, actual) => check(label, actual ? "true" : "false", "true");

/* ---------------------------------------------------------------------------
 * 打桩：把 https.request 换成记录器。
 * lib/proxy.js 在调用时才做 `upstream.protocol === "https:" ? https : http`，
 * 所以替换模块上的 request 属性即可拦到它发出的每一个请求。
 * -------------------------------------------------------------------------*/
const realRequest = https.request;
let captured = null;
let requestCount = 0; // 重试是否真的发生，只能靠数「一共建了几次请求」来断言
let responder = null; // (req, cb, cap) => void，决定这次请求怎么回应

https.request = function patched(opts, cb) {
  requestCount++;
  const cap = { opts, headers: Object.assign({}, opts.headers || {}), chunks: [], req: null };
  captured = cap;
  const req = {
    reusedSocket: false,
    agent: { freeSockets: {} },
    _listeners: {},
    on(ev, fn) {
      (this._listeners[ev] = this._listeners[ev] || []).push(fn);
      return this;
    },
    once(ev, fn) {
      const wrapped = (arg) => {
        this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== wrapped);
        fn(arg);
      };
      return this.on(ev, wrapped);
    },
    emit(ev, arg) {
      (this._listeners[ev] || []).forEach((f) => f(arg));
      return true;
    },
    write(chunk) {
      cap.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      cap.ended = true;
      return this;
    },
    destroy(err) {
      cap.destroyed = true;
      if (err) this.emit("error", err);
      return this;
    },
  };
  cap.req = req;
  if (responder) responder(req, cb, cap);
  return req;
};
const restore = () => {
  https.request = realRequest;
};

/* ---------------------------------------------------------------------------
 * 替身：入站请求（handleProxy 的第一个参数）与响应（第三个参数）
 * -------------------------------------------------------------------------*/
function incoming({ method = "GET", headers = {}, body, rawBody, consumed }) {
  const raw = rawBody === undefined ? null : Buffer.from(rawBody);
  return {
    method,
    url: "/",
    headers,
    body, // undefined 模拟「平台没解析」；{} 模拟「平台对无正文请求也给了空对象」
    // consumed: true 模拟「入站流已被平台消费」—— 此时再 pipe 只会得到 0 字节
    readableEnded: consumed === undefined ? false : !!consumed,
    pipe(dest) {
      if (raw) dest.end(raw);
      else dest.end();
      return dest;
    },
  };
}

function outgoing() {
  const state = { statusCode: null, headers: null, chunks: [], finished: false };
  const self = {
    headersSent: false,
    writeHead(code, headers) {
      state.statusCode = code;
      state.headers = headers || null;
      self.headersSent = true;
      return self;
    },
    write(chunk) {
      if (chunk) state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk) self.write(chunk);
      state.finished = true;
      return self;
    },
    on() {
      return self;
    },
    once() {
      return self;
    },
    removeListener() {
      return self;
    },
    emit() {
      return false;
    },
    // 便捷读取
    get status() {
      return state.statusCode;
    },
    get headers() {
      return state.headers;
    },
    get body() {
      return Buffer.concat(state.chunks).toString("utf8");
    },
  };
  return self;
}

/**
 * 上游响应替身。
 * ⚠️ 必须**异步**触发：真实 Node 里响应回调永远不会在 `request()` 返回前发生，
 * 而 handleProxy 是在 `request()` 返回**之后**才挂 timeout/error 监听器的。
 * 同步触发会赶在监听器挂上之前，测出来的东西与线上不符。
 */
const soon = (fn) => setTimeout(fn, 0);

function upstreamRes({ status = 200, headers = { "content-type": "application/json" }, body = "" }) {
  const stream = Readable.from([Buffer.from(body)]);
  stream.statusCode = status;
  stream.headers = headers;
  return stream;
}

const tick = () => new Promise((r) => setTimeout(r, 10));
/** 等一段**明确长度**的时间：给「自设建连上限」这类按毫秒触发的路径用 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 解析响应体；解析不出来就回 `{}`。
 * 为什么不用裸 JSON.parse：被测代码一旦行为退化（比如根本没回响应体），
 * 裸解析会直接把整个套件崩掉，反而看不到到底是哪条不变量被破坏了。
 */
const parseBody = (raw) => {
  try {
    return JSON.parse(raw || "{}");
  } catch (e) {
    return {};
  }
};

/* ==========================================================================*/
(async () => {
  const UA = "Mozilla/5.0 (Macintosh) Chrome/140";
  // ⚠️ 断言用的哨兵值：它绝不允许出现在中继的任何响应体里
  const SECRET = "SECRET-TOKEN-DO-NOT-LEAK";

  /* ---------- A. GET 无正文，但平台给了 `req.body = {}` ---------- */
  try {
    responder = null;
    handleProxy(
      incoming({ method: "GET", headers: { "user-agent": UA }, body: {} }),
      outgoing(),
      "https://api.prod.deepaffex.cn/",
      {}
    );
    check("A1 GET 不凭空加 content-length", captured.headers["content-length"], undefined);
    check("A2 GET 不发出任何正文", Buffer.concat(captured.chunks).length, 0);
    check("A3 host 头被改成上游域名", captured.headers.host, "api.prod.deepaffex.cn");
    check("A4 端口是 443", captured.opts.port, 443);
  } catch (e) {
    check("A 整体（GET + 平台空对象）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* ---------- B. GET 无正文，平台没解析（本机 server.js 的形态） ---------- */
  try {
    responder = null;
    handleProxy(
      incoming({ method: "GET", headers: { "user-agent": UA } }),
      outgoing(),
      "https://api.as-east.deepaffex.ai/",
      {}
    );
    check("B1 GET 不设 content-length", captured.headers["content-length"], undefined);
    check("B2 正文为空", Buffer.concat(captured.chunks).length, 0);
    check("B3 海外域名 host 正确", captured.headers.host, "api.as-east.deepaffex.ai");
  } catch (e) {
    check("B 整体（GET + 平台未解析）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* ---------- C. POST：正文未被平台消费（原始流） ---------- */
  try {
    responder = null;
    const payload = JSON.stringify({ email: "a@b.c", password: "p", organization: "org" });
    handleProxy(
      incoming({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          authorization: `Bearer ${SECRET}`,
          "user-agent": UA,
        },
        rawBody: payload,
      }),
      outgoing(),
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    check("C1 沿用浏览器的 content-length", captured.headers["content-length"], String(Buffer.byteLength(payload)));
    check("C2 正文逐字节转发", Buffer.concat(captured.chunks).toString("utf8"), payload);
    check("C3 鉴权头被转发", captured.headers.authorization, `Bearer ${SECRET}`);
    check("C4 content-type 被转发", captured.headers["content-type"], "application/json");
  } catch (e) {
    check("C 整体（POST 原始流）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* ---------- D. POST：正文已被平台解析成对象 ---------- */
  try {
    responder = null;
    const obj = { email: "a@b.c", password: "p" };
    handleProxy(
      incoming({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999", // 平台解析后这个值已经不可信，必须用重算值覆盖
          "user-agent": UA,
        },
        body: obj,
      }),
      outgoing(),
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    const expected = JSON.stringify(obj);
    check("D1 content-length 用重算值覆盖旧值", captured.headers["content-length"], String(Buffer.byteLength(expected)));
    check("D2 正文为重新序列化后的 JSON", Buffer.concat(captured.chunks).toString("utf8"), expected);
  } catch (e) {
    check("D 整体（POST 平台已解析）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* ---------- E. 头卫生：逐跳头/平台头剥掉，其余保留 ---------- */
  try {
    responder = null;
    handleProxy(
      incoming({
        method: "GET",
        headers: {
          origin: "https://billing-web-teal.vercel.app",
          referer: "https://billing-web-teal.vercel.app/",
          "accept-encoding": "gzip, deflate, br",
          "x-forwarded-for": "203.0.113.7",
          "x-vercel-id": "sfo1::abc",
          host: "billing-web-teal.vercel.app",
          "accept-language": "zh-CN,zh;q=0.9",
          accept: "application/json",
          "user-agent": UA,
        },
      }),
      outgoing(),
      "https://api.prod.deepaffex.cn/",
      {}
    );
    check("E1 origin 被剥掉", captured.headers.origin, undefined);
    check("E2 referer 被剥掉", captured.headers.referer, undefined);
    check("E3 accept-encoding 被剥掉", captured.headers["accept-encoding"], undefined);
    check("E4 x-forwarded-for 被剥掉", captured.headers["x-forwarded-for"], undefined);
    check("E5 x-vercel-* 被剥掉", captured.headers["x-vercel-id"], undefined);
    check("E6 业务头保留（accept-language）", captured.headers["accept-language"], "zh-CN,zh;q=0.9");
    check("E7 user-agent 保留原值", captured.headers["user-agent"], UA);
  } catch (e) {
    check("E 整体（头卫生）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* ---------- F. 白名单与协议 ---------- */
  {
    responder = null;
    const r1 = outgoing();
    handleProxy(incoming({ method: "GET" }), r1, "https://example.com/", {});
    check("F1 白名单外域名 → 403", r1.status, 403);
    const r2 = outgoing();
    handleProxy(incoming({ method: "GET" }), r2, "ftp://api.prod.deepaffex.cn/", {});
    check("F2 非 http(s) 协议 → 400", r2.status, 400);
    const r3 = outgoing();
    handleProxy(incoming({ method: "GET" }), r3, "not-a-url", {});
    check("F3 非法 URL → 400", r3.status, 400);
  }

  /* ---------- G. 成功路径：透传状态码 + 打上中继标记 ---------- */
  try {
    responder = (req, cb) =>
      soon(() =>
        cb(upstreamRes({ status: 200, headers: { "content-type": "application/json" }, body: '{"ok":1}' }))
      );
    const res = outgoing();
    handleProxy(incoming({ method: "GET" }), res, "https://api.prod.deepaffex.cn/", {});
    await tick();
    check("G1 透传上游状态码", res.status, 200);
    check("G2 打上中继标记头", res.headers && res.headers["X-Billing-Relay"], "1");
    check("G3 正文被透传", res.body, '{"ok":1}');
  } catch (e) {
    check("G 整体（成功路径）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* ---------- H. 失败路径：复现「空 message」并确认不泄漏凭据 ---------- */
  try {
    const emptyErr = new Error(""); // 线上实测就是这个形态：message 为空，成因完全不可见
    responder = (req) => soon(() => req.emit("error", emptyErr));
    const res = outgoing();
    handleProxy(
      incoming({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2",
          authorization: `Bearer ${SECRET}`,
          "user-agent": UA,
        },
        body: {},
      }),
      res,
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    await tick();
    check("H1 上游出错 → 502", res.status, 502);
    const parsed = parseBody(res.body);
    check("H2 带中继标记（前端据此知道是中继发的）", res.headers["X-Billing-Relay"], "1");
    check("H3 错误码", parsed.Code, "PROXY_ERROR");
    check("H4 回出错误对象名（空 message 也能归因）", parsed.ErrName, "Error");
    checkTrue("H5 回出发出的头名", String(parsed.SentHeaderNames || "").includes("authorization"));
    checkTrue("H6 回出本次请求形态", "DeclaresBody" in parsed);
    checkTrue("H7 回出调用栈", String(parsed.Stack || "").length > 0);
    checkTrue("H8 响应体不含 Authorization 的值", !res.body.includes(SECRET));
  } catch (e) {
    check("H 整体（失败路径）", `抛异常 ${e.message}`, "不抛异常");
  }
  /* ---------- J. POST：声明了正文，但平台没给解析结果、流也已被消费 ----------
   * 这就是「声明 N 字节却一个都不发」的形态：旧实现在这里会照抄 content-length
   * 再 pipe 一个已消费的流，然后发出一个畸形的上游请求。现在必须就地拦住。 */
  {
    responder = null; // 连上游都不该有请求，自然也不该有回应
    captured = null; // 关键：本用例**不该**发起任何上游请求
    const res = outgoing();
    handleProxy(
      incoming({
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "87", "user-agent": UA },
        body: undefined,
        consumed: true,
      }),
      res,
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    check("J1 不发上游请求（绝不照抄长度发空流）", captured, null);
    check("J2 → 502", res.status, 502);
    const j = parseBody(res.body);
    check("J3 明确指出正文已丢", j.BodySource, "lost");
    check("J4 回出平台正文类型", j.PlatformBodyType, "none");
    check("J5 带中继标记（前端据此知道是中继发的）", (res.headers || {})["X-Billing-Relay"], "1");
  }

  /* ---------- K. 逐跳头必须剥掉：transfer-encoding 与 content-length 互斥 ---------- */
  {
    responder = null;
    const payload = JSON.stringify({ Email: "a@b.c", Password: "p" });
    handleProxy(
      incoming({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "transfer-encoding": "chunked",
          connection: "keep-alive",
          te: "trailers",
          "user-agent": UA,
        },
        rawBody: payload,
      }),
      outgoing(),
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    check("K1 transfer-encoding 被剥掉", captured.headers["transfer-encoding"], undefined);
    check("K2 connection 被剥掉", captured.headers.connection, undefined);
    check("K3 te 被剥掉", captured.headers.te, undefined);
    check(
      "K4 content-length 保留（剥掉分块后必须留一个长度）",
      captured.headers["content-length"],
      String(Buffer.byteLength(payload))
    );
    check("K5 正文仍完整转发", Buffer.concat(captured.chunks).toString("utf8"), payload);
  }

  /* ---------- L. POST 但正文长度就是 0 ---------- */
  {
    responder = null;
    handleProxy(
      incoming({ method: "POST", headers: { "content-length": "0", "user-agent": UA } }),
      outgoing(),
      "https://api.prod.deepaffex.cn/",
      {}
    );
    check("L1 照实声明 content-length: 0", captured.headers["content-length"], "0");
    check("L2 一个字节都不发", Buffer.concat(captured.chunks).length, 0);
  }

  /* ---------- M. 平台解析了正文、但头里没有 content-length ----------
   * 平台完全可能把正文解析掉、顺手清掉长度头 —— 此时头里没有「声明」，
   * 但平台给的正文是真实非空的，必须采信，否则正文被静默丢掉。 */
  {
    responder = null;
    const obj = { Email: "a@b.c", Password: "p" };
    handleProxy(
      incoming({
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: obj,
      }),
      outgoing(),
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    const expected = JSON.stringify(obj);
    check("M1 仍采信平台的正文", Buffer.concat(captured.chunks).toString("utf8"), expected);
    check("M2 长度按重算值补上", captured.headers["content-length"], String(Buffer.byteLength(expected)));
  }

  /* ---------- N. AggregateError（Node 的 ConnectMultiple）：逐个地址的失败原因 ----------
   * 线上实测形态：`ErrName=AggregateError` / `ErrCode=ETIMEDOUT`，
   * 但只看这两个字段分不清「一个坏 IP」还是「整条出口都不通」—— 处置完全不同。
   * 所以必须把每个地址各自的结果单独回出来，并且带上实例所在区域。 */
  try {
    const agg = new AggregateError(
      [
        Object.assign(new Error("connect ETIMEDOUT 54.223.162.2:443"), { code: "ETIMEDOUT", address: "54.223.162.2", port: 443 }),
        Object.assign(new Error("connect ETIMEDOUT 52.80.97.78:443"), { code: "ETIMEDOUT", address: "52.80.97.78", port: 443 }),
        Object.assign(new Error("connect ETIMEDOUT 52.81.142.173:443"), { code: "ETIMEDOUT", address: "52.81.142.173", port: 443 }),
      ],
      "AggregateError"
    );
    agg.code = "ETIMEDOUT";
    responder = (req) => soon(() => req.emit("error", agg));
    const res = outgoing();
    handleProxy(
      incoming({ method: "GET", headers: { accept: "application/json", "user-agent": UA } }),
      res,
      "https://api.prod.deepaffex.cn/",
      {}
    );
    await tick();
    const parsed = parseBody(res.body);
    check("N1 仍是 502 + 中继标记", `${res.status}/${res.headers["X-Billing-Relay"]}`, "502/1");
    check("N2 回出聚合错误里的地址数", parsed.ConnectErrCount, 3);
    check("N3 逐个地址的原因都列出", (parsed.ConnectErrors || []).length, 3);
    checkTrue(
      "N4 三个地址各自的结果都在",
      ["54.223.162.2", "52.80.97.78", "52.81.142.173"].every((a) =>
        String(parsed.ConnectErrors).includes(`${a}:ETIMEDOUT`)
      )
    );
    // 本地没有 VERCEL_REGION → 值为 null，但**字段必须存在**：
    // 「查过了、这个实例不在任何已知区域」和「压根没查」是两件事。
    checkTrue("N5 回出实例区域字段", "Region" in parsed);
    check("N6 回出本次的超时上限", parsed.TimeoutMs, PROXY.DEFAULT_TIMEOUT_MS);
    checkTrue("N7 响应体不含 Authorization 的值", !res.body.includes(SECRET));
    // 线上实测的形态是「12 并发里 5 个失败，每个都耗满 ~16s」—— 那次失败吃掉了函数时限的一半。
    // 现在同样的失败会**自己重试**，所以 502 里必须能看出「试了几次」：
    // 「试 1 次就失败」与「3 次全失败」指向完全不同的处置（后者说明重试这条路走不通，必须换节点）。
    check("N8 回出尝试次数（默认 3 次全试过）", parsed.Attempts, 3);
    check("N9 每次尝试各自的结论都在", (parsed.AttemptErrors || []).length, 3);
    checkTrue("N10 标出「确实重试过」", parsed.Retried === true);
  } catch (e) {
    check("N 整体（聚合错误归因）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* ---------- O. 建连失败的重试 ----------
   * 线上实测：12 并发打同一批测量接口，5 个失败，形态都是
   * `AggregateError / ETIMEDOUT`，且三个地址**全部**超时。
   * 这类失败发生在**建连阶段**、与请求内容无关 ⇒ 重发一次是有效的；
   * 而当时的实现一次失败就地把 16s 烧完，重试根本塞不进 30s 的函数时限。
   *
   * 这一组钉住三件事：① 什么错误才允许重试；② 重试确实发生、且成功时不回 502；
   * ③ 重试**绝不能**发空正文（不可重放的流一次都不许重试）。 */

  /* O-A. 可重试判据本身（纯函数，不碰网络） */
  {
    // ⚠️ 缺导出时必须**记 FAIL 而不是抛异常**：裸调用会让整个套件以 TypeError 终止，
    // 连带把后面 O-B…O-F 的结论一起吞掉（这条教训在 diag-page 套件上已经吃过一次）。
    const fn = PROXY.isTransientConnectError;
    checkTrue("O0 导出了可重试判据", typeof fn === "function");
    const t = (e) => (typeof fn === "function" ? fn(e) : null);
    checkTrue("O1 ETIMEDOUT 可重试", t(Object.assign(new Error("x"), { code: "ETIMEDOUT" })));
    checkTrue("O2 ECONNRESET 可重试", t(Object.assign(new Error("x"), { code: "ECONNRESET" })));
    checkTrue("O3 EAI_AGAIN 可重试", t(Object.assign(new Error("x"), { code: "EAI_AGAIN" })));
    // 证书类错误重试一百次也是同样结果 —— 重试只会白烧预算、把真实原因埋进噪音里
    checkTrue("O4 证书错误不可重试", !t(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" })));
    checkTrue("O5 没有 code 的裸错误不可重试", !t(new Error("x")));
    // 已经连上、只是响应慢：上游**已经收到请求**了，再发一次是加倍负载且结果大概率相同
    checkTrue("O6 响应期超时不可重试", !t(Object.assign(new Error("x"), { code: "ETIMEDOUT", bwPhase: "response" })));
    const allTimeout = new AggregateError(
      [Object.assign(new Error("a"), { code: "ETIMEDOUT" }), Object.assign(new Error("b"), { code: "ETIMEDOUT" })],
      "AggregateError"
    );
    checkTrue("O7 全部地址都是可重试码 → 可重试", t(allTimeout));
    const mixed = new AggregateError(
      [Object.assign(new Error("a"), { code: "ETIMEDOUT" }), Object.assign(new Error("b"), { code: "CERT_HAS_EXPIRED" })],
      "AggregateError"
    );
    checkTrue("O8 只要有一个地址不是抖动 → 不重试", !t(mixed));
    checkTrue("O8b 可重试码清单非空", typeof PROXY.TRANSIENT_CONNECT_CODES === "object");
  }

  /* O-B. 第一次建连失败、第二次成功 → 用户看到的是成功，不是 502 */
  try {
    let calls = 0;
    const seen = [];
    responder = (req, cb, cap) => {
      calls++;
      seen.push(cap);
      if (calls === 1) {
        soon(() =>
          req.emit("error", Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }))
        );
      } else {
        soon(() => cb(upstreamRes({ status: 200, body: '{"ok":1}' })));
      }
    };
    const res = outgoing();
    handleProxy(incoming({ method: "GET" }), res, "https://api.prod.deepaffex.cn/", {});
    await tick();
    check("O9 一共尝试了 2 次", calls, 2);
    check("O10 重试后成功 → 回 200 而不是 502", res.status, 200);
    check("O11 成功响应仍带中继标记", res.headers && res.headers["X-Billing-Relay"], "1");
    check("O12 正文照常透传", res.body, '{"ok":1}');
    checkTrue("O13 两次尝试的请求形状一致（同样的方法与目标）", seen[0].opts.path === seen[1].opts.path);
  } catch (e) {
    check("O-B 整体（重试后成功）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* O-C. 带正文的 POST：重试必须**原样重发正文**，不能发空的 */
  try {
    let calls = 0;
    const seen = [];
    responder = (req, cb, cap) => {
      calls++;
      seen.push(cap);
      if (calls === 1) soon(() => req.emit("error", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })));
      else soon(() => cb(upstreamRes({ status: 401, body: '{"Code":"INVALID_CREDENTIALS"}' })));
    };
    const obj = { Email: "a@b.c", Password: "p" };
    const res = outgoing();
    handleProxy(
      incoming({
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "999", "user-agent": UA },
        body: obj,
      }),
      res,
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    await tick();
    const expected = JSON.stringify(obj);
    check("O14 重试了（共 2 次）", calls, 2);
    check("O15 第二次仍带完整正文", Buffer.concat(seen[1].chunks).toString("utf8"), expected);
    check(
      "O16 第二次的 content-length 仍是重算值",
      seen[1].headers["content-length"],
      String(Buffer.byteLength(expected))
    );
    check("O17 上游的 401 照常透传", res.status, 401);
  } catch (e) {
    check("O-C 整体（重试重发正文）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* O-D. 正文来自原始流 → **一次都不许重试**（重发会变成空正文，比失败更糟） */
  try {
    let calls = 0;
    responder = (req) => {
      calls++;
      soon(() => req.emit("error", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })));
    };
    const payload = JSON.stringify({ Email: "a@b.c", Password: "p" });
    const res = outgoing();
    handleProxy(
      incoming({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "user-agent": UA,
        },
        rawBody: payload,
      }),
      res,
      "https://api.prod.deepaffex.cn/organizations/auth",
      {}
    );
    await tick();
    check("O18 流式正文只尝试 1 次", calls, 1);
    check("O19 → 502", res.status, 502);
    check("O20 502 里如实写「试了 1 次」", parseBody(res.body).Attempts, 1);
    checkTrue("O21 标出「没有重试」", parseBody(res.body).Retried === false);
  } catch (e) {
    check("O-D 整体（流式正文不重试）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* O-E. 自设的建连上限：连不上、但平台不报错（SYN 石沉大海）时自己放弃并按抖动重试 */
  try {
    let calls = 0;
    let timedOutSocket = false;
    responder = (req, cb) => {
      calls++;
      if (calls === 1) {
        // 石沉大海：既不连接也不报错，只有我们自己的计时器能救
        soon(() => req.emit("socket", { connecting: true, once() {} }));
        return;
      }
      soon(() => cb(upstreamRes({ status: 200, body: '{"ok":1}' })));
    };
    const res = outgoing();
    handleProxy(incoming({ method: "GET" }), res, "https://api.prod.deepaffex.cn/", {
      connectTimeoutMs: 30,
      maxAttempts: 2,
    });
    await wait(80);
    check("O22 长连不上时被自己的建连上限打断并重试", calls, 2);
    check("O23 重试后成功 → 200", res.status, 200);
    check("O24 成功路径照常透传正文", res.body, '{"ok":1}');
    checkTrue("O25 成功路径不回 502", !res.body.includes("PROXY_ERROR"));
  } catch (e) {
    check("O-E 整体（自设建连上限）", `抛异常 ${e.message}`, "不抛异常");
  }

  /* O-F. 重试预算用尽 → 不再开新尝试（防止撞穿平台函数时限） */
  try {
    let calls = 0;
    responder = (req) => {
      calls++;
      soon(() => req.emit("error", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })));
    };
    const res = outgoing();
    handleProxy(incoming({ method: "GET" }), res, "https://api.prod.deepaffex.cn/", { retryBudgetMs: 0 });
    await tick();
    check("O26 预算为 0 时只尝试 1 次", calls, 1);
    check("O27 → 502", res.status, 502);
    // 与常量比对时不能拿 undefined 跟 undefined 比 —— 那样「常量没导出」会伪装成通过
    const CT = PROXY.CONNECT_TIMEOUT_MS;
    check(
      "O28 502 里回出建连上限",
      parseBody(res.body).ConnectTimeoutMs,
      CT === undefined ? "（常量未导出）" : CT
    );
  } catch (e) {
    check("O-F 整体（重试预算）", `抛异常 ${e.message}`, "不抛异常");
  }

  await tick();
  restore();

  /* ---------- I. 自检：桩是否真的被拦到（防「测了个寂寞」） ---------- */
  checkTrue("I1 https.request 已被打桩拦截过", captured !== null && captured.opts.hostname === "api.prod.deepaffex.cn");

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
