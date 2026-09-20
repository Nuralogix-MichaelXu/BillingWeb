/* ============================================================================
 * 三页端到端逻辑演练（自 /tmp 迁移，改用 tests/harness.js 的统一 DOM 桩）
 * 运行：node tests/
 * 可选参数：<appDir> 指定被测目录（用于在未修复副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const path = require("path");
const vm = require("vm");
const { createHarness } = require("./harness");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, sleep, waitFor, check, results } = h;

const fakeStudies = [
  { Created: 1788451200, ID: "c06e1xxx458b", Name: "Joey 赵小吉", Description: "", StatusID: "ACTIVE", Measurements: 0, _billing: 4, _period: 4 },
  { Created: 1788451200, ID: "d95d5xxx0c27", Name: "塞尔思维脑测试", Description: "", StatusID: "ACTIVE", Measurements: 0, _billing: 17, _period: 17 },
  { Created: 1788364800, ID: "7a8b9xxx8d27", Name: "中博会", Description: "", StatusID: "ACTIVE", Measurements: 0, _billing: 2, _period: 2 },
  { Created: 1788278400, ID: "6cd8axxxa385", Name: "Anura mini", Description: "", StatusID: "ACTIVE", Measurements: 0, _billing: 7, _period: 7 },
  { Created: 1787616000, ID: "84d1zxxx800a", Name: "Karneen 盆年", Description: "", StatusID: "ACTIVE", Measurements: 0, _billing: 1, _period: 1 },
];

(async function main() {
  load("model.js");
  load("api.js");

  // 假接口：替换网络层（接口路径与参数仍由 api.js 逻辑处理，此处只替换结果）
  h.sandbox.__fakeStudies = fakeStudies;
  vm.runInContext(
    `
    APIClient.getAllStudies = async function () {
      return { "support0": __fakeStudies.map((j) => new StudyResponse(j)) };
    };
    // 模拟 updateStudies：Date=billingDate 且无 EndDate → 账单内测量；否则周期内测量
    APIClient.updateStudies = async function (studyDic, billingDateDic, startDate, endDate, progress) {
      for (const key of Object.keys(studyDic)) {
        for (let i = 0; i < studyDic[key].length; i++) {
          const s = studyDic[key][i];
          const src = __fakeStudies.find((j) => j.ID === s.ID);
          s.totalSuccessMeasurements = billingDateDic ? src._billing : src._period;
          progress(); progress();
        }
      }
    };
    `,
    h.sandbox
  );

  load("app.js");
  check("初始化后当前页", get("AppState").currentPage, "login");
  check("登录页提示文案", els["login-note"].textContent, "· 请使用NuraLogix提供的管理员账号登录 ·");
  check(
    "多账号占位示例完整（格式说明 + 3 行示例都在框内）",
    /placeholder="[^"]*格式如下[^"]*org3 example3[^"]*"/.test(
      require("fs").readFileSync(require("path").join(h.appDir, "index.html"), "utf8").replace(/&#10;/g, "\n")
    ),
    true
  );
  check("多账号文本框初始为空（对齐 iOS 空框+占位）", get("AppState").login.multiAccountText, "");

  // 登录页首次打开：表单为空（不再预填测试账号）
  check("首次打开·组织为空", els["login-org"].value, "");
  check("首次打开·邮箱为空", els["login-email"].value, "");
  check("首次打开·密码为空", els["login-pwd"].value, "");

  // 清空后再提交，验证必填校验
  for (const id of ["login-org", "login-email", "login-pwd"]) {
    els[id].value = "";
    els[id].fire("input");
  }
  els["login-form"].fire("submit");
  check("空值校验提示", els["modal-root"].innerHTML.includes("请填写完整信息"), true);
  check("校验后 loading 复位", get("AppState").login.isLoading, false);

  els["mode-toggle"].fire("click");
  check("切换为多账号模式", get("AppState").login.isMultiAccountMode, true);
  check("按钮文案切换", els["mode-toggle"].textContent, "普通登录");
  els["mode-toggle"].fire("click");
  check("切回普通登录", get("AppState").login.isMultiAccountMode, false);

  // 模拟登录成功后的用户
  vm.runInContext(
    `SharedUsers.push(makeUser({ orgName: "support", email: "a@b.com", password: "p", region: Region.china, deposits: 0, unitPrice: 1.0, billingDate: kInitialStartDate, token: "T" }));`,
    h.sandbox
  );
  check("用户 key = orgName+regionTag", get("SharedUsers")[0].key, "support0");

  // 列表页：默认「无」周期
  await vm.runInContext(`ListPage.performFilter(DateFilter.none)`, h.sandbox);
  await sleep(80);
  check("研究数", get("AppState").list.orgs[0].studyCount, 5);
  check("账单内测量合计", get("AppState").list.orgs[0].billingSuccessMeasurements, 31);
  check("账单费用", get("AppState").list.orgs[0].billingCostString, "31");
  check("余额", get("AppState").list.orgs[0].balanceString, "-31");
  check("周期成功(无周期)", get("AppState").list.orgs[0].periodSuccessString, "-");
  check("周期消费(无周期)", get("AppState").list.orgs[0].periodCostString, "-");
  check("统计周期文案", get("AppState").list.billingPeriod, "无");
  check("账单名称（按设计稿留空，未显示 iOS 的时间戳）", get("AppState").list.billingName, "");
  check("表格已渲染组织", els["org-rows"].innerHTML.includes("support"), true);
  check("负余额标红", els["org-rows"].innerHTML.includes("var(--red-text)"), true);
  check("组织计数文案", els["org-count"].textContent, "1 个组织");

  // 列表页：切换「全部」周期
  await vm.runInContext(`AppState.list.selectedFilter = DateFilter.all; ListPage.performFilter(DateFilter.all)`, h.sandbox); // 菜单点击时会先设置 selectedFilter
  await sleep(450);
  check("统计周期文案(全部)", get("AppState").list.billingPeriod, "全部");
  check("周期成功(全部)", get("AppState").list.orgs[0].periodSuccessString, "31");
  check("周期消费(全部)", get("AppState").list.orgs[0].periodCostString, "31");
  check("更新失败标记", get("AppState").list.isUpdateFail, false);
  check("刷新态已结束", get("AppState").list.isRefreshing, false);

  // 详情页
  vm.runInContext(`AppState.list.selectedOrgIndex = 0; DetailPage.open();`, h.sandbox);
  check("详情当前页", get("AppState").currentPage, "detail");
  check("组织名", els["d-title"].textContent, "support");
  check("总充值", els["d-deposits"].textContent, "0");
  check("单价", els["d-unitprice"].textContent, "1.0");
  check("账单费用", els["d-billcost"].textContent, "31");
  check("余额", els["d-balance"].textContent, "-31");
  check("余额颜色", els["d-balance"].style.color, "var(--red-text)");
  check("账单开始日期", els["d-billingdate"].textContent, "2020.01.01");
  // 设计稿里「统计周期」「周期内消费」的数值只渲染值本身，不带标签前缀
  // （Ardot 3:178 = "全部"、3:181 = "31"），标签是卡片上独立的 12px 文本。
  check("统计周期", els["d-period"].textContent, "全部");
  check("周期内消费", els["d-periodcost"].textContent, "31");
  check("研究表 5 行", (els["research-rows"].innerHTML.match(/class="table-row"/g) || []).length, 5);
  check("研究名称", els["research-rows"].innerHTML.includes("塞尔思维脑测试"), true);
  check("状态文案", els["research-rows"].innerHTML.includes("有效"), true);
  check("研究ID 脱敏", els["research-rows"].innerHTML.includes("c06e****458b"), true);
  check("合计行标签", els["d-total-label"].textContent, "合计 (5)");
  check("合计-周期内测量", els["d-total-period-success"].textContent, "31");
  check("合计-周期费用", els["d-total-period-cost"].textContent, "31");
  check("合计-账单内测量", els["d-total-billing-success"].textContent, "31");
  check("合计-账单费用", els["d-total-billing-cost"].textContent, "31");

  // 详情页：修改全局单价（走真实交互链路：点编辑 → 弹窗 → 内部逻辑）
  vm.runInContext(
    `(function(){ const org = DetailPage.org; org.unitPrice = 2; org.resetStudyUnitPrice(); const i = SharedUsers.findIndex(u=>u.key===org.key); SharedUsers[i].unitPrice = 2; SharedUsers[i].studyUnitPrices = null; UserStorage.save(SharedUsers); DetailPage.render(); })()`,
    h.sandbox
  );
  check("改价后单价", els["d-unitprice"].textContent, "2.0");
  check("改价后账单费用", els["d-billcost"].textContent, "62");
  check("改价后余额", els["d-balance"].textContent, "-62");
  check("研究行单价已同步", els["research-rows"].innerHTML.includes("2.0"), true);
  check("本地存储已写入", JSON.parse(h.store["userList"])[0].unitPrice, 2);

  // 详情页：编辑单个研究单价 → studyUnitPrices 记录
  vm.runInContext(
    `(function(){ const org = DetailPage.org; const id = org.studies[1].ID; org.studies[1].unitPrice = 3; const i = SharedUsers.findIndex(u=>u.key===org.key); const m = SharedUsers[i].studyUnitPrices || {}; m[id] = 3; SharedUsers[i].studyUnitPrices = m; UserStorage.save(SharedUsers); DetailPage.render(); })()`,
  h.sandbox
  );
  check("研究单价覆盖已存", JSON.parse(h.store["userList"])[0].studyUnitPrices["d95d5xxx0c27"], 3);
  check("单价混价展示(2.0/3.0)", get("AppState").list.orgs[0].unitPriceString, "2.0/3.0");

  // 退出登录
  els["settings-logout"].fire("click");
  check("退出确认弹窗", els["modal-root"].innerHTML.includes("确定要退出登录吗?"), true);
  vm.runInContext(`SharedUsers = []; UserStorage.clear(); Router.go("login");`, h.sandbox);
  check("退出后用户清空", get("SharedUsers").length, 0);
  check("退出后本地存储清空", h.store["userList"], undefined);
  check("退出后回到登录页", get("AppState").currentPage, "login");

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
