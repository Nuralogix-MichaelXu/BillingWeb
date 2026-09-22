#!/usr/bin/env node
/* ============================================================================
 * 自检页面（GET /api/diag?form=1）的客户端脚本回归
 *
 * 为什么单独一个套件：这个页面是**唯一**让用户自己在真实部署上验证中继的办法
 * （本机被 DNS 污染挡住，验证不了 *.vercel.app）。页面坏了 = 唯一的验证手段没了。
 *
 * 而它坏过一次，且坏法很隐蔽：页面脚本是拼在 Node 文件里的字符串，**在浏览器里**执行。
 * 两个上游地址当时写在 Node 的模块作用域（`const CN_AUTH = …`），客户端脚本直接引用 ——
 * 浏览器里没有这个名字，于是点「POST /__proxy」时压根没发出请求，只报
 * `Can't find variable: CN_AUTH`。现象长得像「中继坏了」，实际是自检工具自己坏了。
 *
 * 这个套件因此不比对字符串，而是**把页面脚本真的跑一遍**（vm + DOM/fetch 桩），
 * 再逐个按下按钮，断言「确实发出了请求、且 URL 正确」——
 * 两组都用 `git show <commit>:api/diag.js` 对照跑过，确认它们真的会红：
 * 客户端作用域那组在 `7389e06` 上 13/32；探测结果缺 `ok` 那组在 `f7a2d88` 上 33/35。
 *
 * 钉住的不变量：
 *   · 页面脚本能在「只有 document + fetch」的环境里执行完，不抛 ReferenceError。
 *   · 四个按钮都绑上了 onclick，且每个按钮都会发出恰好一个 fetch。
 *   · 两个 POST 按钮打的是 /__proxy?url=<上游 auth>（国内 / 海外各一），
 *     且**带上了账号口令字段的请求体** —— 缺了正文这测试就白测了。
 *   · 第 4 个按钮打 GET /api/diag，并把区域 / commit / 三次重放压成可读文本。
 *   · 第 5 个按钮打 GET /api/diag?flaky=1，并把**逐次结果与成功率**摊开 ——
 *     「偶发」与「稳定不通」的结论全靠这一屏，把两者说反等于误诊。
 *   · 每个上游探测（`lookupAll` / tcp / tls / http / 抖动率逐次）**都必须回一个布尔 `ok`** ——
 *     页面靠它决定打 ✓ 还是 ✗。少写 `ok: true` 会让「成功」显示成「✗ ?」，把一次正常的运行
 *     报成故障；真实部署上就这样误报过（dns 行全红而 tls/http 全通）。
 * ==========================================================================*/
const path = require("path");
const vm = require("vm");

const handler = require(path.resolve(__dirname, "../api/diag"));

/* 刻意硬编码：要断言的就是「这两个地址真的出现在**页面源码**里」，
 * 从被测模块反推期望值会让这个套件跟着错值一起通过。 */
const CN_URL = "https://api.prod.deepaffex.cn/organizations/auth";
const AI_URL = "https://api.as-east.deepaffex.ai/organizations/auth";

