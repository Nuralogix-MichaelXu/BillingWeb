/**
 * 接口中继核心：/__proxy?url=<encodeURIComponent(接口绝对地址)>
 *
 * 本地（server.js）与线上（Vercel 的 api/proxy.js）共用这一份实现，
 * 「URL / Query / Method / Header / Body 原样透传」的语义只有一处真值，
 * 避免线上与本地行为漂移。
 *
 * 为什么要中继：
 *   接口 https://api.prod.deepaffex.cn(国内) / https://api.as-east.deepaffex.ai(海外)
 *   不接受浏览器直连（跨域预检会让服务端请求量翻倍），而海外接口硬限制 5 请求/秒。
 *   中继让页面与其同源（本地 127.0.0.1:4173 / 线上同域 /__proxy），
 *   浏览器不发预检，上游每个业务请求只看到 1 次 —— 与 iOS 原生 URLSession 一致。
 *
 * 安全：部署到公网后中继必须只转发接口域名，否则就是一个开放代理（SSRF / 被白嫖）。
 */
const http = require("http");
const https = require("https");

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * 单次「TCP 建连」的上限（不含 TLS 与响应）。
 *
 * 为什么必须自己限：线上实测（Vercel 东京 → AWS 中国区）整条出口失联时，
 * 平台的建连上限约 **5.3s/地址**，而 Node 的 `internalConnectMultiple` 会把该域的
 * 3 个 A 记录**逐个**试完 ⇒ 单次失败就是 ~16s。那一次失败已经吃掉函数时限（30s）的一半，
 * 「再试一次」根本塞不下。把建连自己压到 CONNECT_TIMEOUT_MS 换来的正是重试的空间。
 *
 * 只限「建连」而不动既有的 `timeout`：后者管的是响应期空闲，正常的慢响应不能被误杀。
 */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * 一次中继最多尝试几次。仅当正文**可重放**时才 > 1（见 handleProxy 里的 replayable）。
 * 3 次是为了压住实测的失败率（12 并发里 5 个失败）：
 * 单次失败是「网络层静默丢包」，与请求内容无关，因此重试是有效的，而非撞同一堵墙。
 */
const MAX_ATTEMPTS = 3;

/**
 * 重试预算：超过它就不再开新的尝试。
 * 与 Vercel 的 30s 函数时限留出余量（20s + 最后一次建连 5s = 25s）。
 */
const RETRY_BUDGET_MS = 20000;

/**
 * 「重试有意义」的错误码 —— 都是**建连阶段**的网络抖动。
 * 注意不含任何 TLS/证书类错误：那类问题重试一百次也是同样的结果，
 * 重试只会白烧函数预算、把真实原因埋进噪音里。
 */
const TRANSIENT_CONNECT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
]);

/**
 * 这次失败值不值得重试。
 * · 已经连上、只是响应慢（`bwPhase === "response"`）→ 不重试：上游已经收到了请求，
 *   再发一次是加倍负载，且结果大概率相同。
 * · `AggregateError`（Node 的 ConnectMultiple）→ 只有**每个**地址都落在可重试码上才重试。
 */
function isTransientConnectError(e) {
  if (!e) return false;
  if (e.bwPhase === "response") return false;
  if (Array.isArray(e.errors) && e.errors.length) {
    // 严格：**每个**地址都必须落在可重试码上。只要有一个不是（例如证书错误、
    // 甚至压根没有 code），就说明这次失败不是单纯的抖动 → 不重试，宁可如实报错。
    return e.errors.every((x) => x && x.code && TRANSIENT_CONNECT_CODES.has(x.code));
  }
  return TRANSIENT_CONNECT_CODES.has(e.code);
}

/** 允许转发的上游域名白名单（国内 *.deepaffex.cn / 海外 *.deepaffex.ai） */
const ALLOWED_HOST_PATTERNS = [/(^|\.)deepaffex\.ai$/i, /(^|\.)deepaffex\.cn$/i];

function isAllowedTarget(hostname) {
  return ALLOWED_HOST_PATTERNS.some((re) => re.test(String(hostname || "")));
}

