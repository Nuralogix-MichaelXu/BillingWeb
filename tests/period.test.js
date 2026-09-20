/* ============================================================================
 * 周期选择（DateFilter）回归测试
 *
 * 覆盖三类问题：
 *  A. 周期区间计算是否与 iOS `Calendar` 语义一致（月初/上周等边界）
 *  B. 选周期后是否真的重新请求测量接口、并把新数据写进表格
 *  C. 自定义周期：日期输入框是否可用、确定后是否按新区间取数
 * ==========================================================================*/
const { createHarness } = require("./harness");

// 允许指定被测目录（用于在"未修复"的副本上确认测试确实抓得住缺陷）
const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, check, waitFor, sleep, get, run } = h;

/* 断言用的小工具 */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hms = (d) => `${d.getHours()}:${d.getMinutes()}:${d.getSeconds()}.${d.getMilliseconds()}`;
const isMidnight = (d) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
const isEndOfDay = (d) => d.getHours() === 23 && d.getMinutes() === 59 && d.getSeconds() === 59;
/** 只设置区间、不发请求（needRequest=false） */
const setFilter = (f) => run(`ListPage.performFilter(${JSON.stringify(f)}, false)`);
const S = (expr) => get(`AppState.list.${expr}`);

(async function main() {
  h.load("model.js");
  h.load("api.js");

  run(`
    globalThis.__calls = [];
    globalThis.__round = 0;
    APIClient.login = async (email, password, orgName, region) => ({ Token: "T-" + orgName });
    APIClient.getAllStudies = async () => ({
      "support0": [ new StudyResponse({ Created: 1757000000, ID: "c06eabcdef458b", Name: "研究1",
        Description: "", StatusID: "ACTIVE", Measurements: 0 }) ],
    });
    APIClient.updateStudies = async function (studyDic, billingDateDic, startDate, endDate, progress) {
      globalThis.__calls.push({
        billing: billingDateDic != null,
        start: startDate ? startDate.getTime() : null,
        end: endDate ? endDate.getTime() : null,
        round: globalThis.__round,
      });
      for (const key of Object.keys(studyDic)) {
        for (const s of studyDic[key]) { s.totalSuccessMeasurements = globalThis.__round; progress(); progress(); }
      }
    };
  `);
  h.load("app.js");

  /* ======================= A. 周期区间计算 ======================= */
  console.log("\n=== A. 周期区间（对齐 iOS Calendar）===");
  const now = new Date();

  S("selectedFilter");

  setFilter("none");
  check("none·start=end(now)", S("startDate").getTime() === S("endDate").getTime(), true);

  setFilter("all");
  check("all·起点=2020-01-01", ymd(S("startDate")), "2020-01-01");
  check("all·起点时刻=00:00:00", isMidnight(S("startDate")), true);
  check("all·终点=now", Math.abs(S("endDate").getTime() - new Date().getTime()) < 3000, true);

  setFilter("today");
  check("today·起点=今天00:00", `${ymd(S("startDate"))} ${hms(S("startDate"))}`, `${ymd(new Date())} 0:0:0.0`);

  setFilter("yesterday");
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  check("yesterday·起=昨天00:00", `${ymd(S("startDate"))} ${isMidnight(S("startDate"))}`, `${ymd(y)} true`);
  check("yesterday·止=昨天23:59:59", `${ymd(S("endDate"))} ${isEndOfDay(S("endDate"))}`, `${ymd(y)} true`);

  setFilter("beforeYesterday");
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2);
  check("beforeYesterday·起=前天00:00", `${ymd(S("startDate"))} ${isMidnight(S("startDate"))}`, `${ymd(b)} true`);
  check("beforeYesterday·止=前天23:59:59", `${ymd(S("endDate"))} ${isEndOfDay(S("endDate"))}`, `${ymd(b)} true`);

  setFilter("thisWeek");
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
  check("thisWeek·起=本周一00:00", `${ymd(S("startDate"))} ${isMidnight(S("startDate"))} ${S("startDate").getDay()}`, `${ymd(monday)} true 1`);
  check("thisWeek·止=now", Math.abs(S("endDate").getTime() - new Date().getTime()) < 3000, true);

  setFilter("lastWeek");
  const lastMon = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
  const lastSun = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 1);
  check("lastWeek·起=上周一00:00", `${ymd(S("startDate"))} ${isMidnight(S("startDate"))}`, `${ymd(lastMon)} true`);
  check("lastWeek·止=上周日23:59:59", `${ymd(S("endDate"))} ${isEndOfDay(S("endDate"))}`, `${ymd(lastSun)} true`);

  setFilter("thisMonth");
  check("thisMonth·起=本月1日", ymd(S("startDate")), ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
  check("thisMonth·起点为00:00:00（不能带当前时刻）", isMidnight(S("startDate")), true);
  check("thisMonth·止=now", Math.abs(S("endDate").getTime() - new Date().getTime()) < 3000, true);

  setFilter("lastMonth");
  const lmFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lmLast = new Date(now.getFullYear(), now.getMonth(), 0);
  check("lastMonth·起=上月1日", ymd(S("startDate")), ymd(lmFirst));
  check("lastMonth·起点为00:00:00", isMidnight(S("startDate")), true);
  check("lastMonth·止=上月最后一天23:59:59", `${ymd(S("endDate"))} ${isEndOfDay(S("endDate"))}`, `${ymd(lmLast)} true`);

  setFilter("halfYear");
  const sixAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  check("halfYear·起=半年前同刻", Math.abs(S("startDate").getTime() - sixAgo.getTime()) < 2000, true);
  check("halfYear·止=now", Math.abs(S("endDate").getTime() - new Date().getTime()) < 3000, true);

  setFilter("oneYear");
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  check("oneYear·起=一年前同刻", Math.abs(S("startDate").getTime() - yearAgo.getTime()) < 2000, true);

  /* 区间赋值要同步 startDateString / endDateString（对应 iOS didSet） */
  const todayStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  setFilter("today");
  check("today·startDateString 已同步", S("startDateString"), todayStr);
  run('AppState.list.lastSelectedFilter = DateFilter.today;');
  setFilter("custom");
  check("custom·endDateString=至今", S("endDateString"), "至今");
  check("custom·显示区间视图", S("isCustomDatePickerPresented"), true);
  check("custom·区间视图已渲染", els["custom-range"].style.display, "flex");
  check("custom·周期胶囊隐藏", els["cycle-row"].style.display, "none");

  /* ======================= B. 选周期 → 重新请求 → 数据更新 ======================= */
  console.log("\n=== B. 选周期后重新取数并更新表格 ===");
  els["login-org"].value = "support"; els["login-org"].fire("input");
  els["login-email"].value = "a@b.com"; els["login-email"].fire("input");
  els["login-pwd"].value = "p"; els["login-pwd"].fire("input");
  run("globalThis.__round = 1;");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(60);
  check("登录后默认周期=none", S("selectedFilter"), "none");
  check("none·周期列为「-」", S("orgs[0].periodSuccessString"), "-");
  check("none·账单内测量已取到", S("orgs[0].billingSuccessMeasurements"), 1);

  // 选「今天」
  run("globalThis.__calls = []; globalThis.__round = 2;");
  const before2 = S("orgs[0].periodSuccessString");
  h.pickFilter("today");
  await waitFor("AppState.list.isRefreshing === true");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(80);
  check("选「今天」后胶囊文案", els["cycle-pill-text"].textContent, "今天");
  check("选「今天」后发出周期请求", get("__calls.some(c => !c.billing)"), true);
  const todayCall = get("__calls.find(c => !c.billing && c.end != null)");
  check("周期请求·Date=今天00:00", ymd(new Date(todayCall.start)) + " " + isMidnight(new Date(todayCall.start)), `${ymd(now)} true`);
  check("周期请求·EndDate=now", Math.abs(todayCall.end - new Date().getTime()) < 5000, true);
  check("选「今天」后周期列 已更新", `${before2} → ${S("orgs[0].periodSuccessString")}`, "- → 2");
  check("选「今天」后表格已重绘", els["org-rows"].innerHTML.includes(">2<"), true);
  check("选「今天」后周期费用已重算", S("orgs[0].periodCostString"), "2");

  // 再选「昨天」—— 数据必须跟着变
  run("globalThis.__calls = []; globalThis.__round = 3;");
  h.pickFilter("yesterday");
  await waitFor("AppState.list.isRefreshing === true");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(80);
  const yCall = get("__calls.find(c => !c.billing && c.end != null)");
  check("切「昨天」后胶囊文案", els["cycle-pill-text"].textContent, "昨天");
  check("切「昨天」·请求区间=昨天全天", `${ymd(new Date(yCall.start))}~${ymd(new Date(yCall.end))}`, `${ymd(y)}~${ymd(y)}`);
  check("切「昨天」后周期列 已更新", S("orgs[0].periodSuccessString"), "3");
  check("切「昨天」后表格已重绘", els["org-rows"].innerHTML.includes(">3<"), true);

  // 选「全部」→ EndDate 存在
  run("globalThis.__calls = []; globalThis.__round = 4;");
  h.pickFilter("all");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(80);
  const allCall = get("__calls.find(c => !c.billing && c.end != null)");
  check("切「全部」·起点=2020-01-01", ymd(new Date(allCall.start)), "2020-01-01");
  check("切「全部」后周期列", S("orgs[0].periodSuccessString"), "4");

  // 连续快速切换：只有最后一次生效
  run("globalThis.__calls = []; globalThis.__round = 5;");
  h.pickFilter("thisWeek");
  await sleep(60);
  run("globalThis.__round = 9;");
  h.pickFilter("lastMonth");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(200);
  check("快速连切·最终周期=lastMonth", S("selectedFilter"), "lastMonth");
  check("快速连切·胶囊=上月", els["cycle-pill-text"].textContent, "上月");
  check("快速连切·周期列=最后一次的结果", S("orgs[0].periodSuccessString"), "9");

  /* ======================= C. 自定义周期 ======================= */
  console.log("\n=== C. 自定义周期（日期输入框 + 确定取数）===");
  h.pickFilter("custom");
  await sleep(60);
  const startVal = els["start-date-input"].value;
  const endVal = els["end-date-input"].value;
  check("自定义·开始日期输入框非空", /^\d{4}-\d{2}-\d{2}$/.test(startVal), true);
  check("自定义·截止日期输入框非空", /^\d{4}-\d{2}-\d{2}$/.test(endVal), true);
  // iOS：savedStartDate/EndDate 会被每次 performFilter 的 didSet 覆盖，
  // 所以自定义视图回填的是「上一个周期的区间」；无 savedXxx 时退回 startDate/endDate
  check("自定义·开始日期=当前区间起点", startVal, S("savedStartDate") ? ymd(S("savedStartDate")) : ymd(S("startDate")));
  check("自定义·截止日期=当前区间终点", endVal, S("savedEndDate") ? ymd(S("savedEndDate")) : ymd(S("endDate")));
  check("自定义·不再停留在周期胶囊视图", els["cycle-row"].style.display, "none");
  check("自定义·区间视图可见", els["custom-range"].style.display, "flex");

  // 改开始日期 → 内部状态同步（00:00:00）
  els["start-date-input"].value = "2026-09-01";
  els["start-date-input"].fire("change", { target: els["start-date-input"] });
  check("改开始日期·startDate=2026-09-01 00:00", `${ymd(S("startDate"))} ${isMidnight(S("startDate"))}`, "2026-09-01 true");
  check("改开始日期·startDateString 同步", S("startDateString"), "2026.09.01");

  // 改截止日期 → 23:59:59
  els["end-date-input"].value = "2026-09-10";
  els["end-date-input"].fire("change", { target: els["end-date-input"] });
  check("改截止日期·endDate=2026-09-10 23:59:59", `${ymd(S("endDate"))} ${isEndOfDay(S("endDate"))}`, "2026-09-10 true");

  // 点「开始时间」确定 → 按新区间取数
  run("globalThis.__calls = []; globalThis.__round = 7;");
  els["confirm-start"].fire("click");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(80);
  const cCall = get("__calls.find(c => !c.billing && c.end != null)");
  check("自定义·确定后发出请求", cCall != null, true);
  check("自定义·请求起点=2026-09-01", cCall ? ymd(new Date(cCall.start)) : "无", "2026-09-01");
  check("自定义·请求终点=2026-09-10", cCall ? ymd(new Date(cCall.end)) : "无", "2026-09-10");
  check("自定义·周期列已更新", S("orgs[0].periodSuccessString"), "7");
  check("自定义·统计周期显示区间", S("billingPeriod"), "2026.09.01 ~ 2026.09.10");

  // 输入框直接键入后马上点确定（change 还没触发）也要用输入框的值
  els["start-date-input"].value = "2026-08-01";
  run("globalThis.__calls = []; globalThis.__round = 8;");
  els["confirm-start"].fire("click");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(80);
  const typed = get("__calls.find(c => !c.billing && c.end != null)");
  check("直接键入日期后点确定·用输入框的值", typed ? ymd(new Date(typed.start)) : "无", "2026-08-01");

  // 重置开始时间 → 回到 2020-01-01（且显示「至今」逻辑不变）
  run("globalThis.__calls = [];");
  els["reset-start"].fire("click");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(80);
  const rCall = get("__calls.find(c => !c.billing && c.end != null)");
  check("重置开始时间·请求起点=2020-01-01", rCall ? ymd(new Date(rCall.start)) : "无", "2020-01-01");
  check("重置开始时间·startDateString=2020.01.01", S("startDateString"), "2020.01.01");

  // 重置截止时间 → 至今
  els["reset-end"].fire("click");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(80);
  check("重置截止时间·endDateString=至今", S("endDateString"), "至今");
  check("重置截止时间·输入框回填为今天", els["end-date-input"].value, ymd(new Date()));

  // 返回按钮 → 回到上一个周期
  els["back-to-list-from-range"].fire("click");
  await waitFor("AppState.list.isRefreshing === false");
  await sleep(60);
  check("返回·不再显示区间视图", S("isCustomDatePickerPresented"), false);
  check("返回·周期回到上一个（lastMonth）", S("selectedFilter"), "lastMonth");

  console.log(h.results.join("\n"));
  const r = h.report();
  console.log(`\n周期回归：${r.text}${r.failed ? `（失败 ${r.failed}）` : ""}`);
  process.exit(r.failed ? 1 : 0);
})();
