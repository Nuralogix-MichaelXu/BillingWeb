#!/usr/bin/env node
/**
 * 真机端到端验证：会话过期弹框在「并发失败」与「收尾异常」下仍能可靠回登录页。
 *
 * 背景（线上反馈）：网页上 token 过期后点「确定」回不到登录页。
 * 根因不在跳转本身，而在**弹框被覆盖 / 收尾中途抛异常**：
 *   1) 并发请求里只要有一个普通错误（解析失败等）后到，旧代码会用普通提示框
 *      覆盖掉「登录已过期」—— 用户手里那颗「确定」连同按钮一起被换掉，
 *      点下去只关掉普通提示框，人留在原页（本地会话也还在）。
 *   2) 收尾链条（cancel → 清会话 → 清存储 → 回登录页）只要中间一步抛异常，
 *      跳转就被吞掉：弹框已经关了，页面毫无反应。
 *
 * 本脚本不看实现细节，只驱动真实页面 + 真实 DOM，检查用户看到的东西：
 *   阶段一：会话过期 + 并发普通错误 → 屏上必须仍是「登录已过期」→ 点确定回登录页
 *   阶段二：收尾某步抛异常 → 点确定仍必须回登录页
 *
 * 用法：node server.js &  然后  node tools/session-expired-race.js
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
const PORT = 9800 + Math.floor(Math.random() * 300);
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
        this.errors.push(
          `[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)}`
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "se-race-"));
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

/** 造一个「登录态看起来正常但 token 已失效」的会话，并停在列表页（不发请求） */
const INJECT = `(function () {
  var region = 0;
  var key = "support" + Region.tag(region);
  var u = makeUser({
    key: key, orgName: "support", email: ${JSON.stringify(creds.email())},
    password: "p", region: region,
    deposits: 0, unitPrice: 1.0, billingDate: new Date(2026, 0, 14),
    token: "expired-token"
  });
  SharedUsers = [u];
  UserStorage.save([u]);
  Router.go("list");
  return key;
})()`;

/** 屏上真实可见内容（不看实现，只看用户看得见的东西） */
const SNAP = `(function () {
  var root = document.getElementById("modal-root");
  var t = root.querySelector(".modal-title");
  var m = root.querySelector(".modal-message");
  return {
    page: AppState.currentPage,
    modalShown: root.classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: m ? m.textContent : null,
    modalButtons: Array.prototype.map.call(root.querySelectorAll(".modal-btn"), function (b) { return b.textContent; }),
    loginActive: document.getElementById("page-login").classList.contains("active"),
    listActive: document.getElementById("page-list").classList.contains("active"),
    users: SharedUsers.length,
    hasSession: (function () { try { return !!localStorage.getItem("userList"); } catch (e) { return null; } })()
  };
})()`;

const results = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}${ok ? "" : `  (期望 ${JSON.stringify(expected)})`}`);
  return ok;
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
  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  console.log("应用已就绪\n");

  /* ---------------- 阶段一：并发普通错误不得覆盖会话弹框 ---------------- */
  console.log("[阶段一] 会话过期 + 并发普通错误");
  await cdp.eval(INJECT);
  await cdp.eval(`
    (function () {
      var e = new APIError("Invalid token", -1);
      e.apiCode = "INVALID_TOKEN";
      showPageError(e);                       // 会话过期 → 弹「登录已过期」
      showPageError(new Error("研究列表解析失败")); // 并发请求的普通错误随后到达
      showAlert("提示", "另一条错误");            // 再补一刀
    })()
  `);
  await sleep(400);
  let s = await cdp.eval(SNAP);
  console.log(`    弹框：标题「${s.modalTitle}」按钮：${s.modalButtons.join(" / ")}`);
  check("屏上是「登录已过期」", s.modalTitle, "登录已过期");
  check("弹框按钮只有「确定」", s.modalButtons.join("/"), "确定");
  check("点确定前仍在列表页", s.page, "list");

  console.log("    点击「确定」");
  await cdp.eval(`document.querySelector("#modal-root .modal-btn").click()`);
  await sleep(700);
  s = await cdp.eval(SNAP);
  console.log(`    当前页 ${s.page} | login active=${s.loginActive} | 弹框仍在=${s.modalShown} | 内存会话=${s.users} | 本地会话仍在=${s.hasSession}`);
  check("点确定 → 回登录页", s.page, "login");
  check("登录页已激活", s.loginActive, true);
  check("弹框已关闭", s.modalShown, false);
  check("内存会话已清空", s.users, 0);
  check("本地会话已清空", s.hasSession, false);

  /* ---------------- 阶段二：收尾某一步抛异常也要回登录页 ---------------- */
  console.log("\n[阶段二] 收尾某步抛异常（ListPage.resetState 抛错）");
  const errBefore = cdp.errors.length;
  await cdp.eval(INJECT);
  await cdp.eval(`
    (function () {
      var orig = ListPage.resetState;
      ListPage.resetState = function () { throw new Error("模拟收尾异常"); };
      var e = new APIError("Invalid token", -1);
      e.apiCode = "INVALID_TOKEN";
      showPageError(e);
      window.__restoreReset = function () { ListPage.resetState = orig; };
    })()
  `);
  await sleep(300);
  await cdp.eval(`document.querySelector("#modal-root .modal-btn").click()`);
  await sleep(700);
  s = await cdp.eval(SNAP);
  console.log(`    当前页 ${s.page} | 弹框仍在=${s.modalShown} | 内存会话=${s.users} | 本地会话仍在=${s.hasSession}`);
  check("收尾抛异常仍回登录页", s.page, "login");
  check("内存会话已清空", s.users, 0);
  check("本地会话已清空", s.hasSession, false);
  const newErrors = cdp.errors.slice(errBefore).filter((x) => x.includes("模拟收尾异常"));
  check("异常被记录（未静默）", newErrors.length > 0, true);

  console.log("\n" + results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log(`\n会话过期弹框健壮性（真机）：${results.length - failed.length}/${results.length}`);
  // 必须显式退出：WebSocket / Chrome 子进程会挂住事件循环
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("验证异常：", e.message);
  process.exit(1);
});
