#!/usr/bin/env node
/**
 * 真机多账号数据验证（Chrome Headless + CDP）。
 *
 * 目的：用真实测试账号走「多账号登录」，进入各页面抓取
 *   ① 页面展示值（表格单元格 / 卡片文本）
 *   ② 页面内部数据（AppState.list.orgs、DetailPage.org …）
 *   ③ 网络取证（每个打到 deepaffex 的请求 URL / 状态码）
 * 然后在 Node 侧用 **独立复算** 校验：以 iOS（AnuraHelper/Model.swift）的公式为准，
 * 从叶子数据重新算一遍，和页面展示值逐项比对。复算公式与页面 getter 各写一遍，
 * 因此能抓出「字段接错 / 聚合错 / 周期口径错」这类 bug。
 *
 * 用法：
 *   node tools/live-verify.js --stage list   --out /tmp/lv-list.json
 *   node tools/live-verify.js --stage detail --out /tmp/lv-detail.json
 *   node tools/live-verify.js --stage stats  --out /tmp/lv-stats.json
 *   node tools/live-verify.js --stage trend  --out /tmp/lv-trend.json
 *
 * 依赖：本地 server.js（默认 4173）+ 本机 Google Chrome。
 * 账号从环境变量取：BW_EMAIL / BW_PASSWORD（或用 BW_ACCOUNTS 整段覆盖，\n 分隔）。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const creds = require("./_creds");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BW_BASE || "http://127.0.0.1:4173/";
const PORT = 9700 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const STAGE = arg("stage", "list");
const OUT = arg("out", null);
const SHOT = arg("shot", null); // 在阶段结束时截图（真机证据）
const RAW_ENABLED = argv.includes("--raw"); // 额外打一遍许可证接口（会污染网络取证，默认关）
const WIDTH = Number(arg("width", 1440));
const HEIGHT = Number(arg("height", 980));

/** 多账号登录文本：组织 账号 密码 已充值金额 单价 计费日期 域名(0=国内 1=海外)
 *  账号与口令来自 BW_EMAIL / BW_PASSWORD，也可用 BW_ACCOUNTS 整段覆盖 */
const ACCOUNTS = creds.accountLines([
  { org: "support", unitPrice: 1.0, date: "2026.01.14" },
  { org: "lssd_01", unitPrice: 1.2, date: "2026.01.14" },
]);

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

/* ------------------------------------------------------------ CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.net = []; // 网络取证
    this.console = [];
    this.exceptions = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method === "Network.requestWillBeSent") {
        const u = msg.params.request.url || "";
        if (u.includes("deepaffex")) {
          this.net.push({ kind: "request", id: msg.params.requestId, method: msg.params.request.method, url: u });
        }
      } else if (msg.method === "Network.responseReceived") {
        const u = msg.params.response.url || "";
        if (u.includes("deepaffex")) {
          this.net.push({ kind: "response", id: msg.params.requestId, status: msg.params.response.status, url: u });
        }
      } else if (msg.method === "Network.loadingFailed") {
        this.net.push({ kind: "failed", id: msg.params.requestId, error: msg.params.errorText, type: msg.params.type });
      } else if (msg.method === "Runtime.consoleAPICalled") {
        if (msg.params.type === "error" || msg.params.type === "warning") {
          this.console.push(
            msg.params.type + ": " + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ")
          );
        }
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails || {};
        this.exceptions.push(d.text + " " + ((d.exception || {}).description || ""));
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
          reject(new Error("CDP timeout: " + method));
        }
      }, 60000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.text + " :: " + ((r.exceptionDetails.exception || {}).description || "")
      );
    }
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
  for (let i = 0; i < 80; i++) {
    try {
      const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
      const page =
        Array.isArray(list) && list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome CDP 未就绪（端口 " + PORT + "）");
}

/** 等待应用脚本就绪（本沙箱里 index.html 解析+3 个脚本加载约需 5s，固定 sleep 不可靠） */
async function waitForApp(cdp, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await cdp.eval(
        `document.readyState !== "loading" && typeof AppState !== "undefined" && typeof APIClient !== "undefined" && document.scripts.length >= 3`
      );
      if (ok) return true;
    } catch {}
    await sleep(400);
  }
  throw new Error("应用脚本未就绪（AppState/APIClient 未加载）");
}

/** 截图（真机证据）；等字体就绪避免文字抖位 */
async function shoot(cdp) {
  await cdp.eval(`(async () => { if (document.fonts && document.fonts.ready) await document.fonts.ready; return true; })()`);
  await sleep(500);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(path.resolve(SHOT)), { recursive: true });
  fs.writeFileSync(path.resolve(SHOT), Buffer.from(shot.data, "base64"));
  console.log("已截图:", path.resolve(SHOT), "(" + WIDTH + "x" + HEIGHT + ")");
}

