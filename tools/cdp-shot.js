#!/usr/bin/env node
/**
 * 真实浏览器渲染 + 计算样式取证（Chrome Headless + CDP，无需 puppeteer）。
 *
 * 用途：把 Web 应用在真实 Chrome 里渲染出来，既能截图做视觉比对，
 *       也能直接读取每个元素的 computedStyle（字号/字重/行高/颜色），
 *       用于「对照设计稿校准字体」这类需要客观数字的任务。
 *
 * 依赖：本机 Google Chrome + 本地 server.js（默认 4173）。
 * 需要登录的页面从环境变量取账号：BW_EMAIL / BW_PASSWORD（或用 BW_ACCOUNTS 整段覆盖）；
 * login / login-multi 不需要账号，可裸跑。
 *
 * 用法：
 *   export BW_EMAIL='<账号邮箱>' BW_PASSWORD='<口令>'   # 不要写进代码
 *   node tools/cdp-shot.js --page detail --out /tmp/detail.png
 *   node tools/cdp-shot.js --page detail --width 1440 --height 920
 *   node tools/cdp-shot.js --page detail --styles        # 只导计算样式（JSON）
 *   node tools/cdp-shot.js --page list --out /tmp/list.png
 *
 * 选项：
 *   --page   login | login-multi | list | detail 等  要截的页面（默认 detail）
 *   --out    PNG 输出路径（省略则不截图）
 *   --width  视口宽（默认 1440）
 *   --height 视口高（默认 920）
 *   --styles 打印目标页所有可见元素的计算样式 JSON
 *   --keep   保留浏览器进程（调试用）
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const creds = require("./_creds");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BW_BASE || "http://127.0.0.1:4173/";

// 本沙箱里 Chrome 自带的 sandbox 起不来（sandbox initialization failed:
// Operation not permitted），必须 --no-sandbox 才能跑；GPU 同理要关掉。
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

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const PAGE = arg("page", "detail");
const OUT = arg("out", null);
const WIDTH = Number(arg("width", 1440));
const HEIGHT = Number(arg("height", 920));
const WANT_STYLES = has("styles");
const KEEP = has("keep");

const PORT = 9222 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 迷你 CDP 客户端 ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
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
  /** 在页面里求值并取回 JSON 结果 */
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
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

async function waitForCDP() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const page = Array.isArray(list) && list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome CDP 未就绪（端口 " + PORT + "）");
}

// ---------- 凭据 ----------
// 只有 login / login-multi 不需要认证；其余页面都要真登录，缺环境变量就地报错，
// 免得截图跑完才发现「列表空」是被当成真结果了。
const NEEDS_LOGIN = !["login", "login-multi"].includes(PAGE);
if (NEEDS_LOGIN) creds.requireLive("cdp-shot");

/** 多账号截图用的 4 条账号：组织/单价/日期是截图所需的结构，账号与口令来自环境变量 */
const MULTI_ACCOUNTS = NEEDS_LOGIN
  ? creds.accountLines([
      { org: "support", unitPrice: 1.0, date: "2020.01.01" },
      { org: "lssd_01", unitPrice: 1.0, date: "2021.06.15" },
      { org: "lab-wuhan", unitPrice: 1.0, date: "2019.11.02" },
      { org: "demo-clinic", unitPrice: 1.5, date: "2022.03.08", region: 1 },
    ]).join("\n")
  : "";

