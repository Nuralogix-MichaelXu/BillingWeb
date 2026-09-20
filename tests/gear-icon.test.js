#!/usr/bin/env node
/* ==========================================================================
   设置按钮图标（齿轮）结构回归测试
   背景：该图标原先用「4 个矩形齿 + 中心圆」手绘，渲染出来是一个十字加方块，
        在圆形按钮里完全不像齿轮。此测试锁住正确几何，防止再次退化。
   ==========================================================================*/
const fs = require("fs");
const path = require("path");
const APP = process.argv[2] || path.resolve(__dirname, "../app");

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} → 实际 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`); }
};
const checkFn = (name, fn) => {
  let got; try { got = fn(); } catch (e) { got = "throws:" + e.message; }
  check(name, got, true);
};

const html = fs.readFileSync(`${APP}/index.html`, "utf8");

/* ---------- 1. 取到设置按钮与其中的 SVG ---------- */
const btnStart = html.indexOf('id="settings-btn"');
checkFn("能找到设置按钮", () => btnStart > -1);

const btnOpen = html.lastIndexOf("<button", btnStart);
const btnClose = html.indexOf("</button>", btnStart);
const btn = html.slice(btnOpen, btnClose);

const svgStart = btn.indexOf("<svg");
const svgEnd = btn.indexOf("</svg>") + 6;
const svg = btn.slice(svgStart, svgEnd);
const inner = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));

checkFn("按钮内存在内联 SVG 图标", () => svg.startsWith("<svg") && svg.length > 100);

/* ---------- 2. 按钮外壳样式未被破坏 ---------- */
check("按钮 class 保持圆形图标按钮", /class="icon-btn-circle"/.test(btn), true);
check("按钮 title 为「设置」", /title="设置"/.test(btn), true);

/* ---------- 3. 齿轮几何 ---------- */
check("svg viewBox 为 24×24", /viewBox="0 0 24 24"/.test(svg), true);
check("svg 尺寸 20×20", /width="20" height="20"/.test(svg), true);
check("svg 根节点 fill=none（线性图标，非实心块）", /<svg[^>]*fill="none"/.test(svg), true);

const rects = (inner.match(/<rect/g) || []).length;
const paths = (inner.match(/<path/g) || []).length;
const circles = (inner.match(/<circle/g) || []).length;

check("不含矩形齿（旧实现的退化形态）", rects, 0);
check("含 1 条齿轮外轮廓路径", paths, 1);
check("含 1 个中心孔圆", circles, 1);

/* 齿轮外轮廓必须是「多齿 + 圆角连接」的曲线路径，而不是几段直线拼出的十字 */
checkFn("齿轮路径为闭合曲线（含贝塞尔曲线指令）", () => /d="M[\d.]+ [\d.]+[^"]*[aAcCqQ]/.test(inner));

/* ---------- 4. 颜色需继承 currentColor，才能跟随设计变量 ---------- */
const strokeAttrs = inner.match(/stroke="[^"]*"/g) || [];
check("描边均使用 currentColor", strokeAttrs.length > 0 && strokeAttrs.every((s) => s === 'stroke="currentColor"'), true);
check("图标内无硬编码色值", /#[0-9A-Fa-f]{3,8}/.test(inner), false);
checkFn("齿轮齿尖为圆角连接（避免尖刺感）", () => /stroke-linejoin="round"/.test(inner));
checkFn("线条与同导航栏其他线性图标一致（1.6px）", () => /stroke-width="1\.6"/.test(inner));

/* ---------- 5. 设置菜单结构未受影响 ---------- */
checkFn("设置菜单仍含「退出登录」", () => /id="settings-logout"[\s\S]*?退出登录/.test(html));
checkFn("菜单容器 id 保持 settings-menu", () => /id="settings-menu"/.test(html));

/* ---------- 6. 全文件不得再出现旧的退化几何 ---------- */
check("index.html 中无残留的矩形齿几何", /<rect x="10" y="1"/.test(html), false);

console.log(`\n设置按钮齿轮图标：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
