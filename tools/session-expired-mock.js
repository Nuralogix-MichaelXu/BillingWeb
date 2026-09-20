#!/usr/bin/env node
/**
 * 真机端到端验证（全 mock，不碰真实接口）：
 *   mock 接口令 token 过期 → 弹「登录已过期」→ **用真实鼠标点击「确定」** → 是否回到登录页。
 *
 * 为什么单独建这个脚本（与已有的几个不同）：
 *   · 请求全部由 CDP Fetch 域伪造，不依赖真实账号、不受接口限流影响，可反复快速跑；
 *   · 点击走 Input.dispatchMouseEvent（真实指针事件），而不是 el.click() ——
 *     这样才能暴露「按钮被遮挡 / 没绑上监听 / 坐标点不到」这类只在真实交互下才出现的问题；
 *   · 点击前后抓 Runtime.exceptionThrown 与 console.error ——
 *     如果「确定」的回调链抛异常，这就是「弹框关了但页面没动」的直接证据。
 *
 * 流程：真实登录（mock 成功）→ 进入列表页 → 切换 mock 为「token 失效」→
 *       点刷新 → 断言弹「登录已过期」→ 真实鼠标点「确定」→ 断言回到登录页且会话清空。
 *
 * 用法：node server.js &  然后  node tools/session-expired-mock.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BW_BASE || "http://127.0.0.1:4173/";
const VIEWPORT = { width: 1440, height: 900 };
const CHROME_FLAGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
];
const PORT = 9600 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================ mock 接口状态 */
/** "ok"：一切正常（登录成功、数据正常）；"expired"：token 失效且自动续期也失败 */
let PHASE = "ok";
/** 记录命中的接口，便于判断「点刷新到底有没有发出请求」 */
const HITS = [];

const json = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const CORS = [
  { name: "Content-Type", value: "application/json; charset=utf-8" },
  { name: "Access-Control-Allow-Origin", value: "*" },
  { name: "Access-Control-Expose-Headers", value: "*" },
  { name: "Cache-Control", value: "no-store" },
];
/**
 * 跨域 POST（Content-Type: application/json）会先发 OPTIONS 预检。
 * 预检不答好，浏览器会直接拦掉真正的请求、代码随后回退到本地中继 ——
 * 那样 mock 就不再是「直连接口」这条真实链路了，必须显式应答。
 */
