/* ============================================================================
 * 刷新按钮行为（重新取数）（自 /tmp 迁移，改用 tests/harness.js 的统一 DOM 桩）
 * 运行：node tests/
 * 可选参数：<appDir> 指定被测目录（用于在未修复副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const path = require("path");
const vm = require("vm");
const { createHarness } = require("./harness");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, sleep, waitFor, check, results } = h;

(async function main() {
  load("model.js");
  load("api.js");

  // 假接口：每次测量请求返回的值会按轮次递增，用于验证「刷新真的重新取数」
  run(`
    globalThis.__measureCalls = 0;
    globalThis.__round = 0;
    APIClient.login = async (email, password, orgName, region) => ({ Token: "T-" + orgName });
    APIClient.getAllStudies = async () => {
      const out = {};
      for (const u of SharedUsers) {
        out[u.key] = [ new StudyResponse({ Created: 1788451200, ID: "c06eabcdef458b", Name: u.orgName + "-研究",
          Description: "", StatusID: "ACTIVE", Measurements: 0 }) ];
      }
      return out;
    };
    // updateStudies 内部就是逐个 study 调 getMeasurementInfo，这里直接统计它
    const _realGMI = APIClient.getMeasurementInfo.bind(APIClient);
    APIClient.getMeasurementInfo = async function (orgName, region, studyID, date, endDate, progress) {
      globalThis.__measureCalls++;
      return new MeasurementInfo(orgName, studyID, 10 * globalThis.__round);
    };
  `);

  load("app.js");

  /* ---------- 登录进入列表 ---------- */
  els["login-org"].value = "support"; els["login-org"].fire("input");
  els["login-email"].value = "a@b.com"; els["login-email"].fire("input");
  els["login-pwd"].value = "p"; els["login-pwd"].fire("input");
  run("globalThis.__round = 1;");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  await waitFor('AppState.list.isRefreshing === false');
  const afterLoginCalls = get("__measureCalls");
  check("首次进入列表请求了测量接口", afterLoginCalls > 0, true);
  check("首屏账单内测量(第1轮=10)", get("AppState").list.orgs[0].billingSuccessMeasurements, 10);

  /* ---------- 点击刷新按钮 ---------- */
  run("globalThis.__measureCalls = 0; globalThis.__round = 2;");
  const beforeClick = get("AppState").list.updateTime.getTime();
  await sleep(1100); // 让 updateTime 明显变化
  els["refresh-btn"].fire("click");
  await waitFor('AppState.list.isRefreshing === true');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(50);
  check("刷新时重新请求了测量接口", get("__measureCalls") > 0, true);
  check("刷新时测量请求至少 1 次（每个 study 一次 getMeasurementInfo）", get("__measureCalls") >= 1, true);
  check("刷新后账单内测量已更新(第2轮=20)", get("AppState").list.orgs[0].billingSuccessMeasurements, 20);
  check("刷新后余额已重算", get("AppState").list.orgs[0].balanceString, "-20");
  check("刷新后表格已重绘", els["org-rows"].innerHTML.includes("-20"), true);
  check("刷新后更新时间已推进", get("AppState").list.updateTime.getTime() > beforeClick, true);
  check("刷新结束后按钮态复位", get("AppState").list.isRefreshing, false);
  check("刷新结束后 refreshCompleted", get("AppState").list.refreshCompleted, true);

  /* ---------- 选「全部」周期后再刷新：应带上周期区间再请求 ---------- */
  run("globalThis.__measureCalls = 0; globalThis.__round = 3;");
  run("AppState.list.selectedFilter = DateFilter.all;");
  get("ListPage").performFilter("all");
  await waitFor('AppState.list.isRefreshing === false');
  const allPeriodCalls = get("__measureCalls");
  check("切周期请求测量接口", allPeriodCalls > 0, true);
  check("周期内测量(第3轮=30)", get("AppState").list.orgs[0].periodSuccessString, "30");
  run("globalThis.__measureCalls = 0; globalThis.__round = 4;");
  els["refresh-btn"].fire("click");
  await waitFor('AppState.list.isRefreshing === true');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(50);
  check("周期下刷新也重新请求测量接口", get("__measureCalls") > 0, true);
  check("周期下刷新后周期内测量已更新(第4轮=40)", get("AppState").list.orgs[0].periodSuccessString, "40");
  check("周期下刷新后统计周期文案保持", get("AppState").list.billingPeriod, "全部");

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
