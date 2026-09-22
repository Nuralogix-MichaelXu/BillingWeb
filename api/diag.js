/**
 * 诊断端点 /api/diag —— 只读，纯排查用
 *
 * 为什么需要它：`/__proxy` 的 502 有多种截然不同的成因，从外部无法区分：
 *   ① 部署根本没换（构建失败 / 推送的分支不是生产分支 → 域名仍指向旧部署）
 *   ② 区域换了，但平台的函数连不上上游（出口网络问题）
 *   ③ 出口能连上（diag 的 http 探测成功），但**中继那条代码路径**自己失败
 * 前两项分别用 region/git_sha 与 dns/tls/http 区分；第三项用 **replay** 区分 ——
 * 它直接调用真实的 `handleProxy`，与 /__proxy 走同一份代码、同一个运行时，
 * 区别只在于参数是这里给的。
 *
 * 三个入口：
 *   GET  /api/diag            → JSON：区域 / commit / 每个上游的 DNS+TLS+HTTP，
 *                               并用真实中继重放三次（GET、POST-平台解析、POST-原始流）
 *   POST /api/diag            → 回显**平台对这次 POST 正文的处理**（登录 POST 的同一条路）
 *   GET  /api/diag?form=1     → 自检页面：四个按钮跑完上面两项 + 真实 /__proxy 的 POST
 *                               （第 4 个按钮把 GET /api/diag 的三次重放压成可读汇总）
 *
 * ⚠️ 为什么要专门测 POST：这套系统里**只有登录是 POST**。GET 通不等于 POST 通 ——
 *    带正文的请求会多出「正文从哪来」这一层，而它恰好是最容易出错、现象最难归因的一层。
 *
 * 安全：只回 `VERCEL_*` 里的非敏感项（区域 / commit / 部署 id），不读任何自定义
 * 环境变量；回显正文时**只回键名与字节数、绝不回值**（正文里就是账号口令）；
 * `SentHeaderNames` 只回头名、不回头值。排查完可直接删除本文件，删掉不影响 /__proxy。
 */
const dns = require("dns");
const https = require("https");
const net = require("net");
const tls = require("tls");
const { handleProxy, resolveBody, streamConsumed } = require("../lib/proxy");

/** 两个上游：国内（AWS 中国区北京）与海外（AWS 东京） */
const UPSTREAMS = [
  { label: "国内", host: "api.prod.deepaffex.cn" },
  { label: "海外", host: "api.as-east.deepaffex.ai" },
];

/** 单个探测的超时；每个上游串行跑 dns→tls→http，之后三个重放并行，总耗时上限 ≈ 4 × 该值 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * 抖动率探测：连续几次、每次多长。
 * 正常建连实测 0.08–0.6s，所以单次 3s 已是很宽松的上限；超时即记「不可达」。
 * 次数 × 上限 = 最坏耗时，必须留在平台函数时限（Vercel 30s）以内 —— 4 × 3s = 12s。
 */
const FLAKY_TRIES = 4;
const FLAKY_TIMEOUT_MS = 3000;

/**
 * 重放用的假正文 —— **不含任何真实凭据**，长度也刻意贴近真实的登录请求体。
 * 它只需要证明「正文能完整到达上游」；上游回什么业务错误都无所谓（404/401 都算通）。
 */
const DUMMY_LOGIN_BODY = JSON.stringify({
  Email: "diag-no-reply@example.com",
  Password: "not-a-real-password",
  Identifier: "diag",
  TokenExpiresIn: 86400,
});

/**
 * DNS 解析探测。
 * ⚠️ 成功与失败都**必须显式带上 `ok`** —— 自检页面是靠 `ok` 决定打 ✓ 还是 ✗ 的；
 *    少写 `ok: true` 会让「解析成功」也显示成 `✗ ?`，把一次完全正常的运行报成故障。
 *    （2026-09-21 实际发生过：两个上游的 dns 行都是 `✗ ?`，而 tls/http 全通 ——
 *      解析显然是好的，是这一条探测在说谎。）
 */
function lookupAll(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) {
        return resolve({
          ok: false,
          // code 最有用（ENOTFOUND / EAI_AGAIN…）；都没有时也别留空，否则页面只能显示「?」
          error: err.code || err.message || err.name || String(err),
          code: err.code || null,
          name: err.name || null,
        });
      }
      resolve({ ok: true, addresses: addrs.map((a) => `${a.address} (IPv${a.family})`) });
    });
  });
}