const PREFLIGHT = [
  { name: "Access-Control-Allow-Origin", value: "*" },
  { name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
  { name: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
  { name: "Access-Control-Max-Age", value: "600" },
  { name: "Content-Length", value: "0" },
];

/**
 * mock 路由：只按接口语义造响应，不关心具体业务数据。
 *   /organizations/auth      POST，登录
 *   /licenses/organization   GET，许可证（列表页首屏）
 *   /studies                 GET，研究列表
 *   其它 GET                 → 空数组（这类接口都返回数组）
 */
function mockFor(url, method) {
  const short = url.replace(/^https?:\/\/[^/]+/, "");
  HITS.push({ url: short, method, phase: PHASE });
  if (method === "OPTIONS") return { preflight: true };

  const isAuth = url.includes("/organizations/auth");
  const isStudies = url.includes("/studies");
  const isMeasurements = url.includes("/organizations/measurements");

  if (PHASE === "ok") {
    if (isAuth) return { code: 200, body: { Token: "mock-token-ok" } };
    // 一条研究记录：列表页有数据后，点「刷新」才会走「逐研究拉测量」的真实编排
    // （orgs 非空时 requestData 复用研究清单、不重拉 /studies，与 iOS 一致）
    if (isStudies)
      return {
        code: 200,
        body: [{ ID: "study-1", Created: 1726500000, Name: "Demo Study", Description: "", StatusID: "COMPLETE", Measurements: 12 }],
      };
    if (isMeasurements) return { code: 200, body: [{ TotalCount: 5 }] };
    return { code: 200, body: [] };
  }
  // 失效阶段：业务接口 401 INVALID_TOKEN；自动重登录也被拒（凭据已不可用）
  // → 触发「会话无法续期」分支，页面应弹「登录已过期」并回登录页
  if (isAuth) return { code: 401, body: { Code: "INVALID_CREDENTIALS", Message: "Invalid credentials" } };
  return { code: 401, body: { Code: "INVALID_TOKEN", Message: "Invalid token" } };
}

/* ================================================================= CDP 封装 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    /** 回退到本地中继的次数：>0 说明直连被浏览器拦掉了，mock 没走在真实链路上 */
    this.relayFallbacks = 0;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.method === "Fetch.requestPaused") {
        const { requestId, request } = msg.params;
        const m = mockFor(request.url, request.method);
        if (request.url.includes("/__proxy")) this.relayFallbacks += 1;
        this.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: m.preflight ? 204 : m.code,
          responseHeaders: m.preflight ? PREFLIGHT : CORS,
          body: m.preflight ? "" : json(m.body),
        }).catch(() => {});
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails || {};
        this.errors.push(`[exception] ${d.text} :: ${(d.exception || {}).description || ""}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push(
          `[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400)}`
        );
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  }
  async waitFor(expr, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(expr)) return true;
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  }
  /** 真实鼠标点击：先探测落点，再派发移动/按下/抬起 */
  async click(sel) {
    const box = await this.eval(`(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: el.disabled === true };
    })()`);
    if (!box) throw new Error(`找不到元素：${sel}`);
    // 这一刻「谁在最上层」——若返回的不是按钮本身，说明点击被别的元素挡了
    const hit = await this.eval(`(function(){
      var el = document.elementFromPoint(${box.x}, ${box.y});
      return el ? (el.tagName + (el.id ? "#" + el.id : "") + (el.className ? "." + String(el.className).split(" ").join(".") : "")) : null;
    })()`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    return { box, hit };
  }
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/** 供异常兜底打印现场用 */
let LAST_CDP = null;

let CHROME_PROC = null;
process.on("exit", () => {
  try {
    CHROME_PROC && CHROME_PROC.kill();
  } catch (e) {}
});

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "se-mock-"));
  const chrome = spawn(CHROME, [...CHROME_FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
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

/* ==================================================================== 探针 */
const READY = `document.readyState !== "loading" && typeof Router !== "undefined" && typeof SharedUsers !== "undefined"`;
const MODAL_SHOWN = `document.getElementById("modal-root").classList.contains("show")`;

/** 页面快照：当前页 / 弹框 / 会话 / 登录页可见性 / 按钮落点 */
const SNAP = `(function () {
  var t = document.querySelector("#modal-root .modal-title");
  var btns = Array.prototype.slice.call(document.querySelectorAll("#modal-root .modal-btn"));
  var b0 = btns[0];
  var rect = b0 ? b0.getBoundingClientRect() : null;
  var cs = b0 ? getComputedStyle(b0) : null;
  var topEl = null;
  if (rect) {
    var e = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    topEl = e ? (e.tagName + (e.id ? "#" + e.id : "") + (e.className ? "." + String(e.className).split(" ").join(".") : "")) : null;
  }
  var lp = document.getElementById("page-login");
  return {
    page: AppState.currentPage,
    loginActive: lp.classList.contains("active"),
    loginVisible: lp.getBoundingClientRect().height > 0 && getComputedStyle(lp).display !== "none",
    modalShown: document.getElementById("modal-root").classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: (document.querySelector("#modal-root .modal-message") || {}).textContent || null,
    modalButtons: btns.map(function (b) { return b.textContent; }),
    confirmRect: rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    confirmStyle: cs ? { display: cs.display, visibility: cs.visibility, pointerEvents: cs.pointerEvents, opacity: cs.opacity } : null,
    topElementAtConfirm: topEl,
    users: SharedUsers.length,
    storage: (function () { try { return localStorage.getItem("userList"); } catch (e) { return "ERR"; } })(),
    currentPageActiveEl: (document.querySelector(".page.active") || {}).id || null
  };
})()`;

/** 覆盖表单为 mock 账号（登录页已不预填任何账号，这里显式填 mock 值） */
const FILL_LOGIN = `(function () {
  function set(id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }
  set("login-org", "support");
  set("login-email", "mock@example.com");
  set("login-pwd", "mock-password");
  return { org: AppState.login.orgName, email: AppState.login.email, pwd: AppState.login.password };
})()`;

const STATE = `({ page: AppState.currentPage, refreshing: AppState.list.isRefreshing, orgs: AppState.list.orgs.length, users: SharedUsers.length, token: (SharedUsers[0] || {}).token || null })`;

/* ===================================================================== 主流程 */
(async function main() {
  const page = await launch();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")));
  });
  const cdp = new CDP(ws);
  LAST_CDP = cdp;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // 只拦业务接口，页面资源（html/js/css）照常走本地服务
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*deepaffex*", requestStage: "Request" }] });

  const results = [];
  const check = (label, ok, detail = "") => {
    results.push([label, ok, detail]);
    console.log(`  ${ok ? "✔" : "✘"} ${label}${detail ? "  —— " + detail : ""}`);
  };

  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  // 兜底错误钩子：点击回调里抛出的异常若没被 CDP 捕获，这里还能留下证据
  await cdp.eval(`(function(){
    window.__bwErrors = [];
    window.addEventListener("error", function (e) { window.__bwErrors.push("error: " + e.message); });
    window.addEventListener("unhandledrejection", function (e) { window.__bwErrors.push("rejection: " + ((e.reason && (e.reason.message || e.reason)) || "?")); });
    return true;
  })()`);
  console.log("应用已就绪（业务接口全部走 mock，无真实请求）\n");

  /* ---------------------------------------------------------- [1] 正常登录 */
  console.log("[1] mock 正常接口 → 真实点击「登录」");
  await cdp.eval(FILL_LOGIN);
  const loginClick = await cdp.click("#login-btn");
  console.log(`    登录按钮落点 (${Math.round(loginClick.box.x)}, ${Math.round(loginClick.box.y)})，该点最上层元素：${loginClick.hit}`);
  await cdp.waitFor(`${STATE}.page === "list"`, 30000, "进入列表页");
  await cdp.waitFor(`${STATE}.refreshing === false`, 30000, "列表首屏加载完成");
  let st = await cdp.eval(STATE);
  console.log(`    当前页 ${st.page}｜组织数 ${st.orgs}｜会话 ${st.users} 个｜token=${st.token}`);
  console.log(`    请求全部直连 mock（回退中继次数 ${cdp.relayFallbacks}）`);
  check("mock 登录成功并进入列表页", st.page === "list" && st.token === "mock-token-ok", `token=${st.token}`);
  check("请求走直连 mock，未回退本地中继", cdp.relayFallbacks === 0, `relayFallbacks=${cdp.relayFallbacks}`);

  /* ------------------------------------------------- [2] token 失效 → 刷新 */
  console.log("\n[2] 切换 mock 为「token 失效」→ 真实点击「刷新」");
  await sleep(400); // 首屏彻底落定后再切换成失效，避免与首屏在途请求混淆
  PHASE = "expired";
  const refreshClick = await cdp.click("#refresh-btn");
  console.log(`    刷新按钮落点 (${Math.round(refreshClick.box.x)}, ${Math.round(refreshClick.box.y)})，该点最上层元素：${refreshClick.hit}`);
  await cdp.waitFor(MODAL_SHOWN, 30000, "弹出提示框");
  await sleep(400);
  let s = await cdp.eval(SNAP);
  console.log(`    触发请求：${HITS.slice(-4).map((h) => h.url).join(" , ")}`);
  console.log(`    弹框：标题「${s.modalTitle}」正文「${s.modalMessage}」按钮 ${JSON.stringify(s.modalButtons)}`);
  check("弹出「登录已过期」", s.modalTitle === "登录已过期", `标题=「${s.modalTitle}」`);
  check("弹框只有一个「确定」按钮", s.modalButtons.length === 1 && s.modalButtons[0] === "确定", JSON.stringify(s.modalButtons));

  /* ------------------------------------------------------ [3] 真实点「确定」 */
  console.log("\n[3] 用真实鼠标点击「确定」");
  console.log(`    按钮矩形中心 (${s.confirmRect.x}, ${s.confirmRect.y}) 尺寸 ${s.confirmRect.w}×${s.confirmRect.h}`);
  console.log(`    样式 ${JSON.stringify(s.confirmStyle)}`);
  console.log(`    该点最上层元素：${s.topElementAtConfirm}`);
  const errBefore = cdp.errors.length;
  const confirmClick = await cdp.click("#modal-root .modal-btn");
  await sleep(900);
  const errAfter = cdp.errors.slice(errBefore);

  s = await cdp.eval(SNAP);
  console.log(`\n    点后：currentPage=${s.page}｜.page.active=${s.currentPageActiveEl}｜login active=${s.loginActive} 可见=${s.loginVisible}`);
  console.log(`          弹框仍在=${s.modalShown}｜内存会话=${s.users}｜localStorage=${s.storage === null ? "已清空" : s.storage}`);
  check("点击时没有运行时异常", errAfter.length === 0, errAfter.join(" | ").slice(0, 300));
  check("回到登录页（currentPage=login）", s.page === "login", `currentPage=${s.page}`);
  check("登录页已激活且可见", s.loginActive && s.loginVisible);
  check("弹框已关闭", !s.modalShown);
  check("内存会话已清空", s.users === 0, `SharedUsers=${s.users}`);
  check("本地会话已清空", s.storage === null, `userList=${s.storage}`);

  /* --------------------------------------------------------- [4] 可重复使用 */
  console.log("\n[4] 再次登录 → 再次过期（确认弹框不会被前一次锁死）");
  // 回登录页后表单已被强制清空（需求：不预填账号 + 清空密码）→ 必须重新填表
  await cdp.eval(FILL_LOGIN);
  PHASE = "ok";
  await cdp.click("#login-btn");
  await cdp.waitFor(`${STATE}.page === "list"`, 30000, "第二次进入列表页");
  await cdp.waitFor(`${STATE}.refreshing === false`, 30000, "第二次首屏完成");
  await sleep(400); // 首屏彻底落定后再切换成失效，避免与首屏在途请求混淆
  PHASE = "expired";
  await cdp.click("#refresh-btn");
  await cdp.waitFor(MODAL_SHOWN, 30000, "第二次弹出提示框");
  await sleep(300);
  s = await cdp.eval(SNAP);
  const secondTitle = s.modalTitle;
  await cdp.click("#modal-root .modal-btn");
  await sleep(800);
  s = await cdp.eval(SNAP);
  check("第二次仍能弹「登录已过期」并回登录页", secondTitle === "登录已过期" && s.page === "login", `标题=「${secondTitle}」→ currentPage=${s.page}`);

  /* ------------------------------------------------------------------ 结论 */
  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n==================== 结果：${results.length - failed.length}/${results.length} 通过 ====================`);
  if (failed.length) {
    console.log("未通过项：");
    failed.forEach(([l, , d]) => console.log(`  ✘ ${l}${d ? "  —— " + d : ""}`));
    if (cdp.errors.length) console.log("\n运行期错误：\n" + cdp.errors.map((e) => "  " + e).join("\n"));
  }
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error("验证异常：", e.message);
  try {
    const s = await LAST_CDP.eval(SNAP);
    console.log("现场快照：", JSON.stringify(s, null, 2));
    console.log("登录页状态：", JSON.stringify(await LAST_CDP.eval(`(function(){return {page:AppState.currentPage, loading:AppState.login.isLoading, users:SharedUsers.length, lastErr:(window.__bwErrors||[]).slice(-3)}})()`), null, 2));
  } catch (e2) {}
  if (HITS.length) console.log("已命中的接口：", JSON.stringify(HITS.slice(-8), null, 2));
  if (LAST_CDP && LAST_CDP.errors.length) console.log("运行期错误：\n" + LAST_CDP.errors.map((x) => "  " + x).join("\n"));
  process.exit(1);
});
