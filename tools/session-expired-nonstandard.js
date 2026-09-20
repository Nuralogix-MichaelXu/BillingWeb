#!/usr/bin/env node
/**
 * 真机端到端验证：接口返回「非标准 401 报文」时，是否也能弹「登录已过期」并回登录页。
 *
 * 背景（线上反馈）：网页上 token 过期后点「确定」回不到登录页。
 * 排查发现真实链路本身是通的（见 session-expired-repro.js / -pages.js），
 * 但有一类响应会漏判：**HTTP 401，但响应体不是 {Code,Message} 结构**
 * （网关 HTML、字段缺失等）。旧代码把它当成成功数据返回，上层解析失败后
 * 只弹一个普通错误框 —— 点「确定」只关掉弹框、滞留在原页。
 *
 * 本脚本用 CDP Fetch 域直接伪造这种响应，验证加固后的行为。
 *
 * 用法：node server.js &  然后  node tools/session-expired-nonstandard.js
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
const PORT = 9600 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 伪造的响应体：合法 HTML，但完全不是接口的 {Code,Message} 结构 */
const FAKE_BODY = "<html><head><title>401 Unauthorized</title></head><body>401 Unauthorized</body></html>";

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.hits = 0;
    this.errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      // 拦截：把命中 pattern 的请求直接改写成 401 + HTML
      if (msg.method === "Fetch.requestPaused") {
        this.hits += 1;
        this.send("Fetch.fulfillRequest", {
          requestId: msg.params.requestId,
          responseCode: 401,
          responseHeaders: [
            { name: "Content-Type", value: "text/html; charset=utf-8" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: Buffer.from(FAKE_BODY, "utf8").toString("base64"),
        }).catch(() => {});
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "se-nonstd-"));
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
const MODAL_SHOWN = `document.getElementById("modal-root").classList.contains("show")`;

/** 会话本身看起来正常（token 存在，authHeader 不会提前抛错），但服务端一律回 401 HTML */
const INJECT = `(function () {
  var region = 0;
  var key = "support" + Region.tag(region);
  var u = makeUser({
    key: key, orgName: "support", email: ${JSON.stringify(creds.email())},
    password: "WRONG-PASSWORD", region: region,
    deposits: 0, unitPrice: 1.0, billingDate: new Date(2026, 0, 14),
    token: "some-token-that-server-rejects"
  });
  SharedUsers = [u];
  UserStorage.save([u]);
  Router.go("list");
  ListPage.onAppear();
  return { key: key };
})()`;

const SNAP = `(function () {
  var t = document.querySelector("#modal-root .modal-title");
  var m = document.querySelector("#modal-root .modal-message");
  return {
    page: AppState.currentPage,
    modalShown: document.getElementById("modal-root").classList.contains("show"),
    modalTitle: t ? t.textContent : null,
    modalMessage: m ? m.textContent : null,
    modalButtons: Array.prototype.map.call(document.querySelectorAll("#modal-root .modal-btn"), function (b) { return b.textContent; }),
    loginActive: document.getElementById("page-login").classList.contains("active"),
    users: SharedUsers.length,
    hasSession: (function () { try { return !!localStorage.getItem("userList"); } catch (e) { return null; } })()
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
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*deepaffex*", requestStage: "Request" }] });

  await cdp.send("Page.navigate", { url: BASE });
  await cdp.waitFor(READY, 60000, "应用就绪");
  console.log("应用已就绪（已开启请求拦截：业务接口一律返回 401 + HTML）\n");

  console.log("[1] 注入会话并进入列表页（服务端会以非标准 401 报文拒绝）");
  await cdp.eval(INJECT);

  await cdp.waitFor(MODAL_SHOWN, 60000, "弹出提示框");
  await sleep(300);
  let s = await cdp.eval(SNAP);
  console.log(`    被拦截的接口请求数：${cdp.hits}`);
  console.log(`    弹框：标题「${s.modalTitle}」/ 正文「${s.modalMessage}」  按钮：${s.modalButtons.join(" / ")}`);
  console.log(`    当前页：${s.page}`);

  const titleOk = s.modalTitle === "登录已过期";

  console.log("\n[2] 点击「确定」");
  await cdp.eval(`document.querySelector("#modal-root .modal-btn").click()`);
  await sleep(700);
  s = await cdp.eval(SNAP);
  console.log(`    当前页 ${s.page} | login active=${s.loginActive} | 弹框仍在=${s.modalShown} | 内存会话=${s.users} | 本地会话仍在=${s.hasSession}`);

  const pass = titleOk && s.page === "login" && s.loginActive && !s.modalShown && !s.hasSession && s.users === 0;
  console.log(`\n结论：${pass ? "✔ 非标准 401 也正确弹「登录已过期」并回到登录页" : "✘ 未通过"}`);
  if (!pass && cdp.errors.length) console.log("运行时错误：", JSON.stringify(cdp.errors, null, 2));
  // 必须显式退出：WebSocket / Chrome 子进程会挂住事件循环，node 不会自己结束
  // （否则输出被管道缓冲，看起来像「卡住」）
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error("验证异常：", e.message);
  process.exit(1);
});
