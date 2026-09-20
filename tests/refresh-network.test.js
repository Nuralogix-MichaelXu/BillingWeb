/* ============================================================================
 * 刷新网络层取证（自 /tmp 迁移，改用 tests/harness.js 的统一 DOM 桩）
 * 运行：node tests/
 * 可选参数：<appDir> 指定被测目录（用于在未修复副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const path = require("path");
const vm = require("vm");
const { createHarness } = require("./harness");
const creds = require("../tools/_creds");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, sleep, waitFor, check, results } = h;

// 本套件专用：记录请求顺序与测量请求次数
let log = [];
let measureCount = 0;

// 网络层取证：只替换 fetch，其余（URL 组装、参数、鉴权、重试）全走 api.js 真实逻辑
h.ctx.fetch = async (url) => {
  const u = String(url);
  const m = /[?&]url=([^&]+)/.exec(u);
  const real = m ? decodeURIComponent(m[1]) : u;
  log.push(real);
  let body = "{}";
  if (real.includes("/studies")) {
    body = JSON.stringify([{ ID: "c06eabcdef458b", Name: "塞尔思维脑测试", Created: 1788451200, StatusID: "ACTIVE", Measurements: 0, Description: "" }]);
  } else if (real.includes("/organizations/measurements")) {
    measureCount++;
    body = JSON.stringify([{ TotalCount: measureCount, StudyID: "c06eabcdef458b", StatusID: "COMPLETE" }]);
  } else if (real.includes("/organizations/auth")) {
    body = JSON.stringify({ Token: "T", ExpiresIn: 86400 });
  } else if (real.includes("/licenses/organization")) {
    body = JSON.stringify({ Licenses: [] });
  }
  return { ok: true, status: 200, text: async () => body };
};

const brief = (list) => list.map((u) => {
  const p = u.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const status = (/StatusID=([A-Z]+)/.exec(u) || [])[1];
  const hasDate = /[?&]Date=/.test(u), hasEnd = /[?&]EndDate=/.test(u);
  return p + (status ? `[${status}]` : "") + (hasDate ? "+Date" : "") + (hasEnd ? "+EndDate" : "");
});
let modalBtns = [];

(async function main() {
  load("model.js");
  load("api.js");
  load("app.js");

  // fetch 已被本套件替换成桩，不发真实认证请求，用占位账号即可
  els["login-org"].value = creds.ORG; els["login-org"].fire("input");
  els["login-email"].value = creds.email(); els["login-email"].fire("input");
  els["login-pwd"].value = creds.password(); els["login-pwd"].fire("input");
  run("SharedUsers = [];");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(80);
  const loginPath = brief(log.filter((u) => u.includes("/organizations/measurements")));
  check("登录后请求了测量接口", loginPath.length > 0, true);
  console.log("  登录后测量请求:", JSON.stringify(loginPath));
  check("列表已渲染", els["org-rows"].innerHTML.includes("support"), true);

  /* ---- 点刷新 ---- */
  log = []; measureCount = 0;
  els["refresh-btn"].fire("click");
  await waitFor('AppState.list.isRefreshing === true');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(80);
  const refreshCalls = log.filter((u) => u.includes("/organizations/measurements"));
  console.log("  刷新时全部请求:", JSON.stringify(brief(log)));
  check("刷新时重新请求了测量接口", refreshCalls.length > 0, true);
  check("刷新时测量请求含 StatusID=COMPLETE", refreshCalls.some((u) => u.includes("StatusID=COMPLETE")), true);
  check("刷新时测量请求含 StatusID=PARTIAL", refreshCalls.some((u) => u.includes("StatusID=PARTIAL")), true);
  check("刷新时测量请求带 Date（账单起始日）", refreshCalls.some((u) => /[?&]Date=/.test(u)), true);
  check("刷新时未重新拉 /studies", log.some((u) => u.includes("/studies")), false);

  /* ---- 切到「全部」周期 ---- */
  log = [];
  run("AppState.list.selectedFilter = DateFilter.all;");
  get("ListPage").performFilter("all");
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(80);
  console.log("  周期=全部 请求:", JSON.stringify(brief(log)));
  check("周期请求了测量接口", log.filter((u) => u.includes("/organizations/measurements")).length > 0, true);

  /* ---- 周期=全部 下点刷新 ---- */
  log = [];
  els["refresh-btn"].fire("click");
  await waitFor('AppState.list.isRefreshing === true');
  await waitFor('AppState.list.isRefreshing === false');
  await sleep(80);
  console.log("  周期=全部 刷新请求:", JSON.stringify(brief(log)));
  check("周期=全部 刷新也重新请求测量接口", log.filter((u) => u.includes("/organizations/measurements")).length > 0, true);

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
