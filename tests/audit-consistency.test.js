/* ============================================================================
 * 与 iOS 对齐的「审计修复」回归测试
 *
 * 覆盖 2026-09-17 全量审计中发现并修复的三个真实缺陷。每条都对应 Swift 源码的
 * 某一行语义；**故意回滚对应改动应当让本套件变红**（已人工验证，见文件末尾注释）。
 *
 *   1) api.js   —— APIClient.sendRequestWithTokenRefresh
 *                  token 失效 → **不自动续期**，直接抛「会话失效」交页面处理
 *                  （弹「登录已过期」→ 点确定回登录页）。
 *                  历史缺陷：旧实现会静默重新登录并把用户留在原页，
 *                  或沿用入参里的旧 headers 重试（仍带过期 token，刷新等于白做）。
 *                  两者都已由「不续期」根除 —— 现在过期一定是可见的。
 *
 *   2) app.js   —— 1-LoginView.swift:237 `Double(components[3]) ?? 1.0`
 *                  `Double(_:)` 解析失败才回落 1.0；显式填 0 必须保留。
 *                  旧实现 `Number(x) || 1.0` 会把 0 当 falsy 吞成 1.0。
 *
 *   3) model.js —— Common.swift:51 `String.dateFromYyyyMMddString`
 *                  ICU `yyyy.MM.dd` / `MM/dd/yyyy` 的字段宽度是「最少位数」，
 *                  所以 "2020.1.1" 合法；但越界月/日 ICU 返回 nil，
 *                  而 JS `new Date(2020,12,45)` 会静默进位成 2021.02.14。
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHarness } = require("./harness");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, waitFor, check, results } = h;

/* ==========================================================================
 * 1. token 失效 → 不自动续期，直接抛「会话失效」（页面据此弹框并回登录页）
 *
 * 用独立的 vm 沙箱（同 transport.test.js）：只加载 model.js + api.js。
 * ========================================================================*/
