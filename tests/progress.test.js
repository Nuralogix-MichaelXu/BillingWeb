/* ============================================================================
 * 进度条接力契约（假进度 → 真进度）
 * 运行：node tests/    可选参数：<appDir> 指定被测目录（用于在未修复副本上确认测试抓得住缺陷）
 *
 * 设计意图（用户 2026-09-18 明确，与 iOS 完全一致）：
 *   ① 总请求数算不出来之前（等 /studies）：用假进度定时器让条子动起来
 *      —— 2-BillingListView.swift:699-707，每 100ms += 0.002 × totalRequests，撞 0.9 就自停
 *   ② /studies 回来后：换真进度（updateStudies 回调），并把假进度按比例继承过来
 *      —— 2-BillingListView.swift:710-711 停表、:728/:779 `completedRequests = progress * totalRequests`
 *   ③ 之后 totalRequests 只增，所以百分比既不跳变也不回退
 *
 * 曾经的缺陷（本次修复）：JS 在 ② 之后又 startProgressTimer() 了一次（iOS 没有这一步），
 * 假进度与真进度并行累加 → 抢先顶到 0.9 天花板 → 定时器自停 → 条子冻在 90%，
 * 等真进度追上来才猛跳到 100%（用户报障「经常卡在 90% 左右停住，然后快速到 100%」）。
 * ==========================================================================*/
const { createHarness } = require("./harness");

const h = createHarness(process.argv[2] ? { appDir: process.argv[2] } : {});
const { els, load, get, run, sleep, waitFor, check, results } = h;

const STUDIES = [
  { Created: 1788451200, ID: "a1b2c3d4e5f6", Name: "研究A", Description: "", StatusID: "ACTIVE", Measurements: 0 },
  { Created: 1788451200, ID: "b1b2c3d4e5f7", Name: "研究B", Description: "", StatusID: "ACTIVE", Measurements: 0 },
];

/** 采样器：记录显示百分比 + 假进度定时器是否在跑 */
function makeSampler() {
  const rows = [];
  const id = setInterval(() => {
    const raw = els["progress-text"].textContent;
    rows.push({
      pct: raw === "" ? null : parseInt(raw, 10),
      fake: get("ListPage._progressTimer") != null,
      real: get("__measureCalls"),
    });
  }, 25);
  return { rows, stop: () => clearInterval(id) };
}

