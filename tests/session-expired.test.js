/* ============================================================================
 * tests/session-expired.test.js —— 「token 过期 → 点确定回登录页」
 *
 * 需求：任何页面弹出 token 过期弹框后，点「确定」返回登录页。
 *
 * 真实接口实测（2026-09-17，support 组织）决定了判定口径：
 *   · token 失效   → 401 {"Code":"INVALID_TOKEN","Message":"Invalid token"}   ← 算过期
 *   · 未带鉴权头   → 401 {"Code":"UNAUTHORIZED", "Message":"UNAUTHORIZED"}    ← 算过期
 *   · 跨组织访问   → 403 {"Code":"RESTRICTED_ACCESS","Message":""}            ← **不算**过期
 *
 * 分两段：
 *   A. API 层分类（vm 沙箱，只加载 model.js + api.js）
 *   B. 页面层行为（harness + app.js）：列表页 / 详情页 / 趋势页 → 弹框 → 回登录页
 *
 * 运行：node tests/session-expired.test.js
 * 可选参数：<appDir> 指定被测目录（用于在缺陷副本上确认测试抓得住缺陷）
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHarness } = require("./harness");

/** 可选参数 <appDir>：用于在「未修复副本」上确认本套件真的抓得住缺陷 */
const APP_DIR = process.argv[2] ?? null;
const h = createHarness(APP_DIR ? { appDir: APP_DIR } : {});
const { els, load, get, run, sleep, waitFor, check, results } = h;

/* ==========================================================================
 * A. API 层：什么算「会话失效」
 * ========================================================================*/
function makeApiSandbox(fetchImpl) {
  const store = {};
  const calls = [];
  const ctx = {
    location: { protocol: "http:", origin: "http://127.0.0.1:4173" },
    console,
    setTimeout,
    clearTimeout,
    AbortSignal,
    AbortController,
    URL,
    JSON,
    Promise,
    Error,
    TypeError,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    fetch: async (u, o) => {
      calls.push(u);
      return fetchImpl(u, o, calls.length);
    },
  };
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  const loadFile = (f) =>
    vm.runInContext(fs.readFileSync(path.join(h.appDir, f), "utf8"), sandbox, { filename: f });
  loadFile("model.js");
  loadFile("api.js");
  return {
    calls,
    get: (expr) => vm.runInContext(expr, sandbox),
    run: (code) => vm.runInContext(code, sandbox),
  };
}
const body = (text) => ({ status: 200, text: async () => text });
/** 带 HTTP 状态码的响应桩（用于覆盖「401 但报文不是标准 ErrorResponse」的兜底） */
const statusBody = (status, text) => ({ status, text: async () => text });
const apiError = (Code, Message) => body(JSON.stringify({ Code, Message }));

/**
 * 在沙箱内完成「请求 → 断言」，返回纯对象（跨 context 的对象不能用 instanceof 判断）。
 * SharedUsers / UserStorage 由 withUser / withoutUser 决定，用来控制能否自动刷新。
 */
function probe(s, withUsers) {
  const seed = `makeUser({ orgName: "support", region: 0, email: "a@b.com", password: "p", token: "T" })`;
  s.run(withUsers ? `SharedUsers = [${seed}]; UserStorage.save(SharedUsers);` : `SharedUsers = []; UserStorage.save([${seed}]);`);
  return s.get(`
    APIClient.getLicences("support", Region.china, 100).then(
      function (v) { return { ok: true, isArray: Array.isArray(v) }; },
      function (e) {
        return { ok: false, name: e.name, code: e.code, apiCode: e.apiCode, message: e.message,
                 flagged: e.isSessionExpired === true, classified: isSessionExpiredError(e) };
      }
    )
  `);
}
/**
 * 不自动续期：第 1 次请求返回 Code 报文，此后若还有请求说明发生了「重新登录」
 * —— 这正是本套件要杜绝的行为，故后续响应统一返回同一份错误报文。
 */
const alwaysApiError = (Code, Message) => async () => apiError(Code, Message);