/**
 * 不转发的头。三类，各有各的理由：
 *
 * ① 逐跳头（hop-by-hop）—— 只对「客户端 ↔ 本进程」这一跳有意义，转发给上游是畸形请求：
 *      connection / keep-alive / transfer-encoding / te / trailer / upgrade /
 *      proxy-connection / proxy-authorization
 *    ⚠️ `transfer-encoding` 尤其致命：平台若按分块把正文交给函数，转发它等于告诉上游
 *      「正文是分块编码的」，而本中继又会另设 content-length —— 一个请求同时带这两个头
 *      协议不允许，上游通常直接断连。症状：**中继 502、Message 为空、只在平台环境出现、
 *      只有带正文的 POST 中招**（GET 没有正文，所以不受影响）。
 *
 * ② 代理自己决定的头：
 *      · content-length —— 按**实际会发出的字节数**重算（见 resolveBody）
 *      · origin / referer —— 剥掉才是与 iOS 直连一致的请求形态
 *      · accept-encoding —— 必须剥：剥掉上游才回未压缩正文，而本中继只透传 content-type、
 *        不透传 content-encoding，带着压缩体回给浏览器会变成乱码
 *
 * ③ 平台注入的转发头（x-forwarded-* / x-real-ip / forwarded / via / x-vercel-* / cf-*）
 */
const STRIP_HEADERS = [
  // ① 逐跳头
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
  // ② 代理决定
  "host",
  "origin",
  "referer",
  "content-length",
  "accept-encoding",
  // ③ 平台注入
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "via",
];

function filterHeaders(req, upstream) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const key = k.toLowerCase();
    if (STRIP_HEADERS.includes(key)) continue;
    if (key.startsWith("x-vercel-") || key.startsWith("cf-")) continue;
    headers[key] = v;
  }
  headers["host"] = upstream.host;
  headers["user-agent"] = (req.headers && req.headers["user-agent"]) || "BillingWeb/1.0";
  return headers;
}

/**
 * 平台把正文解析成对象后，原始字节流已被消费，不能再 pipe，只能重新序列化。
 * 返回 null 表示「平台没给出可用的正文」。
 *
 * ⚠️ 只有 `resolveBody()` 有权决定「要不要采信这份解析结果」——
 * 平台对**没有正文的 GET** 也常常给出 `req.body = {}`，直接采信会把它序列化成
 * 2 字节 `"{}"`，一个纯 GET 就被加上 `Content-Length: 2` 却没有任何正文发出去。
 */
function parsedBody(req) {
  const b = req && req.body;
  if (b === undefined || b === null) return null;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === "string") return Buffer.from(b, "utf8");
  if (typeof b === "object") return Buffer.from(JSON.stringify(b), "utf8");
  return Buffer.from(String(b), "utf8");
}

/** 平台的解析结果是不是「空正文」（`{}` / `[]` / `""` / 空 Buffer） */
function isParsedEmpty(b) {
  if (b === undefined || b === null) return true;
  if (typeof b === "string") return b.length === 0;
  if (Buffer.isBuffer(b)) return b.length === 0;
  if (Array.isArray(b)) return b.length === 0;
  if (typeof b === "object") return Object.keys(b).length === 0;
  return false;
}

/**
 * 入站流是否**已经被消费掉**（此时再 pipe 只会得到 0 字节）。
 * 只认「已消费」标志，**不看 `req.complete`** —— 后者表示「底层报文已收完」，
 * 本地 server.js 处理小请求时往往已经是 true，但正文仍好好躺在缓冲区里可读。
 */
function streamConsumed(req) {
  if (!req) return true;
  const st = req._readableState;
  if (req.readableEnded === true) return true;
  if (req.readable === false) return true;
  return !!(st && st.endEmitted);
}

/**
 * 这次转发的正文从哪来 —— 只此一处真值。四种来源：
 *
 *   platform  平台已解析出**真正文** → 用它，长度按重算值（平台上的 POST 属于这一支）
 *   stream    平台没给，但入站流仍可读 → 沿用浏览器声明的长度，逐字节转发
 *                                      （本地 server.js 的请求属于这一支）
 *   none      本请求没有正文 → 一个字节都不发，也不设 content-length
 *   lost      声明了正文，却既没有平台解析结果、流也已被消费
 *             → **正文已经不在我们手上**
 *
 * 「按头判断」正是上一版故障的成因：只看 `content-length` 存不存在就照抄一个长度、
 * 再去 pipe 一个已消费的流 —— 结果是「声明 N 字节、实际发 0 字节」，上游等到超时或断连，
 * 中继自己回 502 且 Message 为空。而 GET（无正文）恰好踩不到，所以现象极难归因。
 * 现在的判据是「**我手上到底有没有这些字节**」，不是「头里写了什么」。
 */