/** 建 TLS 握手，只验证「能不能连上 + 握手多久」 */
function tlsProbe(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve(payload);
    };
    const sock = tls.connect(
      { host, port: 443, servername: host, timeout: PROBE_TIMEOUT_MS },
      () => {
        const ms = Date.now() - t0;
        const cert = sock.getPeerCertificate() || {};
        finish({ ok: true, ms, protocol: sock.getProtocol(), cert_valid_to: cert.valid_to || null });
        sock.destroy();
      }
    );
    sock.on("timeout", () => {
      finish({ ok: false, error: "ETIMEDOUT", ms: Date.now() - t0 });
      sock.destroy();
    });
    sock.on("error", (e) => finish({ ok: false, error: e.code || e.message, ms: Date.now() - t0 }));
  });
}

/** 发一个真实 GET /，拿 HTTP 状态码 —— 上游回 404 也算「打通」 */
function httpProbe(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve(payload);
    };
    const req = https.request(
      {
        host,
        port: 443,
        path: "/",
        method: "GET",
        timeout: PROBE_TIMEOUT_MS,
        headers: { "user-agent": "billingweb-diag", accept: "application/json" },
      },
      (res) => {
        const ms = Date.now() - t0;
        res.resume();
        res.on("end", () => finish({ ok: true, status: res.statusCode, ms }));
        res.on("error", (e) => finish({ ok: false, error: e.code || e.message, ms }));
      }
    );
    req.on("timeout", () => {
      finish({ ok: false, error: "ETIMEDOUT", ms: Date.now() - t0 });
      req.destroy();
    });
    req.on("error", (e) => finish({ ok: false, error: e.code || e.message, ms: Date.now() - t0 }));
    req.end();
  });
}

/**
 * 最小可用的 res 替身 —— 让 `handleProxy` 能原样跑完（含成功路径的 `proxyRes.pipe(res)`）。
 * 必需的成员就是 pipe 会用到的那几个：write / end / on / once / removeListener / emit。
 */
function fakeRes(onDone) {
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
      if (!state.finished) {
        state.finished = true;
        onDone(state);
      }
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
  };
  return self;
}

/**
 * 假入站请求 —— 用 `body` / `rawBody` / `consumed` 三件套精确摆出平台可能给出的形态。
 *   body     平台解析出的正文（undefined = 平台没解析）
 *   rawBody  原始字节（只有走 stream 分支时才会被 pipe 出去）
 *   consumed 入站流是否已被消费
 */
function fakeReq({ method, headers, body, rawBody, consumed }) {
  return {
    method,
    url: "/",
    headers,
    body,
    readableEnded: consumed === undefined ? false : !!consumed,
    pipe(dest) {
      if (rawBody === undefined || rawBody === null) dest.end();
      else dest.end(Buffer.from(rawBody));
      return dest;
    },
  };
}

/**
 * 用**真实的中继代码路径**重放一次请求，并回出中继自己选定的正文来源。
 * 与 /__proxy 的差别只有「url 与入站请求形态由这里指定」，代码与环境完全相同 ——
 * 所以它能把「上游特有」和「中继代码路径本身坏了」彻底分开。
 */
function replayRelay(target, shape) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const settle = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const req = fakeReq(shape);
    // 中继自己的决策，与它实际发出去的东西应当一一对应 —— 一并回出，省一次猜测
    const decided = resolveBody(req, req.method);
    const res = fakeRes((state) =>
      settle({
        decided: decided.source,
        declared_content_length: decided.declaredLength || null,
        stream_consumed: streamConsumed(req),
        status: state.statusCode,
        ms: Date.now() - t0,
        relayed: !!(state.headers && state.headers["X-Billing-Relay"]),
        body: Buffer.concat(state.chunks).toString("utf8").slice(0, 300),
      })
    );
    try {
      handleProxy(req, res, target, { timeoutMs: PROBE_TIMEOUT_MS });
    } catch (e) {
      settle({ decided: decided.source, status: null, ms: Date.now() - t0, error: `throw ${e.name}: ${e.message}` });
      return;
    }
    // 兜底：中继若既不回响应也不报错，这里给一个可读结论而不是把诊断卡死
    setTimeout(
      () => settle({ decided: decided.source, status: res.statusCode, ms: Date.now() - t0, error: "no response within timeout" }),
      PROBE_TIMEOUT_MS + 2000
    );
  });
}

