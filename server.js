#!/usr/bin/env node
/**
 * BillingWeb 本地服务：静态页面 + 接口中继
 *
 *   node server.js            # 默认 http://127.0.0.1:4173
 *   node server.js 8080       # 指定端口
 *
 * 为什么需要中继：
 *   iOS 端直连 https://api.prod.deepaffex.cn 与 https://api.as-east.deepaffex.ai，
 *   浏览器里直连会被跨域（CORS）拦截。中继只做传输层转发——
 *   请求的 URL、Query 参数、Method、Authorization 头、JSON Body 全部原样透传，
 *   因此接口行为与 iOS 端保持一致。
 *
 * 中继实现与线上（Vercel api/proxy.js）**共用** api/_lib/proxy.js，行为不许漂移。
 * 页面只要开着（本机任意端口、VS Code Live Preview 都行），中继优先；
 * 跨端口访问中继是允许的（见 app/api.js 的 _isLocalPage）。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { handleProxy, RELAY_HEADERS } = require("./api/_lib/proxy");

const PORT = Number(process.argv[2] || 4173);
const ROOT = path.join(__dirname, "app");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** 静态文件 */
function handleStatic(req, res, pathname) {
  let filePath = path.join(ROOT, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
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
  if (parsed.pathname === "/__proxy") {
    const target = parsed.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("missing url");
      return;
    }
    handleProxy(req, res, target);
    return;
  }
  handleStatic(req, res, decodeURIComponent(parsed.pathname));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`BillingWeb 已启动: http://127.0.0.1:${PORT}`);
  console.log(`接口中继: http://127.0.0.1:${PORT}/__proxy?url=<接口地址>`);
});