/** 轮询直到表达式为真；abortExpr 为真则提前终止（用于快速失败诊断） */
async function pollUntil(cdp, expr, timeoutMs, label, abortExpr) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cdp.eval(`Boolean(${expr})`)) return true;
      if (abortExpr && (await cdp.eval(`Boolean(${abortExpr})`))) {
        throw new Error("异常终止（" + label + "）：页面出现错误态");
      }
    } catch (e) {
      if (String(e.message || "").startsWith("异常终止")) throw e;
    }
    await sleep(1200);
  }
  throw new Error("等待超时: " + label);
}

/* -------------------------------------------------- 调用计数插桩（诊断用） */
/**
 * 在页面里包一层 APIClient 的计数钩子，用来回答：
 *   · 每个 (组织, 研究, 状态) 的测量查询被「发起」几次？
 *   · 每次发起实际打了几次 HTTP（含 getMeasurements 的解码失败重试）？
 *   · updateStudies 被调用几轮、每轮覆盖哪些组织？
 *   · token 刷新重试被触发几次、原因是什么？
 * 计数只做旁观，不改变任何行为。
 */
const INSTRUMENT = `
(() => {
  const S = (globalThis.__stats = {
    updateStudies: [], measurementInitial: {}, measurementAttempts: {},
    retryErrors: [], refreshes: [], authCalls: [],
  });
  const origUpdate = APIClient.updateStudies.bind(APIClient);
  APIClient.updateStudies = function (studyDic, billingDateDic, startDate, endDate, progress) {
    const perKey = {};
    for (const k of Object.keys(studyDic || {})) perKey[k] = (studyDic[k] || []).length;
    S.updateStudies.push({
      perKey: perKey,
      startDate: startDate ? new Date(startDate).toISOString() : null,
      billingDateDic: billingDateDic ? Object.keys(billingDateDic) : null,
      endDate: endDate ? new Date(endDate).toISOString() : null,
    });
    return origUpdate(studyDic, billingDateDic, startDate, endDate, progress);
  };
  const origGetM = APIClient.getMeasurements.bind(APIClient);
  APIClient.getMeasurements = function (org, region, studyID, statusID, date, endDate) {
    const k = org + "|" + studyID + "|" + statusID;
    S.measurementInitial[k] = (S.measurementInitial[k] || 0) + 1;
    return origGetM(org, region, studyID, statusID, date, endDate);
  };
  const origAttempt = APIClient._getMeasurementsWithRetry.bind(APIClient);
  APIClient._getMeasurementsWithRetry = function (org, region, studyID, statusID, date, endDate, n) {
    const k = org + "|" + studyID + "|" + statusID + "|n" + n;
    S.measurementAttempts[k] = (S.measurementAttempts[k] || 0) + 1;
    return origAttempt(org, region, studyID, statusID, date, endDate, n).catch(function (e) {
      S.retryErrors.push({ k: k, err: (e && (e.name + ": " + e.message)) || String(e) });
      throw e;
    });
  };
  const origLogin = APIClient.login.bind(APIClient);
  let loginSeq = 0;
  APIClient.login = function (email, password, org, region) {
    S.authCalls.push({ seq: ++loginSeq, org: org, region: region, at: Date.now() });
    return origLogin(email, password, org, region);
  };
  const origRefresh = APIClient.sendRequestWithTokenRefresh.bind(APIClient);
  APIClient.sendRequestWithTokenRefresh = function (opts) {
    const rec = { url: (opts && opts.urlString || "").replace(/^https:\\/\\/[^/]+/, "") };
    return origRefresh(opts).then(
      function (r) { rec.ok = true; S.refreshes.push(rec); return r; },
      function (e) { rec.ok = false; rec.err = (e && e.message) || String(e); S.refreshes.push(rec); throw e; }
    );
  };
  return "instrumented";
})()
`;

/* -------------------------------------------------------- 页面脚本片段 */
const LOGIN = `
(() => {
  document.getElementById("mode-toggle").click();
  var ta = document.getElementById("multi-text");
  ta.value = ${JSON.stringify(ACCOUNTS.join("\n"))};
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("login-btn").click();
  return {
    submitted: true,
    isMulti: AppState.login.isMultiAccountMode,
    lineCount: ta.value.split("\\n").length,
  };
})()
`;

const DIAG = `
(() => {
  const m = document.getElementById("modal-root");
  return {
    activePage: (document.querySelector(".page.active") || {}).id,
    modalShown: m ? m.classList.contains("show") : null,
    modalText: m ? m.innerText.replace(/\\n+/g, " | ").slice(0, 300) : null,
    rowCount: document.querySelectorAll("#org-rows .table-row").length,
    orgCount: AppState.list.orgs.length,
    isRefreshing: AppState.list.isRefreshing,
    loginLoading: AppState.login.isLoading,
    users: SharedUsers.map(function (u) {
      return { org: u.orgName, region: u.region, deposits: u.deposits, unitPrice: u.unitPrice, hasToken: !!u.token };
    }),
  };
})()
`;

