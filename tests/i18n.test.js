/* ============================================================================
 * tests/i18n.test.js —— 语言切换（1-LoginView.swift LanguageSwitchButton）
 *
 * 覆盖：
 *   1. 双语表完整性（zh-Hans / en 同增同减、app.js 引用的 key 都在）
 *   2. index.html 静态文案守卫（不许有「没被本地化」的中文）
 *   3. LanguageManager：默认语言判定、持久化、isCNLanguage（iOS contains "zh"）
 *   4. Localized() 取值与回落
 *   5. 语言清单与国旗（顺序 = iOS keys.sorted()，国旗在文字右侧）
 *   6. 切换交互：按钮 → 菜单 → 选中 → 文案/持久化更新
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const { createHarness, DEFAULT_APP } = require("./harness");

let pass = 0;
const fails = [];
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) pass++;
  else fails.push(`  ✘ ${label}: ${actual}  (期望 ${expected})`);
  return ok;
}
function ok(label, cond, detail = "") {
  if (cond) pass++;
  else fails.push(`  ✘ ${label}${detail ? ": " + detail : ""}`);
  return cond;
}

/* ------------------------------------------------------------------ 1. 语言表 */
const appSource = fs.readFileSync(path.join(DEFAULT_APP, "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(DEFAULT_APP, "index.html"), "utf8");

function tableKeys(lang) {
  const h = createHarness();
  h.load("model.js");
  return Object.keys(h.get(`LocalizedStrings[${JSON.stringify(lang)}]`));
}
const zhKeys = tableKeys("zh-Hans");
const enKeys = tableKeys("en");

check("zh 表条目数 = en 表条目数", zhKeys.length, enKeys.length);
check("en 表缺少的 key", zhKeys.filter((k) => !enKeys.includes(k)).join(","), "");
check("zh 表缺少的 key", enKeys.filter((k) => !zhKeys.includes(k)).join(","), "");

/* app.js 里 Localized("x") 引用的每个 key 都要在两表里 */
{
  const used = new Set();
  for (const m of appSource.matchAll(/Localized\(\s*"([^"]+)"\s*\)/g)) used.add(m[1]);
  ok("app.js 至少引用了 60 个 key", used.size >= 60, `实际 ${used.size}`);
  check("引用了但 zh 表没有的 key", [...used].filter((k) => !zhKeys.includes(k)).join(","), "");
  check("引用了但 en 表没有的 key", [...used].filter((k) => !enKeys.includes(k)).join(","), "");
}

/* Web 专属 key 必须存在（iOS 无对应文案，容易被漏） */
{
  const webOnly = [
    "app_title", "settings", "logout", "org_list_title", "back", "back_to_list",
    "back_to_statistics", "chart_analysis", "detail_edit_hint",
    "account_info", "account_info_email", "account_info_region",
  ];
  check("Web 专属 key 缺失", webOnly.filter((k) => !zhKeys.includes(k) || !enKeys.includes(k)).join(","), "");
}

/* ------------------------------------------------- 2. index.html 静态文案守卫 */
/**
 * 这些 id 对应的中文是「JS 渲染时用 Localized() 回填」的（如列表表头、统计标题），
 * 因此不需要在 HTML 上写 data-i18n。下面的用例会逐个校验它们确实由 app.js 接管，
 * 防止白名单变成"随便往里塞"的漏洞。
 */
const JS_MANAGED_IDS = new Set([
  "login-note", "mode-toggle", "login-btn-text", "multi-text",
  "update-time", "refresh-btn-text", "cycle-pill-text",
  "d-crumb", "d-region-badge", "d-region", "d-period", "d-total-label",
  "th-created", "th-name", "th-status", "th-unitprice", "th-period-success",
  "th-period-cost", "th-billing-success", "th-billing-cost", "th-study-id",
  "stats-crumb", "stats-title", "stats-tab-custom", "stats-tab-bill", "stats-total-bar",
  "stats-f-title", "stats-f-count", "stats-f-cost",
  "stats-s-title", "stats-s-count", "stats-s-cost",
  "stats-t-title", "stats-t-count", "stats-t-cost",
  "trend-crumb", "trend-title", "trend-loading-text", "trend-loading-tip",
  "trend-day-title", "trend-month-title", "trend-day-hint", "trend-month-hint",
]);

const CJK = /[\u4e00-\u9fff]/;
const VOID_TAGS = new Set([
  "input", "br", "img", "hr", "meta", "link", "source", "path", "rect", "circle",
  "ellipse", "line", "polyline", "polygon", "use", "stop", "area", "col", "embed",
  "track", "wbr", "!doctype",
]);
function attrOf(tag, name) {
  // 必须要求前面是空白，否则 `id="x"` 会误匹配 `data-page-node-id="x"`
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}
/** 扫描 HTML：任何带中文的文本 / title / placeholder 都必须可本地化 */
function findUnlocalizedCJK(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
  const problems = [];
  const stack = [];
  const tokenRe = /<[^>]+>|[^<]+/g;
  let m;
  while ((m = tokenRe.exec(s))) {
    const tok = m[0];
    if (tok[0] === "<") {
      if (tok.startsWith("</")) { stack.pop(); continue; }
      const name = (/^<([a-zA-Z0-9!-]+)/.exec(tok)?.[1] || "").toLowerCase();
      for (const [attr, i18nAttr] of [
        ["title", "data-i18n-title"],
        ["placeholder", "data-i18n-placeholder"],
        ["alt", "data-i18n-alt"],
      ]) {
        const v = attrOf(tok, attr);
        if (v && CJK.test(v) && !tok.includes(i18nAttr)) {
          problems.push(`属性 ${attr}="${v.slice(0, 18)}" 缺少 ${i18nAttr}（<${name} id="${attrOf(tok, "id") ?? "-"}">）`);
        }
      }
      const selfClose = /\/>$/.test(tok) || VOID_TAGS.has(name);
      if (!selfClose) stack.push(tok);
      continue;
    }
    if (!CJK.test(tok) || !tok.trim()) continue;
    const parent = stack[stack.length - 1];
    if (!parent) { problems.push(`无归属元素的中文文本「${tok.trim().slice(0, 18)}」`); continue; }
    if (parent.includes("data-i18n")) continue;
    const pid = attrOf(parent, "id");
    if (pid && JS_MANAGED_IDS.has(pid)) continue;
    problems.push(`中文文本「${tok.trim().slice(0, 18)}」所在元素 <${(/^<([a-zA-Z0-9-]+)/.exec(parent)?.[1] || "")} id="${pid ?? "-"}"> 既没有 data-i18n 也不在 JS 托管白名单里`);
  }
  return problems;
}
{
  const problems = findUnlocalizedCJK(htmlSource);
  check("index.html 未本地化的中文（应为空）", problems.join(" | "), "");
  ok("HTML 里确实存在带中文的静态文案（守卫没空跑）",
    findUnlocalizedCJK(htmlSource.replace(/data-i18n(-\w+)?="[^"]*"/g, "")).length > 5);
}
/* 白名单本身要被校验：每个 id 都得真的在 app.js 里被取用 */
{
  const notManaged = [...JS_MANAGED_IDS].filter((id) => !appSource.includes(`"${id}"`));
  check("白名单里但 app.js 未接管的 id", notManaged.join(","), "");
}
/* applyI18n 必须真的被调用（否则 data-i18n 是死代码） */
{
  ok("Router.go 调用了 applyI18n()", /applyI18n\(\);\s*\/\/ 静态文案/.test(appSource));
  ok("init 调用了 applyI18n()", /LanguageSwitcher\.render\(\);\s*\n\s*applyI18n\(\);/.test(appSource));
}

/* --------------------------------------------- 3. LanguageManager 默认语言判定 */
function freshModel(opts) {
  const h = createHarness(opts);
  h.load("model.js");
  return h;
}
check("默认（浏览器 zh-CN）→ zh-Hans", freshModel({ language: null }).get("LanguageManager.currentLanguage"), "zh-Hans");
check("浏览器 en-US → en", freshModel({ language: null, browserLanguage: "en-US" }).get("LanguageManager.currentLanguage"), "en");
check("浏览器 zh-Hant-TW → zh-Hans", freshModel({ language: null, browserLanguage: "zh-Hant-TW" }).get("LanguageManager.currentLanguage"), "zh-Hans");
check("浏览器 en-GB → en", freshModel({ language: null, browserLanguage: "en-GB" }).get("LanguageManager.currentLanguage"), "en");
check("无 navigator.language → en", freshModel({ language: null, browserLanguage: "" }).get("LanguageManager.currentLanguage"), "en");
check("已持久化 en（浏览器是中文）→ en", freshModel({ language: "en" }).get("LanguageManager.currentLanguage"), "en");
check("已持久化 zh-Hans（浏览器是英文）→ zh-Hans", freshModel({ language: "zh-Hans", browserLanguage: "en-US" }).get("LanguageManager.currentLanguage"), "zh-Hans");
check("持久化非法值 → 回落浏览器语言", freshModel({ language: "fr", browserLanguage: "en-US" }).get("LanguageManager.currentLanguage"), "en");

/* isCNLanguage：iOS 是 contains("zh")，不是 === "zh-Hans" */
{
  const h = freshModel();
  check("zh-Hans → isCN", h.get("LanguageManager.isCNLanguage()"), true);
  h.run(`LanguageManager.currentLanguage = "en"`);
  check("en → !isCN", h.get("LanguageManager.isCNLanguage()"), false);
  h.run(`LanguageManager.currentLanguage = "zh-Hant"`);
  check("zh-Hant（iOS contains zh）→ isCN", h.get("LanguageManager.isCNLanguage()"), true);
}

/* setLanguage 持久化 + 非法值忽略 */
{
  const h = freshModel();
  h.run(`LanguageManager.setLanguage("en")`);
  check("setLanguage 写入 localStorage", h.store.AppLanguage, "en");
  check("setLanguage 切换 currentLanguage", h.get("LanguageManager.currentLanguage"), "en");
  h.run(`LanguageManager.setLanguage("de")`);
  check("非法语言被忽略", h.get("LanguageManager.currentLanguage"), "en");
  check("非法语言不写存储", h.store.AppLanguage, "en");
}

/* ------------------------------------------------------------------ 4. Localized */
{
  const h = freshModel();
  check("zh: login_title", h.get(`Localized("login_title")`), "请登录");
  check("zh: analysis_month_title 为 12 个月", h.get(`Localized("analysis_month_title")`), "12个月测量趋势");
  h.run(`LanguageManager.setLanguage("en")`);
  check("en: login_title", h.get(`Localized("login_title")`), "Please Login");
  check("en: analysis_month_title", h.get(`Localized("analysis_month_title")`), "12-Month Trend");
  check("en: 未翻译的 key 回落 key 本身", h.get(`Localized("no_such_key")`), "no_such_key");
  h.run(`LanguageManager.currentLanguage = "fr"`);
  check("未知语言回落 zh 表而非抛错", h.get(`Localized("login_title")`), "请登录");
}

/* -------------------------------------------------------- 5. 语言清单与国旗 */
{
  const h = freshModel();
  check("语言数量 = 2（同 iOS）", h.get("AppLanguages.length"), 2);
  check("顺序第 1 项 = en（iOS keys.sorted）", h.get("AppLanguages[0].code"), "en");
  check("顺序第 2 项 = zh-Hans", h.get("AppLanguages[1].code"), "zh-Hans");
  check("英文名 = English（不沿用 iOS 笔误 Eglish）", h.get("AppLanguages[0].name"), "English");
  check("中文名 = 中文", h.get("AppLanguages[1].name"), "中文");
  check("英文旗 = 美国", h.get("AppLanguages[0].flag"), "us");
  check("中文旗 = 中国", h.get("AppLanguages[1].flag"), "cn");
  ok("渲染出的英文语言项文案是 English（不沿用 iOS 笔误 Eglish）",
    h.get("AppLanguages.map(l => l.name).join('/')") === "English/中文");
  // 国旗必须是内联 SVG（emoji 旗帜在 Windows Chrome 上会退化成字母）
  ok("国旗是内联 SVG，不是 emoji", /<svg class="flag" data-flag="cn"/.test(appSource) && /<svg class="flag" data-flag="us"/.test(appSource));
  ok("没有使用 emoji 区域指示符", !/[\u{1F1E6}-\u{1F1FF}]/u.test(appSource));
}

/* -------------------------------------------------------- 6. 切换交互 */
function bootApp(opts) {
  const h = createHarness(opts);
  h.load("model.js");
  h.load("api.js");
  h.load("app.js");
  return h;
}
{
  const h = bootApp();
  const btn = h.els["lang-btn"];
  // 初始按钮：中文 + 中国国旗，国旗在文字右侧
  ok("按钮显示当前语言名", /<span>中文<\/span>/.test(btn.innerHTML), btn.innerHTML.slice(0, 80));
  ok("按钮国旗在文字右侧", /<span>中文<\/span><svg class="flag" data-flag="cn"/.test(btn.innerHTML), btn.innerHTML.slice(0, 120));
  check("按钮初始 aria-expanded=false", btn.getAttribute("aria-expanded"), "false");
  check("菜单初始收起", h.els["lang-menu"].classList.contains("open"), false);

  // 展开
  btn.fire("click");
  check("点击后菜单展开", h.els["lang-menu"].classList.contains("open"), true);
  check("点击后 aria-expanded=true", btn.getAttribute("aria-expanded"), "true");
  const items = h.langItems();
  check("下拉项数量 = 2", items.length, 2);
  check("下拉项顺序 1 = en", items[0].dataset.lang, "en");
  check("下拉项顺序 2 = zh-Hans", items[1].dataset.lang, "zh-Hans");
  ok("英文项：English + 美国旗（旗在文字右侧）",
    /<span>English<\/span><svg class="flag" data-flag="us"/.test(items[0].innerHTML), items[0].innerHTML.slice(0, 140));
  ok("中文项：中文 + 中国旗（旗在文字右侧）",
    /<span>中文<\/span><svg class="flag" data-flag="cn"/.test(items[1].innerHTML), items[1].innerHTML.slice(0, 140));
  ok("当前项高亮（active）", items[1].innerHTML.includes("lang-item active"));
  check("当前项 aria-selected", items[1].innerHTML.includes('aria-selected="true"'), true);
  check("非当前项 aria-selected", items[0].innerHTML.includes('aria-selected="false"'), true);

  // 点 English
  items[0].fire("click");
  check("切换后 currentLanguage", h.get("LanguageManager.currentLanguage"), "en");
  check("切换后写入存储", h.store.AppLanguage, "en");
  check("切换后菜单收起", h.els["lang-menu"].classList.contains("open"), false);
  ok("按钮文案变 English", /<span>English<\/span>/.test(btn.innerHTML), btn.innerHTML.slice(0, 80));
  ok("按钮国旗变美国", /data-flag="us"/.test(btn.innerHTML), btn.innerHTML.slice(0, 120));
  check("Localized 随语言变化", h.get(`Localized("login_title")`), "Please Login");
  check("日期格式随语言变化（iOS yyyyMMddDateString）", h.get(`yyyyMMddDateString(new Date(2020,0,5))`), "01/05/2020");
  check("切换后 active 项变成 en", h.langItems()[0].innerHTML.includes("lang-item active"), true);

  // 再切回中文
  h.langItems()[1].fire("click");
  check("切回中文", h.get("LanguageManager.currentLanguage"), "zh-Hans");
  check("切回后日期格式", h.get(`yyyyMMddDateString(new Date(2020,0,5))`), "2020.01.05");
  check("切回后存储", h.store.AppLanguage, "zh-Hans");
}

/* 语言选择是持久的：新一次启动直接是英文 */
{
  const h = bootApp({ language: "en" });
  check("再次启动读取持久化语言", h.get("LanguageManager.currentLanguage"), "en");
  ok("再次启动按钮显示 English", /<span>English<\/span>/.test(h.els["lang-btn"].innerHTML));
}

/* ---------------------------------------------------------------- 输出 */
console.log(`语言切换回归：${pass}/${pass + fails.length}`);
if (fails.length) {
  console.log(fails.join("\n"));
  process.exitCode = 1;
}