function resolveBody(req, method) {
  const hasBody = method !== "GET" && method !== "HEAD";
  const h = (req && req.headers) || {};
  const declaredLength = h["content-length"];
  const declared = Number(declaredLength);
  const declaresBody =
    hasBody && ((Number.isFinite(declared) && declared > 0) || h["transfer-encoding"] !== undefined);
  const consumed = streamConsumed(req);

  const parsed = parsedBody(req);
  // 平台给了**非空**正文 → 采信；平台给的是空正文时，只有本请求自己声明过正文才采信
  // （否则就是那个凭空多出来的 `Content-Length: 2`）
  if (parsed && (!isParsedEmpty(req && req.body) || declaresBody)) {
    return { source: "platform", buf: parsed, hasBody, declaredLength, declaresBody, consumed };
  }
  if (declaresBody && !consumed) {
    return { source: "stream", buf: null, hasBody, declaredLength, declaresBody, consumed };
  }
  if (declaresBody) {
    return { source: "lost", buf: null, hasBody, declaredLength, declaresBody, consumed };
  }
  return { source: "none", buf: null, hasBody, declaredLength, declaresBody, consumed };
}

/**
 * 每个中继响应的标记头。
 * 客户端（app/api.js）据此判定「这条响应确实来自我们的中继」：
 *   有标记 → 上游什么状态码都是正常透传（上游自己的 404/500 页面也是 HTML，不能误判）；
 *   无标记 → 这个地址上根本不是我们的中继（平台错误页 / 静态托管 HTML 兜底页 /
 *            端口被别的服务占了 / rewrite 没生效）→ 按传输层失败换通道。
 * Access-Control-Expose-Headers 必须带上：本机 Live Preview(:3000) → 中继(:4173)
 * 是跨源请求，不显式暴露的话 JS 读不到自定义响应头。
 */
const RELAY_HEADERS = {
  "X-Billing-Relay": "1",
  "Access-Control-Expose-Headers": "X-Billing-Relay",
};

