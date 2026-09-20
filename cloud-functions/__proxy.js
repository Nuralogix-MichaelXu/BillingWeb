/**
 * EdgeOne Pages Node.js 函数：接口中继 /__proxy?url=<接口地址>
 *
 * 为什么需要这个文件：
 *   本项目的线上中继在 Vercel 上是「vercel.json 的 rewrite + api/proxy.js」，
 *   而 EdgeOne Pages **不读 vercel.json**，只认仓库根的 edgeone.json，
 *   并且 Node 函数必须放在 cloud-functions/ 目录下、按文件路径生成路由。
 *   所以 EdgeOne 侧需要这份等价实现，否则 /__proxy 返回 404（静态托管的 HTML 兜底页），
 *   前端 app/api.js 判定「中继不可用」→ 登录必然失败。
 *
 * 路由：cloud-functions/__proxy.js → https://<域名>/__proxy
 *   刻意让文件名直接等于路径，不走 rewrite —— 避免「rewrite 是否透传 query string」
 *   这个平台差异成为又一个故障点（query 里带着 url= 参数，丢了就整个失效）。
 *
 * 为什么不用 require 复用 api/_lib/proxy.js：
 *   本地（server.js）与 Vercel（api/proxy.js）共用的是 Node 的
 *   IncomingMessage / ServerResponse 经典 API；EdgeOne 函数拿到的是 Web 标准的
 *   Request / Response，需要一层适配器才能调那份实现。
 *   而 EdgeOne 的构建只保证打包 cloud-functions/ 目录，跨目录 require 有打包失败的风险，
 *   因此这里保持自包含。⚠️ 语义如需改动，必须同步下面这四处（含 api/_lib/proxy.js）：
 *     1. ALLOWED_HOST_PATTERNS  白名单（SSRF 防线，绝不能放宽）
 *     2. STRIP_HEADERS          不转发的头
 *     3. RELAY_HEADERS          中继标记头（前端据此判定响应确实来自中继）
 *     4. 错误形态：400 missing url / 400 invalid url / 400 unsupported protocol /
 *        403 target not allowed / 502 {"Code":"PROXY_ERROR"}
 *
 * 自检（部署完成后直接在浏览器打开，应与 Vercel 版行为一致）：
 *   https://<域名>/__proxy?url=https%3A%2F%2Fapi.prod.deepaffex.cn
 *   返回接口 JSON（且响应头带 X-Billing-Relay: 1）即正常；返回 404 说明函数没被路由到。
 */

/** 允许转发的上游域名白名单（国内 *.deepaffex.cn / 海外 *.deepaffex.ai） */
const ALLOWED_HOST_PATTERNS = [/(^|\.)deepaffex\.ai$/i, /(^|\.)deepaffex\.cn$/i];

/**
 * 不转发的头：
 *   · 逐跳头与中继自己决定的头（host / origin / referer / connection /
 *     content-length / accept-encoding）—— content-length 与 accept-encoding
 *     必须让 fetch 自己处理，否则会出现长度不符或响应体没被解压
 *   · 平台注入的转发头（x-forwarded-* / x-real-ip / forwarded / via / cf-* /
 *     x-eo-*）—— 剥掉才是与 iOS 直连一致的请求形态
 */
const STRIP_HEADERS = new Set([
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
]);

/**
 * 每个中继响应的标记头。
 * 客户端（app/api.js）据此判定「这条响应确实来自我们的中继」：
 *   有标记 → 上游什么状态码都是正常透传（上游自己的 404/500 页面也是 HTML，不能误判）；
 *   无标记 → 这个地址上根本不是我们的中继（平台错误页 / 静态托管 HTML 兜底页）
 *            → 按传输层失败换通道。
 */
const RELAY_HEADERS = {
  "X-Billing-Relay": "1",
  "Access-Control-Expose-Headers": "X-Billing-Relay",
};

/** 单个转发请求的上游超时；必须小于 edgeone.json 里给的 maxDuration(30s) */
const UPSTREAM_TIMEOUT_MS = 20000;

function isAllowedTarget(hostname) {
  return ALLOWED_HOST_PATTERNS.some((re) => re.test(String(hostname || "")));
}

function fail(status, message) {
  return new Response(message, {
    status,
    headers: {
      ...RELAY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** 兼容两种调用形态：context.request（文档形态）与直接传入 request */
function requestOf(context) {
  return (context && context.request) || context;
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...RELAY_HEADERS,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function onRequest(context) {
  const request = requestOf(context);
  const method = String(request.method || "GET").toUpperCase();

  if (method === "OPTIONS") return onRequestOptions();

  const target = new URL(request.url).searchParams.get("url");
  if (!target) return fail(400, "missing url");

  let upstream;
  try {
    upstream = new URL(target);
  } catch (e) {
    return fail(400, "invalid url");
  }
  if (upstream.protocol !== "https:" && upstream.protocol !== "http:") {
    return fail(400, "unsupported protocol");
  }
  if (!isAllowedTarget(upstream.hostname)) return fail(403, "target not allowed");

  const headers = {};
  for (const [k, v] of request.headers) {
    const key = k.toLowerCase();
    if (STRIP_HEADERS.has(key)) continue;
    if (key.startsWith("x-forwarded-") || key.startsWith("cf-") || key.startsWith("x-eo-")) continue;
    headers[key] = v;
  }
  headers["user-agent"] = request.headers.get("user-agent") || "BillingWeb/1.0";

  const hasBody = method !== "GET" && method !== "HEAD";
  let body;
  if (hasBody) {
    const buf = await request.arrayBuffer();
    if (buf.byteLength) body = buf;
  }

  try {
    const upstreamRes = await fetch(upstream.toString(), {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const buf = await upstreamRes.arrayBuffer();
    // HEAD 与 204/304 不允许带响应体；其余原样透传
    const out = method === "HEAD" || upstreamRes.status === 204 || upstreamRes.status === 304 ? null : buf;
    return new Response(out, {
      status: upstreamRes.status,
      headers: {
        ...RELAY_HEADERS,
        "Content-Type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    // fetch 失败时 err.message 只有干巴巴的 "fetch failed"，真实原因在 err.cause 里
    // （ENOTFOUND / ETIMEDOUT / ECONNRESET / 超时 AbortError）。
    // 这个 Message 是排查「中继能不能连上接口」的唯一线索，必须带上 cause。
    const cause = err && err.cause;
    const message =
      [cause && (cause.code || cause.message), err && err.message].filter(Boolean).join(" / ") ||
      "unknown error";
    return fail(502, JSON.stringify({ Code: "PROXY_ERROR", Message: message }));
  }
}