(async function main() {
  load("model.js");
  load("api.js");

  h.sandbox.__studies = STUDIES;
  run(`
    globalThis.__studyDelay = 1600;   // 模拟 /studies 的网络耗时（够假进度爬出几个百分点）
    globalThis.__measureDelay = 60;   // 模拟单个测量请求的耗时
    globalThis.__studiesCalls = 0;
    globalThis.__measureCalls = 0;
    APIClient.login = async (email, password, orgName, region) => ({ Token: "T" });
    APIClient.getAllStudies = () => new Promise((resolve) => {
      globalThis.__studiesCalls++;
      setTimeout(() => {
        const out = {};
        for (const u of SharedUsers) out[u.key] = __studies.map((j) => new StudyResponse(j));
        resolve(out);
      }, globalThis.__studyDelay);
    });
    APIClient.updateStudies = async function (studyDic, billingDateDic, startDate, endDate, progress) {
      for (const key of Object.keys(studyDic)) {
        for (const s of studyDic[key]) {
          await new Promise((r) => setTimeout(r, globalThis.__measureDelay));
          globalThis.__measureCalls++;
          progress(); progress();
        }
      }
    };
  `);

  load("app.js");

  /* ------------------------------------------------ 场景 1：首次进入（orgs 为空） */
  els["login-org"].value = "support";
  els["login-org"].fire("input");
  els["login-email"].value = "a@b.com";
  els["login-email"].fire("input");
  els["login-pwd"].value = "p";
  els["login-pwd"].fire("input");

  const s1 = makeSampler();
  els["login-form"].fire("submit");

  // ① 等 /studies 期间：假进度定时器必须在跑，条子在动
  await sleep(300);
  check("S1 等 /studies 期间假进度定时器在跑", get("ListPage._progressTimer") != null, true);
  check("S1 假进度已开始累加", get("AppState.list.completedRequests") > 0, true);
  check("S1 此时还没发测量请求（仍在等 /studies）", get("__measureCalls"), 0);

  await sleep(1100); // 累计 ~1.4s，假进度约 2.8%
  const tBefore = Date.now();
  const ratioBefore = get("AppState.list.completedRequests / AppState.list.totalRequests");
  const pctBefore = get("AppState.list.completedRequests / AppState.list.totalRequests") * 100;
  check("S1 假进度确实在推进", ratioBefore > 0.01, true);

  // ② /studies 回来 → 交接。真进度阶段绝不能有假进度定时器
  const handedOff = await waitFor("AppState.list.totalRequests > 1", 5000);
  const tAfter = Date.now();
  check("S1 /studies 已返回（总请求数已算出）", handedOff, true);
  check("S1 交接后假进度定时器已停（真进度阶段不许它再跑）", get("ListPage._progressTimer"), null);

  const ratioAfter = get("AppState.list.completedRequests / AppState.list.totalRequests");
  // 假进度每 100ms 涨 0.002（比值口径），所以两次采样之间最多涨「经过的 tick 数 × 0.002」；
  // 交接若把假进度清零或换算错（例如误用绝对值而非比例），增量会明显超出这个上界。
  const maxDelta = 0.002 * (Math.floor((tAfter - tBefore) / 100) + 1) + 1e-9;
  check("S1 交接继承假进度（不清零）", ratioAfter > 0.01, true);
  check(`S1 交接不跳变（增量 ${(ratioAfter - ratioBefore).toFixed(4)} ≤ 上界 ${maxDelta.toFixed(4)}）`, ratioAfter - ratioBefore >= 0 && ratioAfter - ratioBefore <= maxDelta, true);
  check("S1 交接不回退（百分比不下降）", ratioAfter >= ratioBefore, true);
  check("S1 交接瞬间显示百分比不回退", parseInt(els["progress-text"].textContent, 10) >= Math.trunc(pctBefore), true);

  // ③ 真进度阶段：靠 updateStudies 回调推进，且中途不会再冒出假进度定时器
  await sleep(200);
  check("S1 真进度阶段已开始发请求", get("__measureCalls") > 0, true);
  check("S1 真进度阶段仍无假进度定时器", get("ListPage._progressTimer"), null);

  await waitFor("AppState.list.isRefreshing === false", 8000);
  s1.stop();
  check("S1 结束时条子已到 100%", parseInt(els["progress-text"].textContent, 10), 100);
  check("S1 结束后进度条隐藏", els["progress-wrap"].style.display, "none");
  const pcts1 = s1.rows.map((r) => r.pct).filter((x) => x != null);
  check("S1 全过程中间态出现过（不是 0 直接跳 100）", pcts1.some((p) => p > 0 && p < 100), true);
  check("S1 百分比全程单调不减（不回退）", pcts1.every((p, i) => i === 0 || p >= pcts1[i - 1]), true);
  check("S1 真进度阶段从未冒出假进度定时器", s1.rows.every((r) => !(r.fake && r.real > 0)), true);

  /* ------------------------------------ 场景 2：已有数据时刷新（orgs 非空，不再拉 /studies） */
  const studiesCallsBefore = get("__studiesCalls");
  run("globalThis.__measureCalls = 0;");
  const s2 = makeSampler();
  els["refresh-btn"].fire("click");
  await waitFor("AppState.list.isRefreshing === true", 3000);
  await sleep(200);
  check("S2 有数据时刷新不重新拉 /studies", get("__studiesCalls"), studiesCallsBefore);
  check("S2 该分支没有假进度定时器（与 iOS 一致：没有 /studies 就没有假进度）", get("ListPage._progressTimer"), null);
  await waitFor("AppState.list.isRefreshing === false", 8000);
  s2.stop();
  check("S2 结束时条子已到 100%", parseInt(els["progress-text"].textContent, 10), 100);
  const pcts2 = s2.rows.map((r) => r.pct).filter((x) => x != null);
  check("S2 百分比全程单调不减", pcts2.every((p, i) => i === 0 || p >= pcts2[i - 1]), true);
  check("S2 全程无假进度定时器（真进度驱动）", s2.rows.every((r) => !r.fake), true);

  console.log(results.join("\n"));
  const failed = results.filter((x) => x.startsWith("FAIL"));
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})();
