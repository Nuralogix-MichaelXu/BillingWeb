#!/usr/bin/env node
/**
 * 完全独立的数据核对通道：Node 直连生产接口，绕过浏览器与 Web 代码。
 * 目的：用「同一时刻的接口原始数据」独立复算，再和真机页面展示值对比，
 *       确认页面数字不是内部自证（页面 getter → 页面显示 可能一起错）。
 *
 * 用法：
 *   export BW_EMAIL='<账号邮箱>' BW_PASSWORD='<口令>'   # 不要写进代码
 *   node tools/api-verify.js
 */
const creds = require("./_creds");
creds.requireLive("api-verify"); // 缺凭据立刻报错，不拿占位账号去撞生产接口

const HOST = "https://api.prod.deepaffex.cn";
const PWD = creds.password();
const EMAIL = creds.email();
const ORGS = [
  { name: "support", unitPrice: 1.0 },
  { name: "lssd_01", unitPrice: 1.2 },
];
/** 计费日期 2026.01.14（本地 UTC+8）→ UTC 字符串 */
const BILLING_UTC = "2026-01-13T16:00:00.000Z";

async function login(org) {
  const res = await fetch(HOST + "/organizations/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Email: EMAIL,
      Password: PWD,
      Identifier: org,
      TokenExpiresIn: 3600 * 24,
    }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (typeof json.Token !== "string") throw new Error("登录失败 " + org + ": " + text.slice(0, 200));
  return json.Token;
}

async function get(path, token) {
  const res = await fetch(HOST + path, { headers: { Authorization: "Bearer " + token } });
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch (e) { return null; } })() };
}

/** iOS getMeasurementInfo：COMPLETE + PARTIAL 的 TotalCount 相加 */
async function measureCount(studyID, status, token) {
  const q = "/organizations/measurements?Limit=1&StudyID=" + studyID + "&Date=" + encodeURIComponent(BILLING_UTC) + "&StatusID=" + status;
  const r = await get(q, token);
  if (r.status !== 200) return { err: r.status + " " + r.text.slice(0, 120) };
  const arr = r.json;
  if (!Array.isArray(arr)) return { err: "非数组: " + r.text.slice(0, 120) };
  return { count: arr[0] ? (arr[0].TotalCount ?? 0) : 0 };
}

async function main() {
  const page = require(process.argv[2] || "/tmp/lv-detail.json");
  const pageByOrg = {};
  for (const r of page.results) pageByOrg[r.orgName] = r;

  console.log("计费日（UTC）:", BILLING_UTC);
  const summary = {};
  for (const org of ORGS) {
    console.log("\n########## " + org.name + " ##########");
    const token = await login(org.name);
    console.log("登录: ok, token 长度", token.length);

    const studies = await get("/studies?Limit=5", token);
    console.log("/studies →", studies.status, Array.isArray(studies.json) ? studies.json.length + " 条" : studies.text.slice(0, 120));
    if (!Array.isArray(studies.json)) continue;

    let sumInBill = 0;
    const detail = [];
    for (const s of studies.json) {
      const c = await measureCount(s.ID, "COMPLETE", token);
      const p = await measureCount(s.ID, "PARTIAL", token);
      const total = (c.count ?? 0) + (p.count ?? 0);
      sumInBill += total;
      detail.push({ name: s.Name, id: s.ID, complete: c, partial: p, total });
      console.log(
        "  · " + String(s.Name).padEnd(22) +
          " COMPLETE=" + (c.err ? "ERR " + c.err : c.count) +
          " PARTIAL=" + (p.err ? "ERR " + p.err : p.count) +
          " → " + total
      );
    }
    const expectCost = sumInBill * org.unitPrice;
    const pageOrg = pageByOrg[org.name] || {};
    summary[org.name] = { sumInBill, expectCost, pageInBill: pageOrg.org && pageOrg.org.billingSuccessMeasurements, pageCost: pageOrg.org && pageOrg.org.billingCost };
    console.log("独立复算: 账单内测量=" + sumInBill + "  账单费用=" + sumInBill + "×" + org.unitPrice + "=" + expectCost);
    console.log("页面展示: 账单内测量=" + (pageOrg.org && pageOrg.org.billingSuccessMeasurements) + "  账单费用=" + (pageOrg.org && pageOrg.org.billingCost));
    console.log("是否一致: " + (sumInBill === (pageOrg.org && pageOrg.org.billingSuccessMeasurements) ? "✓ 一致" : "✗ 不一致"));
  }
  console.log("\n=== 小结 ===");
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((e) => { console.error("独立核对异常:", e.stack || e); process.exit(1); });
