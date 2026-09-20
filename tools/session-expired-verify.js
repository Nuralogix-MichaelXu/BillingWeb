#!/usr/bin/env node
/**
 * 「token 过期 → 点确定回登录页」真机验证（Chrome Headless + CDP + 真实接口）。
 *
 * 离线套件（tests/session-expired.test.js）用的是桩数据，这里用**生产接口真的造出
 * token 失效**，验证端到端行为：
 *
 *   A. 负向对照：只把 token 换掉（密码仍正确）→ 应静默自动重新登录、不弹任何框、
 *      列表照常出数据（证明自动刷新链路没被这次改动破坏）。
 *      —— 顺带核对：本地存储里的 token 已被换成新 token。
 *   B. 正向验证：token 与密码一起换掉 → 接口返回 401 INVALID_TOKEN，自动重新登录
 *      又被 401 INVALID_CREDENTIALS 拒绝 → 应弹「登录已过期」；点确定后必须回到
 *      登录页、会话清空、弹窗关闭。
 *
 * 用法：
 *   export BW_EMAIL='<账号邮箱>' BW_PASSWORD='<口令>'   # 不要写进代码
 *   node server.js &                       # 先起本地服务（默认 4173）
 *   node tools/session-expired-verify.js --out-dir /tmp
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const creds = require("./_creds");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BW_BASE || "http://127.0.0.1:4173/";
creds.requireLive("session-expired-verify"); // 缺凭据立刻报错，不拿占位账号去撞生产接口
const EMAIL = creds.email();
const PWD = creds.password();
const ORG = creds.ORG;
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
  "--disable-lcd-text",
];

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const OUT_DIR = arg("out-dir", "/tmp");
const WIDTH = Number(arg("width", 1440));
const HEIGHT = Number(arg("height", 900));
const PORT = 9222 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.net = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Network.responseReceived") {
        const u = msg.params.response.url || "";
        if (u.includes("deepaffex")) this.net.push(`${msg.params.response.status} ${u.replace(/^https:\/\/[^/]+/, "").replace(/\?.*$/, "")}`);
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " :: " + (r.exceptionDetails.exception || {}).description);
    }
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }
  async waitFor(expr, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(expr)) return true;
      await sleep(150);
    }
    throw new Error(`等待超时：${label}（${expr}）`);
  }
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

let CHROME_PROC = null;
// 无论正常结束还是抛异常，都要回收 headless Chrome，否则会残留进程
process.on("exit", () => {
  try {
    CHROME_PROC && CHROME_PROC.kill();
  } catch (e) {}
});

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "se-verify-"));
  const chrome = spawn(
    CHROME,
    [...CHROME_FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  CHROME_PROC = chrome;
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const page = Array.isArray(list) && list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return { chrome, page };
    } catch {}
    await sleep(250);
  }
  chrome.kill();
  throw new Error("Chrome CDP 未就绪");
}

/* --------------------------------------------------------------- 页面脚本片段 */
const READY = `document.readyState !== "loading" && typeof AppState !== "undefined" && typeof ListPage !== "undefined"`;
const RELOAD_READY = `document.readyState === "complete" && typeof AppState !== "undefined"`;
/** 当前页 + 弹窗内容 + 本地存储会话状态 */
const STATE = `(function () {
  const root = document.getElementById("modal-root");
  const btn = document.querySelector("#modal-root .modal-btn");
  const t = document.querySelector("#modal-root .modal-title");
  const m = document.querySelector("#modal-root .modal-message");
  let tokens = null;
  try { tokens = (JSON.parse(localStorage.getItem("userList")) || []).map(function (u) { return u.token; }); } catch (e) {}
  return {
    page: AppState.currentPage,
    modalShown: root.classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: m ? m.textContent : null,
    modalButtons: Array.prototype.map.call(document.querySelectorAll("#modal-root .modal-btn"), function (b) { return b.textContent; }),
    tokens: tokens,
    hasSession: (function () { try { return !!localStorage.getItem("userList"); } catch (e) { return null; } })(),
    loginOrg: (document.getElementById("login-org") || {}).value,
    loginPwd: (document.getElementById("login-pwd") || {}).value,
    rows: document.querySelectorAll("#org-rows .table-row, #org-rows tr").length,
    pageLoginActive: document.getElementById("page-login").classList.contains("active"),
  };
})()`;

const LOGIN = `(function () {
  const set = function (id, v) {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set("login-org", ${JSON.stringify(ORG)});
  set("login-email", ${JSON.stringify(EMAIL)});
  set("login-pwd", ${JSON.stringify(PWD)});
  document.getElementById("login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  return "submitted";
})()`;

const TAMPER = (withPassword) => `(function () {
  const arr = JSON.parse(localStorage.getItem("userList"));
  arr[0].token = "bogus-expired-token-for-test";
  ${withPassword ? `arr[0].password = "WRONG-PASSWORD";` : ""}
  localStorage.setItem("userList", JSON.stringify(arr));
  return arr[0].token;
})()`;

/* ---------------------------------------------------------------------- 断言 */
let pass = 0;
const fails = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) pass++;
  else fails.push(`  ✘ ${label}: ${actual}  (期望 ${expected})`);
  return ok;
}

