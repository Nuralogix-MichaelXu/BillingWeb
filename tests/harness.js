/* ============================================================================
 * tests/harness.js —— 三个页面逻辑的共用测试脚手架
 *
 * 为什么要有这个文件：之前每个测试脚本各自手写一套 DOM 桩，桩会随着 app.js
 * 用到的浏览器 API 变多而失配（例如后来加了 document.addEventListener），
 * 于是"测试挂了"其实是桩缺了方法，而不是逻辑坏了。统一到这里，只维护一份。
 *
 * 用法：
 *   const { createHarness } = require("./harness");
 *   const h = createHarness();              // 可选 { appDir, fetch }
 *   h.load("model.js"); h.load("api.js"); h.load("app.js");
 *   h.els["login-org"].value = "x"; h.els["login-org"].fire("input");
 *   await h.waitFor('AppState.currentPage === "list"');
 *   h.check("当前页", h.get("AppState.currentPage"), "list");
 * ==========================================================================*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DEFAULT_APP = path.resolve(__dirname, "../app");

/** 最小 DOM 元素桩（够 app.js 用） */
function makeEl(id) {
  const el = {
    id,
    style: {},
    dataset: {},
    value: "",
    title: "",
    placeholder: "",
    disabled: false,
    _text: "",
    _innerHTML: "",
    _attrs: {},
    _listeners: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const l = this._listeners[type];
      if (l) this._listeners[type] = l.filter((x) => x !== fn);
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    focus() {},
    select() {},
    closest() { return null; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; },
    fire(type, ev = {}) {
      (this._listeners[type] || []).forEach((fn) =>
        fn({ preventDefault() {}, stopPropagation() {}, target: this, ...ev })
      );
    },
  };
  return el;
}

