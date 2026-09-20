/* ============================================================================
 * 测量趋势页（7-AnalysisView.swift）回归
 * 覆盖：30天/12月时间点生成、UTC 缓存键、近似 iOS 刻度、
 *       聚合请求编排（今天/本月强制刷新，其余走缓存；每点逐账号求和）、
 *       折线/柱状 SVG 渲染与选中态、公司入口过滤、返回统计分析。
 * 运行：node tests/trend.test.js
 * 可选参数：<appDir> 指定被测目录（用于在缺陷副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const vm = require("vm");
const { createHarness } = require("./harness");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, check, results } = h;

function pad(n) {
  return String(n).padStart(2, "0");
}

(async function main() {
  load("model.js");
  load("api.js");

  // 记录 getMeasurementInfo 调用；lssd_01 每次 10 次、其余 5 次
  run(`
    globalThis.__calls = [];
    APIClient.login = async function () { return { Token: "TOKEN" }; };
    APIClient.getAllStudies = async function () { return {}; };
    APIClient.updateStudies = async function () {};
    APIClient.getMeasurementInfo = async function (orgName, region, studyID, date, endDate, progress) {
      __calls.push({ orgName, region, date, endDate });
      if (progress) progress();
      if (progress) progress();
      return new MeasurementInfo(orgName, studyID, orgName === "lssd_01" ? 10 : 5);
    };
  `);

  load("app.js");

  /* ---------- 0. 纯函数 ---------- */
  const dayStarts = get("trendLast30DayStarts")();
  check("30 天时间点数量", dayStarts.length, 30);
  const today = new Date();
  const lastDay = dayStarts[29];
  check("最后一天=今天", `${lastDay.getFullYear()}-${pad(lastDay.getMonth() + 1)}-${pad(lastDay.getDate())}`,
    `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  const firstDay = dayStarts[0];
  const expectFirst = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
  check("第一天=今天-29", firstDay.getTime(), expectFirst.getTime());
  check("每天为本地 00:00", firstDay.getHours(), 0);

  const monthStarts = get("trendLast12MonthStarts")();
  check("12 个月时间点数量", monthStarts.length, 12);
  check("最后一个月=本月 1 日", monthStarts[11].getMonth(), today.getMonth());
  const expectFirstMonth = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  check("第一个月=本月-11（跨年回溯）", monthStarts[0].getTime(), expectFirstMonth.getTime());
  check("每月均为 1 日 00:00", monthStarts.every((m) => m.getDate() === 1 && m.getHours() === 0), true);
  check("月份序列递增且连续（含跨年）",
    monthStarts.every((m, i) => {
      if (i === 0) return true;
      const prev = monthStarts[i - 1];
      return m.getTime() === new Date(prev.getFullYear(), prev.getMonth() + 1, 1).getTime();
    }), true);

  // 缓存键用 GMT formatter：传 UTC 意义的日期断言（与本地时区无关）
  check("UTC 日键", get("trendUTCDayString")(new Date(Date.UTC(2026, 8, 17, 16, 0, 0))), "2026-09-17");
  check("UTC 月键", get("trendUTCMonthString")(new Date(Date.UTC(2026, 8, 0, 12))), "2026-08");

  const t1 = get("trendNiceTicks")(460);
  check("刻度 460 → top 600", t1.top, 600);
  check("刻度 460 → [0,200,400,600]", t1.ticks.join(","), "0,200,400,600");
  const t2 = get("trendNiceTicks")(3800);
  check("刻度 3800 → top 4000", t2.top, 4000);
  check("刻度 3800 → 5 档", t2.ticks.length, 5);
  check("刻度 0 → top 1", get("trendNiceTicks")(0).top, 1);

  const path2 = get("trendCatmullRomPath")([[0, 100], [100, 50]]);
  check("平滑路径含贝塞尔段", path2.startsWith("M 0.0 100.0") && path2.includes(" C "), true);

  check("iOS 格式串 %1$@/%2$@", get("trendFormatArgs")("已选中：%1$@，测量次数：%2$@", "2026-09-12", "460"),
    "已选中：2026-09-12，测量次数：460");
  check("iOS 格式串 %@", get("trendFormatArgs")("%@月", "09"), "09月");

  /* ---------- 1. 登录 → 造 2 个账号 → 汇总入口打开趋势页 ---------- */
  els["login-org"].value = "support";
  els["login-org"].fire("input");
  els["login-email"].value = "a@a.com";
  els["login-email"].fire("input");
  els["login-pwd"].value = "pwd";
  els["login-pwd"].fire("input");
  els["login-form"].fire("submit");
  await h.waitFor('AppState.currentPage === "list"');

  run(`
    SharedUsers = [
      makeUser({ key: "lssd_010", orgName: "lssd_01", email: "a@a.com", password: "p", region: 0 }),
      makeUser({ key: "junying1", orgName: "junying_01", email: "b@b.com", password: "p", region: 1 }),
    ];
  `);

  els["stats-chart-summary"].fire("click");
  await h.waitFor('AppState.currentPage === "trend"');
  check("汇总入口进入趋势页", get("AppState").currentPage, "trend");
  check("标题=全部", els["trend-title"].textContent, "全部");
  check("面包屑=统计分析 / 全部", els["trend-crumb"].textContent, "统计分析 / 全部");
  check("targetUsers=全部账号", get("TrendPage.targetUsers")().length, 2);

  await h.waitFor('document.getElementById("trend-content").style.display === "flex"');
  check("加载态隐藏", els["trend-loading"].style.display, "none");

  /* ---------- 2. 数据聚合：30 天 × 2 账号 + 12 月 × 2 账号 ---------- */
  const callCount = () => get("__calls.length");
  const callsAfterFirstLoad = callCount();
  check("首次加载请求数=30×2+12×2", callsAfterFirstLoad, 84);
  check("今天有请求（date=今天 00:00 的 UTC 串）",
    get(`__calls.some(c => c.date === toUTCString(TrendPage.dayData[29].date))`), true);
  check("dayData 长度=30", get("TrendPage.dayData.length"), 30);
  check("monthData 长度=12", get("TrendPage.monthData.length"), 12);
  check("每日聚合=两账号之和", get("TrendPage.dayData[0].count"), 15);
  check("每月聚合=两账号之和", get("TrendPage.monthData[0].count"), 15);
  check("进度到 100%", els["trend-pct"].textContent, "100%");

  /* ---------- 3. 图表渲染 ---------- */
  const dayPlot = els["trend-day-plot"].innerHTML;
  check("折线图有 SVG", dayPlot.includes("<svg"), true);
  check("折线图 30 个数据点", (dayPlot.match(/<circle /g) || []).length, 30);
  check("折线图 x 轴 30 个标签", (dayPlot.match(/trend-axis-label" style="left:/g) || []).length, 30);
  check("折线图 30 天全部展示（宽 1264，无横向滚动内容）", dayPlot.includes('width="1264"') && !dayPlot.includes('width="61'), true);
  check("圆点带 data-idx 可直接选中", (dayPlot.match(/circle data-idx="/g) || []).length, 30);
  check("无选中时显示点击提示", els["trend-day-hint"].textContent, "点击折线图或圆点查看当天测量次数");
  check("折线图 y 轴刻度含 0/5", els["trend-day-ylabels"].innerHTML.includes(">5<") && els["trend-day-ylabels"].innerHTML.includes(">0<"), true);

  const monthPlot = els["trend-month-plot"].innerHTML;
  check("柱状图 12 根柱", (monthPlot.match(/fill="#0064E0"/g) || []).length, 12);
  check("柱状图 x 轴 12 个月", (monthPlot.match(/月<\/span>/g) || []).length, 12);
  check("月份标签百分比定位（对齐柱中心）", (monthPlot.match(/trend-axis-label" style="left:/g) || []).length, 12);
  check("月份标签中心=柱中心",
    (() => {
      const slot = 100 / 12;
      const centers = [...monthPlot.matchAll(/left:([\d.]+)%/g)].map((m) => Number(m[1]));
      return centers.every((c, i) => Math.abs(c - (i * slot + slot / 2)) < 0.05);
    })(), true);
  check("柱子带 data-idx 可直接选中", (monthPlot.match(/path data-idx="/g) || []).length, 12);
  check("本月月份标签", monthPlot.includes(`>${pad(today.getMonth() + 1)}月</span>`), true);
  check("首月标签=11 个月前（跨年）", monthPlot.includes(`>${pad(monthStarts[0].getMonth() + 1)}月</span>`), true);
  check("柱宽仍为 48（槽宽 105.3 自适应不压缩柱宽）",
    [...monthPlot.matchAll(/d="M([\d.]+) [\d.]+V240H([\d.]+)V/g)]
      .map((m) => Number(m[2]) - Number(m[1]))
      .every((w) => Math.abs(w - 48) < 0.05), true);
  check("无选中时显示点击提示", els["trend-month-hint"].textContent, "点击柱子查看该月测量次数");

  /* ---------- 4. 选中态（iOS 点选折线点 / 柱子） ---------- */
  // 视觉基准（2026-09-17 用户确认的最终 UI，设计稿已按此回同步）：
  //   折线 stroke-width 1.5、普通点 r=2.5（5px）、选中点 r=4（8px）、选中变橙
  const selDate = get("TrendPage.dayData[2].date");
  run("TrendPage.selectDayIndex(2)");
  check("选中点变橙 r=4", dayPlotNext().includes('r="4" fill="#FF9500"'), true);
  check("未选中点为蓝 r=2.5", dayPlotNext().includes('r="2.5" fill="#0064E0"'), true);
  check("折线描边 1.5", dayPlotNext().includes('stroke-width="1.5" fill="none"'), true);
  check("选中点只有一个", (dayPlotNext().match(/r="4" fill="#FF9500"/g) || []).length, 1);
  function dayPlotNext() {
    return els["trend-day-plot"].innerHTML;
  }
  check("选中虚线参考线", dayPlotNext().includes('stroke-opacity="0.5"'), true);
  check("选中提示文案", els["trend-day-hint"].textContent,
    `已选中：${selDate.getFullYear()}-${pad(selDate.getMonth() + 1)}-${pad(selDate.getDate())}，测量次数：15`);

  run("TrendPage.selectMonthIndex(3)");
  check("选中柱变橙", els["trend-month-plot"].innerHTML.includes('fill="#FF9500"'), true);
  const selMonth = get("TrendPage.monthData[3].monthStart");
  check("选中月份提示文案", els["trend-month-hint"].textContent,
    `已选中：${selMonth.getFullYear()}-${pad(selMonth.getMonth() + 1)}，测量次数：15`);

  /* ---------- 5. 二次打开：非今天/本月走缓存 ---------- */
  els["stats-chart-summary"].fire("click");
  await h.waitFor('AppState.currentPage === "trend"');
  await h.waitFor('document.getElementById("trend-content").style.display === "flex"');
  check("二次加载只请求今天+本月（2 账号 × 2 期）", callCount() - callsAfterFirstLoad, 4);

  /* ---------- 6. 公司入口：按 "_" 前缀过滤 ---------- */
  els["trend-back"].fire("click");
  check("返回按钮回到统计分析", get("AppState").currentPage, "statistics");
  run(`TrendPage.open("lssd")`);
  await h.waitFor('AppState.currentPage === "trend"');
  check("公司入口标题", els["trend-title"].textContent, "lssd");
  check("公司入口面包屑", els["trend-crumb"].textContent, "统计分析 / lssd");
  check("公司入口只聚合该公司账号", get("TrendPage.targetUsers")().length, 1);
  await h.waitFor('document.getElementById("trend-content").style.display === "flex"');
  check("公司入口每日=单账号值", get("TrendPage.dayData[0].count"), 10);
  check("公司入口请求数=今天+本月（1 账号 × 2 期）", callCount() - callsAfterFirstLoad, 6);

  /* ---------- 7. 统计页公司卡带公司名 ---------- */
  run(`
    function stName(name) {
      return new StudyResponse({ ID: name, Name: name, StatusID: "ACTIVE", unitPrice: 1,
        billingSuccessMeasurements: 10, periodSuccessMeasurements: 10 });
    }
    function stOrg(name, studies) {
      return new OrgInfo({ key: name + "0", region: "china", name, successCount: 0,
        totalDeposits: 0, unitPrice: 1, periodSuccess: 0,
        billingDate: new Date(2026, 0, 15), startDate: null, endDate: null, studies });
    }
    AppState.list.orgs = [stOrg("lssd_01", [stName("Study A")]), stOrg("junying_01", [stName("Study B 5s")])];
  `);
  els["stat-btn"].fire("click");
  await h.waitFor('AppState.currentPage === "statistics"');
  check("公司卡图表按钮带公司名", els["stats-org-list"].innerHTML.includes('data-stats-company="lssd"'), true);

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("测试执行异常:", e);
  process.exit(1);
});