/** 平台可能给出的两种带正文形态 —— 两种都必须能转发成功 */
function replayPostVariants(target, callerHeaders) {
  const mk = () => ({
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(DUMMY_LOGIN_BODY)),
    accept: "application/json",
    "user-agent": (callerHeaders && callerHeaders["user-agent"]) || "billingweb-diag",
  });
  return Promise.all([
    // ① 平台已解析正文：Vercel 上带正文的 POST 就是这一支（流已被消费，只能用它）
    replayRelay(target, {
      method: "POST",
      headers: mk(),
      body: JSON.parse(DUMMY_LOGIN_BODY),
      consumed: true,
    }),
    // ② 平台未解析、原始流可读：本机 server.js 就是这一支
    replayRelay(target, {
      method: "POST",
      headers: mk(),
      body: undefined,
      rawBody: DUMMY_LOGIN_BODY,
      consumed: false,
    }),
  ]).then(([platform, stream]) => ({ platform, stream }));
}

/** 平台对「这次 POST 的正文」做了什么 —— 登录 POST 走的就是这一条路 */
function describeIncomingPost(req, headers) {
  const method = (req.method || "POST").toUpperCase();
  const decided = resolveBody(req, method);
  const parsed = req.body;
  const verdict =
    decided.source === "platform"
      ? "✓ 平台解析出了正文，中继会用重算长度原样发出 → POST 应可正常转发"
      : decided.source === "stream"
        ? "✓ 平台未解析，但原始流可读 → 中继走流式转发"
        : decided.source === "none"
          ? "✗ 判定为「没有正文」—— 若你确实提交了正文，这就是故障点"
          : "✗ 正文已丢：声明了正文，但既没有平台解析结果、流也已被消费（登录 POST 502 的成因）";
  return {
    echo: "平台对本次 POST 正文的处理",
    method,
    content_length: headers["content-length"] || null,
    transfer_encoding: headers["transfer-encoding"] || null,
    // 只回类型 / 键名 / 字节数，绝不回正文内容（正文里就是账号口令）
    body_type: parsed === undefined ? "none" : Array.isArray(parsed) ? "array" : typeof parsed,
    body_is_empty:
      parsed === undefined ? null : Buffer.byteLength(typeof parsed === "string" ? parsed : JSON.stringify(parsed)) <= 2,
    body_keys: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [],
    body_bytes: parsed === undefined ? null : Buffer.byteLength(typeof parsed === "string" ? parsed : JSON.stringify(parsed)),
    stream_consumed: streamConsumed(req),
    resolve_body_source: decided.source,
    verdict,
  };
}

/**
 * 单次 TCP 建连探测 —— 直击线上 502 的失败环节。
 *
 * 线上那次的栈落在 `internalConnectMultiple`：连 TCP 都没建起来，**根本没走到 TLS**。
 * 所以「抖动率」只测 TCP 就够了，而且是三者里最快的（TLS/HTTP 由 `?form=1` 的第 4 个
 * 按钮覆盖）。返回里**必须**带布尔 `ok`（同 `lookupAll`，页面靠它决定打 ✓ 还是 ✗）。
 */
function tcpProbe(host, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      resolve(payload);
    };
    const sock = net.connect({ host, port: 443, timeout: timeoutMs });
    sock.on("connect", () => {
      const ms = Date.now() - t0;
      sock.destroy();
      finish({ ok: true, ms });
    });
    sock.on("timeout", () => {
      sock.destroy();
      // 与 https 探测一致地补上 code —— 页面只认 error/code/name 这条回退链
      finish({ ok: false, ms: Date.now() - t0, error: "ETIMEDOUT", code: "ETIMEDOUT" });
    });
    sock.on("error", (e) =>
      finish({ ok: false, ms: Date.now() - t0, error: e.code || e.message || e.name, code: e.code || null })
    );
  });
}

