#!/usr/bin/env node
/**
 * 语言切换真机验证（Chrome Headless + CDP，无需 puppeteer）。
 *
 * 离线 jsdom 桩里 applyI18n 是空跑（querySelectorAll("[data-i18n]") 返回 []），
 * 所以「静态文案真的被换成英文了吗」必须在真实 DOM 里验一次。
 *
 * 验证内容：
 *   1. 登录页右上角按钮 = 当前语言名 + 国旗（旗在文字右侧）
 *   2. 点开下拉：2 项、顺序 en → zh-Hans、每项「语言名在左、国旗在右」
 *   3. 点 English：语言表切换、按钮更新、菜单收起、localStorage 持久化
 *   4. 全页扫描：切到英文后不允许残留中文（语言菜单里的自称「中文」除外）
 *   5. 重新加载：语言保持英文
 *
 * 用法：
 *   node server.js &            # 先起本地服务（默认 4173）
 *   node tools/lang-verify.js --out-dir /tmp
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

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
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
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

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lang-verify-"));
  const chrome = spawn(
    CHROME,
    [...CHROME_FLAGS, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
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
/** 扫描全页可见文案 + 全部 placeholder / title（用于「不许残留中文」检查） */
const COLLECT = `
(() => {
  const CJK = /[\\u4e00-\\u9fff]/;
  const texts = [];
  const page = document.querySelector(".page.active");
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t) continue;
    const p = n.parentElement;
    if (!p || p.closest("#lang-menu")) continue;      // 语言菜单里的自称「中文」豁免
    if (!p.getClientRects().length) continue;
    texts.push(t);
  }
  const attrs = [];
  for (const el of document.querySelectorAll("[placeholder]")) {
    if (el.placeholder.trim()) attrs.push("placeholder=" + el.placeholder.trim());
  }
  for (const el of document.querySelectorAll("[title]")) {
    if (el.title.trim()) attrs.push("title=" + el.title.trim());
  }
  return { texts, attrs, docTitle: document.title, cjkInTexts: texts.filter(t => CJK.test(t)), cjkInAttrs: attrs.filter(t => CJK.test(t)) };
})()
`;

const READY = `document.readyState !== "loading" && typeof AppState !== "undefined" && typeof LanguageSwitcher !== "undefined"`;

const MENU_INFO = `
(() => {
  const items = [...document.querySelectorAll("#lang-menu .lang-item")];
  const order = (el) => [...el.childNodes].filter(n => n.nodeType === 1).map(n => n.tagName.toLowerCase());
  return {
    open: document.getElementById("lang-menu").classList.contains("open"),
    count: items.length,
    codes: items.map(i => i.dataset.lang),
    names: items.map(i => i.textContent.trim()),
    flags: items.map(i => (i.querySelector("svg.flag") || {}).dataset ? i.querySelector("svg.flag").dataset.flag : null),
    childOrder: items.map(order),          // 期望 ["span","svg"]：文字在左、国旗在右
    active: items.filter(i => i.classList.contains("active")).map(i => i.dataset.lang),
    btnText: document.getElementById("lang-btn").textContent.trim(),
    btnChildOrder: [...document.getElementById("lang-btn").childNodes].filter(n => n.nodeType === 1).map(n => n.tagName.toLowerCase()),
    btnFlag: (document.querySelector("#lang-btn svg.flag") || {}).dataset ? document.querySelector("#lang-btn svg.flag").dataset.flag : null,
    btnAria: document.getElementById("lang-btn").getAttribute("aria-expanded"),
  };
})()
`;

const STATE = `
(() => ({ lang: LanguageManager.currentLanguage, stored: localStorage.getItem("AppLanguage"),
         loginTitle: document.querySelector(".login-title").textContent,
         orgLabel: document.querySelector(".field-label").textContent,
         title: document.title }))()
`;

/* ------------------------------------------------------------------ 结果检查 */
let pass = 0;
const fails = [];
const check = (label, actual, expected) => {
  const okv = String(actual) === String(expected);
  if (okv) { pass++; console.log(`  ✔ ${label}: ${actual}`); }
  else { fails.push(`  ✘ ${label}: ${actual}  (期望 ${expected})`); console.log(`  ✘ ${label}: ${actual}  (期望 ${expected})`); }
};

