#!/usr/bin/env node
/**
 * 海外（international）登录复现探针：
 * 真实 Chrome + 真实接口（无 mock），选「海外」→ 登录 → 等列表页数据加载，
 * 逐请求记录 URL / 状态码 / 失败原因，并抓取错误弹框文案。
 *
 * 用法：
 *   export BW_EMAIL='<账号邮箱>' BW_PASSWORD='<口令>'   # 不要写进代码
 *   node tools/overseas-login-probe.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const creds = require("./_creds");
creds.requireLive("overseas-login-probe"); // 缺凭据立刻报错，不拿占位账号去撞生产接口

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BW_BASE || "http://127.0.0.1:4173/";
const PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_FLAGS = [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars",
  "--window-size=1440,900",
];

/**
 * BW_HOST_MAP=<域名>：把这个域名解析到 127.0.0.1。
 * 用来在真机上模拟「线上部署」形态（页面 origin 是个真域名、不再是 127.0.0.1），
 * 从而验证 api.js 的部署分支：同源相对 /__proxy + 中继优先 + 404 优雅降级。
 * 例：BW_HOST_MAP=billing.example.com BW_BASE=http://billing.example.com:4173/app/index.html
 */
if (process.env.BW_HOST_MAP) {
  CHROME_FLAGS.push(`--host-resolver-rules=MAP ${process.env.BW_HOST_MAP} 127.0.0.1`);
}