/**
 * 连续探测同一上游 N 次，用**成功率**回答「是不是不稳定」。
 *
 * 为什么必须连续多次：偶发抖动本来就会让**单次**探测通过或失败，一次的结果既不能证明
 * 「通了」也不能证明「坏了」。上一轮实测拿到的正是这种形态 —— 几分钟前 401 成功、
 * 几分钟后整段 ETIMEDOUT。只有连续 N 次的分布才能把「偶发」与「稳定不通」分开。
 *
 * ⚠️ 这一段量的是**部署出口 → 上游接口**，请求由函数自己发出、**不经过用户的浏览器**
 *   ⇒ 它的结果与「用户是否挂 VPN」无关。这正是它能拿来回答那个问题的原因：
 *   若这里全通而浏览器侧报错，故障就在浏览器那一跳（那里才轮得到 VPN 嫌疑）。
 */
async function probeFlakiness(host, options) {
  const opt = options || {};
  const tries = opt.tries || FLAKY_TRIES;
  const timeoutMs = opt.timeoutMs || FLAKY_TIMEOUT_MS;
  const startedAt = Date.now();
  const attempts = [];
  for (let i = 0; i < tries; i++) {
    // 串行：并发会因为抢带宽把「抖动」测成「拥塞」，那是另一种现象
    attempts.push(await tcpProbe(host, timeoutMs));
  }
  const okCount = attempts.filter((a) => a.ok).length;
  return {
    host,
    tries,
    timeout_ms: timeoutMs,
    attempts,
    ok_count: okCount,
    fail_count: attempts.length - okCount,
    elapsed_ms: Date.now() - startedAt,
  };
}

/**
 * 请求是从哪儿进来的 —— 用来观察用户那一跳，与「VPN 假设」直接相关。
 *   · edge：`x-vercel-id` 的第一段 = **接收本次请求的边缘区域**。若它不是 sfo1，
 *     说明请求绕了远路（挂 VPN 且出口在别处时会这样），但那只影响浏览器→边缘这一跳的延迟，
 *     **不影响函数连上游**（函数出口固定在部署区域）。
 *   · client_ip_masked：`x-forwarded-for` 的首个地址，**脱敏到前两段** ——
 *     够用户比对「这是不是我预期的出口」，又不必把完整地址贴到聊天里。
 */
function describeEntry(headers) {
  const rawId = headers["x-vercel-id"] || null;
  const xff = headers["x-forwarded-for"] ? String(headers["x-forwarded-for"]).split(",")[0].trim() : null;
  return {
    edge: rawId ? String(rawId).split("::")[0] || null : null,
    vercel_id: rawId,
    client_ip_masked: maskIp(xff),
  };
}

/** 只留前两段（IPv4 `1.2.x.x` / IPv6 `2001:db8::x`），保留「能否辨认」的能力而去掉完整地址 */
function maskIp(ip) {
  if (!ip) return null;
  if (ip.indexOf(":") >= 0) {
    const head = ip.split(":").filter(Boolean).slice(0, 2).join(":");
    return head ? head + "::x" : "x::x";
  }
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : "x.x.x.x";
}