const results = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : `  (期望 ${expected})`}`);
};
const checkTrue = (label, cond) => check(label, cond ? "true" : "false", "true");

/** 拿自检页面的 HTML（走真实 handler） */
function captureFormPage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead() {},
      write(c) {
        if (c) chunks.push(Buffer.from(String(c)));
        return true;
      },
      end(c) {
        if (c) chunks.push(Buffer.from(String(c)));
        resolve(Buffer.concat(chunks).toString("utf8"));
        return res;
      },
      on() {
        return res;
      },
      once() {
        return res;
      },
      removeListener() {
        return res;
      },
    };
    Promise.resolve(handler({ method: "GET", url: "/api/diag?form=1", headers: {} }, res)).catch(reject);
  });
}

(async () => {
  const html = await captureFormPage();

  /* ---------- A. 页面骨架 ---------- */
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  checkTrue("A1 页面取到且含 <script>", !!scriptMatch);
  const script = scriptMatch ? scriptMatch[1] : "";
  if (!script) {
    console.log(results.join("\n"));
    console.log("\n通过 0/" + results.length);
    process.exit(1);
  }
  checkTrue("A2 页面里出现国内 auth 地址", html.includes(CN_URL));
  checkTrue("A3 页面里出现海外 auth 地址", html.includes(AI_URL));
  // 地址必须出现在 <script> 之内（在 <button> 标签里写着没用，脚本引用不到的照样报错）
  checkTrue("A4 地址位于客户端脚本内部", script.includes(CN_URL) && script.includes(AI_URL));

  /* ---------- B. 在桩环境里把页面脚本真跑一遍 ---------- */
  // 输出区的初始文案从页面 HTML 里取（`log()` 靠这个哨兵值决定要不要先换行），
  // 不要自己另写一个 —— 桩跟页面不一致时，"测试挂了"其实是桩错了。
  const preInit = /<pre id="out">([^<]*)<\/pre>/.exec(html);
  checkTrue("B0 页面含输出区并带初始文案", !!preInit);
  const outInit = preInit ? preInit[1] : "";

  const els = {};
  const getEl = (id) => (els[id] ||= { id, disabled: false, textContent: id === "out" ? outInit : "", onclick: null });
  const calls = [];
  let responder = () => ({ status: 200, marker: "1", body: "stub", json: null });

  const ctx = {
    document: { getElementById: getEl },
    fetch(url, opts) {
      calls.push({ url: String(url), opts: opts || {} });
      const r = responder(String(url));
      return Promise.resolve({
        status: r.status,
        headers: { get: (k) => (String(k).toLowerCase() === "x-billing-relay" ? r.marker : null) },
        text: () => Promise.resolve(r.body),
        json: () => Promise.resolve(r.json),
      });
    },
    console,
    setTimeout,
    clearTimeout,
  };

  let bootError = null;
  try {
    vm.runInContext(script, vm.createContext(ctx), { filename: "diag-form-client.js" });
  } catch (e) {
    bootError = `${e.name}: ${e.message}`;
  }
  checkTrue("B1 页面脚本可整体执行（无未声明变量）", bootError === null);
  if (bootError) results.push(`       ↑ ${bootError}`);

  check("B2 输出区初始文案来自页面", getEl("out").textContent, outInit);
  for (const id of ["b1", "b2", "b3", "b4", "b5"]) {
    checkTrue(`B3 ${id} 已绑定 onclick`, typeof getEl(id).onclick === "function");
  }

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  /** 按下按钮并等它的 async 处理完（处理器本身不返回 promise，只能轮询日志） */
  async function press(id) {
    const before = calls.length;
    const el = getEl(id);
    // 页面脚本没跑到这句时会留下 null —— 记 FAIL 而不是崩掉整个套件，
    // 否则「少了一个按钮」会以 TypeError 的形式终止测试，看不出真正的原因。
    if (typeof el.onclick !== "function") {
      results.push(`FAIL  按钮 ${id} 没有 onclick —— 页面脚本没执行到绑定这一句`);
      return [];
    }
    el.onclick.call(el);
    for (let i = 0; i < 60; i++) {
      await tick(10);
      if (calls.length > before) break;
    }
    await tick(20); // 让 log() 落盘
    return calls.slice(before);
  }

  /* ---------- C. 第 1 个按钮：回显平台对正文的处理 ---------- */
  responder = () => ({ status: 200, marker: "1", body: '{"body_type":"object"}', json: null });
  let got = await press("b1");
  check("C1 只发出一个请求", got.length, 1);
  check("C2 打在 /api/diag", got[0] && got[0].url, "/api/diag");
  check("C3 用的是 POST", got[0] && String(got[0].opts.method).toUpperCase(), "POST");

  /* ---------- D. 第 2 个按钮：国内接口（登录的实际路径） ---------- */
  responder = () => ({ status: 401, marker: "1", body: '{"Code":"INVALID_CREDENTIALS"}', json: null });
  got = await press("b2");
  check("D1 只发出一个请求（没被未声明变量掐断）", got.length, 1);
  check("D2 打在 /__proxy 且 url=国内 auth", got[0] && got[0].url, "/__proxy?url=" + encodeURIComponent(CN_URL));
  checkTrue("D3 带上了登录正文（否则等于没测转发）", !!(got[0] && /"Password"/.test(String(got[0].opts.body))));
  checkTrue("D4 日志没报「请求本身失败」", getEl("out").textContent.indexOf("请求本身失败") < 0);
  checkTrue("D5 日志没报未声明变量", getEl("out").textContent.indexOf("Can't find variable") < 0);
  checkTrue("D6 日志识别出 401 是预期结果", getEl("out").textContent.indexOf("INVALID_CREDENTIALS") >= 0);

  /* ---------- E. 第 3 个按钮：海外接口 ---------- */
  got = await press("b3");
  check("E1 只发出一个请求", got.length, 1);
  check("E2 打在 /__proxy 且 url=海外 auth", got[0] && got[0].url, "/__proxy?url=" + encodeURIComponent(AI_URL));

  /* ---------- F. 第 4 个按钮：汇总 GET /api/diag 的三次重放 ---------- */
  responder = () => ({
    status: 200,
    marker: "1",
    body: "",
    json: {
      region: "sfo1",
      env: "production",
      git_sha: "7389e06abcdef1234567890",
      node: "v20.11.0",
      upstreams: [
        {
          label: "国内",
          host: "api.prod.deepaffex.cn",
          dns: { ok: true, addresses: ["54.223.162.2 (IPv4)"] },
          tls: { ok: true, ms: 187, protocol: "TLSv1.3" },
          http: { ok: true, status: 404, ms: 190 },
          replay: { relayed: true, status: 404, decided: "none" },
          replay_post: {
            platform: { relayed: true, status: 404, decided: "platform" },
            stream: { relayed: true, status: 404, decided: "stream" },
          },
        },
        {
          label: "海外",
          host: "api.as-east.deepaffex.ai",
          dns: { ok: true, addresses: ["54.150.58.188 (IPv4)"] },
          tls: { ok: false, error: "ETIMEDOUT" },
          http: { ok: false, error: "ETIMEDOUT" },
          replay: { relayed: false, status: 502, decided: "lost", error: "upstream error" },
          replay_post: { platform: { relayed: false, status: 502, decided: "lost" }, stream: { relayed: false, status: 502, decided: "lost" } },
        },
      ],
    },
  });
  got = await press("b4");
  const text = getEl("out").textContent;
  check("F1 只发出一个请求", got.length, 1);
  check("F2 打在 /api/diag", got[0] && got[0].url, "/api/diag");
  check("F3 用的是 GET", String((got[0] && got[0].opts.method) || "GET").toUpperCase(), "GET");
  checkTrue("F4 回出区域与部署版本", /region=sfo1/.test(text) && /git_sha=7389e06/.test(text));
  checkTrue("F5 两个上游都列出", text.includes("国内") && text.includes("海外"));
  checkTrue("F6 标出「平台解析正文」这一路成功", /重放 POST·平台 : ✓/.test(text));
  checkTrue("F7 国内这一路上游探测为成功", /上游 404 \/ 190ms/.test(text));
  checkTrue("F8 海外这一路失败原因可见（ETIMEDOUT）", text.includes("ETIMEDOUT"));

  /* ---------- G. 探测结果必须带 ok（页面靠它决定打 ✓ 还是 ✗） ----------
   * 这一条是真实部署上暴露出来的：dns 行显示 `✗ ?`，而 tls/http 全通 —— 解析明明是好的。
   * 原因是服务端的 `lookupAll` 两个分支都忘了带 `ok`，而页面只认 `o.ok` →
   * 「成功」被显示成「失败」，一次完全正常的运行被报成了故障。 */
  const dnsMod = require("dns");
  const realLookup = dnsMod.lookup;
  const dnsCases = [
    {
      name: "G1 解析成功",
      err: null,
      addrs: [{ address: "54.223.162.2", family: 4 }],
      ok: true,
      contains: "54.223.162.2 (IPv4)",
    },
    {
      name: "G2 解析失败且有 code",
      err: Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }),
      addrs: null,
      ok: false,
      contains: "ENOTFOUND",
    },
    {
      // 空 message、无 code —— 页面上会退化成「?」的那种，必须回落到 name，不能留空
      name: "G3 解析失败且无 code/message",
      err: new Error(""),
      addrs: null,
      ok: false,
      contains: "Error",
    },
  ];
  // 记 FAIL 而不是让 TypeError 终止套件：否则「少了导出」会连带吞掉后面 H/I 两组的结论
  if (typeof handler.lookupAll !== "function") {
    results.push("FAIL  G0 lookupAll 未导出 —— 探测结果的 ok 字段无法被验证（页面会把它显示成 ✗）");
  } else {
    for (const c of dnsCases) {
      dnsMod.lookup = (host, opts, cb) => cb(c.err, c.addrs);
      const r = await handler.lookupAll("example.test");
      checkTrue(`${c.name} → ok 字段是布尔值`, typeof r.ok === "boolean");
      check(`${c.name} → ok 的值`, r.ok, c.ok);
      checkTrue(`${c.name} → 结果里带上了「${c.contains}」`, JSON.stringify(r).includes(c.contains));
    }
    dnsMod.lookup = realLookup;
  }

  /* ---------- H. dns 行的两种状态在页面上都要显示对 ---------- */
  const mkSummary = (dns) => ({
    status: 200,
    marker: "1",
    body: "",
    json: {
      region: "sfo1",
      env: "production",
      git_sha: "f7a2d88",
      node: "v22.23.2",
      upstreams: [
        {
          label: "国内",
          host: "api.prod.deepaffex.cn",
          dns,
          tls: { ok: true, ms: 475, protocol: "TLSv1.3" },
          http: { ok: true, status: 404, ms: 596 },
          replay: { relayed: true, status: 404, decided: "none" },
          replay_post: {
            platform: { relayed: true, status: 404, decided: "platform" },
            stream: { relayed: true, status: 404, decided: "stream" },
          },
        },
      ],
    },
  });

  responder = () => mkSummary({ ok: true, addresses: ["54.223.162.2 (IPv4)"] });
  await press("b4");
  checkTrue("H1 解析成功显示 ✓（而不是 ✗ ?）", /dns  : ✓ 1 个地址/.test(getEl("out").textContent));

  responder = () => mkSummary({ ok: false, error: "EAI_AGAIN", code: "EAI_AGAIN" });
  await press("b4");
  const dnsFailText = getEl("out").textContent;
  checkTrue("H2 解析失败时给出原因", /dns  : ✗ EAI_AGAIN/.test(dnsFailText));
  checkTrue("H3 并说明 tls 已通、这不是故障", dnsFailText.includes("解析实际是好的"));

  /* ---------- J. 第 5 个按钮：抖动率的三种结论必须说对 ----------
   * 这一屏是「偶发」与「稳定不通」的唯一判据来源，把两者说反等于误诊 ——
   * 用户据此决定「再试一次」还是「换部署」，方向相反。 */
  const mkFlaky = (attempts) => {
    const ok = attempts.filter((a) => a.ok).length;
    return {
      status: 200,
      marker: "1",
      body: "",
      json: {
        region: "sfo1",
        git_sha: "cd45fa0abcdef",
        hosts: [
          {
            host: "api.prod.deepaffex.cn",
            tries: attempts.length,
            timeout_ms: 3000,
            attempts,
            ok_count: ok,
            fail_count: attempts.length - ok,
            elapsed_ms: 400,
          },
        ],
      },
    };
  };
  const okA = (ms) => ({ ok: true, ms });
  const failA = (error) => ({ ok: false, ms: 3000, error, code: error });

  responder = () => mkFlaky([okA(82), okA(79), okA(85), okA(84)]);
  got = await press("b5");
  check("J1 只发出一个请求", got.length, 1);
  check("J2 打在 /api/diag?flaky=1", got[0] && got[0].url, "/api/diag?flaky=1");
  check("J3 用的是 GET", String((got[0] && got[0].opts.method) || "GET").toUpperCase(), "GET");
  checkTrue("J4 全通时结论是「偶发」而不是「不通」", /✓ 4\/4 全通/.test(getEl("out").textContent));
  checkTrue("J5 逐次结果都列了出来（含耗时）", /1\.✓ 82ms/.test(getEl("out").textContent));

  responder = () => mkFlaky([failA("ETIMEDOUT"), failA("ETIMEDOUT"), failA("ETIMEDOUT"), failA("ETIMEDOUT")]);
  await press("b5");
  const allFailText = getEl("out").textContent;
  checkTrue("J6 全失败时结论是「稳定不通」", /✗ 4\/4 全失败/.test(allFailText));
  checkTrue("J7 失败时给出错误码而不是空白", /1\.✗ ETIMEDOUT/.test(allFailText));

  responder = () => mkFlaky([okA(80), failA("ETIMEDOUT"), okA(83), failA("ECONNRESET")]);
  await press("b5");
  const mixedText = getEl("out").textContent;
  checkTrue("J8 时通时不通时结论是「在抖（偶发）」", /~ 2\/4 时而通时而不通/.test(mixedText));

  /* ---------- K. 抖动率探测的结构：每个 attempt 都必须带布尔 ok ----------
   * 与 G 组同一类缺陷 —— 页面按 `a.ok` 决定 ✓/✗，字段缺失会把失败画成成功、或反过来。
   * 打桩 net.connect（真连外网会让这个套件变慢且结果不可复现）。 */
  const netMod = require("net");
  const EventEmitter = require("events");
  const realConnect = netMod.connect;
  let sockBehavior = () => {};
  netMod.connect = (opts) => {
    const sock = new EventEmitter();
    sock.opts = opts;
    sock.destroy = () => {};
    // 异步触发：tcpProbe 是拿到 socket 之后才挂监听，同步 emit 会打在监听器注册之前
    setImmediate(() => sockBehavior(sock, opts));
    return sock;
  };

  // 与 G0 同理：缺导出要记 FAIL 而不是让 TypeError 终止套件 —— 否则后面的 L、I 组结论全被吞掉
  if (typeof handler.tcpProbe !== "function" || typeof handler.probeFlakiness !== "function") {
    results.push("FAIL  K0 tcpProbe / probeFlakiness 未导出 —— 抖动率探测的结构无法验证");
    netMod.connect = realConnect;
  } else {
  try {
    const probes = [
      { name: "K1 建连成功", behave: (s) => s.emit("connect"), ok: true, contains: "ms" },
      {
        name: "K2 建连被拒（ENETUNREACH）",
        behave: (s) => s.emit("error", Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" })),
        ok: false,
        contains: "ENETUNREACH",
      },
      { name: "K3 建连超时", behave: (s) => s.emit("timeout"), ok: false, contains: "ETIMEDOUT" },
    ];
    for (const p of probes) {
      sockBehavior = p.behave;
      const r = await handler.tcpProbe("api.example.test", 3000);
      checkTrue(`${p.name} → ok 是布尔值`, typeof r.ok === "boolean");
      check(`${p.name} → ok 的值`, r.ok, p.ok);
      checkTrue(`${p.name} → 结果里带上「${p.contains}」`, JSON.stringify(r).includes(p.contains));
    }

    // 连续 4 次里 3 通 1 断 —— 成功率必须如实算成 3/1，而不是按「最后一次」拍
    const seq = [(s) => s.emit("connect"), (s) => s.emit("timeout"), (s) => s.emit("connect"), (s) => s.emit("connect")];
    let i = 0;
    sockBehavior = (s) => seq[Math.min(i++, seq.length - 1)](s);
    const flaky = await handler.probeFlakiness("api.example.test", { tries: 4, timeoutMs: 3000 });
    check("K4 探测次数", flaky.attempts.length, 4);
    check("K5 成功次数", flaky.ok_count, 3);
    check("K6 失败次数", flaky.fail_count, 1);
    checkTrue("K7 每个 attempt 都带布尔 ok（页面靠它打 ✓/✗）", flaky.attempts.every((a) => typeof a.ok === "boolean"));
    checkTrue("K8 逐次顺序被保留（成功/失败交替不错位）", flaky.attempts.map((a) => (a.ok ? 1 : 0)).join("") === "1011");
  } finally {
    netMod.connect = realConnect;
  }
  }

  /* ---------- L. 请求入口信息：边缘区域解析与地址脱敏 ---------- */
  if (typeof handler.describeEntry !== "function" || typeof handler.maskIp !== "function") {
    results.push("FAIL  L0 describeEntry / maskIp 未导出 —— 请求入口信息无法验证");
  } else {
    check("L1 x-vercel-id 取第一段作边缘区域", handler.describeEntry({ "x-vercel-id": "hkg1::abc123::xyz" }).edge, "hkg1");
    check("L2 没有该头时为 null（不编造）", handler.describeEntry({}).edge, "null");
    check("L3 IPv4 脱敏保留前两段", handler.maskIp("203.0.113.45"), "203.0.x.x");
    check("L4 IPv6 脱敏保留前两组", handler.maskIp("2001:db8:1234::1"), "2001:db8::x");
    check("L5 没有地址时为 null", handler.maskIp(null), "null");
    check(
      "L6 多个 XFF 只取首个（代理链最左）",
      handler.describeEntry({ "x-forwarded-for": "203.0.113.45, 70.41.3.18" }).client_ip_masked,
      "203.0.x.x"
    );
  }

  /* ---------- I. 自检：桩是否真的被拦到（防「测了个寂寞」） ---------- */
  check("I1 九个按钮各拦到一次请求", calls.length, 9);

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