const NET = [];
/** requestId -> url：loadingFailed 事件自身不带 URL，必须靠这张表归因，否则失败会被静默丢弃 */
const URL_BY_ID = new Map();

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Network.requestWillBeSent") {
        const p = msg.params;
        URL_BY_ID.set(p.requestId, p.request.url);
        NET.push({ kind: "req", url: p.request.url, method: p.request.method, id: p.requestId });
      }
      if (msg.method === "Network.responseReceived") {
        const p = msg.params;
        NET.push({ kind: "res", url: p.response.url, status: p.response.status, id: p.requestId });
      }
      if (msg.method === "Network.loadingFailed") {
        const p = msg.params;
        NET.push({ kind: "fail", id: p.requestId, url: URL_BY_ID.get(p.requestId) || "", error: p.errorText, blocked: p.blockedReason || "", canceled: !!p.canceled });
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails || {};
        this.errors.push(`[exception] ${d.text} :: ${(d.exception || {}).description || ""}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push(`[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 90000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  }
  async waitFor(expr, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await this.eval(expr)) return true; await sleep(150); }
    throw new Error(`等待超时：${label}`);
  }
  async click(sel) {
    const box = await this.eval(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`);
    if (!box) throw new Error(`找不到元素：${sel}`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on("error", reject);
  });
}

let CHROME_PROC = null;
process.on("exit", () => { try { CHROME_PROC && CHROME_PROC.kill(); } catch (e) {} });

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ov-probe-"));
  const chrome = spawn(CHROME, [...CHROME_FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  CHROME_PROC = chrome;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const page = Array.isArray(list) && list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  chrome.kill();
  throw new Error("Chrome CDP 未就绪");
}

const READY = `document.readyState !== "loading" && typeof Router !== "undefined" && typeof SharedUsers !== "undefined"`;

const SNAP = `(function () {
  var t = document.querySelector("#modal-root .modal-title");
  return {
    page: AppState.currentPage,
    modalShown: document.getElementById("modal-root").classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: (document.querySelector("#modal-root .modal-message") || {}).textContent || null,
    users: SharedUsers.map(function (u) { return { key: u.key, region: u.region, org: u.orgName, host: (typeof Region !== "undefined" ? Region.host(u.region) : null) }; }),
    refreshing: AppState.list.isRefreshing,
    orgs: AppState.list.orgs.length,
    err: AppState.list.loadError || null
  };
})()`;

(async function main() {
  const page = await launch();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败"))); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  console.log("应用就绪\n");

  // 传输层判定快照：把 api.js 的环境识别与候选通道直接打印出来，
  // 免得出问题时靠猜（本机 / 线上部署 / file:// 三条分支差异都在这行里）。
  try {
    const model = await cdp.eval(`(function () {
      var u = "https://api.prod.deepaffex.cn/organizations/auth";
      return {
        origin: location.origin,
        local: _isLocalPage(),
        deployed: _isDeployedPage(),
        relative: _useRelativeRelay(),
        relay: _relayLabel(),
        candidates: transportCandidates(u)
      };
    })()`);
    console.log("传输层判定：", JSON.stringify(model), "\n");
  } catch (e) {
    console.log("传输层判定：读取失败（旧版 api.js？）", e.message, "\n");
  }

  // BW_TRACE_PROGRESS=1：在页面里装一个 100ms 采样器，记录进度条的百分比/总量/已完成量，
  // 以及「假进度定时器是否还活着」。用来解释「进度条为什么卡在某个值」这类观感问题 ——
  // 光看代码只能猜是哪一段在停，采样能直接指出停住的时刻与原因。
  if (process.env.BW_TRACE_PROGRESS) {
    await cdp.eval(`(function () {
      if (window.__pt) return 1;
      window.__pt = [];
      window.__pt0 = Date.now();
      window.__ptTimer = setInterval(function () {
        try {
          var L = AppState.list;
          var pct = L.totalRequests > 0
            ? Math.trunc(Math.min(Math.max(L.completedRequests, 0), L.totalRequests) / L.totalRequests * 100)
            : null;
          window.__pt.push({
            t: Date.now() - window.__pt0,
            page: AppState.currentPage,
            refreshing: L.isRefreshing,
            total: Math.round(L.totalRequests * 1000) / 1000,
            done: Math.round(L.completedRequests * 1000) / 1000,
            pct: pct,
            bar: (document.getElementById("progress-text") || {}).textContent || null,
            timer: !!ListPage._progressTimer
          });
        } catch (e) { /* 还在登录页：AppState.list 尚未初始化 */ }
      }, 100);
      return 1;
    })()`);
    console.log("[0] 已开启进度条采样（BW_TRACE_PROGRESS）\n");
  }

  const REGION = process.env.BW_REGION === "0" ? "0" : "1"; // 0=国内 1=海外（默认）
  console.log(`[1] 填表 + 选「${REGION === "1" ? "海外" : "国内"}」`);
  await cdp.eval(`(function () {
    function set(id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }
    set("login-org", ${JSON.stringify(creds.ORG)});
    set("login-email", ${JSON.stringify(creds.email())});
    set("login-pwd", ${JSON.stringify(creds.password())});
    var tab = document.querySelector('#region-tabs .tab[data-region="${REGION}"]');
    tab.click();
    return { regionTab: tab.className, state: AppState.login.region };
  })()`);

  console.log("[2] 真实点击登录\n");
  // BW_PRESET_RATE=<n>：登录前把全局发送速率钉死在 n 请求/秒（并关掉自动回升），
  // 用于验证「压到限流线以下」能否救活直连模式。生产路径不受影响。
  if (process.env.BW_PRESET_RATE) {
    const r = Number(process.env.BW_PRESET_RATE);
    await cdp.eval(`(function(){ _throttle.rate = ${r}; _throttle.penalty = 3; _throttle.tokens = ${r}; _noteSuccess = function(){}; return _throttle.rate; })()`);
    console.log(`   [预设] 发送速率固定为 ${r} 请求/秒\n`);
  }
  await cdp.click("#login-btn");
  // 真实鼠标点击偶发被「字体加载引起的布局位移」吞掉（坐标在 press/release 之间被顶走），
  // 4 秒内没跳转且按钮还没进入 loading 就补一次程序化点击，
  // 避免把偶发的交互问题误判成接口/传输问题。
  try {
    await cdp.waitFor(`AppState.currentPage === "list"`, 4000, "点击生效");
  } catch (e) {
    const busy = await cdp.eval(`AppState.login.isLoading === true`);
    if (!busy) {
      console.log("   [重试] 真实点击未生效（按钮未进入 loading），补一次程序化点击\n");
      await cdp.eval(`(function(){ document.getElementById("login-btn").click(); return 1; })()`);
    }
  }
  await cdp.waitFor(`AppState.currentPage === "list"`, 60000, "登录进入列表页");
  // 海外接口限流 5 req/s，一次列表刷新要发几十个请求；客户端会自动降速重试，
  // 因此这里等「真正加载完成」，而不是固定 sleep。
  const t0 = Date.now();
  let loaded = false;
  try {
    // 加载完成、或提前弹出错误框（失败场景）都算「有结论了」，不必干等到超时
    await cdp.waitFor(
      `(AppState.list.isRefreshing === false && AppState.list.orgs.length > 0)
        || document.getElementById("modal-root").classList.contains("show")`,
      180000,
      "列表加载完成 / 弹出错误框"
    );
    loaded = await cdp.eval(`AppState.list.orgs.length > 0`);
  } catch (e) {
    /* 超时也继续输出快照，便于判断卡在哪 */
  }
  console.log(`[3] 列表加载${loaded ? "完成" : "未完成（超时）"}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const snap = await cdp.eval(SNAP);
  console.log("页面快照：", JSON.stringify(snap, null, 2));

  // 进度条采样分析：只打印「百分比 / 定时器生死 / 刷新态」发生变化的转折点，
  // 再补一段「停顿榜」——最能说明用户看到的「卡住」是哪一段、卡了多久、假进度是否已停。
  if (process.env.BW_TRACE_PROGRESS) {
    const trace = await cdp.eval("window.__pt || []");
    const rows = trace.filter((s) => s.page === "list" && s.refreshing);
    console.log("\n=== 进度条采样（100ms 一次，仅刷新期间）===");
    if (rows.length === 0) {
      console.log("  （没有采到刷新期间的样本）");
    } else {
      const marks = [];
      for (const s of rows) {
        const last = marks[marks.length - 1];
        if (!last || last.bar !== s.bar || last.timer !== s.timer) marks.push(s);
      }
      console.log("    时刻   进度  总量     已完成    假进度定时器");
      for (const s of marks) {
        console.log(
          `  ${String(s.t).padStart(6)}ms ${String(s.bar).padStart(5)} ${String(s.total).padStart(8)} ${String(s.done).padStart(9)}   ${s.timer ? "运行中" : "已停止"}`
        );
      }

      // 停顿榜：把「百分比一直没变」的连续区间按时长排序
      const stalls = [];
      let cur = null;
      for (const s of rows) {
        if (!cur || cur.bar !== s.bar || cur.timer !== s.timer) {
          if (cur) stalls.push(cur);
          cur = { bar: s.bar, timer: s.timer, from: s.t, to: s.t };
        } else cur.to = s.t;
      }
      if (cur) stalls.push(cur);
      stalls.forEach((s) => (s.ms = s.to - s.from));
      const top = stalls.slice().sort((a, b) => b.ms - a.ms).slice(0, 3);
      console.log("  停顿榜（百分比不变的连续区间，按时长）：");
      for (const s of top) {
        console.log(
          `    ${String(s.ms).padStart(6)}ms @ ${s.bar}（假进度定时器${s.timer ? "仍在跑" : "已停止"}）`
        );
      }

      // 假进度贡献 vs 真实回调贡献：定时器每 100ms 加 0.002*total，其余增量来自真实请求回调
      const aliveTicks = rows.filter((s) => s.timer).length;
      const fakeUnits = aliveTicks * 0.002 * (rows[rows.length - 1].total || 0);
      const last = rows[rows.length - 1];
      console.log(
        `  统计：刷新时长 ${last.t}ms ｜ 假进度定时器存活 ${aliveTicks * 100}ms，约贡献 ${fakeUnits.toFixed(1)}/${last.total}（${((fakeUnits / last.total) * 100).toFixed(0)}%）｜ 其余 ${(last.done - fakeUnits).toFixed(1)} 来自真实请求回调`
      );
    }
  }

  // 归并请求与响应/失败
  console.log("\n=== 业务请求时间线 ===");
  const byId = new Map();
  for (const e of NET) {
    if (!/deepaffex|__proxy/.test(e.url || "")) continue;
    const rec = byId.get(e.id) || { url: e.url, method: e.method, events: [] };
    if (e.kind === "req") { rec.url = e.url; rec.method = e.method; }
    rec.events.push(e.kind === "req" ? "sent" : e.kind === "res" ? `res:${e.status}` : `FAIL:${e.error}${e.blocked ? "/" + e.blocked : ""}`);
    byId.set(e.id, rec);
  }
  for (const [, rec] of byId) {
    const short = rec.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80);
    console.log(`  ${rec.method || "?"} ${short} -> ${rec.events.join(" ")}`);
  }
  if (cdp.errors.length) { console.log("\n=== 运行时错误 ==="); for (const e of cdp.errors) console.log("  " + e.slice(0, 300)); }

  process.exit(0);
})().catch((e) => {
  console.error("探针异常：", e.message);
  console.error("最近请求：", JSON.stringify(NET.slice(-10), null, 2));
  process.exit(1);
});