/* ------------------------------------------------------------------ 自检页面 */
const CN_AUTH = "https://api.prod.deepaffex.cn/organizations/auth";
const AI_AUTH = "https://api.as-east.deepaffex.ai/organizations/auth";
const FORM_PAGE = [
  "<!doctype html>",
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>BillingWeb 中继自检</title>",
  "<style>",
  ":root{color-scheme:light dark}",
  'body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;margin:0;padding:24px;max-width:880px;color:#1a1c1e;background:#fff}',
  "h1{font-size:17px;margin:0 0 4px}",
  "p.sub{color:#5b6167;margin:0 0 18px}",
  "button{font:inherit;padding:9px 14px;margin:0 8px 8px 0;border-radius:8px;border:1px solid #c9ccd1;background:#f6f7f9;color:#1a1c1e;cursor:pointer}",
  "button:hover{background:#eceef1}button:disabled{opacity:.55;cursor:progress}",
  "pre{background:#0f1115;color:#e6e8eb;padding:14px;border-radius:8px;overflow:auto;max-height:62vh;white-space:pre-wrap;word-break:break-all;font-size:12px}",
  "@media (prefers-color-scheme:dark){body{background:#16181c;color:#e6e8eb}p.sub{color:#9aa0a6}button{background:#242830;border-color:#3a3f47;color:#e6e8eb}button:hover{background:#2d323b}}",
  "</style></head><body>",
  "<h1>BillingWeb 中继自检</h1>",
  '<p class="sub">按顺序点这三个按钮，结果贴在下面。第 2 个按钮就是登录走的同一条路（用假口令，预期回 401）。</p>',
  '<button id="b1">1. POST 到 /api/diag —— 看平台怎么处理正文</button>',
  '<button id="b2">2. POST 到 /__proxy 国内接口（登录的实际路径）</button>',
  '<button id="b3">3. POST 到 /__proxy 海外接口</button>',
  '<button id="b4">4. GET /api/diag —— 三次重放汇总（区域 / 部署版本 / 两个上游）</button>',
  '<button id="b5">5. 连续探测上游 —— 测抖动率（偶发 还是 稳定不通）</button>',
  '<pre id="out">（尚未运行）</pre>',
  "<script>",
  "var out=document.getElementById('out');",
  "function log(s){out.textContent=(out.textContent==='（尚未运行）'?'':out.textContent+'\\n\\n')+s;}",
  "var DUMMY={Email:'diag-no-reply@example.com',Password:'not-a-real-password',Identifier:'diag',TokenExpiresIn:86400};",
  "var CN_AUTH='" + CN_AUTH + "',AI_AUTH='" + AI_AUTH + "';",
  "async function run(btn,label,fn){btn.disabled=true;log(label+' …');",
  "  try{var s=await fn();log(label+'\\n'+s);}catch(e){log(label+'\\n✗ 请求本身失败：'+e.message);}",
  "  btn.disabled=false;}",
  "function ping(url){var o={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(DUMMY),cache:'no-store'};",
  "  return fetch(url,o).then(async function(r){var t=await r.text();",
  "    var marker=r.headers.get('x-billing-relay')?'有':'没有';",
  "    var v=r.status>=500?('✗ 中继自己回了 '+r.status+'（下面就是它给出的成因）'):",
  "      ((r.status===401||t.indexOf('INVALID_CREDENTIALS')>=0)?'✓ 中继链路是通的！上游回了 '+r.status+' INVALID_CREDENTIALS —— 假口令的预期结果，说明登录请求能完整到达接口':('? 上游回了 '+r.status+'（把原文发给我）'));",
  "    return v+'\\n中继标记 X-Billing-Relay：'+marker+'\\n状态码：'+r.status+'\\n响应体：\\n'+t.slice(0,1200);});}",
  "document.getElementById('b1').onclick=function(){run(this,'1. POST /api/diag',function(){return ping('/api/diag');});};",
  "document.getElementById('b2').onclick=function(){run(this,'2. POST /__proxy → 国内',function(){return ping('/__proxy?url='+encodeURIComponent(CN_AUTH));});};",
  "document.getElementById('b3').onclick=function(){run(this,'3. POST /__proxy → 海外',function(){return ping('/__proxy?url='+encodeURIComponent(AI_AUTH));});};",
  // 把 GET /api/diag 那一大坨 JSON 压成「一行一结论」，省得用户整段贴回来。
  // 写成具名函数（而不是塞进 onclick）：少一层嵌套，好读也好在测试里直接调。
  // ⚠️ flag() 只认 `o.ok`：任何探测结果**都必须**带这个布尔值，否则正常的成功也会显示成 ✗。
  "function flag(o,f){return (o&&o.ok)?('✓ '+f(o)):('✗ '+((o&&(o.error||o.code||o.name))||'未返回原因'));}",
  "function summary(){return fetch('/api/diag',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){",
  "  var L=['region='+d.region+'  env='+d.env+'  git_sha='+String(d.git_sha||'').slice(0,7)+'  node='+d.node];",
  "  if(d.entry&&d.entry.edge)L.push('请求入口：边缘节点 '+d.entry.edge+' ｜ 客户端地址 '+d.entry.client_ip_masked+'（脱敏）—— 边缘节点不是 sfo1 说明你那一跳绕了路，只影响打开页面的速度，不影响下面这些');",
  "  (d.upstreams||[]).forEach(function(u){",
  "    var g=u.replay||{}, pp=(u.replay_post||{}).platform||{}, st=(u.replay_post||{}).stream||{};",
  "    L.push('— '+u.label+'  '+u.host);",
  "    L.push('   dns  : '+flag(u.dns,function(o){return (o.addresses||[]).length+' 个地址';}));",
  "    if(!(u.dns&&u.dns.ok)&&u.tls&&u.tls.ok)L.push('          ↑ 但 tls 已握手成功 → 解析实际是好的，是这条探测本身不可用，别当故障');",
  "    L.push('   tls  : '+flag(u.tls,function(o){return o.ms+'ms '+o.protocol;}));",
  "    L.push('   http : '+flag(u.http,function(o){return '上游 '+o.status+' / '+o.ms+'ms';}));",
  "    L.push('   重放 GET       : '+(g.relayed?'✓':'✗')+' status='+g.status+'  正文来源='+g.decided+(g.error?'  ['+g.error+']':''));",
  "    L.push('   重放 POST·平台 : '+(pp.relayed?'✓':'✗')+' status='+pp.status+'  正文来源='+pp.decided+(pp.error?'  ['+pp.error+']':''));",
  "    L.push('   重放 POST·流式 : '+(st.relayed?'✓':'✗')+' status='+st.status+'  正文来源='+st.decided+(st.error?'  ['+st.error+']':''));",
  "  });",
  "  L.push('（重放 status=404 属正常：假地址查不到组织。关键是 relayed=true —— 带 X-Billing-Relay 标记说明中继转发成功）');",
  "  return L.join('\\n');});}",
  "document.getElementById('b4').onclick=function(){run(this,'4. GET /api/diag 汇总',summary);};",
  // 抖动率：把每个上游的逐次结果与成功率摊开。
  // ⚠️ 逐次结果同样只认 `a.ok` —— 与 flag() 是同一个坑：字段缺失会把「成功」画成 ✗。
  "function flakyVerdict(h){",
  "  if(h.fail_count===0)return '✓ '+h.ok_count+'/'+h.tries+' 全通 —— 此刻出口正常，先前的失败属偶发';",
  "  if(h.ok_count===0)return '✗ '+h.fail_count+'/'+h.tries+' 全失败 —— 出口此刻是稳定不通，不是偶发';",
  "  return '~ '+h.ok_count+'/'+h.tries+' 时而通时而不通 —— 出口确实在抖（偶发）';}",
  "function oneAttempt(a,i){return (i+1)+'.'+(a.ok?('✓ '+a.ms+'ms'):('✗ '+((a.error||a.code||a.name)||'失败')+' '+a.ms+'ms'));}",
  "function flaky(){return fetch('/api/diag?flaky=1',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){",
  "  var hs=d.hosts||[];",
  "  var L=['抖动率 · 每个上游连续探 '+(hs[0]?hs[0].tries:'?')+' 次（TCP 建连，单次上限 '+(hs[0]?hs[0].timeout_ms:'?')+'ms）',",
  "         'region='+d.region+'  git_sha='+String(d.git_sha||'').slice(0,7)];",
  "  hs.forEach(function(h){",
  "    L.push('— '+h.host+'   '+flakyVerdict(h)+'   合计 '+h.elapsed_ms+'ms');",
  "    L.push('   逐次：'+h.attempts.map(oneAttempt).join('   '));",
  "  });",
  "  L.push('（这一段由部署的函数自己发起，不经过你的浏览器 ⇒ 与是否挂 VPN 无关。');",
  "  L.push('  单次上限 '+(hs[0]?hs[0].timeout_ms:'?')+'ms，正常约 0.1–0.6s，超时即记失败。）');",
  "  return L.join('\\n');});}",
  "document.getElementById('b5').onclick=function(){run(this,'5. 抖动率',flaky);};",
  "</" + "script></body></html>",
].join("\n");

