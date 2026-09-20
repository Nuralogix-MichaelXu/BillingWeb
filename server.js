#!/usr/bin/env node
/**
 * BillingWeb 本地服务：静态页面 + 接口中继
 *
 *   node server.js                       # 默认绑 0.0.0.0:4173（本机 + 局域网都能访问）
 *   node server.js 8080                  # 指定端口
 *   BW_HOST=127.0.0.1 node server.js     # 只允许本机访问（关掉局域网暴露）
 *   BW_HOST=192.168.3.244 node server.js # 只绑指定网卡
 *
 * 局域网部署要点：
 *   · 必须绑 0.0.0.0（或具体网卡 IP）。绑 127.0.0.1 时局域网内其它机器一律连不上。
 *   · **前端无需任何改动**：局域网 IP 页面上 `_isLocalPage()` 为 false，前端把自己
 *     当成「部署页」→ 走同源相对路径 `/__proxy`，而它正好由本进程提供，链路自洽。
 *   · ⚠️ 反过来说：**不要把局域网 IP 加进 app/api.js 的 `_isLocalPage()`**。
 *     加了会让前端改用绝对地址 `RelayConfig.base`（`http://127.0.0.1:4173`），
 *     而局域网客户端的 127.0.0.1 指向它自己 → 中继立刻全灭。
 *   · HTTP 明文，本服务不做 TLS。而前端会把组织/账号/口令存进 localStorage 并在
 *     每次登录发出 → **只在可信内网部署，别放到能被人抓包的公共网络**。
 *   · 中继白名单见 api/_lib/proxy.js（仅 `*.deepaffex.cn` / `*.deepaffex.ai`），
 *     其它域名一律 403，不能拿它当开放代理。
 *   · 本进程**没有任何访问口令**：能连到这个端口的人就能打开整个计费系统。
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
const os = require("os");
const path = require("path");
const { URL } = require("url");
const { handleProxy, RELAY_HEADERS } = require("./api/_lib/proxy");

const PORT = Number(process.argv[2] || 4173);
/** 默认绑所有网卡，局域网才能访问；BW_HOST=127.0.0.1 可收回本机专属 */
const HOST = process.env.BW_HOST || "0.0.0.0";
const ROOT = path.join(__dirname, "app");

/** 本机所有非回环 IPv4 地址（用于启动时打印可分享的局域网地址） */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

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

/**
 * 兼容两种地址形态，避免「换个环境地址就 404」：
 *   · 本服务的静态根 = `app/`        → 页面地址是 `/` 或 `/index.html`
 *   · VS Code Live Preview 与线上部署（Vercel、EdgeOne）静态根 = 仓库根
 *                                    → 页面地址是 `/app/index.html`
 * 把 `/app` 前缀映射回根，同一个链接在三种环境下都能打开。
 *
 * ⚠️ 别名必须覆盖整个 `/app/*` 而不只是 index.html：页面内用的是相对路径
 * （`./model.js` / `./api.js` / `./app.js`），浏览器会解析成 `/app/xxx.js`。
 * 只放行 index.html 的话，页面能打开但脚本全 404 → 白屏。
 *
 * 注意：若将来 `app/` 下真的新建了名为 `app/` 的子目录，会被这个别名遮蔽。
 */
function stripAppPrefix(pathname) {
  if (pathname === "/app" || pathname === "/app/") return "/";
  if (pathname.startsWith("/app/")) return pathname.slice(4);
  return pathname;
}

/** 静态文件 */
function handleStatic(req, res, pathname) {
  const rel = stripAppPrefix(pathname);
  let filePath = path.join(ROOT, rel === "/" ? "index.html" : rel);
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

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`✗ 端口 ${PORT} 已被占用。换一个端口：node server.js 4174`);
  } else if (err && err.code === "EADDRNOTAVAIL") {
    console.error(`✗ 绑不上 ${HOST}：这个地址不属于本机。用 ifconfig / ipconfig 确认网卡 IP。`);
  } else {
    console.error("✗ 服务启动失败:", err && err.message);
  }
  process.exit(1);
});

// 收到停止信号时先关掉监听再退出，避免 pm2 / systemd 重启时端口没释放
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

server.listen(PORT, HOST, () => {
  const localOnly = HOST === "127.0.0.1" || HOST === "localhost";
  const addrs = localOnly ? [] : HOST === "0.0.0.0" || HOST === "::" ? lanAddresses() : [HOST];
  console.log("BillingWeb 已启动");
  console.log(`  监听端口: ${PORT}（绑定 ${HOST}）`);
  console.log(`  本机访问: http://127.0.0.1:${PORT}`);
  for (const ip of addrs) console.log(`  局域网访问: http://${ip}:${PORT}`);
  console.log(`  接口中继：与页面同源，即 <上面的地址>/__proxy?url=<接口地址>`);
  if (localOnly) {
    console.log("  ⚠️ 只绑定了回环地址 —— 局域网内其它机器连不上。");
    console.log("     要开放局域网：去掉 BW_HOST，或设 BW_HOST=0.0.0.0");
  } else {
    console.log("  ⚠️ 已对内网开放：无访问口令 + HTTP 明文，仅限可信内网使用。");
  }
});
