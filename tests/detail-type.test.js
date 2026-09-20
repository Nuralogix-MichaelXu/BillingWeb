#!/usr/bin/env node
/* ============================================================================
 * 账单详情页字号回归 —— 逐元素对齐设计稿 3:126「组织账单详情」
 *
 * 期望值全部取自 Ardot 设计稿（file 725650803887406 / frame 3:126）里各
 * TEXT 节点的 fontSize / fontName，不是从截图里估出来的，所以可以当硬标准。
 *
 * 本套件用 jsdom 解析真实 index.html 的 <style> 与级联（不看网络、不开浏览器），
 * 因此不需要 harness.js 的 DOM 桩 —— 这里要验的正是 CSS 级联本身。
 *
 *   node tests/detail-type.test.js
 *
 * 设计稿对照（node id → 字号/字重）：
 *   3:133 面包屑 13 Inter Regular        3:140 组织标题 26 Inter SemiBold
 *   3:142 地区徽章 12 NotoSansSC Regular  3:146/152/158/161/165/174/177/180 指标标签 12
 *   3:148/3:154/3:159/3:162/3:167/3:175/3:178/3:181 指标值 22（SemiBold）
 *   3:182 研究表标题 18 NotoSansSC SemiBold
 *   3:185-193 表头 12 NotoSansSC Medium   3:196... 正文 14 Inter Regular
 *   3:198 状态 13 NotoSansSC Medium       3:204/215/226/237/248 研究ID 13 Inter Regular
 *   3:251 合计标签 13 NotoSansSC Medium   3:255-258 合计数值 14 Inter SemiBold
 *   3:260 底部提示 12 NotoSansSC Regular
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

// 可选第 1 个参数指定 app 目录（用于「把修复回滚成缺陷副本」验证测试真能抓到回归）
const APP_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "../app");
const APP = path.join(APP_DIR, "index.html");

const results = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${actual}${ok ? "" : `  (期望 ${expected})`}`);
}

const dom = new JSDOM(fs.readFileSync(APP, "utf8"), { url: "http://127.0.0.1:4173/" });
const win = dom.window;
const doc = win.document;
const cs = (el) => win.getComputedStyle(el);
const px = (el) => parseFloat(cs(el).fontSize);

/** 造一个游离元素挂到容器里，用来读某个 class 组合的级联结果 */
function probe(className, parentSel, tag = "span") {
  const host = doc.querySelector(parentSel) || doc.body;
  const el = doc.createElement(tag);
  el.className = className;
  host.appendChild(el);
  const out = { size: px(el), weight: cs(el).fontWeight };
  el.remove();
  return out;
}

// ---------- 1. 指标卡：8 个数值必须统一 22px/600 ----------
console.log("\n[指标卡]");
const values = [...doc.querySelectorAll(".metric-card .metric-value")];
check("指标卡数值节点数量", values.length, 8);
const sizes = values.map(px);
check(
  "8 个指标值的字号全部为 22px",
  [...new Set(sizes)].join(","),
  "22"
);
// 历史上第 5~8 张卡（第二行）被 inline 19px / .blue 19px 压小过
check("指标值里不再出现 19px", sizes.includes(19), false);
check(
  "8 个指标值的字重全部为 600",
  [...new Set(values.map((v) => cs(v).fontWeight))].join(","),
  "600"
);
// 账单开始日期 / 地区 曾经写成 inline style="font-size:19px"，这里按节点逐个核
for (const [sel, label] of [
  ["#d-billingdate", "账单开始日期值"],
  ["#d-region", "地区值"],
  ["#d-period", "统计周期值"],
  ["#d-periodcost", "周期内消费值"],
]) {
  const el = doc.querySelector(sel);
  check(`  ${label} 自身字号 22px`, px(el), 22);
}
check("地区值走中文字体(--font-cn)", cs(doc.querySelector("#d-region").parentElement).fontFamily.includes("--font-cn"), true);
check("统计周期值走英文字体栈(中文可回退)", cs(doc.querySelector("#d-period").parentElement).fontFamily.includes("--font-en"), true);

// ---------- 2. 其余详情页元素 ----------
console.log("\n[其余元素]");
const CASES = [
  [".metric-label", "指标标签", 12],
  [".crumb", "面包屑", 13],
  [".org-title", "组织标题", 26],
  [".region-badge", "地区徽章", 12],
  [".section-title", "研究表标题", 18],
  [".detail-hint", "底部提示", 12],
  [".total-row .td.cn-label", "合计行标签", 13],
  [".row110", "（占位）", null],
];
const table = doc.querySelector(".table-card");
for (const [sel, label, want] of CASES) {
  if (want === null) continue;
  const el = doc.querySelector(sel);
  if (!el) {
    // 合计行标签是 JS 渲染的，静态 HTML 里没有 → 用级联探针代替
    const p = probe(sel.replace(/^\./, ""), ".table-card");
    check(`${label} 字号`, p.size, want);
    continue;
  }
  check(`${label} 字号`, px(el), want);
}

// 表头 12 / Medium(500)
const th = doc.querySelector(".table-head .th");
check("表头字号", px(th), 12);
check("表头字重", cs(th).fontWeight, "500");

// ---------- 3. 表格正文 / 状态 / 研究ID（JS 渲染，用级联探针） ----------
console.log("\n[表格单元格]");
const tbody = doc.querySelector("#research-rows") || doc.querySelector(".table-card");
const mk = (cls, text) => {
  const el = doc.createElement("span");
  el.className = cls;
  el.textContent = text;
  tbody.appendChild(el);
  return el;
};
const eDate = mk("td rw110", "2026-09-03");
const eName = mk("td cn rw190", "Joey 赵小吉");
const eStatus = mk("td cn status rw70", "有效");   // ← 曾漏了 .status，被 .td 的 14px 带偏
const eNum = mk("td rw140", "4");
const eKey = mk("td rw150", "c06e****458b");

check("表格·日期 14px", px(eDate), 14);
check("表格·研究名 14px", px(eName), 14);
check("表格·状态 13px（设计稿比正文小一号）", px(eStatus), 13);
check("表格·状态 字重 500 (Medium)", cs(eStatus).fontWeight, "500");
check("表格·数值 14px", px(eNum), 14);
[eDate, eName, eStatus, eNum, eKey].forEach((e) => e.remove());

// 研究ID 用 13px（app.js 里是 inline font-size:13px，这里校验 app.js 确实这么写）
const appJs = fs.readFileSync(path.join(APP_DIR, "app.js"), "utf8");
check("表格·研究ID 渲染时使用 13px", /rw150"\s*style="color:var\(--steel\);font-size:13px"/.test(appJs), true);

// ---------- 4. 防回归：状态列必须挂 .status 类 ----------
console.log("\n[防回归]");
check(
  "app.js 状态列带 .status 类",
  /class="td cn status rw70"/.test(appJs),
  true
);
check(
  ".metric-value.blue 不再覆盖字号",
  /\.metric-value\.blue\{[^}]*font-size/.test(fs.readFileSync(APP, "utf8")),
  false
);
check(
  "详情页不再有 inline font-size:19px",
  /metric-value[^>]*style="font-size:19px"/.test(fs.readFileSync(APP, "utf8")),
  false
);
console.log(`\n（被测目录：${APP_DIR}）`);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n详情页字号对齐：${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