function makeApiSandbox(handler) {
  const calls = [];
  const store = {};
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
      calls.push({ url: u, opts: o });
      return handler(u, o, calls.length);
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

/** 直接把报文当响应体返回（sendRequest 只读 text()） */
const body = (text) => ({ text: async () => text });
const apiError = (Code, Message) => body(JSON.stringify({ Code, Message }));

(async function main() {
  /* ---------------------------------------------------------------- 1. api.js */
  {
    const s = makeApiSandbox(async () => apiError("TOKEN_EXPIRED", "Token expired"));
    s.run(
      `SharedUsers = [makeUser({ orgName: "support", region: 0, email: "a@b.com", password: "p", token: "OLD_TOKEN" })];`
    );
    s.run(`UserStorage.save(SharedUsers);`);

    const out = await s
      .get(`APIClient.getLicences("support", Region.china, 100)`)
      .then((v) => ({ sent: true, value: v }), (e) => ({ sent: false, err: e }));

    check("1a 首次请求带旧 token", s.calls[0].opts.headers.Authorization, "Bearer OLD_TOKEN");
    check("1b token 失效后不重新登录（只发 1 次业务请求）", s.calls.length, 1);
    check(
      "1c 不含 /organizations/auth 调用",
      s.calls.some((c) => decodeURIComponent(c.url).includes("/organizations/auth")),
      false
    );
    check("1d 请求以失败告终（不静默恢复）", out.sent, false);
    check("1e 抛出的错误标记会话失效", out.sent === false && out.err.isSessionExpired === true, true);
    check("1f 保留接口原始 Code", out.sent === false && out.err.apiCode, "TOKEN_EXPIRED");
    check("1g 沿用接口原文提示", out.sent === false && out.err.message, "Token expired");
    check("1h 旧 token 未被改写（无续期即无回写）", s.get("SharedUsers[0].token"), "OLD_TOKEN");
  }

  /* 1x. 对照：反复调用同样只各发 1 次请求 → 不进入任何重试/续期循环 */
  {
    const s = makeApiSandbox(async () => apiError("INVALID_TOKEN", "Invalid token"));
    s.run(
      `SharedUsers = [makeUser({ orgName: "support", region: 0, email: "a@b.com", password: "p", token: "T" })];`
    );
    s.run(`UserStorage.save(SharedUsers);`);
    await s.get(`
      Promise.all([0, 1, 2].map(function () {
        return APIClient.getLicences("support", Region.china, 100).catch(function () { return null; });
      }))
    `);
    check("1x 3 次调用共 3 次请求，不无限重试", s.calls.length, 3);
    check(
      "1y 全程零登录请求",
      s.calls.some((c) => decodeURIComponent(c.url).includes("/organizations/auth")),
      false
    );
  }

  /* 1z. SharedUsers 里没有该 key → 报错照常抛出
   *     （authHeader 会回落 UserStorage，所以必须先有落盘的 token 才能走到这里） */
  {
    const s = makeApiSandbox(async () => apiError("TOKEN_EXPIRED", "Token expired"));
    s.run(
      `UserStorage.save([makeUser({ orgName: "support", region: 0, email: "a@b.com", password: "p", token: "T" })]);`
    );
    s.run(`SharedUsers = [];`);
    const msg = await s.get(`APIClient.getLicences("support", Region.china, 100)`).then(
      () => "",
      (e) => e.message
    );
    check("1z 找不到用户 → 不重新登录，只发 1 次请求", s.calls.length, 1);
    check("1z2 原错误照常抛出", msg, "Token expired");
  }

  /* 1w. authHeader 回落：内存没有但本地存储有 token 时仍能发请求（对齐 iOS） */
  {
    const s = makeApiSandbox(async () => body("[]"));
    s.run(
      `UserStorage.save([makeUser({ orgName: "support", region: 0, email: "a@b.com", password: "p", token: "STORE_TOKEN" })]);`
    );
    s.run(`SharedUsers = [];`);
    const out = await s.get(`APIClient.getLicences("support", Region.china, 100)`).then((v) => v, (e) => e);
    check("1w 回落本地存储取 token", s.calls[0].opts.headers.Authorization, "Bearer STORE_TOKEN");
    check("1w2 请求成功", Array.isArray(out), true);
  }

  /* 1v. 两处都没有 token → 抛 -4「未找到对应组织的授权Token」（对齐 iOS NSError code -4） */
  {
    const s = makeApiSandbox(async () => body("[]"));
    s.run(`SharedUsers = []; UserStorage.save([]);`);
    const err = await s.get(`APIClient.getLicences("ghost", Region.china, 100)`).then(() => null, (e) => e);
    check("1v 缺 token → 直接抛错且不发请求", s.calls.length, 0);
    check("1v2 错误码 -4", err && err.code, -4);
    check("1v3 错误文案", err && err.message, "未找到对应组织的授权Token");
  }

  /* --------------------------------------------------------------- 2/3. app 侧 */
  load("model.js");
  load("api.js");
  load("app.js");

  /* ------------------------------------ 2. swiftDouble：Double(x) ?? fallback */
  check("2a 显式 0 保留（不能被吞成 1.0）", get(`swiftDouble("0", 1.0)`), 0);
  check("2b 0.0 保留", get(`swiftDouble("0.0", 1.0)`), 0);
  check("2c 空串回落（Swift Double(空) = nil）", get(`swiftDouble("", 1.0)`), 1);
  check("2d 非数字回落（Swift Double(abc) = nil）", get(`swiftDouble("abc", 1.0)`), 1);
  check("2e 正常小数", get(`swiftDouble("2.5", 1.0)`), 2.5);
  check("2f 科学计数法（Swift Double(1e3) = 1000）", get(`swiftDouble("1e3", 1.0)`), 1000);
  check("2g 带空白 → nil（Swift Double(空格1) = nil）", get(`swiftDouble(" 1", 1.0)`), 1);
  check("2h 十六进制 → nil（Swift Double(0x10) = nil）", get(`swiftDouble("0x10", 1.0)`), 1);
  check("2i 纯小数点开头", get(`swiftDouble(".5", 1.0)`), 0.5);
  check("2j 负数", get(`swiftDouble("-3", 1.0)`), -3);

  /* 2k. 端到端：多账号文本里「已充值＝0 / 单价＝0」必须原样带进用户 */
  run(`ListPage.onAppear = () => {};`); // 屏蔽登录成功后的列表请求级联
  run(`APIClient.login = async () => ({ Token: "T" });`); // 登录本身不是本用例的关注点
  els["mode-toggle"].fire("click");
  check("2k0 已切到多账号模式", get("AppState.login.isMultiAccountMode"), true);
  els["multi-text"].value = [
    "support0 a@b.com p 0 0 2020.3.7 0", // 显式 0/0，且日期是单位数（3 月 7 日 ≠ 回落值 01.01）
    "support1 b@b.com p x y 2020.01.01 1", // 非法数字 → 回落 1.0；海外
  ].join("\n");
  els["multi-text"].fire("input");
  els["login-form"].fire("submit");
  await waitFor(`SharedUsers.length === 2`);

  check("2k 两个账号都已建立", get("SharedUsers.length"), 2);
  check("2l 已充值 0 未被吞成 1.0", get("SharedUsers[0].deposits"), 0);
  check("2m 单价 0 未被吞成 1.0", get("SharedUsers[0].unitPrice"), 0);
  check("2n 单位数日期 2020.3.7 解析成功（非回落值）", get(`yyyyMMddDateString(SharedUsers[0].billingDate)`), "2020.03.07");
  check("2o 国内 tag", get("SharedUsers[0].key"), "support00");
  check("2p 非法数字回落 1.0", get("SharedUsers[1].deposits"), 1);
  check("2q 非法单价回落 1.0", get("SharedUsers[1].unitPrice"), 1);
  check("2r 海外 tag", get("SharedUsers[1].key"), "support11");

  /* ------------------------- 3. dateFromYyyyMMddString：ICU 宽松宽度 + 严格越界 */
  run(`LanguageManager.currentLanguage = "zh-Hans";`);
  // 安全取值：解析失败时返回 null（而不是在断言里抛异常，导致看不到完整报告）
  const ts = (lit) => `(() => { const d = dateFromYyyyMMddString(${lit}); return d ? d.getTime() : null; })()`;
  check("3a 标准两位", get(`yyyyMMddDateString(dateFromYyyyMMddString("2020.09.15"))`), "2020.09.15");
  check(
    "3b 单位数月/日可解析（ICU 字段宽度是最少位数）",
    get(ts(`"2020.1.1"`)),
    get(`new Date(2020,0,1).getTime()`)
  );
  check("3c 越界月/日 → null（JS Date 会静默进位）", get(`dateFromYyyyMMddString("2020.13.45")`), null);
  check("3d 2 月 30 日 → null", get(`dateFromYyyyMMddString("2020.02.30")`), null);
  check("3e 闰年 2/29 合法", get(ts(`"2020.2.29"`)), get(`new Date(2020,1,29).getTime()`));
  check("3f 平年 2/29 → null", get(`dateFromYyyyMMddString("2021.2.29")`), null);
  check("3g 非日期串 → null", get(`dateFromYyyyMMddString("abc")`), null);
  check("3h 空串 → null", get(`dateFromYyyyMMddString("")`), null);
  check("3i 月 0 → null", get(`dateFromYyyyMMddString("2020.0.10")`), null);
  check("3j 日 0 → null", get(`dateFromYyyyMMddString("2020.10.0")`), null);

  run(`LanguageManager.currentLanguage = "en";`);
  check("3k 英文格式 M/d/yyyy 单位数可解析", get(ts(`"1/1/2020"`)), get(`new Date(2020,0,1).getTime()`));
  check("3l 英文格式越界 → null", get(`dateFromYyyyMMddString("13/45/2020")`), null);
  check("3m 英文格式·月在前（与中文格式互不串味）", get(`dateFromYyyyMMddString("2020.09.15")`), null);
  run(`LanguageManager.currentLanguage = "zh-Hans";`);

  console.log(results.join("\n"));
  const r = h.report();
  console.log(`\n审计修复回归：${r.text}${r.failed ? `（失败 ${r.failed}）` : ""}`);
  process.exit(r.failed ? 1 : 0);
})();
