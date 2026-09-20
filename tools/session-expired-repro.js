#!/usr/bin/env node
/**
 * 「token 过期 → 点确定回登录页」问题复现/诊断（真实 Chrome + 真实接口）。
 *
 * 与 session-expired-verify.js 的区别：
 *   · 跳过耗时的真实登录 + 首屏全量加载，直接注入「坏 token + 错密码」的会话，
 *     秒级进入「请求 401 → 自动重新登录被拒 → 弹『登录已过期』」状态；
 *   · 全程捕获运行时报错（window.onerror / unhandledrejection / console.error /
 *     CDP Runtime.exceptionThrown），用于判断「点确定」回调里是否抛异常中断了跳转。
 *
 * 用法：node server.js &  然后  node tools/session-expired-repro.js
 * 账号只用于页面显示：BW_EMAIL 有则用，无则回落显然非真实的占位值。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const creds = require("./_creds");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BW_BASE || "http://127.0.0.1:4173/";
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
];
const PORT = 9400 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.net = [];
    this.errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Network.responseReceived") {
        const u = msg.params.response.url || "";
        if (u.includes("deepaffex")) this.net.push(`${msg.params.response.status} ${u.replace(/^https:\/\/[^/]+/, "").replace(/\?.*$/, "")}`);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails || {};
        this.errors.push(`[exceptionThrown] ${d.text} :: ${(d.exception || {}).description || ""}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
        this.errors.push(`[console.${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
      }
      if (msg.method === "Log.entryAdded") {
        const e = msg.params.entry;
        if (e.level === "error") this.errors.push(`[log] ${e.text}`);
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
      await sleep(150);
    }
    throw new Error(`等待超时：${label}`);
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

let CHROME_PROC = null;
process.on("exit", () => {
  try {
    CHROME_PROC && CHROME_PROC.kill();
  } catch (e) {}
});

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "se-repro-"));
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

const READY = `document.readyState !== "loading" && typeof Router !== "undefined" && typeof SharedUsers !== "undefined"`;

/** 注入：坏 token + 错密码（= 无法自动续期的会话），并直接进列表页触发请求 */
const INJECT = `(function () {
  window.__errs = [];
  window.addEventListener("error", function (e) { window.__errs.push("error: " + e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    window.__errs.push("unhandledrejection: " + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)));
  });
  var region = 0;
  var u = makeUser({
    key: "support" + Region.tag(region), orgName: "support", email: ${JSON.stringify(creds.email())},
    password: "WRONG-PASSWORD", region: region,
    deposits: 0, unitPrice: 1.0, billingDate: "2026.01.14",
    token: "bogus-expired-token-for-test"
  });
  SharedUsers = [u];
  UserStorage.save([u]);
  Router.go("list");
  ListPage.onAppear();
  return { page: AppState.currentPage, users: SharedUsers.length };
})()`;

const SNAP = `(function () {
  var root = document.getElementById("modal-root");
  var t = document.querySelector("#modal-root .modal-title");
  var m = document.querySelector("#modal-root .modal-message");
  var btns = Array.prototype.map.call(document.querySelectorAll("#modal-root .modal-btn"), function (b) { return b.textContent; });
  var session = null;
  try { session = localStorage.getItem("userList"); } catch (e) {}
  return {
    page: AppState.currentPage,
    modalShown: root.classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: m ? m.textContent : null,
    modalButtons: btns,
    loginActive: document.getElementById("page-login").classList.contains("active"),
    listActive: document.getElementById("page-list").classList.contains("active"),
    users: SharedUsers.length,
    hasSession: !!session,
    errors: window.__errs || []
  };
})()`;

(async function main() {
  const page = await launch();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("WebSocket 连接失败")));
  });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Log.enable");

  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  console.log("应用已就绪");

  console.log("\n[1] 注入失效会话（坏 token + 错密码）并进入列表页");
  console.log("    ", JSON.stringify(await cdp.eval(INJECT)));

  await cdp.waitFor(`document.getElementById("modal-root").classList.contains("show")`, 60000, "弹出提示框");
  await sleep(400);
  let s = await cdp.eval(SNAP);
  console.log("\n[2] 弹框出现");
  console.log("    标题   :", s.modalTitle);
  console.log("    正文   :", s.modalMessage);
  console.log("    按钮   :", s.modalButtons.join(" / "));
  console.log("    当前页 :", s.page, "| list active =", s.listActive);
  console.log("    接口   :", JSON.stringify([...new Set(cdp.net)]));

  console.log("\n[3] 点击「确定」");
  await cdp.eval(`document.querySelector("#modal-root .modal-btn").click()`);
  await sleep(800);
  s = await cdp.eval(SNAP);
  console.log("    当前页       :", s.page);
  console.log("    login active :", s.loginActive, "| list active =", s.listActive);
  console.log("    弹框仍在显示 :", s.modalShown);
  console.log("    内存会话数量 :", s.users);
  console.log("    本地会话仍在 :", s.hasSession);
  console.log("    页面内报错   :", JSON.stringify(s.errors, null, 2));

  console.log("\n[4] CDP 捕获的运行时异常 / 控制台错误");
  console.log("   ", cdp.errors.length ? JSON.stringify(cdp.errors, null, 2) : "（无）");

  const ok = s.page === "login" && s.loginActive && !s.modalShown && !s.hasSession;
  console.log(`\n结论：${ok ? "✔ 已正确返回登录页" : "✘ 未返回登录页 —— 问题复现"}`);
  // 必须显式退出：Chrome 子进程 / WebSocket 会挂住事件循环
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("诊断异常：", e.message);
  process.exit(1);
});