const LIST_READY = `AppState.list.orgs.length >= ${ACCOUNTS.length} && !AppState.list.isRefreshing`;
const LIST_FAILED = `document.getElementById("modal-root").classList.contains("show")`;
const DETAIL_READY = `document.getElementById("page-detail").classList.contains("active") && document.querySelectorAll("#research-rows .table-row").length > 0`;
const STATS_READY = `document.getElementById("page-statistics").classList.contains("active")`;
const TREND_READY = `document.getElementById("trend-content") && document.getElementById("trend-content").style.display === "flex"`;
/** 二次进入趋势页：render() 会先同步清空 dayData，据此区分「新一輪渲染完成」与上一轮的残留态 */
const TREND_READY2 = `document.getElementById("trend-content").style.display === "flex" && typeof TrendPage !== "undefined" && TrendPage.dayData.length === 30`;

const EXTRACT = {
  list: `
  (async () => {
    const num = (t) => {
      if (t == null) return null;
      const s = String(t).trim();
      if (s === "" || s === "-") return null;
      const v = Number(s.replace(/,/g, ""));
      return Number.isFinite(v) ? v : null;
    };
    const users = SharedUsers.map((u) => ({
      key: u.key, orgName: u.orgName, email: u.email, region: u.region,
      deposits: u.deposits, unitPrice: u.unitPrice,
      billingDate: yyyyMMddDateString(u.billingDate),
      hasToken: !!u.token,
    }));
    const rows = [...document.querySelectorAll("#org-rows .table-row")].map((r) => ({
      cells: [...r.querySelectorAll(".td")].map((c) => c.innerText.trim()),
      nums: [...r.querySelectorAll(".td")].map((c) => num(c.innerText)),
      color: (() => { const b = r.querySelectorAll(".td")[7]; return b ? getComputedStyle(b).color : null; })(),
    }));
    const orgs = AppState.list.orgs.map((o) => ({
      key: o.key, name: o.name, region: o.region,
      studyCount: o.studyCount,
      totalDeposits: o.totalDeposits, totalDepositsString: o.totalDepositsString,
      unitPrice: o.unitPrice, unitPriceString: o.unitPriceString,
      successCount: o.successCount,
      billingSuccessMeasurements: o.billingSuccessMeasurements,
      billingCost: o.billingCost, billingCostString: o.billingCostString,
      balance: o.balance, balanceString: o.balanceString, balanceColor: o.balanceColor,
      periodSuccess: o.periodSuccess, periodSuccessString: o.periodSuccessString,
      periodCost: o.periodCost, periodCostString: o.periodCostString,
      billingDate: yyyyMMddDateString(o.billingDate),
      startDate: yyyyMMddDateString(o.startDate),
      endDate: yyyyMMddDateString(o.endDate),
      studies: o.studies.map((s) => ({
        ID: s.ID, Name: s.Name, StatusID: s.StatusID, Created: s.Created,
        TotalCount: s.TotalCount, Measurements: s.Measurements,
        unitPrice: s.unitPrice,
        totalSuccessMeasurements: s.totalSuccessMeasurements,
        periodSuccessMeasurements: s.periodSuccessMeasurements,
        billingSuccessMeasurements: s.billingSuccessMeasurements,
        periodBillingSuccessMeasurements: s.periodBillingSuccessMeasurements,
        isPerioContainBilling: s.isPerioContainBilling,
        billingCost: s.billingCost,
        periodCost: s.periodCost,
        createdDateString: s.createdDateString,
        statusString: s.statusString,
      })),
    }));
    const meta = {
      selectedFilter: AppState.list.selectedFilter,
      isPeriodNone: AppState.list.isPeriodNone,
      billingPeriod: AppState.list.billingPeriod,
      billingName: AppState.list.billingName,
      updateTime: AppState.list.updateTime,
      startDateString: AppState.list.startDateString,
      endDateString: AppState.list.endDateString,
    };
    const uiText = {
      orgCount: (document.getElementById("org-count") || {}).textContent,
      billingName: (document.getElementById("billing-name") || {}).textContent,
      cyclePill: (document.getElementById("cycle-pill-text") || {}).textContent,
      tableHead: [...document.querySelectorAll("#org-rows")].length
        ? [...document.querySelectorAll(".table-head .th")].map((t) => t.textContent.trim())
        : [],
    };
    // 可选独立通道：直接打接口再取一遍许可证（默认关闭，避免污染网络取证）
    let raw = null, rawErr = null;
    if (${RAW_ENABLED}) {
      try {
        raw = {};
        for (const u of SharedUsers) {
          const licences = await APIClient.getLicences(u.orgName, u.region, 100);
          raw[u.orgName] = {
            licenceCount: licences.length,
            licences: licences.slice(0, 50).map((l) => ({
              Key: l.Key, StatusID: l.StatusID, LicenseType: l.LicenseType,
              Created: l.Created, TotalCount: l.TotalCount,
            })),
          };
        }
      } catch (e) { rawErr = String((e && e.message) || e); }
    }
    return { stage: "list", users, rows, orgs, meta, uiText, raw, rawErr, callStats: globalThis.__stats };
  })()
  `,

  detail: `
  (async () => {
    const num = (t) => {
      if (t == null) return null;
      const s = String(t).trim();
      if (s === "" || s === "-") return null;
      const v = Number(s.replace(/,/g, ""));
      return Number.isFinite(v) ? v : null;
    };
    const o = DetailPage.org;
    const cards = [...document.querySelectorAll(".metric-card")].map((c) => ({
      label: (c.querySelector(".metric-label") || {}).textContent,
      value: (c.querySelector(".metric-value") || {}).textContent,
    }));
    const rows = [...document.querySelectorAll("#research-rows .table-row")].map((r) => ({
      cells: [...r.querySelectorAll(".td")].map((c) => c.innerText.trim()),
      nums: [...r.querySelectorAll(".td")].map((c) => num(c.innerText)),
      studyID: r.getAttribute("data-study-id"),
    }));
    const total = [...document.querySelectorAll(".total-row .td")].map((c) => c.innerText.trim());
    const head = [...document.querySelectorAll(".research-table .table-head .th, .table-head .th")].map((t) => t.textContent.trim());
    return {
      stage: "detail",
      orgName: o ? o.name : null,
      region: o ? o.region : null,
      billingPeriod: AppState.list.billingPeriod,
      periodNone: AppState.list.isPeriodNone,
      fieldValues: {
        deposits: (document.getElementById("d-deposits") || {}).textContent,
        unitPrice: (document.getElementById("d-unitprice") || {}).textContent,
        billCost: (document.getElementById("d-billcost") || {}).textContent,
        balance: (document.getElementById("d-balance") || {}).textContent,
        billingDate: (document.getElementById("d-billingdate") || {}).textContent,
        period: (document.getElementById("d-period") || {}).textContent,
        periodCost: (document.getElementById("d-periodcost") || {}).textContent,
      },
      org: o ? {
        name: o.name,
        totalDeposits: o.totalDeposits, unitPrice: o.unitPrice,
        billingCost: o.billingCost, billingCostString: o.billingCostString,
        balance: o.balance, balanceString: o.balanceString,
        billingSuccessMeasurements: o.billingSuccessMeasurements,
        periodSuccess: o.periodSuccess, periodCost: o.periodCost, periodCostString: o.periodCostString,
        unitPriceString: o.unitPriceString,
        billingDate: yyyyMMddDateString(o.billingDate),
        startDate: yyyyMMddDateString(o.startDate),
        endDate: yyyyMMddDateString(o.endDate),
      } : null,
      cards, tableHead: head, total,
      studies: o ? o.studies.map((s) => ({
        ID: s.ID, Name: s.Name, StatusID: s.StatusID,
        unitPrice: s.unitPrice,
        totalSuccessMeasurements: s.totalSuccessMeasurements,
        periodSuccessMeasurements: s.periodSuccessMeasurements,
        billingSuccessMeasurements: s.billingSuccessMeasurements,
        periodBillingSuccessMeasurements: s.periodBillingSuccessMeasurements,
        isPerioContainBilling: s.isPerioContainBilling,
        billingCost: s.billingCost, periodCost: s.periodCost,
        createdDateString: s.createdDateString, statusString: s.statusString,
      })) : [],
      rows,
    };
  })()
  `,

  stats: `
  (async () => {
    const S = StatisticsPage;
    return {
      stage: "stats",
      selectedTab: S.selectedTab,
      pageText: document.getElementById("page-statistics").innerText.replace(/\\n+/g, " | ").slice(0, 2500),
      cardCount: document.querySelectorAll("#stats-org-list .stats-card").length,
      cards: [...document.querySelectorAll("#stats-org-list .stats-card")].map((c) => c.innerText.replace(/\\n+/g, " | ")),
      totalBar: (document.getElementById("stats-total-bar") || {}).innerText,
      tableRows: [...document.querySelectorAll("#stats-table-rows .table-row")].map((r) => [...r.querySelectorAll(".td")].map((c) => c.innerText.trim())),
      state: JSON.parse(JSON.stringify(S, (k, v) => (typeof v === "function" ? undefined : v))),
    };
  })()
  `,

  trend: `
  (async () => {
    const T = TrendPage;
    const d2 = (x) => x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
    return {
      stage: "trend",
      title: (document.getElementById("trend-title") || {}).textContent,
      monthTitle: (document.getElementById("trend-month-title") || {}).textContent,
      dayCount: (T.dayData || []).length,
      monthCount: (T.monthData || []).length,
      day: (T.dayData || []).map((d) => ({ date: d2(d.date), count: d.count })),
      month: (T.monthData || []).map((m) => ({ month: m.monthStart.getFullYear() + "-" + String(m.monthStart.getMonth() + 1).padStart(2, "0"), count: m.count })),
      daySum: (T.dayData || []).reduce((a, d) => a + d.count, 0),
      monthSum: (T.monthData || []).reduce((a, m) => a + m.count, 0),
      bars: document.querySelectorAll("#trend-month-plot path[data-idx]").length,
      points: document.querySelectorAll("#trend-day-plot circle").length,
      monthLabels: [...document.querySelectorAll("#trend-month-plot .trend-axis-label")].map((s) => s.textContent),
      state: JSON.parse(JSON.stringify(T, (k, v) => (typeof v === "function" ? undefined : v))),
    };
  })()
  `,
};

