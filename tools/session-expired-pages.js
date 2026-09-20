#!/usr/bin/env node
/**
 * 「token 过期 → 点确定回登录页」多页面复现（真实 Chrome + 真实接口）。
 *
 * 列表页首屏链路已由 tools/session-expired-repro.js 验证通过。
 * 这里补测另外两个会发请求的页面：组织账单详情、测量趋势。
 * 用构造的 OrgInfo / StudyResponse 起页，因此不需要真实登录，秒级出结论。
 * 账号只用于页面显示：BW_EMAIL 有则用，无则回落显然非真实的占位值。
 *
 * 用法：node server.js &  然后  node tools/session-expired-pages.js
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
const PORT = 9500 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails || {};
        this.errors.push(`[exception] ${d.text} :: ${(d.exception || {}).description || ""}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push(`[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400)}`);
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "se-pages-"));
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

/** 构造一个带一次测量的组织，并装入「坏 token + 错密码」的会话（= 无法自动续期） */
const SEED = `(function () {
  window.__errs = [];
  window.addEventListener("error", function (e) { window.__errs.push("error: " + e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    window.__errs.push("unhandledrejection: " + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)));
  });
  var region = 0;
  var key = "support" + Region.tag(region);
  var u = makeUser({
    key: key, orgName: "support", email: ${JSON.stringify(creds.email())},
    password: "WRONG-PASSWORD", region: region,
    deposits: 0, unitPrice: 1.0, billingDate: new Date(2026, 0, 14),
    token: "bogus-expired-token-for-test"
  });
  SharedUsers = [u];
  UserStorage.save([u]);
  AppState.list.orgs = [new OrgInfo({
    key: key, region: region, name: "support",
    successCount: 10, totalDeposits: 0, unitPrice: 1.0, periodSuccess: 5,
    billingDate: new Date(2026, 0, 14),
    startDate: new Date(2025, 0, 1),
    endDate: new Date(),
    studies: [new StudyResponse({ ID: "study-1", Name: "Study 1", Measurements: 10 })]
  })];
  AppState.list.selectedOrgIndex = 0;
  AppState.list.billingPeriod = "全部";
  return { key: key, users: SharedUsers.length, orgs: AppState.list.orgs.length };
})()`;

const SNAP = `(function () {
  var root = document.getElementById("modal-root");
  var t = document.querySelector("#modal-root .modal-title");
  var m = document.querySelector("#modal-root .modal-message");
  return {
    page: AppState.currentPage,
    modalShown: root.classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: m ? m.textContent : null,
    modalButtons: Array.prototype.map.call(document.querySelectorAll("#modal-root .modal-btn"), function (b) { return b.textContent; }),
    loginActive: document.getElementById("page-login").classList.contains("active"),
    users: SharedUsers.length,
    hasSession: (function () { try { return !!localStorage.getItem("userList"); } catch (e) { return null; } })(),
    errors: window.__errs || []
  };
})()`;

const MODAL_SHOWN = `document.getElementById("modal-root").classList.contains("show")`;

/** 每个页面的触发脚本：进入该页并发起一次真实请求 */
const TRIGGERS = {
  "列表页（点刷新）": `(function () { Router.go("list"); ListPage.performFilter("all"); return "list"; })()`,
  "详情页（刷新研究表）": `(function () { DetailPage.open(); DetailPage.updateStudies(); return "detail"; })()`,
  "趋势页（进入页面）": `(function () { Router.go("trend"); return "trend"; })()`,
};

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

  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  console.log("应用已就绪\n");

  const results = [];
  for (const [name, trigger] of Object.entries(TRIGGERS)) {
    cdp.errors.length = 0;
    console.log("=".repeat(64));
    console.log(`场景：${name}`);
    console.log("=".repeat(64));
    try {
      await cdp.eval(SEED);
      await cdp.eval(trigger);
      await cdp.waitFor(MODAL_SHOWN, 45000, "弹出提示框");
      await sleep(300);
      let s = await cdp.eval(SNAP);
      console.log(`  弹框   : 「${s.modalTitle}」/「${s.modalMessage}」  按钮：${s.modalButtons.join(" / ")}`);
      console.log(`  当前页 : ${s.page}`);

      await cdp.eval(`document.querySelector("#modal-root .modal-btn").click()`);
      await sleep(700);
      s = await cdp.eval(SNAP);
      const ok = s.page === "login" && s.loginActive && !s.modalShown && !s.hasSession && s.users === 0;
      console.log(`  点确定后 → 当前页 ${s.page} | login active=${s.loginActive} | 弹框仍在=${s.modalShown} | 内存会话=${s.users} | 本地会话仍在=${s.hasSession}`);
      if (s.errors.length) console.log(`  页面内报错: ${JSON.stringify(s.errors)}`);
      console.log(`  结论：${ok ? "✔ 已返回登录页" : "✘ 未返回登录页 —— 复现成功"}`);
      results.push([name, ok]);
      if (!ok) break; // 已复现，不必再测
    } catch (e) {
      console.log(`  ✘ 场景执行失败：${e.message}`);
      if (cdp.errors.length) console.log(`  CDP 错误：${JSON.stringify(cdp.errors, null, 2)}`);
      results.push([name, false]);
    }
    console.log("");
  }

  console.log("\n================ 汇总 ================");
  results.forEach(([n, ok]) => console.log(`${ok ? "✔" : "✘"} ${n}`));
  // 必须显式退出：Chrome 子进程 / WebSocket 会挂住事件循环，输出会被管道缓冲
  process.exit(results.every(([, ok]) => ok) ? 0 : 1);
})().catch((e) => {
  console.error("诊断异常：", e.message);
  process.exit(1);
});