(async function main() {
  const { page } = await launch(); // Chrome 由 process.on("exit") 兜底回收
  const cdp = await connect(page);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  console.log("应用已就绪（真实 Chrome + 真实接口）");

  /* ---------- 0. 真实登录 ---------- */
  console.log("\n[0] 真实账号登录");
  await cdp.eval(LOGIN);
  try {
    await cdp.waitFor(`AppState.currentPage === "list"`, 90000, "登录进入列表页");
  } catch (e) {
    /* 自诊断：把屏上真实提示打出来 —— 最常见的是账号被接口限流
     * （429 TOO_MANY_LOGIN_ATTEMPTS），以前只会看到一句「等待超时」。 */
    const d = await cdp.eval(`(function () {
      var root = document.getElementById("modal-root");
      var t = root.querySelector(".modal-title"), m = root.querySelector(".modal-message");
      return { page: AppState.currentPage,
               title: t ? t.textContent : null,
               message: m ? m.textContent : null };
    })()`).catch(() => null);
    console.error(`登录未进入列表页：当前页=${d && d.page}`);
    console.error(`  屏上提示：「${(d && d.title) || "无"}」/「${(d && d.message) || "无"}」`);
    console.error("  若提示含 Too many login attempts → 账号被接口限流，稍后重跑即可（不是代码问题）");
    throw e;
  }
  await cdp.waitFor(`AppState.list.isRefreshing === false`, 180000, "列表首屏加载完成");
  await sleep(800);
  let s = await cdp.eval(STATE);
  check("0.1 登录后进入列表页", s.page, "list");
  check("0.2 列表已出数据", s.rows > 0, true);
  check("0.3 会话已持久化", s.hasSession, true);
  console.log(`      列表行数 = ${s.rows}`);

  /* ---------- A. 负向对照：只换 token → 静默自动重新登录 ---------- */
  console.log("\n[A] 负向对照：token 失效但密码正确 → 应静默刷新，不弹框");
  const oldToken = await cdp.eval(TAMPER(false));
  cdp.net.length = 0;
  await cdp.send("Page.reload");
  await cdp.waitFor(RELOAD_READY, 60000, "页面重载");
  await cdp.waitFor(`AppState.currentPage === "list"`, 60000, "回到列表页");
  await cdp.waitFor(`AppState.list.isRefreshing === false`, 180000, "重载后列表加载完成");
  await sleep(1200);
  s = await cdp.eval(STATE);
  check("A.1 未弹出任何提示框", s.modalShown, false);
  check("A.2 仍停留在列表页", s.page, "list");
  check("A.3 列表照常出数据（自动续期后重试成功）", s.rows > 0, true);
  check("A.4 本地 token 已被换成新 token", s.tokens && s.tokens[0] !== oldToken, true);
  const auth401 = cdp.net.filter((n) => n.includes("/organizations/auth"));
  console.log("      本轮接口要点：");
  [...new Set(cdp.net)].sort().forEach((n) => console.log("        " + n));
  check("A.5 确实发生过一次鉴权调用（自动重新登录）", auth401.length > 0, true);
  check("A.6 没有任何 4xx（token 已在服务端被换新）", cdp.net.some((n) => /^4/.test(n)), false);

  /* ---------- B. 正向：token + 密码都失效 → 弹框 → 点确定回登录页 ---------- */
  console.log("\n[B] token 与密码同时失效 → 应弹「登录已过期」，点确定回登录页");
  await cdp.eval(TAMPER(true));
  cdp.net.length = 0;
  await cdp.send("Page.reload");
  await cdp.waitFor(RELOAD_READY, 60000, "页面重载");
  await cdp.waitFor(`document.getElementById("modal-root").classList.contains("show")`, 120000, "弹出提示框");
  await sleep(500);
  s = await cdp.eval(STATE);
  check("B.1 弹框标题 = 登录已过期", s.modalTitle, "登录已过期");
  check("B.2 弹框正文 = 登录状态已失效，请重新登录", s.modalMessage, "登录状态已失效，请重新登录");
  check("B.3 只有一个按钮", s.modalButtons.join("/"), "确定");
  check("B.4 点确定前仍停在原页", s.page, "list");
  check("B.5 点确定前会话仍在（等用户确认）", s.hasSession, true);
  await cdp.shot(path.join(OUT_DIR, "session-expired-alert.png"));
  console.log("      已截图 session-expired-alert.png");

  const real401 = cdp.net.filter((n) => /^(401|403)/.test(n));
  console.log("      本轮 401/403：", JSON.stringify(real401));
  check("B.6 确实收到 401（真实 token 失效）", real401.length > 0, true);

  await cdp.eval(`document.querySelector("#modal-root .modal-btn").click()`);
  await sleep(600);
  s = await cdp.eval(STATE);
  check("B.7 点确定 → 回到登录页", s.page, "login");
  check("B.8 登录页已激活", s.pageLoginActive, true);
  check("B.9 弹窗已关闭", s.modalShown, false);
  check("B.10 会话已清空", s.hasSession, false);
  check("B.11 回登录页表单为空（不再预填账号）", s.loginOrg, "");
  check("B.12 回登录页强制清空密码", s.loginPwd, "");
  await cdp.shot(path.join(OUT_DIR, "session-expired-back-to-login.png"));
  console.log("      已截图 session-expired-back-to-login.png");

  /* ---------- C. 回到登录页后不应再有残留弹框 ---------- */
  console.log("\n[C] 回到登录页后的稳定性");
  await sleep(1500);
  s = await cdp.eval(STATE);
  check("C.1 没有残留弹框", s.modalShown, false);
  check("C.2 仍在登录页", s.page, "login");
  check("C.3 列表页已隐藏", await cdp.eval(`!document.getElementById("page-list").classList.contains("active")`), true);

  console.log(`\n真机验证：${pass}/${pass + fails.length}`);
  if (fails.length) {
    console.log(fails.join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error("验证异常：", e.message);
  process.exit(1);
});

/** 连接 CDP（Node 22 内置 WebSocket），返回已就绪的客户端 */
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")));
  });
  return new CDP(ws);
}