/* -------------------------------------------------- 独立复算（iOS 公式） */
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * 以 AnuraHelper/Model.swift 为唯一真值，从叶子数据独立复算列表页每个组织的展示值。
 * 注意：这里的公式是「照着 Swift 再写一遍」，不复用 app/model.js 的 getter。
 */
function verifyList(d) {
  const out = [];
  const add = (org, name, actual, expected) => {
    const pass =
      typeof actual === "number" && typeof expected === "number"
        ? Math.abs(actual - expected) < 0.005
        : JSON.stringify(actual) === JSON.stringify(expected);
    out.push({ org, name, pass, actual, expected });
  };

  for (const o of d.orgs) {
    const S = o.studies;
    // StudyResponse.billingCost = (unitPrice ?? 0) * Double(billingSuccessMeasurements ?? totalSuccessMeasurements ?? 0)
    const expBillingCost = r2(
      S.reduce(
        (a, s) =>
          a + (s.unitPrice ?? 0) * (s.billingSuccessMeasurements ?? s.totalSuccessMeasurements ?? 0),
        0
      )
    );
    add(o.name, "账单费用 = Σ(单价×(账单内测量 ?? 总成功))", r2(o.billingCost), expBillingCost);

    // OrgInfo.billingSuccessMeasurements = Σ(billingSuccessMeasurements ?? totalSuccessMeasurements ?? 0)
    const expInBill = S.reduce(
      (a, s) => a + (s.billingSuccessMeasurements ?? s.totalSuccessMeasurements ?? 0),
      0
    );
    add(o.name, "账单内测量 = Σ(…)", o.billingSuccessMeasurements, expInBill);

    // OrgInfo.balance = totalDeposits - billingCost
    add(o.name, "余额 = 总充值 − 账单费用", r2(o.balance), r2(o.totalDeposits - expBillingCost));

    // OrgInfo.studyCount
    add(o.name, "研究数 = studies.count", o.studyCount, S.length);

    // OrgInfo.periodCost
    if (o.periodSuccess == null) {
      add(o.name, "无周期 → 周期内消费为 null（显示 -）", o.periodCost, null);
    } else {
      const expPeriod = r2(
        S.reduce((a, s) => {
          if (s.periodSuccessMeasurements == null) return a; // 该 study 无周期数据 → 贡献 0
          if (s.isPerioContainBilling === true) {
            return a + (s.unitPrice ?? 0) * (s.billingSuccessMeasurements ?? 0);
          }
          const p =
            s.periodBillingSuccessMeasurements ??
            s.periodSuccessMeasurements ??
            s.totalSuccessMeasurements ??
            0;
          return a + (s.unitPrice ?? 0) * p;
        }, 0)
      );
      add(o.name, "周期内消费 = Σ(单价×周期内测量口径)", r2(o.periodCost), expPeriod);
    }

    // unitPriceString：唯一价 → 单值；多价 → 升序前 5 用 "/" 连接
    const prices = Array.from(
      new Set(S.map((s) => (s.unitPrice ?? o.unitPrice)).filter((v) => v != null))
    ).sort((a, b) => a - b);
    if (prices.length <= 1) {
      add(
        o.name,
        "单价显示（单一价）",
        o.unitPriceString,
        String((prices.length ? prices[0] : o.unitPrice).toFixed(1))
      );
    }

    // 单元测试口径：UI 单元格 ←→ 数据字段一一对应（列序见 2-BillingListView.swift 表头）
    const row = d.rows.find((r) => r.cells[0] === o.name);
    if (row) {
      add(o.name, "UI[研究数]", row.nums[2], o.studyCount);
      add(o.name, "UI[账单内测量]", row.nums[3], o.billingSuccessMeasurements);
      add(o.name, "UI[总充值]", row.nums[4], r2(o.totalDeposits));
      add(o.name, "UI[账单费用]", row.nums[6], r2(o.billingCost));
      add(o.name, "UI[余额]", row.nums[7], r2(o.balance));
      add(o.name, "UI[账单开始日期]", row.cells[10], o.billingDate);
      if (o.periodSuccess == null) {
        add(o.name, "UI[周期内成功测量]=-", row.cells[8], "-");
        add(o.name, "UI[周期内消费]=-", row.cells[9], "-");
      } else {
        add(o.name, "UI[周期内成功测量]", row.nums[8], o.periodSuccess);
        add(o.name, "UI[周期内消费]", row.nums[9], o.periodCost == null ? null : r2(o.periodCost));
      }
    } else {
      out.push({ org: o.name, name: "UI 行存在", pass: false, actual: null, expected: "存在" });
    }
  }

  // 跨账号隔离：两个组织的 key / 数据不得相同
  if (d.orgs.length >= 2) {
    const keys = d.orgs.map((o) => o.key);
    add("(全局)", "两组织 key 互不相同", new Set(keys).size, keys.length);
  }
  // 计费日期与入参一致（计费日期=2026.01.14）
  for (const u of d.users) {
    add(u.orgName, "user.billingDate 解析（入参 2026.01.14）", u.billingDate, "2026.01.14");
  }
  add("(全局)", "多账号全部带 token", d.users.every((u) => u.hasToken), true);
  return out;
}

