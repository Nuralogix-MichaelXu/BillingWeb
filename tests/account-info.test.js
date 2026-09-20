/* ============================================================================
 * 设置菜单「账号信息」弹窗回归
 * 覆盖：菜单新增「账号信息」项 → 点击弹出账号信息弹窗 →
 *       列出当前已登录的全部账号（组织名称 / 邮箱 / 区域）→ 关闭可关闭。
 * 运行：node tests/account-info.test.js
 * 可选参数：<appDir> 指定被测目录（用于在未修复副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const path = require("path");
const vm = require("vm");
const { createHarness } = require("./harness");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, sleep, check, results } = h;

function fillLogin(org, email, pwd) {
  els["login-org"].value = org;
  els["login-org"].fire("input");
  els["login-email"].value = email;
  els["login-email"].fire("input");
  els["login-pwd"].value = pwd;
  els["login-pwd"].fire("input");
}

/** 走真实交互打开「账号信息」弹窗，返回弹窗 HTML */
async function openAccountInfo() {
  els["settings-btn"].fire("click");
  check("点齿轮后设置菜单展开", els["settings-menu"].style.display, "flex");
  els["settings-account-info"].fire("click");
  await sleep(0);
  return els["modal-root"].innerHTML;
}

(async function main() {
  load("model.js");
  load("api.js");

  // 假接口
  vm.runInContext(
    `
    APIClient.login = async function (email, password, orgName, region) {
      return { Token: "TOKEN-" + orgName };
    };
    APIClient.getAllStudies = async function () {
      const out = {};
      for (const u of SharedUsers) out[u.key] = [];
      return out;
    };
    APIClient.updateStudies = async function (studyDic, billingDateDic, startDate, endDate, progress) {
      for (const key of Object.keys(studyDic)) for (const s of studyDic[key]) { progress(); progress(); }
    };
    `,
    h.sandbox
  );

  load("app.js");

  /* ---------- 0. 初始状态 ---------- */
  check("菜单含「账号信息」项", /id="settings-account-info"[\s\S]*?账号信息/.test(require("fs").readFileSync(`${h.appDir}/index.html`, "utf8")), true);

  /* ---------- 1. 单账号：弹窗内容 ---------- */
  fillLogin("orgA", "a@a.com", "pwdA");
  els["login-form"].fire("submit");
  await h.waitFor('AppState.currentPage === "list"');
  check("进入列表页后菜单隐藏", els["settings-menu"].style.display, "none");

  let html = await openAccountInfo();
  check("弹窗已打开", els["modal-root"].classList.contains("show"), true);
  check("弹窗标题「账号信息」", /modal-title[^>]*>账号信息</.test(html), true);
  check("列出 1 个账号", (html.match(/account-item/g) || []).length, 1);
  check("组织名称=orgA", /account-row[^]*?组织名称[^]*?orgA</.test(html), true);
  check("邮箱=a@a.com", /account-row[^]*?邮箱[^]*?a@a.com</.test(html), true);
  check("区域=国内", /account-row[^]*?区域[^]*?国内</.test(html), true);

  /* ---------- 2. 关闭弹窗 ---------- */
  h.clickModalBtn("关闭");
  check("点「关闭」后弹窗关闭", els["modal-root"].classList.contains("show"), false);
  check("关闭后设置菜单也收起", els["settings-menu"].style.display, "none");

  /* ---------- 3. 区域=海外的账号 ---------- */
  els["settings-logout"].fire("click");
  h.clickModalBtn("确定");
  await h.waitFor('AppState.currentPage === "login"');
  run(`document.querySelectorAll("#region-tabs .tab").find((t) => t.dataset.region === "1").fire("click")`);
  fillLogin("orgOversea", "o@o.com", "pwdO");
  els["login-form"].fire("submit");
  await h.waitFor('AppState.currentPage === "list"');

  html = await openAccountInfo();
  check("海外账号区域=海外", /account-row[^]*?区域[^]*?海外</.test(html), true);
  h.clickModalBtn("关闭");

  /* ---------- 4. 多账号：列出全部已登录账号 ---------- */
  els["settings-logout"].fire("click");
  h.clickModalBtn("确定");
  await h.waitFor('AppState.currentPage === "login"');
  els["mode-toggle"].fire("click");
  els["multi-text"].value = [
    "orgA a@a.com pwdA 0 1.0 2020.01.01 0",
    "orgOversea o@o.com pwdO 0 1.0 2020.01.01 1",
  ].join("\n");
  els["multi-text"].fire("input");
  els["login-form"].fire("submit");
  await h.waitFor('AppState.currentPage === "list"');
  check("多账号登录出 2 个用户", get("SharedUsers").length, 2);

  html = await openAccountInfo();
  check("多账号列出 2 个账号块", (html.match(/account-item/g) || []).length, 2);
  check("含第 1 个账号邮箱", html.includes("a@a.com"), true);
  check("含第 2 个账号邮箱", html.includes("o@o.com"), true);
  check("两个账号区域并存（国内+海外）", /区域[^]*?国内/.test(html) && /区域[^]*?海外/.test(html), true);
  h.clickModalBtn("关闭");
  check("多账号弹窗也可关闭", els["modal-root"].classList.contains("show"), false);

  /* ---------- 4b. 超过 3 个账号：列表定高滚动（不全部平铺） ---------- */
  els["settings-logout"].fire("click");
  h.clickModalBtn("确定");
  await h.waitFor('AppState.currentPage === "login"');
  // isMultiAccountMode 持久化在 localStorage：上一节已切到多账号，登出后仍是多账号；
  // 只有当前不是多账号时才需要点 toggle（点反了会切回单账号导致只用默认账号登录）。
  if (!get("AppState").login.isMultiAccountMode) els["mode-toggle"].fire("click");
  els["multi-text"].value = [
    "a1 a@a.com p 0 1.0 2020.01.01 0",
    "a2 b@b.com p 0 1.0 2020.01.01 0",
    "a3 c@c.com p 0 1.0 2020.01.01 1",
    "a4 d@d.com p 0 1.0 2020.01.01 0",
  ].join("\n");
  els["multi-text"].fire("input");
  els["login-form"].fire("submit");
  await h.waitFor('AppState.currentPage === "list"');
  check("多账号登录出 4 个用户", get("SharedUsers").length, 4);

  html = await openAccountInfo();
  check("DOM 渲染全部 4 个账号块（滚动而非截断）", (html.match(/account-item/g) || []).length, 4);
  const css = require("fs").readFileSync(`${h.appDir}/index.html`, "utf8");
  check(".account-list 定高 338px（恰好 3 块 + 间距）", /\.account-list\{[^}]*max-height:338px/.test(css), true);
  check(".account-list 可纵向滚动", /\.account-list\{[^}]*overflow-y:auto/.test(css), true);
  h.clickModalBtn("关闭");

  /* ---------- 5. 再点齿轮仍能正常开合（菜单未被弹窗逻辑破坏） ---------- */
  els["settings-btn"].fire("click");
  check("齿轮再次展开菜单", els["settings-menu"].style.display, "flex");
  els["settings-btn"].fire("click");
  check("齿轮再次收起菜单", els["settings-menu"].style.display, "none");

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("测试执行异常:", e);
  process.exit(1);
});
