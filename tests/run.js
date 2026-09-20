#!/usr/bin/env node
/* ============================================================================
 * 测试总入口：node tests/run.js [appDir] [--live]
 *
 *   默认      只跑离线套件（DOM stub + vm，无网络依赖）。
 *   --live    额外跑真实环境套件（jsdom 真实 DOM + 真实接口，需先启动 server.js）。
 *
 * 逐个运行 tests/*.test.js，汇总通过/失败；任一失败则以非 0 退出。
 * ==========================================================================*/
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const argv = process.argv.slice(2);
const withLive = argv.includes("--live");
const appDir = argv.find((a) => !a.startsWith("--"));

// jsdom 装在托管 node workspace 里，通过 NODE_PATH 暴露给子进程
const MANAGED_MODULES = "/Users/michael/.workbuddy/binaries/node/workspace/node_modules";

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => (withLive ? true : !f.startsWith("live-")))
  .sort();

if (!files.length) {
  console.log("未找到测试文件");
  process.exit(1);
}

let failedSuites = 0;
const rows = [];
for (const f of files) {
  const args = [path.join(dir, f)];
  if (appDir) args.push(appDir);
  const env = Object.assign({}, process.env);
  // jsdom（detail-type / live-* 用）只装在托管 node workspace 里，统一通过 NODE_PATH 暴露
  env.NODE_PATH = env.NODE_PATH ? `${MANAGED_MODULES}:${env.NODE_PATH}` : MANAGED_MODULES;
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: path.resolve(dir, ".."), env });
  const out = (r.stdout || "") + (r.stderr || "");
  const last = out.trim().split("\n").filter((l) => /\d+\s*\/\s*\d+|通过\s*\d+/.test(l)).pop() || "";
  const pass = r.status === 0;
  if (!pass) failedSuites++;
  rows.push({ file: f, pass, summary: last.trim() || (pass ? "OK" : "FAIL"), status: r.status });
  if (!pass) {
    console.log(`\n----- ${f} 失败输出 -----`);
    console.log(out.split("\n").filter((l) => l.startsWith("FAIL") || /Error|error:/.test(l)).slice(0, 12).join("\n"));
  }
}

console.log("\n================ 汇总 ================");
for (const r of rows) console.log(`${r.pass ? "✔" : "✘"} ${r.file.padEnd(28)} ${r.summary}`);
console.log(`\n${rows.length - failedSuites}/${rows.length} 个套件通过${withLive ? "（含真实环境）" : "（离线；真实环境请加 --live）"}`);
process.exit(failedSuites ? 1 : 0);
