#!/usr/bin/env node
/**
 * 趋势页独立复算：Node 直连接口拉每个时间点（30 天 / 12 月）的测量数，
 * 与真机页面展示的 dayData / monthData 逐点比对。
 *
 * 复刻页面的取数口径：
 *   getMeasurementInfo(org, region, studyID=null, Date=起点UTC, EndDate=终点UTC)
 *   = COMPLETE.TotalCount + PARTIAL.TotalCount
 */
const page = require(process.argv[2] || "/tmp/lv-trend.json");
const creds = require("./_creds");
creds.requireLive("trend-verify"); // 缺凭据立刻报错，不拿占位账号去撞生产接口

const HOST = "https://api.prod.deepaffex.cn";
const EMAIL = creds.email();
const PWD = creds.password();
const ORGS = ["support", "lssd_01"];
const ONLY = process.argv[3] || "all";

async function login(org) {
  const res = await fetch(HOST + "/organizations/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Email: EMAIL, Password: PWD, Identifier: org, TokenExpiresIn: 3600 * 24 }),
  });
  const j = JSON.parse(await res.text());
  if (typeof j.Token !== "string") throw new Error("登录失败 " + org);
  return j.Token;
}

async function count(org, token, dateISO, endISO) {
  let total = 0;
  for (const st of ["COMPLETE", "PARTIAL"]) {
    let q = "/organizations/measurements?Limit=1&Date=" + encodeURIComponent(dateISO);
    if (endISO) q += "&EndDate=" + encodeURIComponent(endISO);
    q += "&StatusID=" + st;
    const res = await fetch(HOST + q, { headers: { Authorization: "Bearer " + token } });
    const t = await res.text();
    if (res.status !== 200) throw new Error(org + " " + st + " HTTP " + res.status + " " + t.slice(0, 120));
    const arr = JSON.parse(t);
    total += arr[0] ? (arr[0].TotalCount ?? 0) : 0;
  }
  return total;
}

/** 本地日期 → UTC ISO（复刻页面 toUTCString） */
function localToUTC(y, m, d) {
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

async function main() {
  const tokens = {};
  for (const o of ORGS) tokens[o] = await login(o);
  console.log("登录完成:", ORGS.join(", "));

  let pass = 0, fail = 0;
  const rows = [];

  if (ONLY === "all" || ONLY === "month") {
    console.log("\n===== 12 个月 =====");
    for (const m of page.month) {
      const [y, mm] = m.month.split("-").map(Number);
      const ny = mm === 12 ? y + 1 : y;
      const nm = mm === 12 ? 1 : mm + 1;
      const startISO = localToUTC(y, mm, 1);
      const endISO = localToUTC(ny, nm, 1);
      let sum = 0;
      for (const o of ORGS) sum += await count(o, tokens[o], startISO, endISO);
      const ok = sum === m.count;
      ok ? pass++ : fail++;
      rows.push([m.month, m.count, sum, ok]);
      console.log(
        "  " + m.month + "  页面=" + String(m.count).padStart(6) + "  独立复算=" + String(sum).padStart(6) + "  " + (ok ? "✓" : "✗ 不一致") +
          "   [" + startISO + " → " + endISO + "]"
      );
    }
  }

  if (ONLY === "all" || ONLY === "day") {
    console.log("\n===== 30 天 =====");
    for (const d of page.day) {
      const [y, mm, dd] = d.date.split("-").map(Number);
      const startISO = localToUTC(y, mm, dd);
      const next = new Date(y, mm - 1, dd + 1);
      const endISO = new Date(next.getFullYear(), next.getMonth(), next.getDate()).toISOString();
      let sum = 0;
      for (const o of ORGS) sum += await count(o, tokens[o], startISO, endISO);
      const ok = sum === d.count;
      ok ? pass++ : fail++;
      rows.push([d.date, d.count, sum, ok]);
      console.log("  " + d.date + "  页面=" + String(d.count).padStart(5) + "  独立复算=" + String(sum).padStart(5) + "  " + (ok ? "✓" : "✗ 不一致"));
    }
  }

  console.log("\n=== 汇总: " + pass + " 通过, " + fail + " 不一致 ===");
  const bad = rows.filter((r) => !r[3]);
  if (bad.length) { console.log("不一致明细:"); bad.forEach((r) => console.log("  " + r[0] + " 页面=" + r[1] + " 复算=" + r[2])); process.exitCode = 2; }
}
main().catch((e) => { console.error("趋势复算异常:", e.stack || e); process.exit(1); });
