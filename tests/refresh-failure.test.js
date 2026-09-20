/* ============================================================================
 * 刷新失败隔离（自 /tmp 迁移，改用 tests/harness.js 的统一 DOM 桩）
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
  run(`
    APIClient.login = async () => ({ Token: "T" });
    APIClient.getAllStudies = async () => {
      const out = {};
      for (const u of SharedUsers) {
        out[u.key] = [ new StudyResponse({ Created: 1788451200, ID: "c06eabcdef458b", Name: u.orgName + "-研究",
          Description: "", StatusID: "ACTIVE", Measurements: 0 }) ];
      }
      return out;
    };
    globalThis.__fail = false;
    APIClient.getMeasurementInfo = async function (orgName, region, studyID) {
      if (globalThis.__fail) throw new Error("模拟网络失败");
      return new MeasurementInfo(orgName, studyID, 42);
    };
  `);
  load("app.js");

  els["login-org"].value = "support"; els["login-org"].fire("input");
  els["login-email"].value = "a@b.com"; els["login-email"].fire("input");
  els["login-pwd"].value = "p"; els["login-pwd"].fire("input");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(60);
  check("首屏账单内测量=42", get("AppState").list.orgs[0].billingSuccessMeasurements, 42);
  check("首屏表格显示 42", els["org-rows"].innerHTML.includes("42"), true);

  /* 刷新：这次测量请求全部失败 */
  run("globalThis.__fail = true;");
  els["refresh-btn"].fire("click");
  await waitFor('AppState.list.isRefreshing === true');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(60);
  check("刷新失败弹出错误提示", els["modal-root"].innerHTML.includes("模拟网络失败"), true);
  check("失败后账单内测量仍为 42（不被 reset 清零）", get("AppState").list.orgs[0].billingSuccessMeasurements, 42);
  check("失败后表格仍显示 42", els["org-rows"].innerHTML.includes("42"), true);
  check("失败后余额未被重算成 0", els["org-rows"].innerHTML.includes("-42"), true);

  /* 再刷新：恢复成功 → 数据应更新为 42（同一假值） */
  run("globalThis.__fail = false;");
  els["refresh-btn"].fire("click");
  await waitFor('AppState.list.isRefreshing === true');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(60);
  check("恢复后账单内测量仍正确", get("AppState").list.orgs[0].billingSuccessMeasurements, 42);

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
