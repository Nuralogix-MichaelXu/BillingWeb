#!/usr/bin/env node
/**
 * 真实 DOM + 真实接口的周期切换验证（jsdom 加载 index.html，走本地中继打到线上接口）。
 *
 * 与 tests/period.test.js 的区别：
 *   period.test.js  —— 纯逻辑 + DOM stub，快速、离线、可复现。
 *   live-period.test.js —— jsdom 真实 DOM + 真实网络，最接近用户实际浏览器的环境。
 *
 * 需要先启动 server.js（默认 4173），且需配置测试账号。
 * 二者任一缺失时本套件自动跳过（不视为失败）。
 *
 * 用法:
 *   export BW_EMAIL='<账号邮箱>' BW_PASSWORD='<口令>'   # 不要写进代码
 *   node tests/live-period.test.js [baseURL]
 */
const path = require("path");
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const creds = require("../tools/_creds");

const BASE = process.argv[2] || "http://127.0.0.1:4173/";
const APP_INDEX = path.resolve(__dirname, "../app/index.html");

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(actual)}${ok ? "" : `  (期望 ${JSON.stringify(expected)})`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await reachable(BASE))) {
    console.log(`\n跳过热更新验证：${BASE} 无服务，请先启动 server.js。`);
    process.exit(0);
  }

  // 真实登录必须有账号。凭据只从环境变量取，缺了就跳过，不拿占位账号去撞生产接口。
  if (!creds.hasLiveCreds()) {
    console.log(
      `\n跳过真实环境周期验证：未配置 BW_EMAIL / BW_PASSWORD。\n` +
        `  export BW_EMAIL='<账号邮箱>' BW_PASSWORD='<口令>'  后重跑。`
    );
    process.exit(0);
  }

  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {});

  const dom = new JSDOM(fs.readFileSync(APP_INDEX, "utf8"), {
    url: BASE,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    resources: "usable",
    virtualConsole: vc,
  });
  const win = dom.window;

  // jsdom 无 fetch / AbortController：接上 Node 实现，并把相对地址补成绝对地址。
  win.AbortController = AbortController;
  win.AbortSignal = AbortSignal;
  const seen = [];
  win.fetch = (input, init) => {
    const url = typeof input === "string" ? new URL(input, BASE).toString() : input.url;
    seen.push(url);
    return fetch(url, init);
  };

  // 等三个脚本加载完（app.js 会跑顶层初始化）
  await sleep(1200);
  const $ = (id) => win.document.getElementById(id);

  // 登录页不再预填账号（需求：去掉默认测试账号），这里显式填入测试账号
  // （账号与口令来自 BW_EMAIL / BW_PASSWORD，不在仓库里留存）
  const setVal = (id, v) => {
    const el = $(id);
    if (!el) throw new Error(`未找到 ${id}`);
    el.value = v;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  setVal("login-org", creds.ORG);
  setVal("login-email", creds.email());
  setVal("login-pwd", creds.password());
  const loginBtn = $("login-btn");
  if (!loginBtn) throw new Error("未找到登录按钮，index.html 结构可能已变更");
  loginBtn.dispatchEvent(new win.Event("click", { bubbles: true }));
  // 有些实现是 form submit
  const form = $("login-form");
  if (form) form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));

  // 等首轮数据（登录 → licences → studies → 三路测量）
  const deadline = Date.now() + 90000;
  const listReady = () => win.document.querySelector("#org-rows .table-row");
  while (Date.now() < deadline && !listReady()) await sleep(500);
  const rows = win.document.querySelectorAll("#org-rows .table-row");
  if (!rows.length) throw new Error("登录后列表未出现数据行（检查账号/网络）");

  const periodOf = () => {
    const r = win.document.querySelector("#org-rows .table-row");
    if (!r) return null;
    const tds = r.querySelectorAll(".td");
    // 列序: 0名称 1地区 2研究 3账单内测量 4总充值 5单价 6账单费用 7余额 8周期内成功测量 9周期内消费 10账单开始日期
    return { success: tds[8] && tds[8].textContent.trim(), cost: tds[9] && tds[9].textContent.trim() };
  };

  const initial = periodOf();
  console.log(`\n初始周期数据: ${JSON.stringify(initial)}`);
  const reqCountBefore = seen.length;

  // 打开周期菜单 → 依次选择一个明显不同的周期
  const cyclePill = $("cycle-pill");
  const menuItems = () => [...win.document.querySelectorAll("#cycle-menu .menu-item")];
  if (!cyclePill) throw new Error("未找到周期选择控件");

  const picks = [
    { filter: "today", label: "今天" },
    { filter: "lastMonth", label: "上月" },
    { filter: "all", label: "全部" },
  ];

  const observed = [];
  for (const p of picks) {
    cyclePill.dispatchEvent(new win.Event("click", { bubbles: true }));
    await sleep(120);
    const item = menuItems().find((el) => el.dataset.filter === p.filter);
    if (!item) {
      console.log(`  (跳过 ${p.label}：菜单项不存在)`);
      continue;
    }
    item.dispatchEvent(new win.Event("click", { bubbles: true }));

    // 等本轮测量请求完成（胶囊文字变化 + 至少一个 measurements 请求）
    const pillText = $("cycle-pill-text");
    const wantPill = item.textContent.replace("✓", "").trim();
    const d2 = Date.now() + 45000;
    while (Date.now() < d2 && pillText.textContent.trim() !== wantPill) await sleep(200);
    await sleep(1500);
    observed.push({ ...p, want: wantPill, pill: pillText.textContent.trim(), ...periodOf() });
    console.log(`  选择「${p.label}」→ 胶囊=${pillText.textContent.trim()} 周期列=${JSON.stringify(periodOf())}`);
  }

  const reqAfter = seen.length;

  // 断言 1：切换周期确实重新发起了测量请求
  check("切换周期重新请求接口", reqAfter > reqCountBefore, true);

  // 断言 2：请求里出现了周期区间参数（Date= 且 EndDate=）
  const measured = seen.filter((u) => u.includes("measurements"));
  check("测量请求带周期区间参数", measured.some((u) => /[?&]Date=/.test(u) && /[?&]EndDate=/.test(u)), true);

  // 断言 3：胶囊文字与所选周期一致（说明选择被真正应用）
  check(
    "所选周期被应用（胶囊文案逐个匹配）",
    observed.every((o) => o.pill === o.want),
    true
  );

  // 断言 4：不同周期的数据确实不同（至少有一对不一样）
  const vals = observed.map((o) => `${o.success}|${o.cost}`);
  check("切换周期后数据发生更新", new Set(vals).size > 1, true);

  // 断言 5：自定义区间输入框是合法 yyyy-MM-dd（历史上这里被本地化字符串写坏）
  cyclePill.dispatchEvent(new win.Event("click", { bubbles: true }));
  await sleep(120);
  const customItem = menuItems().find((el) => el.dataset.filter === "custom");
  if (customItem) {
    customItem.dispatchEvent(new win.Event("click", { bubbles: true }));
    await sleep(400);
    const s = $("start-date-input");
    const e = $("end-date-input");
    console.log(`  自定义区间输入框: start="${s && s.value}" end="${e && e.value}"`);
    check("开始日期输入框为合法 yyyy-MM-dd", !!s && /^\d{4}-\d{2}-\d{2}$/.test(s.value), true);
    check("截止日期输入框为合法 yyyy-MM-dd", !!e && /^\d{4}-\d{2}-\d{2}$/.test(e.value), true);
  } else {
    console.log("  (自定义区间菜单项不存在，跳过)");
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n真实环境周期回归：${results.length - failed}/${results.length}`);
  dom.window.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("真实环境验证失败:", err && err.message);
  process.exit(1);
});