// ---------- 页面准备脚本 ----------
const PREPARE = {
  login: `true`,
  // 多账号登录视图：点右上「多账号登录」切换后再截
  "login-multi": `(() => {
    document.getElementById("mode-toggle").click();
    return { mode: document.getElementById("mode-toggle").textContent,
             multiVisible: document.getElementById("multi-area").style.display };
  })()`,
  list: `
    (async () => {
      var _set = function (id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      _set("login-org", ${JSON.stringify(creds.ORG)});
      _set("login-email", ${JSON.stringify(creds.email())});
      _set("login-pwd", ${JSON.stringify(creds.password())});
      document.getElementById("login-btn").click();
      const dl = Date.now() + 90000;
      while (Date.now() < dl && !document.querySelector("#org-rows .table-row")) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 1200));
      return { rows: document.querySelectorAll("#org-rows .table-row").length, page: document.querySelector(".page.active") && document.querySelector(".page.active").id };
    })()
  `,
  // 列表页 + 设置菜单展开
  "list-settings": `
    (async () => {
      var _set = function (id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      _set("login-org", ${JSON.stringify(creds.ORG)});
      _set("login-email", ${JSON.stringify(creds.email())});
      _set("login-pwd", ${JSON.stringify(creds.password())});
      document.getElementById("login-btn").click();
      const dl = Date.now() + 90000;
      while (Date.now() < dl && !document.querySelector("#org-rows .table-row")) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 1200));
      document.getElementById("settings-btn").click();
      await new Promise(r => setTimeout(r, 300));
      return { menuOpen: document.getElementById("settings-menu").style.display };
    })()
  `,
  // 列表页 + 账号信息弹窗
  "list-account-info": `
    (async () => {
      var _set = function (id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      _set("login-org", ${JSON.stringify(creds.ORG)});
      _set("login-email", ${JSON.stringify(creds.email())});
      _set("login-pwd", ${JSON.stringify(creds.password())});
      document.getElementById("login-btn").click();
      const dl = Date.now() + 90000;
      while (Date.now() < dl && !document.querySelector("#org-rows .table-row")) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 1200));
      document.getElementById("settings-btn").click();
      document.getElementById("settings-account-info").click();
      await new Promise(r => setTimeout(r, 400));
      return { modal: document.getElementById("modal-root").classList.contains("show"),
               items: document.querySelectorAll("#modal-root .account-item").length };
    })()
  `,
  // 列表页 + 账号信息弹窗（多账号 4 条 → 列表应可滚动）
  "list-account-info-multi": `
    (async () => {
      document.getElementById("mode-toggle").click();
      document.getElementById("multi-text").value = ${JSON.stringify(MULTI_ACCOUNTS)};
      document.getElementById("multi-text").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("login-btn").click();
      const dl = Date.now() + 90000;
      while (Date.now() < dl && !document.querySelector("#org-rows .table-row")) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 1200));
      document.getElementById("settings-btn").click();
      document.getElementById("settings-account-info").click();
      await new Promise(r => setTimeout(r, 400));
      const list = document.querySelector("#modal-root .account-list");
      return { modal: document.getElementById("modal-root").classList.contains("show"),
               items: document.querySelectorAll("#modal-root .account-item").length,
               clientHeight: list && list.clientHeight, scrollHeight: list && list.scrollHeight,
               scrollable: !!(list && list.scrollHeight > list.clientHeight) };
    })()
  `,
  // 统计分析页（列表页点「统计分析」；无周期 → 账单统计态）
  statistics: `
    (async () => {
      var _set = function (id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      _set("login-org", ${JSON.stringify(creds.ORG)});
      _set("login-email", ${JSON.stringify(creds.email())});
      _set("login-pwd", ${JSON.stringify(creds.password())});
      document.getElementById("login-btn").click();
      const dl = Date.now() + 90000;
      while (Date.now() < dl && !document.querySelector("#org-rows .table-row")) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 1200));
      document.getElementById("stat-btn").click();
      await new Promise(r => setTimeout(r, 600));
      return { page: document.querySelector(".page.active") && document.querySelector(".page.active").id,
               companies: document.querySelectorAll("#stats-org-list .stats-card").length,
               total: document.getElementById("stats-total-bar").textContent };
    })()
  `,
  // 测量趋势页（统计页点汇总卡图表按钮；真实接口聚合 30 天/6 月，首载较慢）。
  // 用「异步启动 + 轮询」：长任务不能放在单条 Runtime.evaluate 里（CDP 60s 限制）
  trend: `
    (() => {
      var _set = function (id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      _set("login-org", ${JSON.stringify(creds.ORG)});
      _set("login-email", ${JSON.stringify(creds.email())});
      _set("login-pwd", ${JSON.stringify(creds.password())});
      document.getElementById("login-btn").click();
      globalThis.__trendStep = 0;
      (async () => {
        const dl = Date.now() + 90000;
        while (Date.now() < dl && !document.querySelector("#org-rows .table-row")) await new Promise(r => setTimeout(r, 400));
        await new Promise(r => setTimeout(r, 1200));
        document.getElementById("stat-btn").click();
        await new Promise(r => setTimeout(r, 600));
        document.getElementById("stats-chart-summary").click();
        globalThis.__trendStep = 1;
        const dl2 = Date.now() + 300000;
        while (Date.now() < dl2 && document.getElementById("trend-content").style.display !== "flex") await new Promise(r => setTimeout(r, 1000));
        globalThis.__trendStep = 2;
      })();
      return { started: true, __wait: "globalThis.__trendStep === 2" };
    })()
  `,
  detail: `
    (async () => {
      var _set = function (id, v) { var el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      _set("login-org", ${JSON.stringify(creds.ORG)});
      _set("login-email", ${JSON.stringify(creds.email())});
      _set("login-pwd", ${JSON.stringify(creds.password())});
      document.getElementById("login-btn").click();
      const dl = Date.now() + 90000;
      while (Date.now() < dl && !document.querySelector("#org-rows .table-row")) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 1200));
      const row = document.querySelector("#org-rows .table-row");
      if (!row) throw new Error("列表未出现数据行");
      row.click();
      const dl2 = Date.now() + 60000;
      while (Date.now() < dl2 && !document.querySelector("#research-rows .table-row")) await new Promise(r => setTimeout(r, 400));
      await new Promise(r => setTimeout(r, 1500));
      return { page: document.querySelector(".page.active") && document.querySelector(".page.active").id,
               rows: document.querySelectorAll("#research-rows .table-row").length };
    })()
  `,
};

