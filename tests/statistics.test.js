/* ============================================================================
 * 统计分析页（6-StatisticsView.swift）回归
 * 覆盖：列表页「统计分析」按钮进入统计页 → 公司聚合（组织名 "_" 前缀）、
 *       30s/5s 归类（名称含 "5s"）、周期统计 vs 账单统计两套数值、
 *       公司卡按 totalCost 升序、segment/周期条/账单开始日期的显隐、返回列表。
 * 运行：node tests/statistics.test.js
 * 可选参数：<appDir> 指定被测目录（用于在未修复副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const vm = require("vm");
const { createHarness } = require("./harness");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, check, results } = h;

function statsHtml() {
  return els["stats-org-list"].innerHTML;
}
function cardCount() {
  return (statsHtml().match(/class="stats-card"/g) || []).length;
}
function cardPills() {
  return [...statsHtml().matchAll(/stats-org-pill">([^<]*)</g)].map((m) => m[1].trim());
}
function cardDates() {
  return [...statsHtml().matchAll(/stats-date">([^<]*)</g)].map((m) => m[1].trim());
}

(async function main() {
  load("model.js");
  load("api.js");

  vm.runInContext(
    `
    APIClient.login = async function () { return { Token: "TOKEN" }; };
    APIClient.getAllStudies = async function () { return {}; };
    APIClient.updateStudies = async function (studyDic, billingDateDic, startDate, endDate, progress) {};
    `,
    h.sandbox
  );

  load("app.js");

  /* ---------- 0. 纯函数 ---------- */
  check("公司名取下划线前缀", get("statisticsCompanyNameFrom")("lssd_01"), "lssd");
  check("无下划线用原名", get("statisticsCompanyNameFrom")("support"), "support");
  check("名称含 5s 归 5s（大小写不敏感）", get("statisticsIs5sStudy")("Study B 5S"), true);
  check("名称不含 5s 归 30s", get("statisticsIs5sStudy")("Study A"), false);

  /* ---------- 1. 登录进列表 → 点「统计分析」 ---------- */
  els["login-org"].value = "support";
  els["login-org"].fire("input");
  els["login-email"].value = "a@a.com";
  els["login-email"].fire("input");
  els["login-pwd"].value = "pwd";
  els["login-pwd"].fire("input");
  els["login-form"].fire("submit");
  await h.waitFor('AppState.currentPage === "list"');

  /* ---------- 假数据（对应 iOS Preview 的造数方式） ---------- */
  run(`
    function stName(name, unitPrice, billingSuccess, periodSuccess) {
      return new StudyResponse({
        ID: name, Name: name, StatusID: "ACTIVE", unitPrice,
        billingSuccessMeasurements: billingSuccess,
        periodSuccessMeasurements: periodSuccess,
      });
    }
    function stOrg(name, studies) {
      return new OrgInfo({
        key: name + "CN", region: "china", name, successCount: 0,
        totalDeposits: 0, unitPrice: 1, periodSuccess: 0,
        billingDate: new Date(2026, 0, 15), startDate: null, endDate: null, studies,
      });
    }
    // 账单值（bill）：lssd 30s=2000/1600 5s=400/400 共 2400/2000
    //               junying 30s=100/120 5s=50/60 共 150/180
    // 周期值（custom）：lssd 30s=500/400 5s=120/120 共 620/520
    //                  junying 30s=500/600 5s=200/240 共 700/840
    AppState.list.orgs = [
      stOrg("lssd_01", [stName("Study A", 0.8, 1200, 300), stName("Study B 5s", 1.0, 400, 120)]),
      stOrg("lssd_02", [stName("Study C", 0.8, 800, 200)]),
      stOrg("junying_01", [stName("Study E", 1.2, 100, 500), stName("Study F 5s", 1.2, 50, 200)]),
    ];
  `);


  // 未选周期（默认 none）→ onAppear 语义：tab=账单，segment 隐藏
  els["stat-btn"].fire("click");
  await h.waitFor('AppState.currentPage === "statistics"');
  check("进入统计页", get("AppState").currentPage, "statistics");
  check("无周期时 segment 隐藏", els["stats-seg"].style.display, "none");
  check("无周期时周期条隐藏", els["stats-period-bar"].style.display, "none");
  check("标题=统计分析", els["stats-title"].textContent, "统计分析");

  /* ---------- 2. 账单统计：数值 / 排序 / 账单开始日期 ---------- */
  check("汇总条「共计 (2)」", els["stats-total-bar"].textContent, "共计 (2)");
  check("账单·30s次数=2,100", els["stats-f-count"].textContent, "· 测量次数:  2,100");
  check("账单·30s费用=1,720", els["stats-f-cost"].textContent, "· 测量费用:  1,720");
  check("账单·5s次数=450", els["stats-s-count"].textContent, "· 测量次数:  450");
  check("账单·5s费用=460", els["stats-s-cost"].textContent, "· 测量费用:  460");
  check("账单·全部次数=2,550", els["stats-t-count"].textContent, "· 测量次数:  2,550");
  check("账单·全部费用=2,180", els["stats-t-cost"].textContent, "· 测量费用:  2,180");
  check("账单页签显示账单开始日期", cardDates().length, 2);
  check("日期格式 yyyy.MM.dd", cardDates()[0].includes("2026.01.15"), true);
  // totalCost 升序：junying(1,800... 150/180) < lssd(2000/2400 → 2000)
  check("账单页签公司卡按 totalCost 升序（junying 在前）", cardPills().join("|"), "1. 公司名称: junying|2. 公司名称: lssd");
  check("公司卡数量=2", cardCount(), 2);

  /* ---------- 3. 切到周期统计：segment / 周期条 / 数值 / 无日期 ---------- */
  run(`
    const L = AppState.list;
    L.selectedFilter = DateFilter.all;
    L.billingPeriod = "全部";
    L.isPeriodNone = false;
  `);
  els["stats-tab-custom"].fire("click");
  check("切到自定义周期后 segment 显示", els["stats-seg"].style.display, "inline-flex");
  check("segment 高亮在自定义周期", els["stats-tab-custom"].classList.contains("active"), true);
  check("周期条显示当前周期文案", els["stats-period-bar"].textContent, "全部");
  check("周期条可见", els["stats-period-bar"].style.display, "flex");
  check("周期·30s次数=1,000", els["stats-f-count"].textContent, "· 测量次数:  1,000");
  check("周期·30s费用=1,000", els["stats-f-cost"].textContent, "· 测量费用:  1,000");
  check("周期·5s次数=320", els["stats-s-count"].textContent, "· 测量次数:  320");
  check("周期·全部次数=1,320", els["stats-t-count"].textContent, "· 测量次数:  1,320");
  check("周期页签不显示账单开始日期", cardDates().length, 0);
  // totalCost 升序：lssd(520) < junying(840)
  check("周期页签公司卡按 totalCost 升序（lssd 在前）", cardPills().join("|"), "1. 公司名称: lssd|2. 公司名称: junying");

  /* ---------- 4. 切回账单 + 返回列表 ---------- */
  els["stats-tab-bill"].fire("click");
  check("切回账单高亮", els["stats-tab-bill"].classList.contains("active"), true);
  check("切回账单后周期条隐藏", els["stats-period-bar"].style.display, "none");

  els["stats-back"].fire("click");
  check("返回按钮回到组织列表", get("AppState").currentPage, "list");

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("测试执行异常:", e);
  process.exit(1);
});
