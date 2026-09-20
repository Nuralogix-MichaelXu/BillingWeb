/* ============================================================================
 * 数据模型保真测试（Model.swift / Common.swift / 1-LoginView 的 User）
 * 用统一脚手架，不再各自造轮子。
 * ==========================================================================*/
const { createHarness } = require("./harness");

const h = createHarness();
const { check, get, run } = h;

h.load("model.js");

/* -------------------------------------------------- Region / 本地化 / 格式化 */
check("Region·国内 host", get("Region.host(Region.china)"), "https://api.prod.deepaffex.cn");
check("Region·国际 host", get("Region.host(Region.international)"), "https://api.as-east.deepaffex.ai");
check("Region·tag·国内", get("Region.tag(Region.china)"), "0");
check("Region·tag·国际", get("Region.tag(Region.international)"), "1");
check("Region·名称·国内", get("Region.name(Region.china)"), "国内");
check("Region·名称·国际", get("Region.name(Region.international)"), "海外");

check("formatAmount·整数", get("formatAmount(35)"), "35");
check("formatAmount·千分位", get("formatAmount(1234567)"), "1,234,567");
check("formatAmount·小数", get("formatAmount(1234.567)"), "1,234.57");
check("formatCount·千分位", get("formatCount(12345)"), "12,345");
check("formatUnitPrice·一位小数", get("formatUnitPrice(1)"), "1.0");

check("encryptUUID·脱敏", get("encryptUUID(\"c06eabcdef458b\")"), "c06e****458b");
check("encryptUUID·短串原样", get("encryptUUID(\"abc\")"), "abc");

/* --------------------------------------------------------------- 日期工具 */
const d = get("new Date(2026, 8, 15, 13, 20, 5)");
check("yyyyMMddDateString", get(`yyyyMMddDateString(new Date(2026,8,15))`), "2026.09.15");
check("yyyyMMddhhmmssDateString2（yyyy-MM-dd HH:mm:ss）", get(`yyyyMMddhhmmssDateString2(new Date(2026,8,15,13,20,5))`), "2026-09-15 13:20:05");
check("toUTCString", get(`toUTCString(new Date(2026,8,15,13,20,5))`), "2026-09-15T05:20:05.000Z");
check("dateFromYyyyMMddString", get(`dateFromYyyyMMddString("2026.09.15").getTime()`), get("new Date(2026,8,15).getTime()"));
check("timeIntervalToDateString（TimeInterval.toDateString → yyyy-MM-dd）", get("timeIntervalToDateString(1757000000)"), "2025-09-04");
check("kInitialStartDate", get(`new Date(kInitialStartDate.getFullYear(), kInitialStartDate.getMonth(), kInitialStartDate.getDate()).getTime()`), get(`new Date(2020,0,1).getTime()`));

/* ------------------------------------------------------- StudyResponse 派生值 */
run(`globalThis.__mk = (o) => new StudyResponse(Object.assign({
  Created: 1757000000, ID: "c06eabcdef458b", Name: "研究", Description: "", StatusID: "ACTIVE", Measurements: 0
}, o));`);
check("StudyResponse·状态·有效", get(`__mk({StatusID:"ACTIVE"}).statusString`), "有效");
check("StudyResponse·状态·删除", get(`__mk({StatusID:"DELETED"}).statusString`), "已删除");
check("StudyResponse·状态·其他", get(`__mk({StatusID:"X"}).statusString`), "无效");
check("StudyResponse·脱敏", get(`__mk({}).encryptedKey`), "c06e****458b");
check("StudyResponse·billingCost", get(`__mk({unitPrice:2, billingSuccessMeasurements:7}).billingCost`), 14);
check("StudyResponse·billingCost·回退 total", get(`__mk({unitPrice:2, totalSuccessMeasurements:3}).billingCost`), 6);
check("StudyResponse·periodCost·含账单", get(`__mk({unitPrice:2, periodSuccessMeasurements:1, isPerioContainBilling:true, billingSuccessMeasurements:7}).periodCost`), 14);
check("StudyResponse·periodCost·用周期账单值", get(`__mk({unitPrice:2, periodSuccessMeasurements:5, periodBillingSuccessMeasurements:9}).periodCost`), 18);
check("StudyResponse·periodCost·回退周期值", get(`__mk({unitPrice:2, periodSuccessMeasurements:5}).periodCost`), 10);
check("StudyResponse·periodCost·无周期→null", get(`__mk({unitPrice:2}).periodCost`), null);
run(`globalThis.__r = __mk({unitPrice:2, totalSuccessMeasurements:3, periodSuccessMeasurements:4, billingSuccessMeasurements:5, periodBillingSuccessMeasurements:6, isPerioContainBilling:true, TotalCount:9}); __r.reset();`);
check("StudyResponse·reset·TotalCount", get("__r.TotalCount"), 0);
check("StudyResponse·reset·total", get("__r.totalSuccessMeasurements"), null);
check("StudyResponse·reset·period", get("__r.periodSuccessMeasurements"), null);
check("StudyResponse·reset·billing", get("__r.billingSuccessMeasurements"), null);
check("StudyResponse·reset·periodBilling", get("__r.periodBillingSuccessMeasurements"), null);
check("StudyResponse·reset·isPerioContainBilling", get("__r.isPerioContainBilling"), null);
run(`globalThis.__a = __mk({unitPrice:2, totalSuccessMeasurements:3, periodSuccessMeasurements:4, billingSuccessMeasurements:5, periodBillingSuccessMeasurements:6, isPerioContainBilling:true});
     globalThis.__b = __a.clone(); __b.totalSuccessMeasurements = 99; __b.isPerioContainBilling = false;`);