// 需要审计字号的元素（详情页）
const STYLE_SELECTORS = [
  [".crumb", "面包屑"],
  [".org-title", "组织标题"],
  [".region-badge", "地区徽章"],
  [".metric-card:nth-child(1) .metric-label", "指标卡·标签"],
  [".metric-card:nth-child(1) .metric-value", "指标卡·数值(22px)"],
  [".metric-row:nth-child(1) .metric-card:nth-child(2) .metric-value", "指标卡·数值(单价)"],
  [".summary .metric-row:nth-child(2) .metric-card:nth-child(1) .metric-value", "指标卡·账单开始日期"],
  [".summary .metric-row:nth-child(2) .metric-card:nth-child(3) .metric-value", "指标卡·统计周期"],
  [".section-title", "小节标题(研究表)"],
  [".table-head .th", "表头"],
  ["#research-rows .table-row .td:nth-child(1)", "表格·创建日期"],
  ["#research-rows .table-row .td:nth-child(2)", "表格·研究名称"],
  ["#research-rows .table-row .td:nth-child(3)", "表格·状态"],
  ["#research-rows .table-row .td:nth-child(9)", "表格·研究ID"],
  [".total-row .td:nth-child(1)", "合计行·标签"],
  [".total-row .td:nth-child(5)", "合计行·周期内测量"],
  [".detail-hint", "底部提示"],
];

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      ...CHROME_FLAGS,
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=" + WIDTH + "," + HEIGHT,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let cdp;
  try {
    const target = await waitForCDP();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res);
      ws.addEventListener("error", rej);
    });
    cdp = new CDP(ws);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // 固定视口，等价于 CSS 像素 1:1，便于与设计稿逐像素比对
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send("Page.navigate", { url: BASE });
    await sleep(2000);

    // 关掉可能残留的弹窗/菜单，保证截图干净
    await cdp.eval(`(() => { const m=document.getElementById("modal-root"); if(m) m.classList.remove("show"); return true; })()`);

    let prep = await cdp.eval(PREPARE[PAGE] || PREPARE.detail);
    // 轮询模式：PREPARE 返回 __wait 表达式时，异步等待页面准备完成再取结果
    if (prep && prep.__wait) {
      const waitExpr = prep.__wait;
      const deadline = Date.now() + 330000;
      let done = false;
      while (Date.now() < deadline) {
        try {
          if (await cdp.eval(`Boolean(${waitExpr})`)) {
            done = true;
            break;
          }
        } catch (e) {
          // 单次轮询失败（如瞬时导航）不中断整体流程
        }
        await sleep(1500);
      }
      const finalInfo = await cdp.eval(`(() => {
        const active = document.querySelector(".page.active");
        return { page: active && active.id,
                 points: document.querySelectorAll("#trend-day-plot circle").length,
                 bars: document.querySelectorAll("#trend-month-plot path[fill='#0064E0'], #trend-month-plot path[fill='#FF9500']").length,
                 hint: (document.getElementById("trend-day-hint") || {}).textContent };
      })()`);
      prep = { ...prep, done, ...finalInfo };
    }
    console.log("页面准备:", JSON.stringify(prep));

    // 让字体稳定（等 webfont）
    await cdp.eval(`(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; return document.fonts ? document.fonts.status : "n/a"; })()`);
    await sleep(500);

    if (OUT) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
      fs.writeFileSync(path.resolve(OUT), Buffer.from(shot.data, "base64"));
      console.log("已截图:", path.resolve(OUT), `(${WIDTH}x${HEIGHT})`);
    }

    if (WANT_STYLES) {
      const data = await cdp.eval(`(() => {
        const sels = ${JSON.stringify(STYLE_SELECTORS)};
        const px = (v) => parseFloat(v) || 0;
        const out = [];
        for (const [sel, label] of sels) {
          const el = document.querySelector(sel);
          if (!el) { out.push({ label, sel, missing: true }); continue; }
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          out.push({
            label, sel,
            text: (el.textContent || "").trim().slice(0, 24),
            fontSize: px(cs.fontSize),
            fontWeight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            fontFamily: cs.fontFamily.split(",")[0].replace(/"/g, ""),
            color: cs.color,
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        }
        return out;
      })()`);
      console.log("\n===== 计算样式 =====");
      console.log(JSON.stringify(data, null, 2));
    }
  } finally {
    try {
      if (cdp) await cdp.send("Browser.close").catch(() => {});
    } catch {}
    if (!KEEP) {
      chrome.kill("SIGKILL");
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch((e) => {
  console.error("渲染失败:", e.message);
  process.exit(1);
});
