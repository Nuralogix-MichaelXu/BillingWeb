#!/usr/bin/env node
/* ============================================================================
 * tools/_creds.js —— 测试凭据的唯一出口
 *
 * 本仓库**不存放**任何真实账号与口令。所有需要认证的脚本都从这里取，
 * 值来自环境变量：
 *
 *   BW_EMAIL      测试账号邮箱
 *   BW_PASSWORD   测试账号口令
 *   BW_ORG        组织名（默认 "support"）
 *   BW_ACCOUNTS   多账号登录整行文本，\n 分隔；设置后优先于上面三项
 *                 （行格式：组织 账号 口令 已充值 单价 计费日期 域名）
 *
 * 用前在 shell 里导出（不要写回代码、不要提交进仓库）：
 *   export BW_EMAIL='...'
 *   export BW_PASSWORD='...'
 *   node tools/api-verify.js
 *
 * 两类取法，别用错：
 *   · requireLive(tool)  —— 会真的拿账号去登录的场景（api-verify / trend-verify /
 *     live-verify / cdp-shot / overseas-login-probe / session-expired-verify /
 *     tests/live-period.test.js）。缺环境变量时**就地报错**并给出导出命令，
 *     而不是拿一个占位账号去撞生产接口、把「凭据没配」伪装成「登录失败」。
 *   · email() / password() —— 只是往表单里回填、根本不发认证请求的离线与仿真
 *     脚本（tests/logout、tests/refresh-network、session-expired-* 仿真、
 *     token-expiry-probe）。缺环境变量时回落成显然非真实的占位值。
 * ==========================================================================*/
const ORG = process.env.BW_ORG || "support";

/** 占位值：一眼能看出不是真实账号，避免被误当成真凭据 */
const PLACEHOLDER_EMAIL = "test@example.com";
const PLACEHOLDER_PASSWORD = "test-password";

function email() {
  return process.env.BW_EMAIL || PLACEHOLDER_EMAIL;
}
function password() {
  return process.env.BW_PASSWORD || PLACEHOLDER_PASSWORD;
}

/** 环境变量是否齐备（BW_ACCOUNTS 也可单独满足） */
function hasLiveCreds() {
  if (process.env.BW_ACCOUNTS) return true;
  return !!(process.env.BW_EMAIL && process.env.BW_PASSWORD);
}

function missingCredsError(tool) {
  const err = new Error(
    `${tool} 需要真实测试账号，当前环境缺少 BW_EMAIL / BW_PASSWORD。\n` +
      `请先在 shell 里导出后再运行：\n` +
      `  export BW_EMAIL='<账号邮箱>'\n` +
      `  export BW_PASSWORD='<口令>'\n` +
      `（口令请勿写回代码或提交进仓库；需要多个账号时用 BW_ACCOUNTS）`
  );
  err.code = "MISSING_CREDENTIALS";
  return err;
}

/** 需要真实认证的脚本在启动时调用；缺凭据立刻报错，不静默降级 */
function requireLive(tool) {
  if (!hasLiveCreds()) throw missingCredsError(tool || "本工具");
}

/**
 * 生成多账号登录的整行文本数组。
 *
 * @param {Array<{org:string, unitPrice?:number, date:string,
 *                region?:number, deposits?:number}>} defaults
 *   只描述**非敏感**的组织结构（组织名 / 单价 / 计费日期 / 域名）；
 *   账号与口令一律从环境变量注入，不作为参数传入。
 * @returns {string[]}
 */
function accountLines(defaults) {
  if (process.env.BW_ACCOUNTS) {
    return process.env.BW_ACCOUNTS.split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
  requireLive("多账号登录");
  return (defaults || []).map((d) =>
    [d.org, email(), password(), d.deposits ?? 0, d.unitPrice ?? 1.0, d.date, d.region ?? 0].join(" ")
  );
}

/** 单条账号行，供只回填表单的脚本使用（不校验环境变量） */
function line({ org, deposits = 0, unitPrice = 1.0, date, region = 0 }) {
  return [org, email(), password(), deposits, unitPrice, date, region].join(" ");
}

module.exports = {
  ORG,
  PLACEHOLDER_EMAIL,
  PLACEHOLDER_PASSWORD,
  email,
  password,
  hasLiveCreds,
  requireLive,
  missingCredsError,
  accountLines,
  line,
};
