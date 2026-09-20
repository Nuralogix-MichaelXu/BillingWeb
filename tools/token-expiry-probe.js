#!/usr/bin/env node
/**
 * 「token 过期 → 弹提示 → 点确定回登录页」真机验证（真实 Chrome + 真实生产接口）。
 *
 * 契约（2026-09-18 变更）：API 层**不做自动续期** —— token 一过期就直接抛「会话失效」，
 * 由页面弹「登录已过期」，点确定回登录页。因此：
 *   · 请求时间线里**绝不能出现 /organizations/auth**（旧版会静默重登、把用户留在原页）
 *   · 无论密码对错，过期都必须是「可见」的
 *
 * 两个阶段（都把内存 token 换成过期值，模拟「token 已过期」，再走页面自己的错误出口）：
 *   A. 过期 → 弹框 → 真实鼠标点确定 → 回登录页（顺带断言零续期请求）
 *   B. 第二次过期 → 仍能弹框并回登录页（验证弹框状态复位）
 *
 * 用法：node server.js（常驻）→ node tools/token-expiry-probe.js
 * 账号只用于页面显示（本版不做续期，密码对错都不影响结论）：
 * BW_EMAIL / BW_PASSWORD 有则用，无则回落显然非真实的占位值。
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
];
const PORT = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.net = []; // {id, method, url, status}
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails || {};
        this.errors.push(`[exception] ${d.text} :: ${(d.exception || {}).description || ""}`);
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        this.errors.push(`[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
      }
      if (msg.method === "Network.requestWillBeSent") {
        this.net.push({ id: msg.params.requestId, method: msg.params.request.method, url: msg.params.request.url, status: null });
      }
      if (msg.method === "Network.responseReceived") {
        const hit = this.net.find((n) => n.id === msg.params.requestId);
        if (hit) hit.status = msg.params.response.status;
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
      try {
        if (await this.eval(expr)) return true;
      } catch (e) {
        /* 页面尚未就绪，继续等 */
      }
      await sleep(150);
    }
    throw new Error(`等待超时：${label}`);
  }
  /** 只看业务接口调用，去掉 OPTIONS 预检与中继自身的噪声 */
  timeline(since = 0) {
    return this.net
      .slice(since)
      .filter((n) => n.method !== "OPTIONS")
      .map((n) => {
        let u = n.url;
        try {
          u = decodeURIComponent(u); // 本机页面走同源中继，真实接口地址藏在 url= 参数里
        } catch (e) {}
        const i = u.indexOf("https://api.");
        if (i >= 0) u = u.slice(i);
        const q = u.indexOf("?");
        if (q >= 0) u = u.slice(0, q);
        return `${n.method} ${u} → ${n.status}`;
      });
  }
  /** 时间线里是否出现过登录接口 */
  sawLogin(since = 0) {
    return this.net
      .slice(since)
      .some((n) => {
        try {
          return decodeURIComponent(n.url).includes("/organizations/auth");
        } catch (e) {
          return false;
        }
      });
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tok-expiry-"));
  const chrome = spawn(
    CHROME,
    [...CHROME_FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
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

/** 装入一个「token 已过期」的会话（本版不做续期，密码对错都不影响结论，用占位值即可） */
const seed = `(function () {
  window.__errs = [];
  window.addEventListener("error", function (e) { window.__errs.push("error: " + e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    window.__errs.push("unhandledrejection: " + ((e.reason && (e.reason.message)) || String(e.reason)));
  });
  var region = 0;
  var key = "support" + Region.tag(region);
  var u = makeUser({
    key: key, orgName: "support", email: ${JSON.stringify(creds.email())},
    password: ${JSON.stringify(creds.password())}, region: region,
    deposits: 0, unitPrice: 1.0, billingDate: new Date(2026, 0, 14),
    token: "expired-token-simulated"
  });
  SharedUsers = [u];
  UserStorage.save([u]);
  // 装一个组织，让详情页能发起真实请求（走页面自己的错误出口 showPageError）
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
  Router.go("list");
  return key;
})()`;

const SNAP = `(function () {
  var root = document.getElementById("modal-root");
  var t = document.querySelector("#modal-root .modal-title");
  var m = document.querySelector("#modal-root .modal-message");
  var u = SharedUsers[0];
  return {
    page: AppState.currentPage,
    modalShown: root.classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: m ? m.textContent : null,
    loginActive: document.getElementById("page-login").classList.contains("active"),
    users: SharedUsers.length,
    token: u ? u.token : null,
    storedToken: (function () {
      try { var l = JSON.parse(localStorage.getItem("userList") || "[]"); return l[0] ? l[0].token : null; } catch (e) { return null; }
    })(),
    loginPwd: document.getElementById("login-pwd").value,
    errors: window.__errs || []
  };
})()`;

const results = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`  ${ok ? "✔" : "✘"} ${name}${ok ? "" : `\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`}`);
};

/** 真实鼠标点击弹框里的「确定」 */
async function clickConfirm(cdp) {
  const box = await cdp.eval(`(function () {
    var b = document.querySelector("#modal-root .modal-btn");
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent };
  })()`);
  if (!box) throw new Error("弹框里找不到「确定」按钮");
  console.log(`  真实鼠标点击按钮「${box.text}」于 (${box.x}, ${box.y})`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  await sleep(900);
}

/** 一个完整回合：注入过期会话 → 页面链路请求 → 弹框 → 点确定 → 回登录页 */
async function round(cdp, tag, opts = {}) {
  const first = opts.first === true;
  cdp.errors.length = 0;
  await cdp.eval(seed);
  const mark = cdp.net.length;
  // 走真实页面链路：详情页刷新研究表，失败经页面 catch → showPageError 统一出口
  await cdp.eval(`(function () { DetailPage.open(); DetailPage.updateStudies(); return "detail"; })()`);
  await cdp.waitFor(`document.getElementById("modal-root").classList.contains("show")`, 45000, `${tag} 弹出「登录已过期」`);
  await sleep(300);
  console.log(`  ${tag} 请求时间线（真实命中生产接口）：`);
  cdp.timeline(mark).forEach((l) => console.log("    " + l));
  let s = await cdp.eval(SNAP);
  console.log(`  弹框：「${s.modalTitle}」/「${s.modalMessage}」\n`);

  check(`${tag}-1 过期后弹出提示`, s.modalShown, true);
  check(`${tag}-2 提示标题为「登录已过期」`, s.modalTitle, "登录已过期");
  check(`${tag}-3 正文为「登录状态已失效，请重新登录」`, s.modalMessage, "登录状态已失效，请重新登录");
  check(`${tag}-4 未自动续期（时间线无 /organizations/auth）`, cdp.sawLogin(mark), false);
  check(`${tag}-5 尚未离开当前页（等用户点确定）`, s.loginActive, false);
  check(`${tag}-6 token 未被改写`, s.token, "expired-token-simulated");

  await clickConfirm(cdp);
  s = await cdp.eval(SNAP);
  console.log(`  点确定后 → 当前页 ${s.page} | login active=${s.loginActive} | 弹框仍在=${s.modalShown} | 内存会话=${s.users}\n`);
  check(`${tag}-7 点确定后回到登录页`, s.page, "login");
  check(`${tag}-8 登录页已激活`, s.loginActive, true);
  check(`${tag}-9 弹框已关闭`, s.modalShown, false);
  check(`${tag}-10 会话已清空`, s.users, 0);
  check(`${tag}-11 本地存储已清空`, s.storedToken, null);
  check(`${tag}-12 密码已清空（不回填）`, s.loginPwd, "");
  check(`${tag}-13 页面内无运行时错误`, s.errors, []);
  if (first) console.log("  → 结论：过期不再被静默续期，而是直接提示并回登录页\n");
}

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

  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  console.log("应用已就绪（真实接口，非 mock）\n");

  console.log("=".repeat(70));
  console.log("阶段 A：token 已过期 → 页面链路请求 → 弹框 → 真实点击「确定」");
  console.log("=".repeat(70));
  await round(cdp, "A", { first: true });

  console.log("=".repeat(70));
  console.log("阶段 B：再次过期 → 仍能提示并回登录页（验证弹框状态复位）");
  console.log("=".repeat(70));
  await round(cdp, "B");

  if (cdp.errors.length) console.log(`\nCDP 捕获的错误：${JSON.stringify(cdp.errors, null, 2)}`);

  const failed = results.filter((r) => !r).length;
  console.log("=".repeat(70));
  console.log(`汇总：${results.length - failed}/${results.length} 通过`);
  console.log("=".repeat(70));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("探针异常：", e.message);
  process.exit(1);
});