function createHarness(options = {}) {
  const appDir = options.appDir ?? DEFAULT_APP;
  const html = fs.readFileSync(path.join(appDir, "index.html"), "utf8");
  const els = {};
  for (const m of html.matchAll(/(?:^|\s)id="([^"]+)"/g)) els[m[1]] = makeEl(m[1]);

  const tabs = [
    Object.assign(makeEl("tab-cn"), { dataset: { region: "0" } }),
    Object.assign(makeEl("tab-intl"), { dataset: { region: "1" } }),
  ];
  // 周期菜单项 / 弹窗按钮：按 innerHTML 缓存，保证应用绑定的元素与测试点击的是同一个
  const menuCache = { html: null, items: [] };
  const cycleMenuItems = () => {
    const cur = els["cycle-menu"].innerHTML;
    if (menuCache.html === cur) return menuCache.items;
    const items = [...cur.matchAll(/data-filter="([^"]+)"/g)].map((m) => {
      const el = makeEl("cycle-menu-item-" + m[1]);
      el.dataset.filter = m[1];
      const label = new RegExp(`data-filter="${m[1]}"[\\s\\S]*?<span>([^<]*)</span>`).exec(cur);
      el.textContent = label ? label[1] : m[1];
      return el;
    });
    menuCache.html = cur;
    menuCache.items = items;
    return items;
  };
  let modalBtns = [];
  const modalCache = { html: null, items: [] };
  const modalButtons = () => {
    const cur = els["modal-root"].innerHTML;
    // 必须按 innerHTML 缓存：showAlert 会把监听器绑到它取到的元素上，
    // 每次调用都新建元素的话，测试点到的是另一个实例 → 点了没反应。
    if (modalCache.html === cur) {
      modalBtns = modalCache.items;
      return modalBtns;
    }
    const items = [...cur.matchAll(/data-modal-idx="(\d+)"/g)].map((m) => {
      const el = makeEl("modal-btn-" + m[1]);
      el.dataset.modalIdx = m[1];
      const label = new RegExp(`data-modal-idx="${m[1]}"[^>]*>([^<]*)<`).exec(cur);
      el.textContent = label ? label[1] : "";
      return el;
    });
    modalCache.html = cur;
    modalCache.items = items;
    modalBtns = items;
    return modalBtns;
  };
  // 语言下拉项：按 innerHTML 缓存，保留每项自己的片段以便断言「文案在左、国旗在右」
  const langCache = { html: null, items: [] };
  const langItems = () => {
    const cur = els["lang-menu"].innerHTML;
    if (langCache.html === cur) return langCache.items;
    const items = [];
    for (const chunk of cur.split("<button").slice(1)) {
      const code = /data-lang="([^"]+)"/.exec(chunk);
      if (!code) continue;
      const el = makeEl("lang-item-" + code[1]);
      el.dataset.lang = code[1];
      el.innerHTML = chunk;
      const name = /<span>([^<]*)<\/span>/.exec(chunk);
      el.textContent = name ? name[1] : code[1];
      items.push(el);
    }
    langCache.html = cur;
    langCache.items = items;
    return items;
  };

  // AppLanguage 预置：让离线用例的语言确定（否则会跟随 navigator.language）。
  // 传 { language: null } 可跳过预置，用于验证「无持久化时按浏览器语言判定」。
  const store = options.language === null ? {} : { AppLanguage: options.language ?? "zh-Hans" };
  const ctx = {
    document: {
      activeElement: null,
      getElementById: (id) => els[id] ?? (els[id] = makeEl(id)),
      querySelectorAll: (sel) => {
        if (sel === ".page")
          return [els["page-login"], els["page-list"], els["page-detail"], els["page-statistics"], els["page-trend"]];
        if (sel === "#region-tabs .tab") return tabs;
        if (sel === "#cycle-menu .menu-item") return cycleMenuItems();
        if (sel === "#modal-root .modal-btn") return modalButtons();
        if (sel === "#lang-menu .lang-item") return langItems();
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
      createElement: (tag) => makeEl(String(tag)),
      body: makeEl("body"),
      documentElement: makeEl("documentElement"),
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    navigator: { onLine: true, language: options.browserLanguage ?? "zh-CN" },
    location: { protocol: "http:", origin: "http://127.0.0.1:4173", search: "" },
    window: { addEventListener() {}, scrollTo() {} },
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    AbortSignal,
    AbortController,
    fetch: options.fetch ?? (async () => ({ text: async () => "" })),
  };
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);

  const load = (f) => vm.runInContext(fs.readFileSync(path.join(appDir, f), "utf8"), sandbox, { filename: f });
  // const/let 不会挂到 sandbox 上，必须用表达式读取
  const get = (expr) => vm.runInContext(expr, sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(expr, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (get(expr)) return true;
      await sleep(15);
    }
    return false;
  }

  const results = [];
  const check = (label, actual, expected) => {
    const ok = String(actual) === String(expected);
    results.push(`${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : `  (期望 ${expected})`}`);
    return ok;
  };
  const report = () => {
    const failed = results.filter((x) => x.startsWith("FAIL"));
    return { total: results.length, failed: failed.length, text: `${results.length - failed.length}/${results.length}` };
  };

  /* ---------------------------------------------------------- 交互便捷方法 */
  /** 打开周期下拉并返回菜单项 */
  const openCycleMenu = () => {
    els["cycle-pill"].fire("click");
    return cycleMenuItems();
  };
  /** 点某个周期（走真实交互：先展开菜单，再点菜单项） */
  const pickFilter = (filter) => {
    const item = openCycleMenu().find((x) => x.dataset.filter === filter);
    if (!item) throw new Error(`周期菜单里没有 ${filter}`);
    item.fire("click");
    return item;
  };
  /** 按文案点弹窗按钮（按钮顺序是 [取消, 确定]，按索引点容易点错） */
  const clickModalBtn = (label) => {
    const b = modalButtons().find((x) => String(x.textContent).includes(label));
    if (!b) throw new Error(`弹窗里没有「${label}」，现有：${modalBtns.map((x) => x.textContent).join(" / ")}`);
    b.fire("click");
  };

  return {
    appDir, els, ctx, sandbox, store,
    load, get, run, sleep, waitFor, check, results, report,
    cycleMenuItems, modalButtons, langItems, openCycleMenu, pickFilter, clickModalBtn,
  };
}

module.exports = { createHarness, makeEl, DEFAULT_APP };