(async function main() {
  /* A1：真实 401 报文（无可用账号刷新）→ 被 api.js 判为会话失效 */
  {
    const s = makeApiSandbox(async () => apiError("INVALID_TOKEN", "Invalid token"));
    const e = await probe(s, false);
    check("A1 保留接口原始 Code", e.apiCode, "INVALID_TOKEN");
    check("A1 提示沿用接口原文", e.message, "Invalid token");
    check("A1 被 api.js 打上会话失效标记", e.flagged, true);
    check("A1 判定函数认同", e.classified, true);
  }

  /* A2：各类 Code / 错误码的判定口径 */
  {
    const s = makeApiSandbox(async () => body("[]"));
    s.run(`
      const mk = function (code, apiCode) { const e = new APIError(code, -1); if (apiCode) e.apiCode = apiCode; return e; };
      const raw = function (msg, c) { const e = new Error(msg); e.code = c; return e; };
      globalThis.__cls = [
        mk("Invalid token", "INVALID_TOKEN"),
        mk("UNAUTHORIZED", "UNAUTHORIZED"),
        mk("", "RESTRICTED_ACCESS"),
        mk("Invalid Credentials", "INVALID_CREDENTIALS"),
        raw("未找到对应组织的授权Token", -4),
        raw("网络错误", -1009),
        mk("发生错误：UNKNOWN", ""),
        new APIError("m", -1),
      ].map(isSessionExpiredError);
    `);
    check("A2 INVALID_TOKEN 算过期", s.get("__cls[0]"), true);
    check("A2 UNAUTHORIZED 算过期", s.get("__cls[1]"), true);
    check("A2 跨组织 RESTRICTED_ACCESS 不算过期（不误踢）", s.get("__cls[2]"), false);
    check("A2 凭据错误 INVALID_CREDENTIALS 不算过期", s.get("__cls[3]"), false);
    check("A2 authHeader 无 token（code -4）算过期", s.get("__cls[4]"), true);
    check("A2 网络错误（-1009）不算过期", s.get("__cls[5]"), false);
    check("A2 空 Code 不算过期", s.get("__cls[6]"), false);
    check("A2 无 apiCode 的 APIError 不算过期", s.get("__cls[7]"), false);
    check("A2 null / undefined 不抛错", s.get("isSessionExpiredError(null) || isSessionExpiredError(undefined)"), false);
    check("A2 普通 Error 不算过期", s.get("isSessionExpiredError(new Error('x'))"), false);
  }

  /* A3：token 过期 → **不自动续期**：即使账号密码都在，也直接抛「会话失效」
   * （旧版会静默重新登录并把用户留在原页，用户永远看不到过期提示） */
  {
    const s = makeApiSandbox(alwaysApiError("TOKEN_EXPIRED", "Your token has expired"));
    const e = await probe(s, true);
    check("A3 抛错而非静默恢复", e.ok, false);
    check("A3 标记 isSessionExpired", e.flagged, true);
    check("A3 判定函数认同", e.classified, true);
    check("A3 保留接口原始 Code", e.apiCode, "TOKEN_EXPIRED");
    check("A3 只发 1 次请求（绝不重新登录）", s.calls.length, 1);
    check("A3 登录接口未被调用", s.calls.some((u) => decodeURIComponent(u).includes("/organizations/auth")), false);
    check("A3 token 未被改写", s.get("SharedUsers[0].token"), "T");
  }

  /* A4：INVALID_TOKEN 同样直接抛会话失效，不做续期 */
  {
    const s = makeApiSandbox(alwaysApiError("INVALID_TOKEN", "Invalid token"));
    const e = await probe(s, true);
    check("A4 标记 isSessionExpired", e.flagged, true);
    check("A4 被判定为会话失效", e.classified, true);
    check("A4 保留原始 apiCode", e.apiCode, "INVALID_TOKEN");
    check("A4 只发 1 次请求", s.calls.length, 1);
    check("A4 原样沿用接口原文", e.message, "Invalid token");
  }

  /* A5：传输层失败 → 不能算会话失效（网络抖动不踢人） */
  {
    const s = makeApiSandbox(async () => {
      throw new TypeError("Failed to fetch");
    });
    const e = await probe(s, true);
    check("A5 抛 NetworkError", e.name, "NetworkError");
    check("A5 不算会话失效", e.flagged, false);
    check("A5 判定函数也不认同", e.classified, false);
    check("A5 不会因网络抖动触发重登", s.calls.some((u) => decodeURIComponent(u).includes("/organizations/auth")), false);
  }

  /* A6：authHeader 拿不到 token（内存与本地存储都没有） */
  {
    const s = makeApiSandbox(async () => body("[]"));
    s.run(`SharedUsers = []; localStorage.removeItem("userList");`);
    const e = s.run(`(function(){ try { APIClient.authHeader("ghost0"); return null; } catch (x) { return x; } })()`);
    check("A6 code = -4", e.code, -4);
    check("A6 标记为会话失效", e.isSessionExpired, true);
    check("A6 判定函数认同", s.get(`isSessionExpiredError((function(){const z=new Error('t');z.code=-4;return z})())`), true);
  }

  /* A7：HTTP 401 但响应体不是标准 ErrorResponse 结构
   * 此前这类响应会被当成「成功数据」返回，上层解析失败后只弹一个普通错误框 ——
   * 用户点「确定」只关掉弹框、滞留在原页（线上反馈：token 过期后点确定回不去登录页）。 */
  {
    const s = makeApiSandbox(async () => statusBody(401, "<html><body>401 Unauthorized</body></html>"));
    const e = await probe(s, false);
    check("A7 非标准 401 报文仍标记会话失效", e.flagged, true);
    check("A7 判定函数认同", e.classified, true);
    check("A7 兜底 apiCode 记为 UNAUTHORIZED", e.apiCode, "UNAUTHORIZED");
  }

  /* A7b：401 且报文缺 Message（不满足 ErrorResponse 形状） */
  {
    const s = makeApiSandbox(async () => statusBody(401, JSON.stringify({ Code: "INVALID_TOKEN" })));
    const e = await probe(s, false);
    check("A7b 缺 Message 的 401 仍算会话失效", e.flagged, true);
    check("A7b 保留接口原始 Code", e.apiCode, "INVALID_TOKEN");
  }

  /* A7c：非 401 的非结构化响应 → 维持原行为，不得误判成会话失效（否则会把用户误踢） */
  {
    const s = makeApiSandbox(async () => statusBody(500, "server boom"));
    const e = await probe(s, false);
    check("A7c 非 401 不误判为会话失效", e.flagged, false);
    check("A7c 判定函数也不认同", e.classified, false);
  }

  /* A8：并发多个请求同时过期 → 每个都按会话失效抛出，且一次登录请求都不发
   * （旧版会为每个失败请求各发一次 login，海外限流下属于白送的负担） */
  {
    const s = makeApiSandbox(alwaysApiError("INVALID_TOKEN", "Invalid token"));
    s.run(
      `SharedUsers = [makeUser({ orgName: "support", region: 0, email: "a@b.com", password: "p", token: "T" })];` +
        `UserStorage.save(SharedUsers);`
    );
    const out = await s.get(`
      Promise.all([0, 1, 2].map(function (i) {
        return APIClient.getLicences("support", Region.china, 100).then(
          function () { return "ok"; },
          function (e) { return isSessionExpiredError(e) ? "expired" : "other"; }
        );
      })).then(function (r) { return r.join(","); })
    `);
    check("A8 三个并发请求全部判定为会话失效", out, "expired,expired,expired");
    check("A8 零次登录请求（请求数 = 3 个业务请求）", s.calls.length, 3);
    check(
      "A8 不含任何 /organizations/auth 调用",
      s.calls.some((u) => decodeURIComponent(u).includes("/organizations/auth")),
      false
    );
  }

  /* ========================================================================
   * B. 页面层：弹框 → 点确定 → 回登录页
   * ======================================================================*/
  function bootApp(opts) {
    // ⚠️ appDir 必须透传，否则页面层会用默认目录 → 回滚验证抓不住页面层的缺陷
    const g = createHarness(Object.assign({}, APP_DIR ? { appDir: APP_DIR } : {}, opts));
    g.load("model.js");
    g.load("api.js");
    g.run(`
      globalThis.__mode = "ok";
      globalThis.__alerts = [];
      /* 真实接口 401 报文的等价物：只带原始 Code，不带 isSessionExpired 标记，
         以此验证页面层靠 apiCode 判定（而不是靠被预先打好的标记） */
      globalThis.__sessionError = function () {
        const e = new APIError("Invalid token", -1);
        e.apiCode = "INVALID_TOKEN";
        return e;
      };
      APIClient.login = async function () { return { Token: "T" }; };
      APIClient.getAllStudies = async function () {
        if (__mode === "token" || __mode === "plain") throw __bizError();
        const out = {};
        for (const u of SharedUsers) {
          out[u.key] = [ new StudyResponse({ Created: 1788451200, ID: "c06eabcdef458b",
            Name: u.orgName + "-研究", Description: "", StatusID: "ACTIVE", Measurements: 0 }) ];
        }
        return out;
      };
      globalThis.__bizError = function () {
        return __mode === "token" ? __sessionError() : new Error("模拟失败");
      };
      APIClient.updateStudies = async function (studyDic, billingDateDic, startDate, endDate, progress) {
        if (__mode === "token" || __mode === "tokenLate" || __mode === "plain") throw __bizError();
        for (const key of Object.keys(studyDic)) {
          for (const s of studyDic[key]) { s.totalSuccessMeasurements = 7; progress(); progress(); }
        }
      };
      APIClient.getMeasurementInfo = async function (orgName, region, studyID, date, endDate, progress) {
        if (__mode === "token") throw __sessionError();
        if (progress) progress();
        if (progress) progress();
        return new MeasurementInfo(orgName, studyID, 3);
      };
    `);
    g.load("app.js");
    /* 统计 showAlert 调用次数：app.js 的 showPageError 在调用时才查全局 showAlert */
    g.run(`
      globalThis.__origShowAlert = showAlert;
      showAlert = function (title, message, buttons) {
        __alerts.push({ title: title, message: message,
          labels: (buttons || []).map(function (b) { return b.text; }),
          buttons: buttons || [] });
        return __origShowAlert(title, message, buttons);
      };
    `);
    return g;
  }

  async function loginToList(g) {
    g.els["login-org"].value = "support";
    g.els["login-org"].fire("input");
    g.els["login-email"].value = "a@b.com";
    g.els["login-email"].fire("input");
    g.els["login-pwd"].value = "p";
    g.els["login-pwd"].fire("input");
    g.els["login-form"].fire("submit");
    await g.waitFor('AppState.currentPage === "list"');
    await g.waitFor('AppState.list.isRefreshing === false');
    await g.sleep(60);
  }

  /* ---------------- B1. 列表页刷新时 token 过期 ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    check("B1 登录后进入列表页", g.get("AppState.currentPage"), "list");

    g.run(`__mode = "token";`);
    g.els["refresh-btn"].fire("click");
    await g.waitFor("__alerts.length > 0");
    await g.sleep(40);

    check("B1 弹框标题 = 登录已过期", g.get("__alerts[0].title"), "登录已过期");
    check("B1 弹框正文 = 登录状态已失效，请重新登录", g.get("__alerts[0].message"), "登录状态已失效，请重新登录");
    check("B1 只有一个按钮（确定，无取消）", g.get("__alerts[0].labels.join('/')"), "确定");
    // 安全取值：未修复副本上 buttons 可能不存在，这里要「报 FAIL」而不是抛异常中断整套
    check("B1 确定是主按钮", g.get("(__alerts[0].buttons[0] || {}).primary"), true);
    check("B1 点确定前仍停留在列表页", g.get("AppState.currentPage"), "list");
    check("B1 只有一处 token 过期弹框", g.get("__alerts.length"), 1);

    g.clickModalBtn("确定");
    check("B1 点确定 → 回登录页", g.get("AppState.currentPage"), "login");
    check("B1 会话已清空", g.get("SharedUsers.length"), 0);
    check("B1 本地存储已清空", g.store["userList"], undefined);
    check("B1 列表数据已重置", g.get("AppState.list.orgs.length"), 0);
    check("B1 筛选已重置", g.get("AppState.list.selectedFilter"), "none");
    check("B1 刷新态已复位", g.get("AppState.list.isRefreshing"), false);
    check("B1 登录表单记住组织（preserveIdentity）", g.els["login-org"].value, "support");
    check("B1 登录表单记住邮箱", g.els["login-email"].value, "a@b.com");
    check("B1 回登录页强制清空密码", g.els["login-pwd"].value, "");
    check("B1 语言设置不受影响", g.store.AppLanguage, "zh-Hans");
    check("B1 弹窗已关闭", g.els["modal-root"].classList.contains("show"), false);

    /* 回到登录页后再来一次会话失败 → 不重复弹（守卫） */
    g.run(`showPageError(__sessionError());`);
    check("B1 已在登录页不再弹第二次", g.get("__alerts.length"), 1);

    /* 重新登录后再次过期 → 仍能提示（复位逻辑正确） */
    g.run(`__mode = "ok";`);
    await loginToList(g);
    g.run(`__mode = "token";`);
    g.els["refresh-btn"].fire("click");
    await g.waitFor("__alerts.length > 1");
    check("B1 重新登录后再次过期仍会提示", g.get("__alerts.length"), 2);
    check("B1 第二次弹框标题一致", g.get("__alerts[1].title"), "登录已过期");
    g.clickModalBtn("确定");
    check("B1 第二次点确定仍回登录页", g.get("AppState.currentPage"), "login");
  }

  /* ---------------- B2. 对照：普通错误不跳登录页 ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    g.run(`__mode = "plain";`);
    g.els["refresh-btn"].fire("click");
    await g.waitFor("__alerts.length > 0");
    check("B2 普通错误仍是「提示 / 错误：xxx」", g.get("__alerts[0].title") + " / " + g.get("__alerts[0].message"), "提示 / 错误：模拟失败");
    g.clickModalBtn("确定");
    check("B2 普通错误点确定后留在列表页", g.get("AppState.currentPage"), "list");
    check("B2 会话未被清空", g.get("SharedUsers.length"), 1);
  }

  /* ---------------- B3. 对照：跨组织 403 不跳登录页 ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    g.run(`
      APIClient.updateStudies = async function () {
        const e = new APIError("发生错误：RESTRICTED_ACCESS", -1);
        e.apiCode = "RESTRICTED_ACCESS";
        throw e;
      };
    `);
    g.els["refresh-btn"].fire("click");
    await g.waitFor("__alerts.length > 0");
    check("B3 403 走普通错误提示", g.get("__alerts[0].title"), "提示");
    g.clickModalBtn("确定");
    check("B3 403 不把用户踢回登录页", g.get("AppState.currentPage"), "list");
  }

  /* ---------------- B4. 并发多次失败只弹一次 ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    g.run(`showPageError(__sessionError()); showPageError(__sessionError()); showPageError(__sessionError());`);
    check("B4 三次连续会话失效只弹一次", g.get("__alerts.length"), 1);
    check("B4 弹框只渲染一组按钮", g.get("__alerts[0].labels.length"), 1);
  }

  /* ---------------- B5. 详情页 token 过期 ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    g.run(`AppState.list.selectedOrgIndex = 0; DetailPage.open();`);
    check("B5 进入详情页", g.get("AppState.currentPage"), "detail");

    g.run(`__mode = "token"; DetailPage.updateStudies();`);
    await g.waitFor("__alerts.length > 0");
    check("B5 详情页弹「登录已过期」", g.get("__alerts[0].title"), "登录已过期");
    check("B5 详情页转圈已收起", g.els["study-refreshing"].style.display, "none");
    check("B5 详情页刷新态已复位", g.get("DetailPage._isRefreshing"), false);

    g.clickModalBtn("确定");
    check("B5 详情页点确定回登录页", g.get("AppState.currentPage"), "login");
    check("B5 详情页会话已清空", g.get("SharedUsers.length"), 0);
    check("B5 详情页本地存储已清空", g.store["userList"], undefined);
  }

  /* ---------------- B6. 趋势页 token 过期 ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    g.run(`__mode = "token";`);
    g.els["stats-chart-summary"].fire("click");
    await g.waitFor('AppState.currentPage === "trend"');
    await g.waitFor("__alerts.length > 0");
    check("B6 趋势页弹「登录已过期」", g.get("__alerts[0].title"), "登录已过期");
    check("B6 趋势页错误不带「错误：」前缀（保持原形态）", g.get("__alerts[0].message"), "登录状态已失效，请重新登录");
    check("B6 加载态已收起", g.els["trend-loading"].style.display, "none");

    g.clickModalBtn("确定");
    check("B6 趋势页点确定回登录页", g.get("AppState.currentPage"), "login");
    check("B6 趋势数据已清空", g.get("TrendPage.dayData.length"), 0);
    check("B6 趋势月数据已清空", g.get("TrendPage.monthData.length"), 0);
    check("B6 公司入口已复位", g.get("TrendPage.companyName"), null);
    check("B6 在途聚合已作废（_seq 自增）", g.get("TrendPage._seq > 1"), true);
    check("B6 趋势页会话已清空", g.get("SharedUsers.length"), 0);
  }

  /* ---------------- B7. 英文模式下的弹框文案 ---------------- */
  {
    const g = bootApp({ language: "en" });
    await loginToList(g);
    g.run(`__mode = "token";`);
    g.els["refresh-btn"].fire("click");
    await g.waitFor("__alerts.length > 0");
    check("B7 英文标题", g.get("__alerts[0].title"), "Session Expired");
    check("B7 英文正文", g.get("__alerts[0].message"), "Your session has expired. Please sign in again.");
    check("B7 英文按钮", g.get("__alerts[0].labels.join('/')"), "Confirm");
    g.clickModalBtn("Confirm");
    check("B7 英文态同样回登录页", g.get("AppState.currentPage"), "login");
    check("B7 英文设置保留", g.store.AppLanguage, "en");
  }

  /* ---------------- B8. 退出登录复用了同一套收尾（含趋势页复位） ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    // 先真的进一次趋势页并完成加载，才能验证退出时把它一并复位
    g.els["stats-chart-summary"].fire("click");
    await g.waitFor('AppState.currentPage === "trend"');
    await g.waitFor("TrendPage.dayData.length === 30");
    const seqBefore = g.get("TrendPage._seq");
    g.run(`Router.go("list");`);

    g.els["settings-logout"].fire("click");
    check("B8 退出登录仍先确认", g.els["modal-root"].innerHTML.includes("确定要退出登录吗?"), true);
    g.clickModalBtn("确定");
    check("B8 退出登录回登录页", g.get("AppState.currentPage"), "login");
    check("B8 退出登录清空会话", g.get("SharedUsers.length"), 0);
    check("B8 退出登录清空本地存储", g.store["userList"], undefined);
    check("B8 退出登录复位趋势页数据", g.get("TrendPage.dayData.length"), 0);
    check("B8 退出登录作废在途趋势请求", g.get("TrendPage._seq") > seqBefore, true);
  }

  /* ---------------- B9. 会话弹框不被并发普通错误覆盖（否则「点确定」会失效） ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    g.run(`showPageError(__sessionError());`);
    await g.sleep(20);
    check("B9 先弹「登录已过期」", g.get("__alerts[0].title"), "登录已过期");
    check("B9 屏上是会话过期弹框", g.els["modal-root"].innerHTML.includes("登录已过期"), true);

    /* 并发请求中的另一个普通错误随后返回：不得把弹框换掉。
     * 换掉 = 用户手里那颗「确定」连同按钮一起消失，表现为「点确定没反应、停在原页」。
     * 这里直接断言屏上内容（真实体感），而不是 __alerts 计数（测试桩不经过 showAlert 守卫）。 */
    g.run(`showPageError(new Error("并发失败")); showAlert("提示", "另一条错误");`);
    await g.sleep(20);
    check("B9 屏上仍是会话过期弹框", g.els["modal-root"].innerHTML.includes("登录已过期"), true);
    check("B9 未被普通错误覆盖", g.els["modal-root"].innerHTML.includes("另一条错误"), false);
    check("B9 「确定」按钮仍在", g.els["modal-root"].innerHTML.includes(">确定<"), true);

    g.clickModalBtn("确定");
    check("B9 点确定仍回登录页", g.get("AppState.currentPage"), "login");
    check("B9 会话已清空", g.get("SharedUsers.length"), 0);
    check("B9 本地存储已清空", g.store["userList"], undefined);
  }

  /* ---------------- B10. 收尾任一步出错也不能挡住回登录页 ---------------- */
  {
    const g = bootApp();
    await loginToList(g);
    g.run(`ListPage.resetState = function () { throw new Error("模拟收尾异常"); };`);
    g.run(`showPageError(__sessionError());`);
    await g.waitFor("__alerts.length > 0");
    g.clickModalBtn("确定");
    check("B10 收尾某步抛异常仍回登录页", g.get("AppState.currentPage"), "login");
    check("B10 后续收尾步骤照常执行（会话已清空）", g.get("SharedUsers.length"), 0);
    check("B10 本地存储已清空", g.store["userList"], undefined);
    check("B10 登录表单记住组织（rememberedOrg 在收尾前已捕获）", g.els["login-org"].value, "support");
  }

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\ntoken 过期回登录页：${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
