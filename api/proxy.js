/**
 * Vercel Serverless Function：接口中继 /__proxy?url=<接口地址>
 *
 * 与本地 server.js 共用 lib/proxy.js，行为完全一致（URL/Query/Method/Header/Body 原样透传）。
 *
 * 部署要点（见仓库根的 vercel.json）：
 *   1. rewrites 把 /__proxy 指向本函数 —— 这样中继与页面同源，浏览器不发跨域预检，
 *      上游每个业务请求只看到 1 次（= iOS），海外接口的 5 请求/秒限流才不会被打爆；
 *   2. 函数区域必须选 **sfo1（旧金山）**，见 vercel.json。实测依据（2026-09-22）：
 *      hnd1（东京）→ AWS 中国区 cn-north-1 北京：connect timeout 5000ms × 3 次全失败
 *      （ETIMEDOUT），但海外接口 api.as-east.deepaffex.ai（AWS 东京）正常 ——
 *      表现为「国内账号登录失败、海外账号正常」。改用 sfo1 后两条跨太平洋航线
 *      （sfo1 → cn-north-1 / sfo1 → as-east）都通，不再有区域盲区。
 *      ⚠️ 不要选 sin1（新加坡）：它连不上国内接口。
 *   3. maxDuration 30s，单个转发请求远用不到，只是给上游留余量。
 *      ⚠️ 中继自身还有「建连上限 5s + 最多 3 次尝试 + 20s 重试预算」，
 *      最坏 ≈25s < 30s。要调这些值必须先把三者一起算一遍（见 lib/proxy.js 顶部）。
 *
 * 自检（部署完成后直接在浏览器打开）：
 *   https://<部署域名>/api/diag?form=1   ← 首选：一键跑完 dns/tls/http + 三次重放 + 抖动率
 *   https://<部署域名>/__proxy?url=https%3A%2F%2Fapi.prod.deepaffex.cn
 *   返回接口的 JSON 报文即正常；返回 404 说明 rewrite 没生效。
 */
const { handleProxy, RELAY_HEADERS } = require("../lib/proxy");

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

/**
 * ⚠️ 这里**刻意不再**声明 `config.api.bodyParser = false`。
 *
 * 原先的意图是「让中继拿到原始流、原样透传」，实测行不通：平台本来就会解析正文
 * （证据：平台对**没有正文的 GET** 也会塞一个 `req.body = {}`），而关掉 bodyParser
 * 并不能换来一个可读的原始流 —— 结果是带正文的请求两边都拿不到 body，
 * resolveBody 只能判定「正文已丢」，登录 POST 整体失败。
 *
 * 现在由 `lib/proxy.js` 的 `resolveBody()` 统一决定正文来源：
 *   平台给了解析结果 → 采信它（重算 content-length，逐字节发出去）
 *   没给、但流可读   → 走原始流（本机 server.js 就是这一支）
 * 两条路都不需要在这里声明任何平台开关。
 */
