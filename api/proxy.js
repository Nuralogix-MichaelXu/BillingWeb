/**
 * Vercel Serverless Function：接口中继 /__proxy?url=<接口地址>
 *
 * 与本地 server.js 共用 api/_lib/proxy.js，行为完全一致（URL/Query/Method/Header/Body 原样透传）。
 *
 * 部署要点（见仓库根的 vercel.json）：
 *   1. rewrites 把 /__proxy 指向本函数 —— 这样中继与页面同源，浏览器不发跨域预检，
 *      上游每个业务请求只看到 1 次（= iOS），海外接口的 5 请求/秒限流才不会被打爆；
 *   2. 函数区域选亚太（sin1/hkg1），否则请求绕美国一圈会明显变慢；
 *   3. maxDuration 30s，单个转发请求远用不到，只是给上游留余量。
 *
 * 自检（部署完成后直接在浏览器打开）：
 *   https://<部署域名>/__proxy?url=https%3A%2F%2Fapi.prod.deepaffex.cn
 *   返回接口的 JSON 报文即正常；返回 404 说明 rewrite 没生效。
 */
const { handleProxy, RELAY_HEADERS } = require("./_lib/proxy");

/** 单个转发请求的上游超时；必须小于 vercel.json 里给本函数配的 maxDuration */
const UPSTREAM_TIMEOUT_MS = 20000;

module.exports = function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...RELAY_HEADERS,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  let target = (req.query && req.query.url) || null;
  if (!target) {
    try {
      target = new URL(req.url, "http://localhost").searchParams.get("url");
    } catch (e) {
      target = null;
    }
  }
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("missing url");
    return;
  }

  handleProxy(req, res, String(target), { timeoutMs: UPSTREAM_TIMEOUT_MS });
};

/** 平台不要预先解析 body：中继需要把原始字节流原样透传给接口 */
module.exports.config = { api: { bodyParser: false } };