check("clone·副本独立（total）", get("__a.totalSuccessMeasurements"), 3);
check("clone·副本独立（isPerioContainBilling）", get("__a.isPerioContainBilling"), true);
check("clone·副本保留单价", get("__b.unitPrice"), 2);

/* --------------------------------------------------------------- OrgInfo */
run(`globalThis.__org = new OrgInfo({
  key: "support0", region: 0, name: "support", successCount: 35, totalDeposits: 0, unitPrice: 1,
  periodSuccess: 31, billingDate: new Date(2020,0,1), startDate: new Date(2026,8,1), endDate: new Date(),
  studies: [
    __mk({unitPrice:1, billingSuccessMeasurements:17, periodSuccessMeasurements:17, periodBillingSuccessMeasurements:17}),
    __mk({unitPrice:1, billingSuccessMeasurements:18, periodSuccessMeasurements:14, periodBillingSuccessMeasurements:14}),
  ],
});`);
check("OrgInfo·studyCount", get("__org.studyCount"), 2);
check("OrgInfo·billingSuccessMeasurements 汇总", get("__org.billingSuccessMeasurements"), 35);
check("OrgInfo·billingCost", get("__org.billingCost"), 35);
check("OrgInfo·balance", get("__org.balance"), -35);
check("OrgInfo·balanceString", get("__org.balanceString"), "-35");
check("OrgInfo·balanceColor 负→红", get("__org.balanceColor"), "var(--red-text)");
check("OrgInfo·periodCost 汇总", get("__org.periodCost"), 31);
check("OrgInfo·periodSuccessString", get("__org.periodSuccessString"), "31");
check("OrgInfo·periodCostString", get("__org.periodCostString"), "31");
check("OrgInfo·totalDepositsString", get("__org.totalDepositsString"), "0");
check("OrgInfo·unitPriceString", get("__org.unitPriceString"), "1.0");
check("OrgInfo·leftSuccessCount", get("__org.leftSuccessCount"), 0);
check("OrgInfo·billingDate 日期格式化", get("yyyyMMddDateString(__org.billingDate)"), "2020.01.01");

/* 充值后余额为正 → 绿色 */
run(`globalThis.__org2 = new OrgInfo({ key:"a0", region:0, name:"a", successCount:0, totalDeposits:100, unitPrice:1, periodSuccess:null, billingDate:new Date(2020,0,1), startDate:new Date(), endDate:new Date(), studies:[] });`);
check("OrgInfo·余额为正", get("__org2.balanceString"), "100");
check("OrgInfo·balanceColor 正→绿", get("__org2.balanceColor"), "var(--green-text)");
check("OrgInfo·无周期时 periodSuccessString = -", get("__org2.periodSuccessString"), "-");
check("OrgInfo·无周期时 periodCostString = -", get("__org2.periodCostString"), "-");

/* 多单价显示（研究级单价不一致） */
run(`globalThis.__org3 = new OrgInfo({ key:"a0", region:0, name:"a", successCount:0, totalDeposits:0, unitPrice:1, periodSuccess:null, billingDate:new Date(2020,0,1), startDate:new Date(), endDate:new Date(),
  studies:[ __mk({unitPrice:1}), __mk({unitPrice:1.5}) ] });`);
check("OrgInfo·多单价合并显示", get("__org3.unitPriceString"), "1.0/1.5");
run("__org3.resetStudyUnitPrice();");
check("OrgInfo·resetStudyUnitPrice", get("__org3.studies.map(s=>s.unitPrice).join(',')"), "1,1");

/* ------------------------------------------------- User / UserStorage */
check("makeUser·key", get(`makeUser({orgName:"support", region:0, email:"a@b.com", password:"p"}).key`), "support0");
check("makeUser·默认单价", get(`makeUser({orgName:"x", region:1, email:"a@b.com", password:"p"}).unitPrice`), 1);
run(`SharedUsers = [makeUser({orgName:"support", region:0, email:"a@b.com", password:"p", token:"T",
  customPeriodStartDate:new Date(2026,8,1), studyUnitPrices:{"id1":2}})];
  UserStorage.save(SharedUsers);`);
check("UserStorage·持久化后可读回", get("UserStorage.load().length"), 1);
check("UserStorage·回读 customPeriodStartDate 为 Date", get("UserStorage.load()[0].customPeriodStartDate instanceof Date"), true);
check("UserStorage·回读 studyUnitPrices", get(`JSON.stringify(UserStorage.load()[0].studyUnitPrices)`), `{"id1":2}`);
check("UserStorage·回读 token", get("UserStorage.load()[0].token"), "T");
run("UserStorage.clear();");
check("UserStorage.clear", get("UserStorage.load().length"), 0);

console.log(h.results.join("\n"));
const r = h.report();
console.log(`\n模型保真：${r.text}${r.failed ? `（失败 ${r.failed}）` : ""}`);
process.exit(r.failed ? 1 : 0);