function printChecks(title, checks) {
  const fail = checks.filter((c) => !c.pass);
  console.log("\n===== " + title + " =====");
  for (const c of checks) {
    console.log(
      (c.pass ? "  ✓ " : "  ✗ FAIL ") + "[" + c.org + "] " + c.name + (c.pass ? "" : "  实际=" + JSON.stringify(c.actual) + " 期望=" + JSON.stringify(c.expected))
    );
  }
  console.log("结果: " + (checks.length - fail.length) + "/" + checks.length + " 通过" + (fail.length ? "，FAIL " + fail.length : ""));
  return fail.length === 0;
}

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-lv-"));
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
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await cdp.send("Page.navigate", { url: BASE });
    await waitForApp(cdp);
    console.log("应用已就绪（脚本加载完成）");
    console.log("插桩:", await cdp.eval(INSTRUMENT));

    console.log("账号:", JSON.stringify(ACCOUNTS));
    const li = await cdp.eval(LOGIN);
    console.log("登录提交:", JSON.stringify(li));

    try {
      await pollUntil(cdp, LIST_READY, 240000, "列表数据就绪", LIST_FAILED);
    } catch (e) {
      const diag = await cdp.eval(DIAG);
      console.log("\n!!! 列表未就绪 !!!");
      console.log("诊断:", JSON.stringify(diag, null, 2));
      console.log("接口请求:", JSON.stringify(cdp.net.slice(-40), null, 2));
      console.log("console:", JSON.stringify(cdp.console.slice(-20), null, 2));
      console.log("异常:", JSON.stringify(cdp.exceptions.slice(-10), null, 2));
      throw e;
    }
    const diag = await cdp.eval(DIAG);
    console.log("登录后状态:", JSON.stringify(diag));

    if (STAGE === "detail") {
      // 依次进两个组织的详情页
      const results = [];
      const n = diag.users.length;
      for (let i = 0; i < n; i++) {
        await cdp.eval(`(() => { const rs = document.querySelectorAll("#org-rows .table-row"); rs[${i}].click(); return true; })()`);
        await pollUntil(cdp, DETAIL_READY, 120000, "详情页 " + i);
        await sleep(2000);
        results.push(await cdp.eval(EXTRACT.detail));
        await cdp.eval(`document.getElementById("back-btn").click()`);
        await sleep(1200);
      }
      finish(cdp, { stage: "detail", results }, null);
      return;
    }

    if (STAGE === "stats" || STAGE === "trend" || STAGE === "trend-cache") {
      await cdp.eval(`document.getElementById("stat-btn").click()`);
      await pollUntil(cdp, STATS_READY, 120000, "统计页");
      await sleep(2500);
      if (STAGE === "stats") {
        if (SHOT) await shoot(cdp);
        finish(cdp, await cdp.eval(EXTRACT.stats), null);
        return;
      }
      await cdp.eval(`document.getElementById("stats-chart-summary").click()`);
      await pollUntil(cdp, TREND_READY, 900000, "趋势页（30天+12月聚合，较慢）");
      await sleep(1500);
      const first = await cdp.eval(EXTRACT.trend);

      if (STAGE !== "trend-cache") {
        if (SHOT) await shoot(cdp);
        finish(cdp, first, null);
        return;
      }

      // 二次进入：缓存已热 → 非「今天/本月」的时间点应全部走缓存
      await cdp.eval(`document.getElementById("trend-back").click()`);
      await pollUntil(cdp, STATS_READY, 60000, "返回统计页");
      await sleep(800);
      const netBefore = cdp.net.filter((n) => n.kind === "request").length;
      const t0 = Date.now();
      await cdp.eval(`document.getElementById("stats-chart-summary").click()`);
      await pollUntil(cdp, TREND_READY2, 600000, "趋势页第二次（走缓存）");
      const elapsedMs = Date.now() - t0;
      await sleep(1200);
      const second = await cdp.eval(EXTRACT.trend);
      const netAfter = cdp.net.filter((n) => n.kind === "request").length;

      // 逐点比对：历史时间点必须完全一致；今天/本月允许实时增长
      const todayStr = first.day[first.day.length - 1].date;
      const thisMonth = first.month[first.month.length - 1].month;
      const diffs = [];
      for (let i = 0; i < first.day.length; i++) {
        const a = first.day[i], b = second.day[i];
        if (a.date !== b.date || a.count !== b.count) diffs.push({ kind: "day", point: a.date, first: a.count, second: b.count, live: a.date === todayStr });
      }
      for (let i = 0; i < first.month.length; i++) {
        const a = first.month[i], b = second.month[i];
        if (a.month !== b.month || a.count !== b.count) diffs.push({ kind: "month", point: a.month, first: a.count, second: b.count, live: a.month === thisMonth });
      }
      console.log("\n===== 缓存路径校验（第二次进入趋势页）=====");
      console.log("第二次加载耗时: " + elapsedMs + " ms；期间新增请求: " + (netAfter - netBefore) + " 条");
      console.log("点数: day " + first.day.length + "→" + second.day.length + ", month " + first.month.length + "→" + second.month.length);
      const stale = diffs.filter((d) => !d.live);
      console.log("历史时间点不一致: " + stale.length + (stale.length ? "  ⚠️ 缓存串数据" : "  ✓ 全部一致"));
      for (const d of stale) console.log("   ✗ " + d.kind + " " + d.point + " 首次=" + d.first + " 二次=" + d.second);
      const liveDiffs = diffs.filter((d) => d.live);
      for (const d of liveDiffs) console.log("   ℹ（实时增长，允许）" + d.kind + " " + d.point + " 首次=" + d.first + " 二次=" + d.second);

      if (SHOT) await shoot(cdp);

      finish(cdp, { stage: "trend-cache", first, second, elapsedMs, requestsBetween: netAfter - netBefore, staleDiffs: stale, liveDiffs, cacheRaw: second.state ? "ok" : "n/a" }, null);
      if (stale.length) EXIT = 2;
      return;
    }

    const data = await cdp.eval(EXTRACT.list);
    if (SHOT) await shoot(cdp);
    finish(cdp, data, verifyList);
  } finally {
    try {
      if (cdp) await cdp.send("Browser.close").catch(() => {});
    } catch {}
    chrome.kill("SIGKILL");
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

let EXIT = 0;
function finish(cdp, data, verifier) {
  data._accounts = ACCOUNTS;
  const reqs = cdp.net.filter((n) => n.kind === "request");
  const ress = cdp.net.filter((n) => n.kind === "response");
  // 按 requestId 归并，得到「真实发出的请求」列表（避免把同一请求的多次事件算成多次请求）
  const byId = new Map();
  for (const r of reqs) byId.set(r.id, { method: r.method, url: r.url, status: null });
  for (const r of ress) {
    if (!byId.has(r.id)) byId.set(r.id, { method: "?", url: r.url, status: null });
    byId.get(r.id).status = r.status;
  }
  data._requests = [...byId.values()].map((r) => ({
    method: r.method,
    status: r.status,
    path: (r.url.replace(/^https:\/\/[^/]+/, "").split("?")[0]) +
      (r.url.includes("StudyID=") ? "?" + (r.url.split("?")[1] || "").split("&").filter((p) => /StudyID|StatusID/.test(p)).join("&") : ""),
  }));
  data._net = data._requests.map((r) => r.status + " " + r.path);
  data._eventDup = { requestWillBeSent: reqs.length, responseReceived: ress.length, uniqueRequestIds: byId.size };
  data._netFailed = cdp.net.filter((n) => n.kind === "failed");
  data._console = cdp.console.slice(-20);
  data._exceptions = cdp.exceptions.slice(-10);

  console.log("\n===== 接口请求 =====");
  console.log(
    "CDP 事件: requestWillBeSent=" + reqs.length + ", responseReceived=" + ress.length +
      " → 唯一 requestId=" + byId.size + (reqs.length > byId.size ? "  ⚠ 存在重复事件" : "")
  );
  const byStatus = {};
  const byPath = {};
  for (const r of data._requests) {
    const st = String(r.status);
    byStatus[st] = (byStatus[st] || 0) + 1;
    const p = r.path.replace(/\?.*$/, "");
    byPath[st + " " + p] = (byPath[st + " " + p] || 0) + 1;
  }
  console.log("真实请求数: " + data._requests.length + "，状态码分布:", JSON.stringify(byStatus));
  console.log("按路径:");
  for (const k of Object.keys(byPath).sort()) console.log("   " + k + " ×" + byPath[k]);
  const authPer = {};
  for (const r of data._requests) if (r.path.includes("auth")) authPer[r.method] = (authPer[r.method] || 0) + 1;
  console.log("登录端点:", JSON.stringify(authPer));
  if (data._netFailed.length) console.log("失败请求:", JSON.stringify(data._netFailed.slice(-10)));
  if (data._exceptions.length) console.log("页面异常:", JSON.stringify(data._exceptions));

  if (!verifier) {
    // 非列表阶段：只输出关键字段摘要，全量写文件
    console.log("\n===== 摘要 =====");
    if (data.stage === "detail") {
      for (const r of data.results) {
        console.log("[" + r.orgName + "] 字段:", JSON.stringify(r.fieldValues));
        console.log("  指标卡:", JSON.stringify(r.cards));
        console.log("  合计行:", JSON.stringify(r.total));
        console.log("  研究数:", r.studies.length, " 表格行:", r.rows.length);
      }
    } else if (data.stage === "stats") {
      console.log("tab:", data.selectedTab, " 卡片数:", data.cardCount, " 总览条:", data.totalBar);
      console.log("卡片:", JSON.stringify(data.cards, null, 2));
    } else if (data.stage === "trend") {
      console.log("标题:", data.title, "/", data.monthTitle);
      console.log("day:", data.dayCount, " sum:", data.daySum, " month:", data.monthCount, " sum:", data.monthSum);
      console.log("bars:", data.bars, " points:", data.points, " labels:", JSON.stringify(data.monthLabels));
      console.log("month 明细:", JSON.stringify(data.month));
    }
  } else {
    const okAll = printChecks("独立复算校验（以 iOS Model.swift 为准）", verifier(data));
    if (!okAll) EXIT = 2;

    const cs = data.callStats || {};
    console.log("\n===== 调用计数（插桩）=====");
    console.log("updateStudies 轮次:");
    for (const u of cs.updateStudies || []) {
      console.log("   perKey=" + JSON.stringify(u.perKey) + " startDate=" + u.startDate + " endDate=" + u.endDate);
    }
    const mi = cs.measurementInitial || {};
    const dup = Object.keys(mi).filter((k) => mi[k] > 1);
    console.log("测量的逻辑发起次数：共 " + Object.keys(mi).length + " 组，其中重复发起 " + dup.length + " 组");
    for (const k of dup) console.log("   ★ 重复 " + mi[k] + " 次: " + k);
    const ma = cs.measurementAttempts || {};
    const retried = Object.keys(ma).filter((k) => k.endsWith("|n1"));
    console.log("HTTP 尝试（含解码重试）：n0=" + Object.keys(ma).filter((k) => k.endsWith("|n0")).length + " 次, n1=" + retried.length + " 次");
    if ((cs.retryErrors || []).length) {
      console.log("重试原因（前 5 条）:");
      for (const r of cs.retryErrors.slice(0, 5)) console.log("   " + r.k + " → " + r.err);
    }
    console.log("登录调用次数: " + (cs.authCalls || []).length + " " + JSON.stringify((cs.authCalls || []).map((a) => a.org)));
    console.log("sendRequestWithTokenRefresh 结果: " + JSON.stringify((cs.refreshes || []).map((r) => (r.ok ? "ok " : "ERR ") + r.url)));

    console.log("\n===== 页面数据摘要 =====");
    for (const o of data.orgs) {
      console.log(
        "[" + o.name + "] 研究=" + o.studyCount + " 账单内测量=" + o.billingSuccessMeasurements +
          " 总充值=" + o.totalDepositsString + " 单价=" + o.unitPriceString +
          " 账单费用=" + o.billingCostString + " 余额=" + o.balanceString +
          " 周期内成功=" + o.periodSuccessString + " 周期内消费=" + o.periodCostString +
          " 计费日期=" + o.billingDate
      );
    }
    console.log("周期:", JSON.stringify(data.meta));
    console.log("\n每研究原始数据:");
    for (const o of data.orgs) {
      for (const s of o.studies) {
        console.log(
          "  [" + o.name + "] " + s.Name + " | 状态=" + s.StatusID + " 单价=" + s.unitPrice +
            " total=" + s.totalSuccessMeasurements + " period=" + s.periodSuccessMeasurements +
            " billing=" + s.billingSuccessMeasurements + " periodBilling=" + s.periodBillingSuccessMeasurements +
            " containsBilling=" + s.isPerioContainBilling +
            " 账单费用=" + r2(s.billingCost) + " 周期费用=" + (s.periodCost == null ? "-" : r2(s.periodCost))
        );
      }
    }
  }

  if (OUT) {
    fs.writeFileSync(path.resolve(OUT), JSON.stringify(data, null, 2));
    console.log("\n已写出:", path.resolve(OUT));
  }
  process.exitCode = EXIT;
}

main().catch((e) => {
  console.error("探针异常:", (e && e.stack) || e);
  process.exit(1);
});
