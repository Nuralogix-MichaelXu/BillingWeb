/* 中继突发探针 —— 粘进「应用页面」的控制台执行（必须与部署页同源，/__proxy 才指得到中继）
 *
 * 为什么需要它：
 *   单发探测（/api/diag 的 dns/tls/http、?flaky=1 的抖动率）回答的是「此刻出口通不通」，
 *   但现场是「刷数据时成批 502」。突发与单发是两种负载，必须分开测。
 *
 * 它能区分的两件事（方向完全相反，所以必须先分清）：
 *   A. 502 正文里 Code === "PROXY_ERROR"  ⇒ 我们的中继自述：它转发上游时失败
 *      （看 ErrCode：ETIMEDOUT/ECONNRESET = 出口建连问题；与用户本机网络/VPN 无关）
 *   B. 502 但正文里**没有** Code === "PROXY_ERROR" ⇒ 那是上游自己回的 502
 *      （突发被上游网关拒绝；处置方向是限并发，不是换部署节点）
 *
 * 用法：整段粘贴、回车。只读，不发账密，不改任何状态。
 *   改成 POST 登录路径：把下边的 API 换成 /organizations/auth 并加 {method:'POST',...}（见文件末尾注释）。
 */
(async () => {
  const API =
    "https://api.prod.deepaffex.cn/organizations/measurements" +
    "?Limit=1&StudyID=a45910f7-f912-46e5-b38d-8678b2818b73" +
    "&Date=2026-01-13T16%3A00%3A00.000Z&StatusID=PARTIAL";
  const URL = "/__proxy?url=" + encodeURIComponent(API);
  const N = 12; // 并发数：与页面上「刷一批研究」的规模同量级

  const t0 = performance.now();
  const rs = await Promise.all(
    [...Array(N)].map(() =>
      fetch(URL, { cache: "no-store" })
        .then(async (r) => {
          const t = await r.text();
          let j = null;
          try { j = JSON.parse(t); } catch (e) {}
          return {
            http: r.status,
            标记: r.headers.get("x-billing-relay") || "-",
            Code: j?.Code || "",                       // PROXY_ERROR = 中继自述
            ErrName: j?.ErrName || "",
            ErrCode: j?.ErrCode || "",
            上游: j?.Upstream || "",
            正文来源: j?.BodySource || "",
            逐个地址: j?.ConnectErrors || "",
            Region: j?.Region || "",
            耗时ms: j?.ElapsedMs ?? "",
            片段: j ? "" : t.slice(0, 60),             // 非 JSON 时留下的线索
          };
        })
        .catch((e) => ({ http: "ERR", 标记: "-", ErrName: e.name, ErrCode: e.message }))
    )
  );

  console.table(rs);

  const bad = rs.filter((x) => typeof x.http === "number" && x.http >= 500);
  console.log(`并发 ${N} · 5xx ${bad.length} 个 · 总耗时 ${Math.round(performance.now() - t0)}ms`);

  if (!bad.length) {
    console.log("本轮零 5xx ⇒ 属偶发。多点几次或把 N 调大（如 30）再看。");
  } else {
    const relaySide = bad.filter((x) => x.Code === "PROXY_ERROR");
    const upstreamSide = bad.filter((x) => x.Code !== "PROXY_ERROR");
    console.log(
      `判据：中继自述(PROXY_ERROR) ${relaySide.length} 个 · 上游自己回 ${upstreamSide.length} 个`
    );
    if (relaySide.length) {
      const by = {};
      relaySide.forEach((x) => {
        const k = `${x.ErrCode || x.ErrName || "未知"} @${x.上游 || "?"} | ${x.逐个地址 || "-"}`;
        by[k] = (by[k] || 0) + 1;
      });
      console.log("A. 中继转发上游失败 —— 成因分布：");
      Object.entries(by).forEach(([k, v]) => console.log(`   ${v}× ${k}`));
      console.log("   ⇒ 出口建连类（ETIMEDOUT/ECONNRESET）= 与你的网络/代理/VPN 无关；换节点或加重试。");
    }
    if (upstreamSide.length) {
      const by = {};
      upstreamSide.forEach((x) => {
        const k = `HTTP ${x.http} | ${x.片段 || "-"}`;
        by[k] = (by[k] || 0) + 1;
      });
      console.log("B. 上游自己回的 5xx —— 分布：");
      Object.entries(by).forEach(([k, v]) => console.log(`   ${v}× ${k}`));
      console.log("   ⇒ 突发被上游网关拒绝：要动的是客户端并发闸门，不是换部署节点。");
    }
  }
})();

/* POST（登录路径）版本 —— 换成这段，其余同上：
 *
 * const API = "https://api.prod.deepaffex.cn/organizations/auth";
 * const URL = "/__proxy?url=" + encodeURIComponent(API);
 * // 用假口令：只要拿到 401 INVALID_CREDENTIALS 就说明请求完整到达了上游
 * const BODY = JSON.stringify({ Email: "probe-no-reply@example.com", Password: "not-a-real-password", Identifier: "probe", TokenExpiresIn: 86400 });
 * const N = 8;
 * ...
 * fetch(URL, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: BODY })
 * // 判据：401 + 标记=1 ⇒ 正文那一跳完好；若 502 ⇒ 同上面的 A/B 判据
 */
