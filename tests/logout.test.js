/* ============================================================================
 * 登出换号 + 登录页默认填充回归（自 /tmp 迁移，改用 tests/harness.js 的统一 DOM 桩）
 * 运行：node tests/
 * 可选参数：<appDir> 指定被测目录（用于在未修复副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const path = require("path");
const vm = require("vm");
const { createHarness } = require("./harness");
const creds = require("../tools/_creds");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, sleep, waitFor, check, results } = h;

function fillLogin(org, email, pwd) {
  els["login-org"].value = org;
  els["login-org"].fire("input");
  els["login-email"].value = email;
  els["login-email"].fire("input");
  els["login-pwd"].value = pwd;
  els["login-pwd"].fire("input");
}

(async function main() {
  load("model.js");
  load("api.js");

  // 假接口：账号不同 → 返回不同的组织与研究数据
  vm.runInContext(
    `
    APIClient.login = async function (email, password, orgName, region) {
      return { Token: "TOKEN-" + orgName };
    };
    APIClient.getAllStudies = async function () {
      const out = {};
      for (const u of SharedUsers) {
        const s = new StudyResponse({
          Created: 1788451200,
          ID: (u.orgName + "000000000000").slice(0, 12),
          Name: u.orgName + "-研究",
          Description: "",
          StatusID: "ACTIVE",
          Measurements: 0,
        });
        s.totalSuccessMeasurements = u.orgName === "orgA" ? 3 : 99;
        out[u.key] = [s];
      }
      return out;
    };
    APIClient.updateStudies = async function (studyDic, billingDateDic, startDate, endDate, progress) {
      for (const key of Object.keys(studyDic)) {
        for (const s of studyDic[key]) {
          s.totalSuccessMeasurements = s.Name.startsWith("orgA") ? 3 : 99;
          progress(); progress();
        }
      }
    };
    `,
    h.sandbox
  );

  load("app.js");

  /* ---------- 0. 登录页首次打开：表单为空（不再预填测试账号） ---------- */
  check("首次打开·组织为空", els["login-org"].value, "");
  check("首次打开·邮箱为空", els["login-email"].value, "");
  check("首次打开·密码为空", els["login-pwd"].value, "");
  check("首次打开·状态 orgName", get("AppState").login.orgName, "");
  check("首次打开·状态 password", get("AppState").login.password, "");
  check("首次打开·多账号文本框为空（空框显示占位示例，对齐 iOS）", els["multi-text"].value, "");

  /* ---------- 1. 账号 A 登录 ---------- */
  fillLogin("orgA", "a@a.com", "pwdA");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  check("A 进入列表页", get("AppState").currentPage, "list");
  check("A 组织数量", get("AppState").list.orgs.length, 1);
  check("A 组织名", get("AppState").list.orgs[0].name, "orgA");
  check("A 表格含 orgA", els["org-rows"].innerHTML.includes("orgA"), true);
  check("A 账单费用=3", get("AppState").list.orgs[0].billingCostString, "3");

  /* ---------- 2. 退出登录（真实点击弹窗确认按钮） ---------- */
  els["settings-logout"].fire("click");
  check("弹出退出确认", els["modal-root"].innerHTML.includes("确定要退出登录吗?"), true);
  check("确认按钮存在", h.modalButtons().length >= 2, true);
  h.clickModalBtn("确定");

  check("退出后 SharedUsers 清空", get("SharedUsers").length, 0);
  check("退出后本地存储清空", h.store["userList"], undefined);
  check("退出后回到登录页", get("AppState").currentPage, "login");
  check("退出后列表数据已重置", get("AppState").list.orgs.length, 0);
  check("退出后筛选已重置", get("AppState").list.selectedFilter, "none");
  check("退出后刷新态已复位", get("AppState").list.isRefreshing, false);
  check("退出后登录表单为空·组织", els["login-org"].value, "");
  check("退出后强制清空密码", get("AppState").login.password, "");
  check("退出后旧账号 orgA 已被清除", els["login-org"].value === "orgA", false);
  check("退出后按钮未卡在加载中", get("AppState").login.isLoading, false);

  /* ---------- 3. 账号 B 登录（核心回归点） ---------- */
  fillLogin("orgB", "b@b.com", "pwdB");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  check("B 进入列表页", get("AppState").currentPage, "list");
  check("B 组织数量", get("AppState").list.orgs.length, 1);
  check("B 组织名已更新", get("AppState").list.orgs[0].name, "orgB");
  check("B 表格含 orgB", els["org-rows"].innerHTML.includes("orgB"), true);
  check("B 表格不含 orgA", els["org-rows"].innerHTML.includes("orgA"), false);
  check("B 账单费用=99", get("AppState").list.orgs[0].billingCostString, "99");

  /* ---------- 4. 换回账号 A，验证可双向切换 ---------- */
  els["settings-logout"].fire("click");
  h.clickModalBtn("确定");
  check("二次退出后列表重置", get("AppState").list.orgs.length, 0);
  fillLogin("orgA", "a@a.com", "pwdA");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  check("回切 A 组织名", get("AppState").list.orgs[0].name, "orgA");
  check("回切 A 不含 orgB", els["org-rows"].innerHTML.includes("orgB"), false);
  check("回切 A 账单费用=3", get("AppState").list.orgs[0].billingCostString, "3");

  /* ---------- 5. 多账号模式也能直接用预填内容登录 ---------- */
  els["settings-logout"].fire("click");
  h.clickModalBtn("确定");
  check("登出后登录表单为空（不预填账号）", els["login-org"].value, "");
  els["mode-toggle"].fire("click");
  check("切到多账号模式", get("AppState").login.isMultiAccountMode, true);
  check("多账号框为空（登出后重建，不残留）", els["multi-text"].value, "");
  // 手工填入与 iOS 格式一致的一行后提交
  // 本套件把 APIClient.login 打桩了，不发真实认证请求，用占位账号即可
  els["multi-text"].value = creds.line({ org: "support", unitPrice: 1.0, date: "2020.01.01" });
  els["multi-text"].fire("input");
  els["login-form"].fire("submit");
  await waitFor('AppState.currentPage === "list"');
  check("多账号登录进入列表", get("AppState").currentPage, "list");
  check("多账号解析出默认组织", get("SharedUsers")[0].orgName, "support");
  check("多账号用户 key", get("SharedUsers")[0].key, "support0");
  check("多账号默认单价", get("SharedUsers")[0].unitPrice, 1);
  check("多账号默认账单起始日", get("SharedUsers")[0].billingDate.getFullYear(), 2020);

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
