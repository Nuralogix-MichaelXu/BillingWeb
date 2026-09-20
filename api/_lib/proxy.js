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

/** 允许转发的上游域名白名单（国内 *.deepaffex.cn / 海外 *.deepaffex.ai） */
const ALLOWED_HOST_PATTERNS = [/(^|\.)deepaffex\.ai$/i, /(^|\.)deepaffex\.cn$/i];

function isAllowedTarget(hostname) {
  return ALLOWED_HOST_PATTERNS.some((re) => re.test(String(hostname || "")));
}

/**
 * 不转发的头：
 *   · 逐跳头与代理自己决定的头（host / origin / referer / connection / content-length / accept-encoding）
 *   · 平台注入的转发头（x-forwarded-* / x-vercel-* / cf-*）—— 剥掉才是与 iOS 直连一致的请求形态
 * 注意：content-length 由 handleProxy 按实际 body 重新决定。
 */
const STRIP_HEADERS = [
  "host",
  "origin",
  "referer",
  "connection",
  "content-length",
  "accept-encoding",
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
 * Vercel 的 Node 运行时可能已经把 body 解析成对象（除非显式关掉 bodyParser）。
 * 这时原始字节流已被消费，不能再 pipe，只能重新序列化。
 */
function parsedBody(req) {
  const b = req.body;
  if (b === undefined || b === null) return null;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === "string") return Buffer.from(b, "utf8");
  if (typeof b === "object") return Buffer.from(JSON.stringify(b), "utf8");
  return Buffer.from(String(b), "utf8");
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
 * @param {{ timeoutMs?: number }} [options]
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
  const buffered = parsedBody(req);
  const hasBody = method !== "GET" && method !== "HEAD";
  // 本地路径（body 还是原始流）沿用浏览器给的 content-length；线上路径（已被平台解析）用重算值
  if (hasBody && !buffered && req.headers && req.headers["content-length"] !== undefined) {
    headers["content-length"] = req.headers["content-length"];
  } else if (buffered) {
    headers["content-length"] = String(buffered.length);
  }

  const transport = upstream.protocol === "https:" ? https : http;
  const proxyReq = transport.request(
    {
      method,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
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
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("timeout", () => proxyReq.destroy(new Error("upstream timeout")));
  proxyReq.on("error", (err) => {
    if (res.headersSent) {
      try {
        res.end();
      } catch (e) {
        /* 忽略 */
      }
      return;
    }
    fail(res, 502, JSON.stringify({ Code: "PROXY_ERROR", Message: err.message }));
  });

  if (!hasBody) {
    proxyReq.end();
  } else if (buffered) {
    proxyReq.end(buffered);
  } else {
    req.pipe(proxyReq);
  }
}

module.exports = { handleProxy, isAllowedTarget, RELAY_HEADERS, DEFAULT_TIMEOUT_MS };