(async () => {
  const { chrome, page } = await launch();
  let cdp;
  try {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    });
    cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    const open = async () => {
      await cdp.send("Page.navigate", { url: BASE });
      for (let i = 0; i < 200; i++) {
        if (await cdp.eval(READY)) return true;
        await sleep(150);
      }
      throw new Error("页面未就绪");
    };
    const click = (sel) => cdp.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

    /* ---------- 1. 中文（默认） ---------- */
    await open();
    await sleep(400);
    console.log("\n[1] 默认语言（浏览器 zh-CN）");
    const zhState = await cdp.eval(STATE);
    check("currentLanguage", zhState.lang, "zh-Hans");
    check("登录页标题", zhState.loginTitle, "请登录");
    check("页面标题", zhState.title, "BillingWeb · NuraLogix 计费系统");

    /* ---------- 2. 语言按钮 / 下拉 ---------- */
    console.log("\n[2] 右上角语言按钮与下拉");
    let info = await cdp.eval(MENU_INFO);
    check("按钮文案 = 当前语言名", info.btnText, "中文");
    check("按钮内元素顺序（文字→国旗）", info.btnChildOrder.join(","), "span,svg");
    check("按钮国旗 = 中国", info.btnFlag, "cn");
    check("初始 aria-expanded", info.btnAria, "false");

    await click("#lang-btn");
    await sleep(250);
    info = await cdp.eval(MENU_INFO);
    check("点击后菜单展开", info.open, true);
    check("点击后 aria-expanded", info.btnAria, "true");
    check("下拉项数量", info.count, 2);
    check("下拉项顺序（iOS keys.sorted）", info.codes.join(","), "en,zh-Hans");
    check("下拉项文案", info.names.join("/"), "English/中文");
    check("下拉项国旗", info.flags.join(","), "us,cn");
    check("每项内元素顺序（文字→国旗）", info.childOrder.map((o) => o.join("+")).join(" | "), "span+svg | span+svg");
    check("当前项高亮", info.active.join(","), "zh-Hans");
    const menuShot = await cdp.shot(path.join(OUT_DIR, "lang-menu-zh.png"));
    console.log("  截图：", menuShot);

    /* ---------- 3. 切到 English ---------- */
    console.log("\n[3] 切到 English");
    await click('#lang-menu .lang-item[data-lang="en"]');
    await sleep(400);
    const enState = await cdp.eval(STATE);
    check("currentLanguage", enState.lang, "en");
    check("localStorage 持久化", enState.stored, "en");
    check("登录页标题变英文", enState.loginTitle, "Please Login");
    check("字段标签变英文", enState.orgLabel, "Organization");
    check("页面标题变英文", enState.title, "BillingWeb · NuraLogix Billing");
    info = await cdp.eval(MENU_INFO);
    check("切换后菜单收起", info.open, false);
    check("按钮文案 = English", info.btnText, "English");
    check("按钮国旗 = 美国", info.btnFlag, "us");
    check("切换后高亮项", info.active.join(","), "en");
    const enShot = await cdp.shot(path.join(OUT_DIR, "lang-en.png"));
    console.log("  截图：", enShot);

    /* ---------- 4. 全页残留中文扫描 ---------- */
    console.log("\n[4] 英文态全页残留中文扫描");
    const scan = await cdp.eval(COLLECT);
    check("可见文本里的中文（应为空）", scan.cjkInTexts.join(" | "), "");
    check("placeholder/title 里的中文（应为空）", scan.cjkInAttrs.join(" | "), "");
    console.log(`  （共扫描 ${scan.texts.length} 条可见文本 + ${scan.attrs.length} 条属性）`);

    /* ---------- 5. 重新加载后语言保持 ---------- */
    console.log("\n[5] 刷新后语言保持");
    await open();
    await sleep(400);
    const again = await cdp.eval(STATE);
    check("刷新后仍为 en", again.lang, "en");
    check("刷新后标题仍为英文", again.loginTitle, "Please Login");

    /* ---------- 6. 切回中文 ---------- */
    console.log("\n[6] 切回中文");
    await click("#lang-btn");
    await sleep(200);
    await click('#lang-menu .lang-item[data-lang="zh-Hans"]');
    await sleep(400);
    const back = await cdp.eval(STATE);
    check("切回 zh-Hans", back.lang, "zh-Hans");
    check("标题复原", back.loginTitle, "请登录");
    const backScan = await cdp.eval(COLLECT);
    check("中文态无残留英文标签", backScan.cjkInTexts.length > 0, true);

    /* ---------- 7. 多账号模式下再扫一遍（隐藏区块的文案也要跟着切） ---------- */
    console.log("\n[7] 多账号模式残留扫描");
    await click("#lang-btn");
    await sleep(200);
    await click('#lang-menu .lang-item[data-lang="en"]');
    await sleep(300);
    await click("#mode-toggle");
    await sleep(400);
    const multi = await cdp.eval(COLLECT);
    check("多账号模式·可见文本里的中文（应为空）", multi.cjkInTexts.join(" | "), "");
    check("多账号模式·placeholder 里的中文（应为空）", multi.cjkInAttrs.join(" | "), "");
    console.log(`  （多账号可见文本 ${multi.texts.length} 条，示例：${multi.texts.slice(0, 3).join(" / ")}）`);
    await cdp.shot(path.join(OUT_DIR, "lang-en-multi.png"));
  } finally {
    try { chrome.kill(); } catch {}
  }
  console.log(`\n语言切换真机验证：${pass}/${pass + fails.length}`);
  if (fails.length) process.exitCode = 1;
})();