function fail(res, status, message) {
  try {
    res.writeHead(status, {
      ...RELAY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(message);
  } catch (e) {
    /* 响应已开始，忽略 */
  }
}

/**
 * 把 /__proxy 请求透传到上游接口。
 * @param {import("http").IncomingMessage} req
 * @param {import("http").ServerResponse} res
 * @param {string} target 接口绝对地址
 * @param {{ timeoutMs?: number, connectTimeoutMs?: number, maxAttempts?: number, retryBudgetMs?: number }} [options]
 */
function handleProxy(req, res, target, options) {
  const opt = options || {};
  const timeoutMs = opt.timeoutMs || DEFAULT_TIMEOUT_MS;

  let upstream;
  try {
    upstream = new URL(target);
  } catch (e) {
    return fail(res, 400, "invalid url");
  }
  if (upstream.protocol !== "https:" && upstream.protocol !== "http:") {
    return fail(res, 400, "unsupported protocol");
  }
  if (!isAllowedTarget(upstream.hostname)) {
    return fail(res, 403, "target not allowed");
  }

  const method = (req.method || "GET").toUpperCase();
  const headers = filterHeaders(req, upstream);
  // 正文来源只由 resolveBody 决定（platform / stream / none / lost，见该函数注释）
  const body = resolveBody(req, method);

  // 正文声明了、却既没有平台解析结果、流也已被消费 —— 这时**绝不能**照抄一个长度再发空流，
  // 那正是「声明 N 字节、实际发 0 字节」的成因。直接把事实回出来，别让下一跳去猜。
  if (body.source === "lost") {
    return fail(
      res,
      502,
      JSON.stringify({
        Code: "PROXY_ERROR",
        Message: "request body unavailable",
        BodySource: body.source,
        PlatformBodyType: req.body === undefined ? "none" : typeof req.body,
        StreamConsumed: body.consumed,
        IncomingContentLength: body.declaredLength || null,
        IncomingTransferEncoding: (req.headers && req.headers["transfer-encoding"]) || null,
        Method: method,
        Upstream: upstream.host,
        Path: upstream.pathname + upstream.search,
      })
    );
  }

  // content-length 必须与**实际会发出的字节数**一致（不一致有两种：上游等一个永远不来的
  // 正文，或 Node 直接抛 CONTENT_LENGTH_MISMATCH —— 两种都表现为中继 502）
  if (body.source === "platform") {
    headers["content-length"] = String(body.buf.length);
  } else if (body.source === "stream") {
    // 原始流：沿用浏览器声明的长度（本机 server.js 路径）
    if (body.declaredLength !== undefined) headers["content-length"] = body.declaredLength;
  } else if (body.hasBody && Number(body.declaredLength) === 0) {
    // 有正文语义但长度就是 0（例如空 POST）：照实声明 0，别退化成 chunked
    headers["content-length"] = "0";
  }

  const transport = upstream.protocol === "https:" ? https : http;
  const port = upstream.port || (upstream.protocol === "https:" ? 443 : 80);

  // 正文能否**重放**，决定「这一次失败能不能再试一次」—— 这是重试的**前提条件**，不是可选优化：
  //   none     本请求就没有正文，重发即原样
  //   platform 平台已解析，本进程手里有完整 Buffer，可原样重发
  //   stream   正文已经 pipe 出去（只存在于本机 server.js 路径）→ 重试会发出**空正文**，
  //            那比失败更糟：上游会把它当成一次「没带口令的请求」，而不是一次「没发出去的请求」
  const replayable = body.source === "none" || body.source === "platform";
  // ⚠️ 「可重放」是**硬门禁**：即使调用方显式传了 maxAttempts，不可重放的正文也只能试一次。
  // 否则一次调用方的手误就会让「重试」变成「发一次空正文」——比不重试更糟。
  const requestedAttempts = Number(opt.maxAttempts) > 0 ? Number(opt.maxAttempts) : MAX_ATTEMPTS;
  const maxAttempts = replayable ? requestedAttempts : 1;
  const connectTimeoutMs =
    Number(opt.connectTimeoutMs) > 0 ? Number(opt.connectTimeoutMs) : CONNECT_TIMEOUT_MS;
  const retryBudgetMs = Number.isFinite(Number(opt.retryBudgetMs))
    ? Number(opt.retryBudgetMs)
    : RETRY_BUDGET_MS;

  const startedAt = Date.now();
  const attemptErrors = [];

  /** 单次尝试；失败且值得重试时会以 n+1 再进来一次。 */
  function attempt(n) {
    const proxyReq = transport.request(
      {
        method,
        hostname: upstream.hostname,
        port,
        path: upstream.pathname + upstream.search,
        headers,
        timeout: timeoutMs,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, {
          ...RELAY_HEADERS,
          "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        });
        // 上游响应**中途**出错时不要留成未捕获异常：serverless 里那会变成平台 500 错误页，
        // 反而丢掉「中继活着」的标记头，前端会误判成通道不可用。直接收尾即可。
        proxyRes.on("error", () => {
          try {
            res.end();
          } catch (e) {
            /* 忽略 */
          }
        });
        proxyRes.pipe(res);
      }
    );

    // 建连单独限时（理由见 CONNECT_TIMEOUT_MS 的注释）。复用到的连接已经连好，直接跳过。
    proxyReq.on("socket", (socket) => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => {
        proxyReq.destroy(
          Object.assign(new Error(`connect timeout after ${connectTimeoutMs}ms`), {
            code: "ETIMEDOUT",
            // 钉住「还没连上就放弃了」：重试判据靠它把「建连失败」与「响应太慢」分开
            bwPhase: "connect",
          })
        );
      }, connectTimeoutMs);
      socket.once("connect", () => clearTimeout(timer));
      proxyReq.once("close", () => clearTimeout(timer));
    });

    proxyReq.on("timeout", () =>
      proxyReq.destroy(
        Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT", bwPhase: "response" })
      )
    );

    proxyReq.on("error", (err) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch (e) {
          /* 忽略 */
        }
        return;
      }
      const e = err || {};
      attemptErrors.push({
        Attempt: n,
        ErrName: e.name,
        ErrCode: e.code,
        Phase: e.bwPhase || "connect",
        ElapsedMs: Date.now() - startedAt,
      });

      // 三个条件缺一不可：还没连上（已连上说明请求已到达上游）、正文可重放（否则会发空正文）、
      // 预算还够（否则会撞平台函数时限，那会变成没有标记头的平台错误页，前端反而判成「中继没了」）。
      if (n < maxAttempts && isTransientConnectError(e) && Date.now() - startedAt < retryBudgetMs) {
        attempt(n + 1);
        return;
      }

      // ⚠️ 只回 message 是不够的：底层的 `new Error()`（空 message）会让成因完全不可见。
      // 这里把错误对象的全部有效字段、本次请求的形态、以及 socket 复用情况一并回出。
      // 只回**头名**不回头值 —— Authorization / Cookie 的值绝不能出现在响应体里。
      fail(
        res,
        502,
        JSON.stringify({
          Code: "PROXY_ERROR",
          Message: e.message,
          ErrName: e.name,
          ErrCode: e.code,
          Errno: e.errno,
          Syscall: e.syscall,
          Addr: e.address,
          Port: e.port,
          // AggregateError（Node 的 ConnectMultiple）只说明「这些地址全都失败了」，
          // 看不出是「一个坏 IP」还是「整条出口不通」—— 两者的处置完全不同，
          // 所以把每个地址各自的结果单独回出来（地址 + 错误码，不含任何请求内容）。
          ConnectErrCount: Array.isArray(e.errors) ? e.errors.length : null,
          ConnectErrors: Array.isArray(e.errors)
            ? e.errors.map((x) => `${(x && x.address) || "?"}:${(x && (x.code || x.message)) || "?"}`)
            : null,
          // 重试了几次、每次各自的结论。只失败 1 次的 502 与「3 次全失败」的 502
          // 指向完全不同的处置：后者说明「再试一次」这条路走不通，必须换部署节点。
          Attempts: n,
          AttemptErrors: attemptErrors,
          Retried: n > 1,
          // 本次函数实例所在区域 —— 用来区分「部署的区域被改了」与「同一个区域里网络在抖」。
          // 502 体里没有它时，这两种情况从外部完全无法分辨。
          Region: process.env.VERCEL_REGION || null,
          TimeoutMs: timeoutMs,
          ConnectTimeoutMs: connectTimeoutMs,
          ElapsedMs: Date.now() - startedAt,
          Upstream: upstream.host,
          Method: method,
          Path: upstream.pathname + upstream.search,
          // 请求形态：用来判断是不是「凭空多了个 body」或「声明了却没发」
          BodySource: body.source,
          DeclaresBody: body.declaresBody,
          StreamConsumed: body.consumed,
          PlatformParsedBody: req.body === undefined ? "none" : typeof req.body,
          BufferedBody: !!body.buf,
          IncomingContentLength: body.declaredLength || null,
          IncomingTransferEncoding: (req.headers && req.headers["transfer-encoding"]) || null,
          SentContentLength: headers["content-length"] || null,
          SentHeaderNames: Object.keys(headers).sort().join(","),
          // socket 复用：serverless 进程被冻结/解冻后，连接池里的旧 socket 会变成死连接
          ReusedSocket: !!proxyReq.reusedSocket,
          FreeSockets: proxyReq.agent && proxyReq.agent.freeSockets
            ? Object.keys(proxyReq.agent.freeSockets).length
            : null,
          Stack: String(e.stack || "").split("\n").slice(0, 4).join(" | "),
        })
      );
    });

    if (body.source === "platform") {
      proxyReq.end(body.buf);
    } else if (body.source === "stream") {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  }

  attempt(1);
}

module.exports = {
  handleProxy,
  isAllowedTarget,
  resolveBody,
  streamConsumed,
  isTransientConnectError,
  RELAY_HEADERS,
  DEFAULT_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RETRY_BUDGET_MS,
  TRANSIENT_CONNECT_CODES,
};