module.exports = async function handler(req, res) {
  const incomingHeaders = (req && req.headers) || {};
  const method = (req && req.method ? req.method : "GET").toUpperCase();
  let search = new URLSearchParams();
  try {
    search = new URL(req.url || "/api/diag", "http://localhost").searchParams;
  } catch (e) {
    /* 忽略，按无 query 处理 */
  }

  if (search.get("form") === "1") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(FORM_PAGE);
    return;
  }

  // 抖动率：连续探测两个上游 —— 回答「是不是不稳定」。单次结果没有信息量，必须连续。
  if (search.get("flaky") === "1") {
    // 上限 6 次：6 × 3s = 18s，仍在平台函数时限内；超过就失去「能拿到结论」的意义
    const asked = parseInt(search.get("tries") || "", 10);
    const tries = Math.min(Math.max(Number.isFinite(asked) ? asked : FLAKY_TRIES, 1), 6);
    const hosts = await Promise.all(UPSTREAMS.map((u) => probeFlakiness(u.host, { tries })));
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Billing-Relay": "1",
    });
    res.end(
      JSON.stringify(
        {
          note: "连续 TCP 建连探测：成功率回答「偶发抖动」还是「稳定不通」。这一段由函数自己发出，不经过浏览器 ⇒ 与用户是否挂 VPN 无关",
          now: new Date().toISOString(),
          region: process.env.VERCEL_REGION || null,
          git_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
          hosts,
        },
        null,
        2
      )
    );
    return;
  }

  // 带正文的 POST：回显平台的处理方式 —— 这是登录 POST 的同一条路
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Billing-Relay": "1",
    });
    res.end(JSON.stringify(describeIncomingPost(req, incomingHeaders), null, 2));
    return;
  }

  // 每个上游：dns → tls → http 串行（每一步都独立结论），三个重放并行（省时间）
  const rows = await Promise.all(
    UPSTREAMS.map(async (u) => {
      const base = `https://${u.host}`;
      const dnsResult = await lookupAll(u.host);
      const tlsResult = await tlsProbe(u.host);
      const httpResult = await httpProbe(u.host);
      const getReplay = await replayRelay(`${base}/`, {
        method: "GET",
        headers: incomingHeaders,
        body: undefined,
      });
      const postReplay = await replayPostVariants(`${base}/`, incomingHeaders);
      return {
        label: u.label,
        host: u.host,
        dns: dnsResult,
        tls: tlsResult,
        http: httpResult,
        // GET 重放：与浏览器直接打开 /__proxy 形态一致（带调用方的请求头）
        replay: getReplay,
        // POST 重放：登录的实际形态。platform 通 → 平台解析路径可用；stream 通 → 流式路径可用
        replay_post: postReplay,
      };
    })
  );

  const body = JSON.stringify(
    {
      note: "region/git_sha 区分「部署没换」；dns/tls/http 区分「出口连不上」；replay 区分「中继代码路径坏了」；replay_post 区分「只有带正文的请求坏」；entry 区分「你那一跳绕了远路」",
      now: new Date().toISOString(),
      // 请求入口：边缘节点 + 脱敏后的客户端地址 —— 用来把「用户那一跳的绕路」与「函数出口不通」分开
      entry: describeEntry(incomingHeaders),
      // 函数实际运行区域 —— 与 vercel.json 的 regions 是否生效直接对应
      region: process.env.VERCEL_REGION || null,
      env: process.env.VERCEL_ENV || null,
      // 部署版本 —— 用来确认这次改动到底有没有被构建
      git_ref: process.env.VERCEL_GIT_COMMIT_REF || null,
      git_sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
      deployment_id: process.env.VERCEL_DEPLOYMENT_ID || null,
      node: process.version,
      // 平台有没有预先消费掉请求正文 —— 决定 resolveBody 会选哪一支
      incoming: {
        method: req.method || null,
        content_length: incomingHeaders["content-length"] || null,
        transfer_encoding: incomingHeaders["transfer-encoding"] || null,
        // 只回类型与是否为空，绝不回正文内容（正文里有账号口令）
        body_type: req.body === undefined ? "none" : typeof req.body,
        body_is_empty: req.body === undefined ? null : Buffer.byteLength(JSON.stringify(req.body)) <= 2,
        stream_consumed: streamConsumed(req),
        header_names: Object.keys(incomingHeaders).sort().join(","),
      },
      upstreams: rows,
    },
    null,
    2
  );

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Billing-Relay": "1",
  });
  res.end(body);
};

/** 与 api/proxy.js 一致：不声明 bodyParser 开关，正文来源统一由 resolveBody 决定 */

/**
 * 供测试直接断言探测结果的结构（`ok` 必须存在）。
 * 正常路由不经过这里 —— 它只是把上面那个纯函数暴露出来，好让「少写 ok」这类
 * 只在**真实部署上**才看得见的缺陷，能在离线套件里被抓住。
 */
module.exports.lookupAll = lookupAll;

/**
 * 同上，供离线套件断言结构。`probeFlakiness` 的每个 attempt **必须**带布尔 `ok` ——
 * 页面靠它决定 ✓/✗，这条不变量与 `lookupAll` 完全一样（那里已经吃过一次亏）。
 */
module.exports.probeFlakiness = probeFlakiness;
module.exports.tcpProbe = tcpProbe;
module.exports.maskIp = maskIp;
module.exports.describeEntry = describeEntry;
