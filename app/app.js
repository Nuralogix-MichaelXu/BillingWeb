/* ============================================================================
 * app.js —— 三个页面的数据展示逻辑，与 iOS 端完全一致
 *   登录：1-LoginView.swift（单账号 / 多账号、校验、并发登录、本地持久化、自动跳转）
 *   列表：2-BillingListView.swift（DateFilter 周期、requestData 请求编排、进度、退出登录）
 *   详情：3-BillingDetailView.swift（字段展示、编辑充值/单价/账单日期、研究表与合计行）
 * ==========================================================================*/

/* ------------------------------------------------------------- DOM 小工具 */
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let _toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* --------------------------------------------------------------- 弹窗组件 */
/** 「登录已过期」弹框是否正在显示：显示期间其它提示不得覆盖它（见 showAlert） */
let _sessionExpiredAlertVisible = false;

function closeModal() {
  $("modal-root").innerHTML = "";
  $("modal-root").classList.remove("show");
  _sessionExpiredAlertVisible = false;
}
function openModal(html) {
  $("modal-root").innerHTML = html;
  $("modal-root").classList.add("show");
}
/**
 * 对应 iOS 的 Alert（title + message + 按钮）
 */
function showAlert(title, message, buttons) {
  // 「登录已过期」已经上屏时，其它提示（多为并发失败里的普通错误）一律不再覆盖：
  // 一旦覆盖，用户正要点的那颗「确定」会连同按钮一起被换掉 —— 表现为
  // 「点了确定却停在原页」，而真正的回登录页按钮其实已经不存在了。
  if (_sessionExpiredAlertVisible) return;
  const btns = buttons ?? [{ text: Localized("confirm"), primary: true }];
  openModal(`
    <div class="modal-card">
      <div class="modal-title">${escapeHTML(title)}</div>
      <div class="modal-message">${escapeHTML(message)}</div>
      <div class="modal-actions">
        ${btns
          .map(
            (b, i) =>
              `<button class="modal-btn ${b.primary ? "primary" : ""}" data-modal-idx="${i}">${escapeHTML(b.text)}</button>`
          )
          .join("")}
      </div>
    </div>`);
  $$("#modal-root .modal-btn").forEach((el) => {
    el.addEventListener("click", () => {
      const btn = btns[Number(el.dataset.modalIdx)];
      closeModal();
      btn?.onClick?.();
    });
  });
}
/** 对应 iOS 的输入弹窗（编辑充值金额 / 编辑单价） */
function showInput(title, placeholder, defaultValue, buttons) {
  openModal(`
    <div class="modal-card">
      <div class="modal-title">${escapeHTML(title)}</div>
      <input class="text-input modal-input" id="modal-input" placeholder="${escapeHTML(placeholder)}" value="${escapeHTML(
    defaultValue ?? ""
  )}" inputmode="decimal">
      <div class="modal-actions">
        ${buttons
          .map(
            (b, i) =>
              `<button class="modal-btn ${b.primary ? "primary" : ""}" data-modal-idx="${i}">${escapeHTML(b.text)}</button>`
          )
          .join("")}
      </div>
    </div>`);
  const input = $("modal-input");
  input.focus();
  input.select();
  $$("#modal-root .modal-btn").forEach((el) => {
    el.addEventListener("click", () => {
      const btn = buttons[Number(el.dataset.modalIdx)];
      const value = input.value;
      closeModal();
      btn?.onClick?.(value);
    });
  });
}
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------- 会话失效（token 过期 / 退出登录）
 * 需求：任何页面弹出「登录已过期」提示后，点「确定」即回登录页，
 *       且后续收尾与「退出登录」完全一致（同一套 endSession()）。
 *
 * 什么时候算过期（分类在 API 层完成，见 model.js isSessionExpiredError）：
 *   · 接口返回 Code INVALID_TOKEN / UNAUTHORIZED / TOKEN_EXPIRED（401）
 *   · HTTP 401 但响应体不是标准 {Code,Message}（网关 HTML、字段缺失等）
 *   · authHeader 找不到该组织的授权 Token（code -4）
 * 会话失效后**不做自动续期**（见 api.js sendRequestWithTokenRefresh）：
 * token 一过期就直接提示并回登录页。
 * 连续并发失败（如趋势页多个请求同时过期）只会弹一次、只回一次登录页。
 *
 * 参考 iOS AlertManager.showAlert(..., onDismiss:) + dismiss()：
 * 差别是 iOS 只在列表页给了「退出登录」入口，token 过期没有对应处理，
 * 这里按 Web 需求补齐；其余 iOS 对齐逻辑不受影响。
 */
let _isSessionExpiredAlert = false;

/**
 * 结束当前会话并回到登录页。退出登录与 token 过期点确定都走这里，
 * 保证两条路径行为逐字一致
 * （iOS：currentTask?.cancel() → SharedUsers.removeAll() → UserStorage.clear() → dismiss()）。
 *
 * 每一步单独兜底：任何一步抛异常都不能挡住最后的跳转 ——
 * 否则用户只会看到弹框关掉、页面毫无反应。
 */
function endSession(options = {}) {
  const preserveIdentity = options.preserveIdentity === true;
  const rememberedOrg = preserveIdentity ? SharedUsers[0]?.orgName ?? AppState.login.orgName ?? "" : "";
  const rememberedEmail = preserveIdentity ? SharedUsers[0]?.email ?? AppState.login.email ?? "" : "";
  const step = (label, fn) => {
    try {
      fn();
    } catch (e) {
      console.error(`[endSession] ${label}`, e);
    }
  };
  _isSessionExpiredAlert = false; // 复位：重新登录后若再次过期仍能提示
  step("作废列表页在途请求", () => ListPage.resetState()); // currentTask?.cancel()
  step("作废趋势页在途请求", () => TrendPage.resetState()); // _seq 守卫
  step("清空内存会话", () => {
    SharedUsers = []; // SharedUsers.removeAll()
  });
  step("清空本地会话", () => UserStorage.clear()); // UserStorage.clear()
  step("复位登录表单", () =>
    LoginPage.resetState(
      preserveIdentity
        ? {
            preserveIdentity: true,
            orgName: rememberedOrg,
            email: rememberedEmail,
          }
        : undefined
    )); // dismiss() 后视图重建
  step("关闭弹窗", () => closeModal());
  step("回到登录页", () => Router.go("login")); // dismiss()：上面任何一步失败，都必须回到登录页
  if (AppState.currentPage !== "login") {
    // 最终兜底：即使 Router.go 在渲染期抛错，也强制把登录页切到前台。
    AppState.currentPage = "login";
    $$(".page").forEach((p) => p.classList.remove("active"));
    $("page-login")?.classList.add("active");
    step("登录页渲染兜底", () => LoginPage.render());
  }
}

/** 弹「登录已过期」→ 点确定回登录页（并发失败只弹一次） */
function showSessionExpiredAlert() {
  // 已经在登录页，或已经弹过（并发请求同时失败）→ 不重复弹
  if (_isSessionExpiredAlert || AppState.currentPage === "login") return;
  _isSessionExpiredAlert = true;
  showAlert(Localized("alert_token_expired"), Localized("alert_token_expired_message"), [
    {
      text: Localized("confirm"),
      primary: true,
      // 与「退出登录」确定按钮同一套收尾
      onClick: () => endSession({ preserveIdentity: true }),
    },
  ]);
  // 弹框上屏后再打标（closeModal 会清掉）：期间任何提示都不得覆盖它
  _sessionExpiredAlertVisible = true;
}

/**
 * 页面级错误统一出口。
 * 会话失效 → 「登录已过期」并回登录页；其余错误 → 常规提示。
 * @param {Error} error
 * @param {boolean} withPrefix 是否加「错误：」前缀（趋势页历史文案不带前缀）
 */
function showPageError(error, withPrefix = true) {
  if (isSessionExpiredError(error)) {
    showSessionExpiredAlert();
    return;
  }
  const message = error?.message ?? String(error);
  showAlert(Localized("alert_title"), `${withPrefix ? Localized("error_prefix") : ""}${message}`);
}

/* ------------------------------------------------- 周期筛选项（DateFilter） */
const DateFilter = {
  none: "none",
  all: "all",
  today: "today",
  yesterday: "yesterday",
  beforeYesterday: "beforeYesterday",
  thisWeek: "thisWeek",
  lastWeek: "lastWeek",
  thisMonth: "thisMonth",
  lastMonth: "lastMonth",
  halfYear: "halfYear",
  oneYear: "oneYear",
  custom: "custom",
};
const DateFilterAllCases = [
  DateFilter.none,
  DateFilter.custom,
  DateFilter.all,
  DateFilter.today,
  DateFilter.yesterday,
  DateFilter.beforeYesterday,
  DateFilter.thisWeek,
  DateFilter.lastWeek,
  DateFilter.thisMonth,
  DateFilter.lastMonth,
  DateFilter.halfYear,
  DateFilter.oneYear,
];
function dateFilterLocalized(filter) {
  return Localized(`datefilter_${filter}`);
}
function dateFilterShortString(filter) {
  if (LanguageManager.isCNLanguage()) return dateFilterLocalized(filter);
  if (filter === DateFilter.beforeYesterday) return "DBY";
  if (filter === DateFilter.halfYear) return "LHY";
  return dateFilterLocalized(filter);
}
function dateFilterEndDateIsNow(filter) {
  return (
    filter === DateFilter.all ||
    filter === DateFilter.today ||
    filter === DateFilter.thisWeek ||
    filter === DateFilter.thisMonth ||
    filter === DateFilter.halfYear ||
    filter === DateFilter.oneYear
  );
}

/* ---------------------------------------------- 登录页默认填充（首次打开） */
/**
 * 登录页首次打开时表单为空：不预填任何账号（原先预填的测试账号已移除）。
 * 对应 iOS：@State 全部以空值初始化，用户手动输入。
 */
const kDefaultLogin = {
  orgName: "",
  email: "",
  password: "",
};

/**
 * 登录页的初始状态。
 * 对应 iOS：dismiss() 销毁视图后重新进入登录页会得到一份全新的 @State；
 * 这里在此基础上额外预填默认账号（多账号文本框也预填等价的一行）。
 */
function makeInitialLoginState() {
  return {
    isMultiAccountMode: localStorage.getItem("isMultiAccountMode") === "true",
    region: Region.china,
    isLoading: false,
    orgName: kDefaultLogin.orgName,
    email: kDefaultLogin.email,
    password: kDefaultLogin.password,
    /**
     * 多账号模式初始为空 —— 对齐 iOS（@State multiAccountText = ""）：
     * 空框时展示与 iOS Localized("login_multi_example") 同文的占位示例。
     */
    multiAccountText: "",
  };
}

/* ------------------------------------------------------------ 全局状态 */
/**
 * OrgListModel + BillingListView 的初始状态。
 * 对应 iOS：dismiss() 销毁 BillingListView 后，再次登录会创建一个全新的视图，
 * 其 @StateObject(OrgListModel) 与所有 @State 都重新初始化。
 */
function makeInitialListState() {
  return {
    orgs: [],
    billingPeriod: "",
    billingName: "",
    updateTime: new Date(),
    isUpdateFail: false,
    isPeriodNone: true,
    isRefreshing: false,
    refreshCompleted: false,
    totalRequests: 0,
    completedRequests: 0,
    startDate: new Date(),
    endDate: new Date(),
    savedStartDate: null,
    savedEndDate: null,
    startDateString: yyyyMMddDateString(kInitialStartDate),
    endDateString: Localized("until_now"),
    selectedFilter: DateFilter.none,
    lastSelectedFilter: DateFilter.none,
    isCustomDatePickerPresented: false,
    isMenuOpen: false,
    isSettingsMenuOpen: false,
    savedUpdateTime: new Date(),
    currentTaskId: 0, // 用于取消上一次 requestData（对应 currentTask?.cancel()）
    selectedOrgIndex: 0,
  };
}

const AppState = {
  currentPage: "login",
  isNetworkAvailable: typeof navigator !== "undefined" ? navigator.onLine : true,

  /* 1-LoginView */
  login: makeInitialLoginState(),

  /* 2-BillingListView / OrgListModel */
  list: makeInitialListState(),
};

/* ============================================================================
 * 全局 UI 设施
 * ==========================================================================*/
/**
 * 静态文案本地化：给 index.html 里带 data-i18n / data-i18n-placeholder /
 * data-i18n-title 的节点回填当前语言文案。
 * 由 JS 渲染的节点（列表表头、统计/趋势标题等）不走这里，它们在各自的 render()
 * 里已经用 Localized() 取值。
 */
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = Localized(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = Localized(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = Localized(el.dataset.i18nTitle);
  });
}

/**
 * 国旗图标（内联 SVG）。
 * ⚠️ 不用 emoji 旗帜：Windows 版 Chrome 不支持区域指示符合成，会退化成 "CN" / "US" 两个字母。
 */
function flagStar(cx, cy, R) {
  const inner = R * 0.382;
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = ((-90 + i * 36) * Math.PI) / 180;
    const rad = i % 2 === 0 ? R : inner;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}
/** 美国国旗：13 道条纹 + 蓝色星区（星区用 3×5 简化星点，18×12 下已是纹理级细节） */
function usFlagSVG() {
  const stripeH = 12 / 13;
  let stripes = "";
  for (let i = 0; i < 7; i++) {
    stripes += `<rect y="${(i * stripeH * 2).toFixed(2)}" width="18" height="${stripeH.toFixed(2)}"/>`;
  }
  let stars = "";
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 5; col++) {
      const cx = 0.9 + col * 1.35 + (row % 2 ? 0.6 : 0);
      const cy = 0.95 + row * 2.1;
      if (cx < 6.9) stars += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="0.34"/>`;
    }
  }
  return (
    `<svg class="flag" data-flag="us" width="18" height="12" viewBox="0 0 18 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<rect width="18" height="12" rx="1" fill="#FFFFFF"/>` +
    `<g fill="#B22234">${stripes}</g>` +
    `<rect width="7.2" height="6.46" rx="0.6" fill="#3C3B6E"/>` +
    `<g fill="#FFFFFF">${stars}</g></svg>`
  );
}
const FLAG_SVG = {
  /* 中国：红底 + 一星 + 四小星（弧列） */
  cn:
    `<svg class="flag" data-flag="cn" width="18" height="12" viewBox="0 0 18 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<rect width="18" height="12" rx="1" fill="#DE2910"/>` +
    `<g fill="#FFDE00">` +
    `<polygon points="${flagStar(3.4, 4, 2.1)}"/>` +
    `<polygon points="${flagStar(6.4, 1.5, 0.75)}"/>` +
    `<polygon points="${flagStar(7.5, 3.1, 0.75)}"/>` +
    `<polygon points="${flagStar(7.5, 5, 0.75)}"/>` +
    `<polygon points="${flagStar(6.4, 6.5, 0.75)}"/>` +
    `</g></svg>`,
  us: usFlagSVG(),
};

/**
 * 语言切换（1-LoginView.swift:517 LanguageSwitchButton）。
 * iOS 用 sheet 列出语言、点选后 setLanguage + 关闭；Web 这一层是导航栏右上角的下拉菜单。
 * 语言项内「语言名在左、国旗在右」。
 */
const LanguageSwitcher = {
  isOpen: false,

  current() {
    return (
      AppLanguages.find((l) => l.code === LanguageManager.currentLanguage) ?? AppLanguages[0]
    );
  },

  render() {
    const cur = LanguageSwitcher.current();
    const btn = $("lang-btn");
    btn.innerHTML = `<span>${escapeHTML(cur.name)}</span>${FLAG_SVG[cur.flag] ?? ""}`;
    btn.setAttribute("aria-expanded", LanguageSwitcher.isOpen ? "true" : "false");

    const menu = $("lang-menu");
    menu.classList.toggle("open", LanguageSwitcher.isOpen);
    menu.innerHTML = AppLanguages.map((l) => {
      const active = l.code === LanguageManager.currentLanguage;
      return (
        `<button type="button" class="lang-item${active ? " active" : ""}" data-lang="${l.code}" ` +
        `role="option" aria-selected="${active}">` +
        `<span>${escapeHTML(l.name)}</span>${FLAG_SVG[l.flag] ?? ""}</button>`
      );
    }).join("");
    $$("#lang-menu .lang-item").forEach((el) => {
      el.addEventListener("click", () => LanguageSwitcher.select(el.dataset.lang));
    });
  },

  /** 1-LoginView.swift:530：langManager.setLanguage(key) + showSheet = false */
  select(code) {
    LanguageManager.setLanguage(code);
    LanguageSwitcher.isOpen = false;
    applyI18n();
    // iOS 用 .id(langManager.currentLanguage) 重建整个视图 → Web 重新渲染当前页
    Router.go(AppState.currentPage);
    LanguageSwitcher.render();
  },

  bind() {
    $("lang-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      LanguageSwitcher.isOpen = !LanguageSwitcher.isOpen;
      LanguageSwitcher.render();
    });
    // 点击空白处收起（iOS 是 sheet，点外部即 dismiss）
    document.addEventListener("click", () => {
      if (!LanguageSwitcher.isOpen) return;
      LanguageSwitcher.isOpen = false;
      LanguageSwitcher.render();
    });
  },
};

/* ============================================================================
 * 页面一：登录（1-LoginView.swift）
 * ==========================================================================*/
/**
 * Swift `Double(_ text: String) ?? fallback` 的等价实现。
 *
 * ⚠️ 不能写成 `Number(x) || fallback`：`0` 是 falsy，会把用户明确填的
 * 「已充值金额 = 0」「单价 = 0」悄悄改成 1.0，与 iOS 不一致。
 * 这里按 Swift 的严格解析语义：只接受十进制数字串，其余（含空串、字母、
 * 十六进制、带下划线等）一律回落 fallback。
 */
function swiftDouble(str, fallback) {
  const s = String(str ?? "");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

const LoginPage = {
  render() {
    const s = AppState.login;
    $("login-org").value = s.orgName;
    $("login-email").value = s.email;
    $("login-pwd").value = s.password;
    $("multi-text").value = s.multiAccountText;
    $("multi-text").placeholder = Localized("login_multi_example");
    $("multi-area").style.display = s.isMultiAccountMode ? "flex" : "none";
    $("single-area").style.display = s.isMultiAccountMode ? "none" : "flex";
    $("mode-toggle").textContent = s.isMultiAccountMode
      ? Localized("login_mode_normal")
      : Localized("login_mode_multi");
    $("login-btn-text").textContent = s.isLoading ? Localized("login_loading") : Localized("login_button");
    $("login-btn").disabled = s.isLoading;
    $("login-spinner").style.display = s.isLoading ? "block" : "none";
    $$("#region-tabs .tab").forEach((t) => t.classList.toggle("active", Number(t.dataset.region) === s.region));
    $("login-note").textContent = Localized("login_note");
  },

  bind() {
    $("login-org").addEventListener("input", (e) => (AppState.login.orgName = e.target.value.trim()));
    $("login-email").addEventListener("input", (e) => (AppState.login.email = e.target.value.trim()));
    $("login-pwd").addEventListener("input", (e) => (AppState.login.password = e.target.value));
    $("multi-text").addEventListener("input", (e) => (AppState.login.multiAccountText = e.target.value));
    $("toggle-pwd").addEventListener("click", () => {
      const pwd = $("login-pwd");
      pwd.type = pwd.type === "password" ? "text" : "password";
    });
    $$("#region-tabs .tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        AppState.login.region = Number(tab.dataset.region);
        LoginPage.render();
      });
    });
    // 普通登录 / 多账号登录 切换（iOS：isMultiAccountMode.toggle() + UserDefaults 持久化）
    $("mode-toggle").addEventListener("click", () => {
      AppState.login.isMultiAccountMode = !AppState.login.isMultiAccountMode;
      localStorage.setItem("isMultiAccountMode", String(AppState.login.isMultiAccountMode));
      LoginPage.render();
    });
    $("login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      LoginPage.onLoginPressed();
    });
  },

  /**
   * 回到登录页时把表单复位成初始状态（含默认账号）。
   * 对应 iOS：dismiss() 后重新创建视图，@State 全部重新初始化。
   * 与 ListPage.resetState() 同理，这里用 Object.assign 原地改，
   * 保证 bind() 里已经绑定的处理器操作的仍是同一个状态对象。
   */
  resetState(options = {}) {
    const next = makeInitialLoginState();
    if (options.preserveIdentity) {
      next.orgName = options.orgName ?? next.orgName;
      next.email = options.email ?? next.email;
      next.password = "";
      next.isMultiAccountMode = false;
      next.multiAccountText = "";
    }
    Object.assign(AppState.login, next);
  },

  onLoginPressed() {
    const s = AppState.login;
    // iOS：先判断网络可用性
    if (!AppState.isNetworkAvailable) {
      showAlert(Localized("alert_title"), Localized("network_unavailable"));
      return;
    }
    s.isLoading = true;
    LoginPage.render();
    LoginPage.login();
  },

  /** 1-LoginView.swift: login() */
  async login() {
    const s = AppState.login;
    // 校验
    if (
      (s.isMultiAccountMode && s.multiAccountText.length === 0) ||
      (!s.isMultiAccountMode && (s.orgName.length === 0 || s.email.length === 0 || s.password.length === 0))
    ) {
      showAlert(Localized("alert_title"), Localized("alert_fill_all"));
      s.isLoading = false;
      LoginPage.render();
      return;
    }

    let users = [];
    if (!s.isMultiAccountMode) {
      users.push(
        makeUser({
          key: s.orgName + Region.tag(s.region),
          orgName: s.orgName,
          email: s.email,
          password: s.password,
          region: s.region,
          deposits: 0,
          unitPrice: 1.0,
          billingDate: kInitialStartDate,
        })
      );
    } else {
      const lines = s.multiAccountText.split(/\r?\n/);
      for (const line of lines) {
        if (line.length === 0) continue;
        const components = line.split(" ").filter((c) => c.length > 0);
        if (components.length >= 7) {
          const org = components[0];
          const email = components[1];
          const password = components[2];
          // iOS：Double(components[n]) ?? 1.0 —— 解析失败才回落 1.0，显式填 0 必须保留
          const deposits = swiftDouble(components[3], 1.0);
          const unitPrice = swiftDouble(components[4], 1.0);
          const billingDate = dateFromYyyyMMddString(components[5]) ?? kInitialStartDate;
          const region = Region[Number(components[6]) === 1 ? "international" : "china"];
          users.push(
            makeUser({
              key: org + Region.tag(region),
              orgName: org,
              email,
              password,
              region,
              deposits,
              unitPrice,
              billingDate,
            })
          );
        } else {
          showAlert(Localized("alert_title"), Localized("alert_fill_format"));
          s.isLoading = false;
          LoginPage.render();
          return;
        }
      }
    }

    // 并发登录（iOS：withTaskGroup）
    const updatedUsers = [];
    const failures = [];
    await Promise.all(
      users.map(async (user) => {
        try {
          const response = await APIClient.login(user.email, user.password, user.orgName, user.region);
          updatedUsers.push(
            makeUser({
              key: user.orgName + Region.tag(user.region),
              orgName: user.orgName,
              email: user.email,
              password: user.password,
              region: user.region,
              deposits: user.deposits,
              unitPrice: user.unitPrice,
              billingDate: user.billingDate,
              token: response.Token,
            })
          );
        } catch (error) {
          failures.push(error);
        }
      })
    );

    if (failures.length) {
      showAlert(Localized("login_failed"), failures[0].message);
      s.isLoading = false;
      LoginPage.render();
      return;
    }

    // 全部成功
    for (const user of users) {
      const updated = updatedUsers.find((u) => u.key === user.key);
      if (updated) SharedUsers.push(updated);
    }
    UserStorage.save(updatedUsers);
    s.isLoading = false;
    LoginPage.render();
    // iOS：登录成功后 navigationDestination 重新创建 BillingListView → OrgListModel 全新
    ListPage.resetState();
    Router.go("list");
    ListPage.onAppear();
  },
};

/* ============================================================================
 * 页面二：组织账单列表（2-BillingListView.swift）
 * ==========================================================================*/
/** 2-BillingListView.swift: DateFilter 的本地化与语义（定义见文件上方） */

const ListPage = {
  _progressTimer: null,

  /**
   * 等价 iOS dismiss()：销毁 BillingListView 及其 @StateObject(OrgListModel)。
   * 使 orgs / selectedFilter / 周期区间 / 更新时间等全部回到初始值，
   * 从而保证换账号后进入列表页必定走 onAppear 的空态分支 → performFilter → requestData。
   */
  resetState() {
    const L = AppState.list;
    L.currentTaskId++; // currentTask?.cancel()：让在途请求在 taskId 守卫处提前返回
    ListPage.stopProgressTimer();
    DetailPage._isRefreshing = false;
    // 原地重置（不替换对象引用），保证 bind() 中已捕获的各事件处理器仍然指向有效状态
    Object.assign(L, makeInitialListState());
  },

  /* ---------------------------------------------------- 2-BillingListView: onAppear */
  onAppear() {
    const L = AppState.list;
    if (L.orgs.length === 0 && !L.isRefreshing) {
      const period = SharedUsers[0]?.period ?? null;
      if (period) {
        L.selectedFilter = period;
        if (period === DateFilter.custom) {
          L.isCustomDatePickerPresented = true;
          const start = SharedUsers[0]?.customPeriodStartDate;
          if (start) {
            ListPage.setStartDate(start);
          } else {
            ListPage.setStartDate(kInitialStartDate);
          }
          const end = SharedUsers[0]?.customPeriodEndDate;
          if (end) {
            ListPage.setEndDate(end);
          } else {
            L.endDate = new Date();
            ListPage.setSavedEndDate(null);
          }
        }
      } else {
        L.selectedFilter = DateFilter.none;
      }
      ListPage.performFilter(L.selectedFilter);
    } else {
      ListPage.render();
    }
  },

  /** savedStartDate / savedEndDate 的 didSet 行为 */
  setSavedStartDate(date) {
    const L = AppState.list;
    L.savedStartDate = date;
    L.startDateString = date ? yyyyMMddDateString(date) : yyyyMMddDateString(kInitialStartDate);
    for (const u of SharedUsers) u.customPeriodStartDate = date;
    UserStorage.save(SharedUsers);
  },
  setSavedEndDate(date) {
    const L = AppState.list;
    L.savedEndDate = date;
    L.endDateString = date ? yyyyMMddDateString(date) : Localized("until_now");
    let shouldSavedEndDate = date;
    if (shouldSavedEndDate && _isSameDay(shouldSavedEndDate, new Date())) shouldSavedEndDate = null;
    for (const u of SharedUsers) u.customPeriodEndDate = shouldSavedEndDate;
    UserStorage.save(SharedUsers);
  },

  /**
   * 对应 iOS 的 startDate / endDate 的 didSet：
   * 赋值即同步 savedStartDate / savedEndDate（进而刷新 xxxDateString、写回 SharedUsers 并持久化）。
   * performFilter 里每一处区间赋值都必须走这里，否则自定义周期显示串会停留在旧值。
   */
  setStartDate(d) {
    AppState.list.startDate = d;
    ListPage.setSavedStartDate(d);
  },
  setEndDate(d) {
    AppState.list.endDate = d;
    ListPage.setSavedEndDate(d);
  },

  /* -------------------------------------------------- 2-BillingListView: performFilter */
  performFilter(filter, needRequest = true) {
    const L = AppState.list;
    const now = new Date();
    const cal = {
      startOfDay: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()),
      addDays: (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds()),
      addMonths: (d, n) => new Date(d.getFullYear(), d.getMonth() + n, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()),
      addYears: (d, n) => new Date(d.getFullYear() + n, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()),
      endOfDay: (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59),
      // weekStart 以周一为一周开始（iOS: calendar.firstWeekday = 2）
      weekStart: (d) => {
        const day = d.getDay(); // 0=周日
        const diff = day === 0 ? -6 : 1 - day;
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
        return monday;
      },
      // iOS: calendar.date(from: dateComponents([.year, .month], from: d))
      // → 该月 1 日 00:00:00（**不能**带当前时刻，否则会漏掉 1 日 0 点到当前时刻的测量）
      monthStart: (d) => new Date(d.getFullYear(), d.getMonth(), 1),
      lastDayOfMonth: (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(),
    };

    if (filter === DateFilter.custom) {
      if (dateFilterEndDateIsNow(L.lastSelectedFilter)) ListPage.setSavedEndDate(null);
      L.isCustomDatePickerPresented = true;
    } else {
      switch (filter) {
        case DateFilter.none:
          ListPage.setStartDate(now);
          ListPage.setEndDate(now);
          break;
        case DateFilter.all:
          ListPage.setStartDate(kInitialStartDate);
          ListPage.setEndDate(now);
          break;
        case DateFilter.today:
          ListPage.setStartDate(cal.startOfDay(now));
          ListPage.setEndDate(now);
          break;
        case DateFilter.yesterday: {
          const y = cal.addDays(now, -1);
          ListPage.setStartDate(cal.startOfDay(y));
          ListPage.setEndDate(cal.endOfDay(y));
          break;
        }
        case DateFilter.beforeYesterday: {
          const b = cal.addDays(now, -2);
          ListPage.setStartDate(cal.startOfDay(b));
          ListPage.setEndDate(cal.endOfDay(b));
          break;
        }
        case DateFilter.thisWeek:
          ListPage.setStartDate(cal.weekStart(now));
          ListPage.setEndDate(now);
          break;
        case DateFilter.lastWeek: {
          const weekStart = cal.weekStart(now);
          ListPage.setStartDate(cal.addDays(weekStart, -7));
          ListPage.setEndDate(cal.endOfDay(cal.addDays(weekStart, -1)));
          break;
        }
        case DateFilter.thisMonth:
          ListPage.setStartDate(cal.monthStart(now));
          ListPage.setEndDate(now);
          break;
        case DateFilter.lastMonth: {
          const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          ListPage.setStartDate(cal.monthStart(lastMonth));
          ListPage.setEndDate(cal.endOfDay(new Date(lastMonth.getFullYear(), lastMonth.getMonth(), cal.lastDayOfMonth(lastMonth))));
          break;
        }
        case DateFilter.halfYear:
          ListPage.setStartDate(cal.addMonths(now, -6));
          ListPage.setEndDate(now);
          break;
        case DateFilter.oneYear:
          ListPage.setStartDate(cal.addYears(now, -1));
          ListPage.setEndDate(now);
          break;
        default:
          break;
      }
    }
    if (needRequest) {
      L.lastSelectedFilter = filter;
      ListPage.requestData();
    } else {
      // iOS 里 @State 一变 SwiftUI 会自动重绘，JS 需要显式 render()
      // （自定义周期要立刻切到区间视图，否则界面停在旧状态）
      ListPage.render();
    }
  },

  /* --------------------------------------------------- 2-BillingListView: requestData */
  async requestData() {
    const L = AppState.list;
    const taskId = ++L.currentTaskId; // 取消上一次任务
    L.isRefreshing = true;
    L.refreshCompleted = false;
    L.totalRequests = 0;
    L.completedRequests = 0;
    ListPage.render();

    try {
      const userCount = SharedUsers.length;
      let studies = {};

      if (L.orgs.length > 0) {
        // 已有数据：复用研究清单、不重新拉 /studies（与 iOS 一致）；
        // 但 Swift 里 org.studies 赋给 studies 是值拷贝，这里必须 clone()，
        // 否则下面的 reset() 会把当前表格正在显示的同一批对象清零，
        // 且请求失败时旧数据也一起被冲掉。
        for (const org of L.orgs) studies[org.key] = (org.studies ?? []).map((s) => s.clone());
      } else {
        L.totalRequests = userCount; // getLicences + getStudies
        ListPage.startProgressTimer();
        studies = await APIClient.getAllStudies();
        ListPage.stopProgressTimer();
      }
      if (taskId !== L.currentTaskId) return;

      // 为每个 study 赋单价（用户级 studyUnitPrices 优先）
      for (const key of Object.keys(studies)) {
        const orgStudies = studies[key] ?? [];
        const user = SharedUsers.find((u) => u.key === key);
        if (user) {
          for (const study of orgStudies) {
            const customPrice = user.studyUnitPrices?.[study.ID];
            study.unitPrice = customPrice != null ? customPrice : user.unitPrice;
          }
        }
        studies[key] = orgStudies;
      }

      const studyCount = Object.values(studies).reduce((n, arr) => n + arr.length, 0);
      const progress = L.totalRequests === 0 ? 0 : L.completedRequests / L.totalRequests;
      L.totalRequests += studyCount * (L.selectedFilter === DateFilter.none ? 0 : 2);

      const studiesCopy3 = {};
      const billingDateDic = {};
      for (const key of Object.keys(studies)) {
        const orgStudies = studies[key] ?? [];
        const user = SharedUsers.find((u) => u.key === key);
        if (!user) continue;
        // Swift：此处是独立值拷贝（先拷贝、后 reset），② 的结果只落在拷贝里
        studiesCopy3[key] = orgStudies.map((s) => s.clone());
        billingDateDic[key] = user.billingDate;
      }
      if (Object.keys(studiesCopy3).length > 0) {
        L.totalRequests +=
          Object.values(studiesCopy3).reduce((n, arr) => n + arr.length, 0) * 2;
      }

      const studiesCopy4 = {};
      for (const key of Object.keys(studies)) {
        let orgStudies = studies[key] ?? [];
        const user = SharedUsers.find((u) => u.key === key);
        if (!user) continue;
        // reset()：清空派生值
        for (const study of orgStudies) study.reset();

        if (user.billingDate > L.startDate && user.billingDate < L.endDate) {
          if (dateFilterEndDateIsNow(L.lastSelectedFilter)) {
            for (const study of orgStudies) study.isPerioContainBilling = true;
            studies[key] = orgStudies;
          } else {
            // Swift：独立值拷贝（reset 之后才拷贝），③ 的结果只落在拷贝里
            studiesCopy4[key] = orgStudies.map((s) => s.clone());
          }
        } else {
          for (const study of orgStudies) {
            study.periodBillingSuccessMeasurements = user.billingDate > L.endDate ? 0 : null;
          }
          studies[key] = orgStudies;
        }
      }

      if (Object.keys(studiesCopy4).length > 0) {
        L.totalRequests +=
          Object.values(studiesCopy4).reduce((n, arr) => n + arr.length, 0) * 2;
      }

      L.completedRequests = progress * L.totalRequests;
      let factor = 1 - progress;
      if (L.orgs.length === 0) {
        factor *= (L.totalRequests / (L.totalRequests - userCount)) * 1.02;
      }

      // 真进度阶段开始：totalRequests 已全部算好，之后每次 updateStudies 回调都是真进度。
      // 必须让假进度定时器**保持停止**（与 iOS 对齐：2-BillingListView.swift:710-711
      // 在 getStudies() 返回后 invalidate 掉 Timer，之后全程不再新建）。
      // 若在这里再 startProgressTimer()：假进度会与真进度并行累加，比真实请求先顶到
      // 0.9 天花板 → 定时器自杀 → 进度条冻在 90%，等真进度追上才跳到 100%，观感就是
      // 「卡在 90% 很久然后猛跳」。
      // completedRequests = progress * totalRequests（上面一行）已经把等待期间的假进度
      // 按比例继承过来（totalRequests 只增，所以百分比不跳变、不回退），接力是无缝的。
      ListPage.renderProgress();

      // Swift：var studiesCopy = studies 是整份值拷贝，① 的回写不影响 studies 本体
      const studiesCopy = {};
      for (const [key, arr] of Object.entries(studies)) {
        studiesCopy[key] = (arr ?? []).map((s) => s.clone());
      }

      // ① 周期内测量（Date = startDate, EndDate = endDate）
      if (L.selectedFilter !== DateFilter.none) {
        // iOS 里 completedRequests 是 @State，改了会自动重绘；Web 要显式重绘进度条
        await APIClient.updateStudies(studiesCopy, null, L.startDate, L.endDate, () => {
          L.completedRequests += 1 * factor;
          ListPage.renderProgress();
        });
        if (taskId !== L.currentTaskId) return;
      }
      for (const [key, list] of Object.entries(studiesCopy)) {
        const studies1 = studiesCopy[key] ?? [];
        for (const s2 of list) {
          const idx = studies1.findIndex((s) => s.ID === s2.ID);
          if (idx >= 0) studies1[idx].periodSuccessMeasurements = s2.totalSuccessMeasurements;
        }
        studiesCopy[key] = studies1;
      }

      // ② 账单内测量（Date = billingDate）
      if (Object.keys(studiesCopy3).length > 0) {
        await APIClient.updateStudies(studiesCopy3, billingDateDic, null, null, () => {
          L.completedRequests += 1 * factor;
          ListPage.renderProgress();
        });
        if (taskId !== L.currentTaskId) return;
        for (const [key, list] of Object.entries(studiesCopy3)) {
          const studies1 = studiesCopy[key] ?? [];
          for (const s3 of list) {
            const idx = studies1.findIndex((s) => s.ID === s3.ID);
            if (idx >= 0) studies1[idx].billingSuccessMeasurements = s3.totalSuccessMeasurements;
          }
          studiesCopy[key] = studies1;
        }
      }

      // ③ 周期内账单测量（Date = billingDate, EndDate = endDate）
      if (Object.keys(studiesCopy4).length > 0) {
        await APIClient.updateStudies(studiesCopy4, billingDateDic, null, L.endDate, () => {
          L.completedRequests += 1 * factor;
          ListPage.renderProgress();
        });
        if (taskId !== L.currentTaskId) return;
        for (const [key, list] of Object.entries(studiesCopy4)) {
          const studies1 = studiesCopy[key] ?? [];
          for (const s4 of list) {
            const idx = studies1.findIndex((s) => s.ID === s4.ID);
            if (idx >= 0) studies1[idx].periodBillingSuccessMeasurements = s4.totalSuccessMeasurements;
          }
          studiesCopy[key] = studies1;
        }
      }

      // 汇总为 OrgInfo
      const orgs = [];
      for (const user of SharedUsers) {
        const totalSuccessCount = ListPage.totalSuccessMeasurements(user, studiesCopy);
        const periodSuccessCount = ListPage.periodSuccessMeasurements(user, studiesCopy);
        orgs.push(
          new OrgInfo({
            key: user.orgName + Region.tag(user.region),
            region: user.region,
            name: user.orgName,
            successCount: totalSuccessCount,
            totalDeposits: user.deposits,
            unitPrice: user.unitPrice,
            periodSuccess: periodSuccessCount,
            billingDate: user.billingDate,
            startDate: L.startDate,
            endDate: L.endDate,
            studies: studiesCopy[user.key] ?? [],
          })
        );
      }

      if (taskId !== L.currentTaskId) return; // 已被新的请求取代
      if (L.isRefreshing) {
        L.refreshCompleted = true;
        L.orgs = orgs;
        L.billingPeriod =
          L.selectedFilter === DateFilter.custom
            ? `${L.startDateString} ~ ${L.endDateString}`
            : dateFilterLocalized(L.selectedFilter);
        L.isPeriodNone = L.selectedFilter === DateFilter.none;
        L.updateTime = new Date();
        L.billingName = ""; // 去掉 NuraLogix账单 时间戳显示
      }
      L.isUpdateFail = false;
      ListPage.render();
      // iOS：refreshCompleted 置位后由 RefreshButton 收起刷新态（仅当前任务有效）
      setTimeout(() => {
        if (taskId !== L.currentTaskId) return;
        L.isRefreshing = false;
        ListPage.render();
      }, 250);
    } catch (error) {
      if (taskId !== L.currentTaskId) return; // 已被新的请求取代
      if (L.isRefreshing) L.refreshCompleted = true;
      L.updateTime = new Date();
      L.isUpdateFail = true;
      L.isRefreshing = false;
      ListPage.render();
      if (SharedUsers.length !== 0) {
        console.error("getData error:", error);
        showPageError(error); // token 过期 → 弹「登录已过期」，点确定回登录页
      }
    } finally {
      ListPage.stopProgressTimer();
    }
  },

  /**
   * 假进度定时器 —— 只在「等 /studies、总量还算不出来」这一段跑（2-BillingListView.swift:699-707）。
   * /studies 一回来就 stopProgressTimer()，之后由真进度（updateStudies 回调）接力：
   * 交接点靠 `completedRequests = progress * totalRequests` 按比例继承，totalRequests 只增，
   * 所以百分比不跳变也不回退（用户看到的连贯感就是这么来的）。
   * 0.9 天花板是给「等 /studies 超过 45 秒」兜底的（0.9 / 0.002 = 450 次 × 100ms），
   * 一旦真进度阶段，这个定时器必须是停的，否则假进度会抢先撞天花板把条子冻在 90%。
   */
  startProgressTimer() {
    const L = AppState.list;
    ListPage.stopProgressTimer();
    ListPage._progressTimer = setInterval(() => {
      L.completedRequests += 0.002 * L.totalRequests;
      if (L.completedRequests >= L.totalRequests * 0.9) ListPage.stopProgressTimer();
      ListPage.renderProgress();
    }, 100);
  },
  stopProgressTimer() {
    if (ListPage._progressTimer) {
      clearInterval(ListPage._progressTimer);
      ListPage._progressTimer = null;
    }
  },

  /** BillingListView 扩展：两个统计函数 */
  totalSuccessMeasurements(user, studies) {
    const arr = studies[user.key];
    if (!arr) return 0;
    return arr.filter((s) => s.totalSuccessMeasurements != null).reduce((n, s) => n + s.totalSuccessMeasurements, 0);
  },
  periodSuccessMeasurements(user, studies) {
    if (AppState.list.selectedFilter === DateFilter.none) return null;
    const arr = studies[user.key];
    if (!arr) return 0;
    return arr
      .filter((s) => (s.periodSuccessMeasurements ?? s.totalSuccessMeasurements) != null)
      .reduce((n, s) => n + (s.periodSuccessMeasurements ?? s.totalSuccessMeasurements), 0);
  },

  /* ------------------------------------------------------------- 渲染 */
  renderProgress() {
    const L = AppState.list;
    const wrap = $("progress-wrap");
    if (L.isRefreshing && L.totalRequests > 0) {
      wrap.style.display = "flex";
      const value = Math.min(Math.max(L.completedRequests, 0), L.totalRequests);
      const percent = L.totalRequests === 0 ? 0 : Math.trunc((value / L.totalRequests) * 100);
      $("progress-bar").style.width = `${percent}%`;
      $("progress-text").textContent = `${percent}%`;
    } else {
      wrap.style.display = "none";
    }
  },

  render() {
    const L = AppState.list;
    // 底部状态（2-BillingListView.footer）
    const title = L.isUpdateFail ? Localized("last_update_fail") : Localized("last_update_time");
    $("update-time").textContent = L.isRefreshing ? Localized("refreshing") : title + yyyyMMddhhmmssDateString2(L.updateTime);
    $("update-time").style.color = L.isUpdateFail && L.refreshCompleted ? "var(--red-text)" : "var(--primary)";
    $("refresh-btn-text").textContent = L.isRefreshing ? Localized("loading") : Localized("refresh");
    $("refresh-btn").disabled = L.isRefreshing;

    // 周期选择
    $("cycle-pill-text").textContent = dateFilterShortString(L.selectedFilter);
    $("cycle-row").style.display = L.isCustomDatePickerPresented ? "none" : "flex";
    $("custom-range").style.display = L.isCustomDatePickerPresented ? "flex" : "none";
    // 自定义周期区间：<input type="date"> 只接受 yyyy-MM-dd。
    // 传入本地化显示串（"2020.01.01" / "至今"）会被浏览器判为非法并清空输入框，
    // 用户就无法设置自定义周期 —— 显示串改放 title，保持 iOS 上的信息不丢。
    setDateInputValue($("start-date-input"), L.savedStartDate ?? L.startDate);
    setDateInputValue($("end-date-input"), L.savedEndDate ?? L.endDate);
    $("start-date-input").title = L.startDateString;
    $("end-date-input").title = L.endDateString;
    $("cycle-chevron").style.transform = L.isMenuOpen ? "rotate(180deg)" : "rotate(0deg)";
    ListPage.renderMenu();
    ListPage.renderProgress();
    ListPage.renderSettingsMenu();

    // 操作按钮可用性（iOS: .disabled(orgList.orgs.isEmpty)）
    const empty = L.orgs.length === 0;
    $("stat-btn").disabled = empty;
    $("refresh-btn").disabled = L.isRefreshing || empty;

    // 表格
    if (empty) {
      $("org-rows").innerHTML = `<div class="empty-state">${Localized("select_org_to_view_detail")}</div>`;
      $("org-count").textContent = "";
      $("billing-name").textContent = "";
      return;
    }
    $("org-rows").innerHTML = L.orgs
      .map(
        (org, index) => `
      <div class="table-row clickable" data-org-index="${index}">
        <span class="td link w170">${escapeHTML(org.name)}</span>
        <span class="td cn w70">${escapeHTML(Region.name(org.region))}</span>
        <span class="td w90">${org.studyCount}</span>
        <span class="td w130">${formatCount(org.billingSuccessMeasurements)}</span>
        <span class="td w100">${org.totalDepositsString}</span>
        <span class="td w110">${org.unitPriceString}</span>
        <span class="td w120">${org.billingCostString}</span>
        <span class="td w100" style="color:${org.balanceColor};${org.balance !== 0 ? "font-weight:500" : ""}">${org.balanceString}</span>
        <span class="td blue w150">${org.periodSuccessString}</span>
        <span class="td blue w140">${org.periodCostString}</span>
        <span class="td w130">${yyyyMMddDateString(org.billingDate)}</span>
      </div>`
      )
      .join("");
    $("org-count").textContent = `${L.orgs.length} 个组织`;
    $("billing-name").textContent = L.billingName; // iOS: bill_prefix + yyyyMMddHHmmss

    $$("#org-rows .table-row").forEach((row) => {
      row.addEventListener("click", () => {
        AppState.list.selectedOrgIndex = Number(row.dataset.orgIndex);
        DetailPage.open();
      });
    });
  },

  renderMenu() {
    const L = AppState.list;
    const menu = $("cycle-menu");
    menu.style.display = L.isMenuOpen ? "block" : "none";
    if (!L.isMenuOpen) return;
    menu.innerHTML = DateFilterAllCases.map(
      (f) => `
      <div class="menu-item ${f === L.selectedFilter ? "active" : ""}" data-filter="${f}">
        <span>${escapeHTML(dateFilterLocalized(f))}</span>
        ${f === L.selectedFilter ? '<span class="menu-check">✓</span>' : ""}
      </div>`
    ).join("");
    $$("#cycle-menu .menu-item").forEach((item) => {
      item.addEventListener("click", () => {
        const filter = item.dataset.filter;
        L.selectedFilter = filter;
        L.isMenuOpen = false;
        if (filter === DateFilter.custom) L.savedUpdateTime = L.updateTime;
        ListPage.performFilter(filter, filter !== DateFilter.custom);
      });
    });
  },

  renderSettingsMenu() {
    const L = AppState.list;
    const menu = $("settings-menu");
    menu.style.display = L.isSettingsMenuOpen ? "flex" : "none";
  },

  /**
   * 账号信息弹窗（设置菜单 → 账号信息）。
   * 展示当前已登录的全部账号（SharedUsers）：组织名称 / 邮箱 / 区域。
   */
  showAccountInfo() {
    const rows = SharedUsers.length
      ? SharedUsers.map(
          (u) => `
        <div class="account-item">
          <div class="account-row"><span class="k">${escapeHTML(Localized("org_label"))}</span><span class="v">${escapeHTML(u.orgName)}</span></div>
          <div class="account-row"><span class="k">${escapeHTML(Localized("account_info_email"))}</span><span class="v">${escapeHTML(u.email)}</span></div>
          <div class="account-row"><span class="k">${escapeHTML(Localized("account_info_region"))}</span><span class="v">${escapeHTML(Region.name(u.region))}</span></div>
        </div>`
        ).join("")
      : `<div class="account-item">
          <div class="account-row"><span class="k">${escapeHTML(Localized("org_label"))}</span><span class="v">-</span></div>
          <div class="account-row"><span class="k">${escapeHTML(Localized("account_info_email"))}</span><span class="v">-</span></div>
          <div class="account-row"><span class="k">${escapeHTML(Localized("account_info_region"))}</span><span class="v">-</span></div>
        </div>`;
    const btns = [{ text: Localized("close") }];
    openModal(`
      <div class="modal-card wide">
        <div class="modal-title">${escapeHTML(Localized("account_info"))}</div>
        <div class="account-list">${rows}</div>
        <div class="modal-actions">
          ${btns
            .map(
              (b, i) =>
                `<button class="modal-btn ${b.primary ? "primary" : ""}" data-modal-idx="${i}">${escapeHTML(b.text)}</button>`
            )
            .join("")}
        </div>
      </div>`);
    $$("#modal-root .modal-btn").forEach((el) => {
      el.addEventListener("click", () => {
        closeModal();
        btns[Number(el.dataset.modalIdx)]?.onClick?.();
      });
    });
  },

  bind() {
    const L = AppState.list;
    // 刷新（RefreshButton）
    $("refresh-btn").addEventListener("click", () => {
      if (L.isRefreshing) return;
      ListPage.requestData();
    });
    // 设置按钮（图标）：悬浮列表
    $("settings-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      L.isSettingsMenuOpen = !L.isSettingsMenuOpen;
      ListPage.renderSettingsMenu();
    });
    // 点击页面任意位置关闭设置菜单
    document.addEventListener("click", (e) => {
      if (L.isSettingsMenuOpen) {
        L.isSettingsMenuOpen = false;
        ListPage.renderSettingsMenu();
      }
      // 点击周期菜单外部时关闭
      if (L.isMenuOpen && !e.target.closest("#cycle-menu") && !e.target.closest("#cycle-pill")) {
        L.isMenuOpen = false;
        ListPage.renderMenu();
        $("cycle-chevron").style.transform = "rotate(0deg)";
      }
    });
    // 账号信息（设置菜单内）
    $("settings-account-info").addEventListener("click", (e) => {
      e.stopPropagation();
      L.isSettingsMenuOpen = false;
      ListPage.renderSettingsMenu();
      ListPage.showAccountInfo();
    });
    // 退出登录（设置菜单内）
    $("settings-logout").addEventListener("click", (e) => {
      e.stopPropagation();
      L.isSettingsMenuOpen = false;
      ListPage.renderSettingsMenu();
      showAlert(Localized("alert_title"), Localized("alert_logout_confirm"), [
        { text: Localized("cancel") },
        {
          text: Localized("confirm"),
          primary: true,
          // iOS：currentTask?.cancel() → SharedUsers.removeAll() → UserStorage.clear() → dismiss()
          // 与 token 过期点确定共用同一套收尾（endSession）
          onClick: () => endSession(),
        },
      ]);
    });
    // 周期下拉
    $("cycle-pill").addEventListener("click", () => {
      L.isMenuOpen = !L.isMenuOpen;
      ListPage.renderMenu();
      $("cycle-chevron").style.transform = L.isMenuOpen ? "rotate(180deg)" : "rotate(0deg)";
    });
    // 自定义周期：开始时间
    // iOS 的 DatePicker 直接绑定 startDate；这里在 change 时同步，点「确定」时再以输入框
    // 的当前值为准（用户直接键入日期后马上点确定，change 可能还没触发）。
    $("start-date-input").addEventListener("change", (e) => {
      const d = fromDateInputValue(e.target.value);
      ListPage.setStartDate(d ?? kInitialStartDate);
    });
    $("end-date-input").addEventListener("change", (e) => {
      const d = fromDateInputValue(e.target.value);
      ListPage.setEndDate(d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59) : new Date());
    });
    $("reset-start").addEventListener("click", () => {
      // iOS：startDate = kInitialStartDate → savedStartDate = nil → requestData()
      ListPage.setStartDate(kInitialStartDate);
      ListPage.setSavedStartDate(null);
      ListPage.requestData();
    });
    $("confirm-start").addEventListener("click", () => {
      // iOS：startDate = date(bySettingHour: 0,0,0, of: startDate) → requestData()
      const picked = fromDateInputValue($("start-date-input").value) ?? L.startDate;
      ListPage.setStartDate(new Date(picked.getFullYear(), picked.getMonth(), picked.getDate()));
      ListPage.requestData();
    });
    $("reset-end").addEventListener("click", () => {
      // iOS：endDate = Date() → savedEndDate = nil → requestData()
      ListPage.setEndDate(new Date());
      ListPage.setSavedEndDate(null);
      ListPage.requestData();
    });
    $("confirm-end").addEventListener("click", () => {
      // iOS：endDate = min(当天 23:59:59, now)；若 23:59:59 仍在未来则 savedEndDate = nil（显示「至今」）
      const now = new Date();
      const picked = fromDateInputValue($("end-date-input").value) ?? L.endDate;
      const fixedEnd = new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), 23, 59, 59);
      ListPage.setEndDate(fixedEnd > now ? now : fixedEnd);
      if (fixedEnd > now) ListPage.setSavedEndDate(null);
      ListPage.requestData();
    });
    $("back-to-list-from-range").addEventListener("click", () => {
      L.isCustomDatePickerPresented = false;
      if (L.lastSelectedFilter === DateFilter.custom) L.lastSelectedFilter = DateFilter.none;
      L.selectedFilter = L.lastSelectedFilter;
      ListPage.performFilter(L.lastSelectedFilter, L.savedUpdateTime.getTime() !== L.updateTime.getTime());
    });
    // 统计分析（6-StatisticsView）
    $("stat-btn").addEventListener("click", () => StatisticsPage.open());
  },
};

/* ============================================================================
 * 页面三：组织账单详情（3-BillingDetailView.swift）
 * ==========================================================================*/
const DetailPage = {
  _isRefreshing: false,

  get org() {
    return AppState.list.orgs[AppState.list.selectedOrgIndex] ?? null;
  },

  open() {
    DetailPage.render();
    Router.go("detail");
  },

  render() {
    const org = DetailPage.org;
    if (!org) return;
    const L = AppState.list;

    $("d-title").textContent = org.name;
    $("d-crumb").textContent = `${Localized("org_name_label")} / ${org.name}`;
    $("d-region-badge").textContent = `${Localized("region_label")}: ${Region.name(org.region)}`;

    // 组织信息区（含可编辑字段）
    $("d-deposits").textContent = org.totalDepositsString;
    $("d-unitprice").textContent = org.unitPriceString;
    $("d-billcost").textContent = org.billingCostString;
    $("d-balance").textContent = org.balanceString;
    $("d-balance").style.color = org.balanceColor;
    $("d-billingdate").textContent = yyyyMMddDateString(org.billingDate);
    $("d-region").textContent = Region.name(org.region);
    // 统计周期 / 周期内消费（浅蓝高亮）
    $("d-period").textContent = L.billingPeriod;
    $("d-periodcost").textContent = org.periodCostString;
    $("d-refreshing").style.display = DetailPage._isRefreshing ? "inline-block" : "none";

    DetailPage.renderStudies();
  },

  /** StudyRowView + StudySummaryRowView */
  renderStudies() {
    const org = DetailPage.org;
    const studies = org.studies;
    const unitPriceOf = (s) => s.unitPrice ?? org.unitPrice;

    const rows = studies
      .map((study) => {
        const billingSuccessMeasurements = study.billingSuccessMeasurements ?? 0;
        const periodSuccessMeasurements = study.periodSuccessMeasurements;
        const periodCost = study.periodCost;
        const cost = study.billingCost;
        const isPeriodCostHighlight = (periodCost ?? 0) < unitPriceOf(study) * Number(periodSuccessMeasurements ?? 0);
        const isCostHighlight = cost < unitPriceOf(study) * billingSuccessMeasurements;
        const periodSuccessString = periodSuccessMeasurements == null ? "-" : `${periodSuccessMeasurements}`;
        const periodCostString = periodCost == null ? "-" : formatAmount(periodCost);
        return `
        <div class="table-row" data-study-id="${escapeHTML(study.ID)}">
          <span class="td rw110">${study.createdDateString}</span>
          <span class="td cn rw190">${escapeHTML(study.Name)}</span>
          <span class="td cn status rw70" style="color:${study.StatusID === "ACTIVE" ? "var(--green-text)" : "var(--stone)"}">${escapeHTML(
          study.statusString
        )}</span>
          <span class="td rw130">
            <span class="study-price">${formatUnitPrice(unitPriceOf(study))}</span>
            <span class="icon-btn" data-edit-study="${escapeHTML(study.ID)}" title="${Localized("input_unit_price_title")}">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M9.5 1.8L12.2 4.5L4.7 12H2V9.3L9.5 1.8Z" stroke="#0064E0" stroke-width="1.3" stroke-linejoin="round"/></svg>
            </span>
          </span>
          <span class="td rw140">${periodSuccessString}</span>
          <span class="td rw140" style="color:${isPeriodCostHighlight ? "var(--orange-text)" : "inherit"}">${periodCostString}</span>
          <span class="td rw140">${billingSuccessMeasurements}</span>
          <span class="td rw130" style="color:${isCostHighlight ? "var(--orange-text)" : "inherit"}">${formatAmount(cost)}</span>
          <span class="td rw150" style="color:var(--steel);font-size:13px">${escapeHTML(study.encryptedKey)}</span>
        </div>`;
      })
      .join("");
    $("research-rows").innerHTML = rows;

    // 合计行
    const totalPeriodSuccessCount = org.periodSuccess; // Int?
    const totalBillingSuccessCount = studies.reduce(
      (n, s) => n + (s.billingSuccessMeasurements ?? s.totalSuccessMeasurements ?? 0),
      0
    );
    const totalPeriodSuccessCost = org.periodCost;
    const billingCost = org.billingCost;
    const periodCostOfStudies = studies.reduce(
      (n, s) => n + Number(s.periodSuccessMeasurements ?? 0) * unitPriceOf(s),
      0
    );
    const isPeriodCostHighlight = (org.periodCost ?? 0) < periodCostOfStudies;
    const billingCostOfStudies = studies.reduce((n, s) => n + Number(s.billingSuccessMeasurements ?? 0) * unitPriceOf(s), 0);
    const isCostHighlight = org.billingCost < billingCostOfStudies;

    $("d-total-label").textContent = `${Localized("summary_total")} (${studies.length})`;
    $("d-total-period-success").textContent = totalPeriodSuccessCount == null ? "-" : `${totalPeriodSuccessCount}`;
    $("d-total-period-cost").textContent = totalPeriodSuccessCost == null ? "-" : formatAmount(totalPeriodSuccessCost);
    $("d-total-period-cost").style.color = isPeriodCostHighlight ? "var(--orange-text)" : "inherit";
    $("d-total-billing-success").textContent = `${totalBillingSuccessCount}`;
    $("d-total-billing-cost").textContent = formatAmount(billingCost);
    $("d-total-billing-cost").style.color = isCostHighlight ? "var(--orange-text)" : "inherit";

    // 表头文案
    $("th-created").textContent = Localized("created_date");
    $("th-name").textContent = Localized("study_name");
    $("th-status").textContent = Localized("status");
    $("th-unitprice").textContent = Localized("unit_price_label");
    $("th-period-success").textContent = Localized("period_success");
    $("th-period-cost").textContent = Localized("period_cost");
    $("th-billing-success").textContent = Localized("success_count_label");
    $("th-billing-cost").textContent = Localized("billing_cost_label");
    $("th-study-id").textContent = Localized("study_id");

    $$("#research-rows .icon-btn[data-edit-study]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        DetailPage.editStudyUnitPrice(btn.dataset.editStudy);
      });
    });
  },

  /** 3-BillingDetailView: 编辑充值金额（追加 / 修改，与 iOS 行为一致） */
  editDeposits() {
    const org = DetailPage.org;
    showInput(Localized("input_deposits_title"), Localized("input_deposits_placeholder"), "", [
      {
        text: Localized("add_deposits"),
        onClick: (value) => {
          const v = Number(value);
          if (!Number.isNaN(v) && value !== "") {
            org.totalDeposits += v;
            const idx = SharedUsers.findIndex((u) => u.key === org.key);
            if (idx >= 0) {
              SharedUsers[idx].deposits = v; // iOS：直接赋值为本次输入值
              UserStorage.save(SharedUsers);
            }
            DetailPage.render();
          }
        },
      },
      {
        text: Localized("edit_deposits"),
        onClick: (value) => {
          const v = Number(value);
          if (!Number.isNaN(v) && value !== "") {
            org.totalDeposits = v;
            const idx = SharedUsers.findIndex((u) => u.key === org.key);
            if (idx >= 0) {
              SharedUsers[idx].deposits = v;
              UserStorage.save(SharedUsers);
            }
            DetailPage.render();
          }
        },
      },
      { text: Localized("cancel") },
    ]);
  },

  /** 编辑全局单价 */
  editUnitPrice() {
    const org = DetailPage.org;
    showInput(Localized("input_unit_price_title"), Localized("input_unit_price_placeholder"), "", [
      {
        text: Localized("confirm"),
        primary: true,
        onClick: (value) => {
          const v = Number(value);
          if (!Number.isNaN(v) && value !== "") {
            org.unitPrice = v;
            org.resetStudyUnitPrice();
            const idx = SharedUsers.findIndex((u) => u.key === org.key);
            if (idx >= 0) {
              SharedUsers[idx].unitPrice = v;
              SharedUsers[idx].studyUnitPrices = null;
              UserStorage.save(SharedUsers);
            }
            DetailPage.render();
          }
        },
      },
      { text: Localized("cancel") },
    ]);
  },

  /** 编辑单个研究单价（写入 user.studyUnitPrices[studyID]） */
  editStudyUnitPrice(studyID) {
    const org = DetailPage.org;
    const study = org.studies.find((s) => s.ID === studyID);
    if (!study) return;
    const defaultValue = study.unitPrice != null ? formatUnitPrice(study.unitPrice) : formatUnitPrice(org.unitPrice);
    showInput(Localized("input_unit_price_title"), Localized("input_unit_price_placeholder"), defaultValue, [
      {
        text: Localized("confirm"),
        primary: true,
        onClick: (value) => {
          const v = Number(value);
          if (!Number.isNaN(v) && value !== "") {
            const idx1 = org.studies.findIndex((s) => s.ID === studyID);
            if (idx1 >= 0) org.studies[idx1].unitPrice = v;
            const idx = SharedUsers.findIndex((u) => u.key === org.key);
            if (idx >= 0) {
              const map = SharedUsers[idx].studyUnitPrices ?? {};
              map[studyID] = v;
              SharedUsers[idx].studyUnitPrices = map;
              UserStorage.save(SharedUsers);
            }
            DetailPage.render();
          }
        },
      },
      { text: Localized("cancel") },
    ]);
  },

  /** 账单开始日期（日历）：确认后触发 updateStudies() */
  editBillingDate() {
    const org = DetailPage.org;
    const current = yyyyMMddDateString(org.billingDate);
    const iso = `${org.billingDate.getFullYear()}-${String(org.billingDate.getMonth() + 1).padStart(2, "0")}-${String(
      org.billingDate.getDate()
    ).padStart(2, "0")}`;
    openModal(`
      <div class="modal-card">
        <div class="modal-title">${escapeHTML(Localized("billing_date"))}</div>
        <input type="date" class="text-input modal-input" id="modal-date" value="${iso}" max="${new Date().toISOString().slice(0, 10)}">
        <div class="modal-actions">
          <button class="modal-btn" id="modal-date-cancel">${escapeHTML(Localized("cancel"))}</button>
          <button class="modal-btn primary" id="modal-date-confirm">${escapeHTML(Localized("confirm"))}</button>
        </div>
      </div>`);
    $("modal-date-cancel").addEventListener("click", () => {
      closeModal();
    });
    $("modal-date-confirm").addEventListener("click", () => {
      const v = $("modal-date").value;
      closeModal();
      if (!v) return;
      const d = new Date(v);
      DetailPage.applyBillingDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    });
  },

  applyBillingDate(newDate) {
    const org = DetailPage.org;
    if (org.billingDate.getTime() === newDate.getTime()) return;
    org.billingDate = newDate;
    const idx = SharedUsers.findIndex((u) => u.key === org.key);
    if (idx >= 0) {
      SharedUsers[idx].billingDate = newDate;
      UserStorage.save(SharedUsers);
      DetailPage.render();
      DetailPage.updateStudies(); // iOS：更新 billingSuccess 数据
    }
  },

  /** 3-BillingDetailView.updateStudies() */
  async updateStudies() {
    const org = DetailPage.org;
    if (!org) return;
    DetailPage._isRefreshing = true;
    $("study-refreshing").style.display = "inline-block";
    DetailPage.render();
    try {
      const studiesDic = { [org.key]: org.studies };
      const billingDateDic = { [org.key]: org.billingDate };

      if (org.billingDate >= org.startDate && org.billingDate < org.endDate) {
        await APIClient.updateStudies(studiesDic, billingDateDic, null, org.endDate, () => {});
        for (const study of studiesDic[org.key]) {
          const idx = org.studies.findIndex((s) => s.ID === study.ID);
          if (idx >= 0) org.studies[idx].periodBillingSuccessMeasurements = study.totalSuccessMeasurements;
        }
      } else {
        for (const study of org.studies) {
          study.periodBillingSuccessMeasurements = org.billingDate > org.endDate ? 0 : null;
        }
      }

      await APIClient.updateStudies(studiesDic, billingDateDic, null, null, () => {});
      for (const study of studiesDic[org.key]) {
        const idx = org.studies.findIndex((s) => s.ID === study.ID);
        if (idx >= 0) org.studies[idx].billingSuccessMeasurements = study.totalSuccessMeasurements;
      }
      DetailPage._isRefreshing = false;
      $("study-refreshing").style.display = "none";
      DetailPage.render();
    } catch (error) {
      console.error("getData error:", error);
      DetailPage._isRefreshing = false;
      $("study-refreshing").style.display = "none";
      DetailPage.render();
      showPageError(error); // token 过期 → 弹「登录已过期」，点确定回登录页
    }
  },

  bind() {
    $("back-btn").addEventListener("click", () => Router.go("list"));
    $("d-deposits-edit").addEventListener("click", () => DetailPage.editDeposits());
    $("d-unitprice-edit").addEventListener("click", () => DetailPage.editUnitPrice());
    $("d-billingdate-edit").addEventListener("click", () => DetailPage.editBillingDate());
  },
};

function _isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/* ------------------------------------------------- 自定义周期的日期输入框
 * iOS 用图形化 DatePicker 直接绑定 Date；Web 侧是 <input type="date">，
 * 它只接受 yyyy-MM-dd。写入本地化显示串（"2020.01.01" / "至今"）会被浏览器
 * 判为非法值并**清空输入框** —— 那样用户就没法设置自定义周期，
 * 点「确定」时用的还是上一个周期的区间，表现就是「选了周期但数据没更新」。
 */
/** Date → <input type="date"> 的 yyyy-MM-dd */
function toDateInputValue(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
}
/** <input type="date"> 的 yyyy-MM-dd → Date（本地 00:00:00），非法值返回 null */
function fromDateInputValue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
/** 写日期输入框；用户正在编辑时不打断 */
function setDateInputValue(el, d) {
  if (document.activeElement === el) return;
  el.value = toDateInputValue(d);
}

/* ============================================================================
 * 路由 / 初始化
 * ==========================================================================*/
/* ============================================================================
 * 页面四：统计分析（6-StatisticsView.swift）
 * ==========================================================================*/

/**
 * 6-StatisticsView.companyName(from:)：组织名 "_" 前缀作为公司名。
 * "lssd_01" / "lssd_02" → "lssd"；无下划线或前缀为空白时用原名。
 */
function statisticsCompanyNameFrom(orgName) {
  const idx = orgName.indexOf("_");
  const prefix = idx === -1 ? orgName : orgName.slice(0, idx);
  const trimmed = prefix.trim();
  return trimmed.length > 0 ? trimmed : orgName;
}

/** 6-StatisticsView.is5sStudy(_:)：研究名含 "5s"（不区分大小写）归入 5s 测量 */
function statisticsIs5sStudy(studyName) {
  return studyName.toLowerCase().includes("5s");
}

const StatisticsPage = {
  /** StatisticsTab：.custom（周期统计） / .bill（账单统计） */
  selectedTab: "custom",

  /** 列表页「统计分析」入口。iOS onAppear：selectedTab = isPeriodNone ? .bill : .custom */
  open() {
    const L = AppState.list;
    StatisticsPage.selectedTab = L.isPeriodNone ? "bill" : "custom";
    Router.go("statistics");
  },

  /**
   * companyAggregates：按公司（组织名前缀）聚合 30s / 5s 测量。
   * custom 取 periodSuccessMeasurements/periodCost；bill 取 billingSuccessMeasurements/billingCost。
   * 公司按名称排序（Swift: localizedCaseInsensitiveCompare 升序）。
   */
  companyAggregates() {
    const L = AppState.list;
    const map = new Map();
    for (const org of L.orgs) {
      const company = statisticsCompanyNameFrom(org.name);
      let agg = map.get(company);
      if (!agg) {
        agg = { name: company, billingDate: org.billingDate, count30s: 0, cost30s: 0, count5s: 0, cost5s: 0 };
        map.set(company, agg);
      }
      for (const study of org.studies) {
        let successCount;
        let cost;
        if (StatisticsPage.selectedTab === "custom") {
          successCount = study.periodSuccessMeasurements ?? study.totalSuccessMeasurements ?? 0;
          cost = study.periodCost ?? 0;
        } else {
          successCount = study.billingSuccessMeasurements ?? study.totalSuccessMeasurements ?? 0;
          cost = study.billingCost ?? 0;
        }
        if (statisticsIs5sStudy(study.Name)) {
          agg.count5s += successCount;
          agg.cost5s += cost;
        } else {
          agg.count30s += successCount;
          agg.cost30s += cost;
        }
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  },

  /** organizations：公司卡数据，按 totalCost 升序（Swift: sorted { $0.totalCost < $1.totalCost }） */
  organizations() {
    return StatisticsPage.companyAggregates()
      .map((a) => ({
        name: a.name,
        count30s: a.count30s,
        cost30s: a.cost30s,
        count5s: a.count5s,
        cost5s: a.cost5s,
        totalCount: a.count30s + a.count5s,
        totalCost: a.cost30s + a.cost5s,
        billingDate: a.billingDate,
      }))
      .sort((a, b) => a.totalCost - b.totalCost);
  },

  /** summary：所有公司合计 */
  summary() {
    const aggs = StatisticsPage.companyAggregates();
    const sum = (pick) => aggs.reduce((acc, a) => acc + pick(a), 0);
    const total30sCount = sum((a) => a.count30s);
    const total5sCount = sum((a) => a.count5s);
    return {
      totalCompanies: aggs.length,
      count30s: total30sCount,
      cost30s: sum((a) => a.cost30s),
      count5s: total5sCount,
      cost5s: sum((a) => a.cost5s),
      totalCount: total30sCount + total5sCount,
      totalCost: sum((a) => a.cost30s) + sum((a) => a.cost5s),
    };
  },

  _blockTexts(count, cost) {
    return {
      count: `${Localized("measurement_count")}${formatCount(count)}`,
      cost: `${Localized("measurement_cost")}${formatAmount(cost)}`,
    };
  },

  render() {
    const L = AppState.list;

    // 顶部：标题 / 面包屑 / segment（无周期时隐藏）/ 周期条（custom 时显示）
    $("stats-title").textContent = Localized("statistics_billing_title");
    $("stats-crumb").textContent = `${Localized("org_name_label")} / ${Localized("statistics_billing_title")}`;
    const seg = $("stats-seg");
    seg.style.display = L.isPeriodNone ? "none" : "inline-flex";
    $("stats-tab-custom").textContent = Localized("statistics_tab_custom_period");
    $("stats-tab-bill").textContent = Localized("statistics_tab_billing");
    $("stats-tab-custom").classList.toggle("active", StatisticsPage.selectedTab === "custom");
    $("stats-tab-bill").classList.toggle("active", StatisticsPage.selectedTab === "bill");
    const periodBar = $("stats-period-bar");
    if (!L.isPeriodNone && StatisticsPage.selectedTab === "custom") {
      periodBar.style.display = "flex";
      periodBar.textContent = L.billingPeriod;
    } else {
      periodBar.style.display = "none";
    }

    // 汇总卡片
    const summary = StatisticsPage.summary();
    $("stats-total-bar").textContent = `${Localized("statistics_total_prefix")} (${summary.totalCompanies})`;
    const f = StatisticsPage._blockTexts(summary.count30s, summary.cost30s);
    const s = StatisticsPage._blockTexts(summary.count5s, summary.cost5s);
    const t = StatisticsPage._blockTexts(summary.totalCount, summary.totalCost);
    $("stats-f-title").textContent = Localized("statistics_30s_measurement");
    $("stats-f-count").textContent = f.count;
    $("stats-f-cost").textContent = f.cost;
    $("stats-s-title").textContent = Localized("statistics_5s_measurement");
    $("stats-s-count").textContent = s.count;
    $("stats-s-cost").textContent = s.cost;
    $("stats-t-title").textContent = Localized("statistics_all_measurement");
    $("stats-t-count").textContent = t.count;
    $("stats-t-cost").textContent = t.cost;

    // 公司卡片（bill 页签显示账单开始日期；Swift: isBilling = selectedTab == .bill）
    const showDate = StatisticsPage.selectedTab === "bill";
    const chartSvg =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 3v18h18" stroke="#0064E0" stroke-width="2" stroke-linecap="round"/><path d="M7 15l4-5 3 3 5-7" stroke="#0064E0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const rows = StatisticsPage.organizations()
      .map((item, i) => {
        const c30 = StatisticsPage._blockTexts(item.count30s, item.cost30s);
        const c5 = StatisticsPage._blockTexts(item.count5s, item.cost5s);
        const ct = StatisticsPage._blockTexts(item.totalCount, item.totalCost);
        return `
      <div class="stats-card">
        <div class="stats-card-head">
          <span class="stats-org-pill">${i + 1}. ${Localized("statistics_company_name")}: ${escapeHTML(item.name)}</span>
          <button class="stats-chart-btn" data-stats-chart data-stats-company="${escapeHTML(item.name)}" title="图表分析">${chartSvg}</button>
          <span style="flex:1"></span>
          ${showDate ? `<span class="stats-date">${Localized("billing_date")}: ${yyyyMMddDateString(item.billingDate)}</span>` : ""}
        </div>
        <div class="stats-divider"></div>
        <div class="stats-blocks">
          <div class="stats-block"><span class="t">${Localized("statistics_30s_measurement")}</span><span class="r">${c30.count}</span><span class="r">${c30.cost}</span></div>
          <div class="stats-block"><span class="t">${Localized("statistics_5s_measurement")}</span><span class="r">${c5.count}</span><span class="r">${c5.cost}</span></div>
          <div class="stats-block"><span class="t">${Localized("statistics_all_measurement")}</span><span class="r">${ct.count}</span><span class="r">${ct.cost}</span></div>
        </div>
      </div>`;
      })
      .join("");
    $("stats-org-list").innerHTML = rows;
    $$("[data-stats-chart]").forEach((btn) =>
      btn.addEventListener("click", () => TrendPage.open(btn.dataset.statsCompany ?? null))
    );
  },

  bind() {
    $("stats-back").addEventListener("click", () => Router.go("list"));
    $("stats-chart-summary").addEventListener("click", () => TrendPage.open(null));
    $("stats-tab-custom").addEventListener("click", () => {
      if (StatisticsPage.selectedTab !== "custom") {
        StatisticsPage.selectedTab = "custom";
        StatisticsPage.render();
      }
    });
    $("stats-tab-bill").addEventListener("click", () => {
      if (StatisticsPage.selectedTab !== "bill") {
        StatisticsPage.selectedTab = "bill";
        StatisticsPage.render();
      }
    });
  },
};

/* ============================================================================
 * 测量趋势页（7-AnalysisView.swift + AnalysisDayView / AnalysisMonthView）
 * 数据：最近 30 天按日、最近 12 个月按月的测量次数聚合（时间点最多 5 并发，
 *       今天/本月强制刷新，其余优先本地缓存）；图表用内联 SVG 渲染。
 * ==========================================================================*/

/** Swift GMT formatter "yyyy-MM-dd"：按 Date 的 UTC 分量格式化（与 iOS 缓存键一致） */
function trendUTCDayString(date) {
  return `${date.getUTCFullYear()}-${_pad(date.getUTCMonth() + 1)}-${_pad(date.getUTCDate())}`;
}
/** Swift GMT formatter "yyyy-MM" */
function trendUTCMonthString(date) {
  return `${date.getUTCFullYear()}-${_pad(date.getUTCMonth() + 1)}`;
}
/** AnalysisDayView.fullDateLabel：yyyy-MM-dd（本地时区） */
function trendFullDateLabel(date) {
  return `${date.getFullYear()}-${_pad(date.getMonth() + 1)}-${_pad(date.getDate())}`;
}

/** 7-AnalysisView.last30DayStarts：本地今天往前 30 个当日 00:00（含今天） */
function trendLast30DayStarts(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = [];
  for (let offset = -29; offset <= 0; offset++) {
    days.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
  }
  return days;
}

/** 月区间：本地本月往前 12 个每月 1 日（含本月）
 *  注：iOS 7-AnalysisView.last6MonthStarts(0..<6, -5+i) 为 6 个月，
 *      此处按需求扩展为 12 个月（-11..0），属对 iOS 的有意偏离。 */
function trendLast12MonthStarts(now = new Date()) {
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const months = [];
  for (let i = -11; i <= 0; i++) {
    months.push(new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() + i, 1));
  }
  return months;
}

/** 分析缓存（iOS: UserDefaults "analysis.measurementCount.*" → Web: localStorage） */
const TrendCache = {
  prefix: "analysis.measurementCount",
  _storage: undefined,
  _store() {
    if (TrendCache._storage === undefined) {
      try {
        TrendCache._storage = typeof localStorage !== "undefined" ? localStorage : null;
      } catch (e) {
        TrendCache._storage = null;
      }
    }
    return TrendCache._storage;
  },
  _get(key) {
    const store = TrendCache._store();
    if (!store) return null;
    try {
      const raw = store.getItem(key);
      if (raw == null) return null;
      const model = JSON.parse(raw);
      return typeof model?.count === "number" ? model.count : null;
    } catch (e) {
      return null;
    }
  },
  _set(key, count) {
    const store = TrendCache._store();
    if (!store) return;
    try {
      store.setItem(key, JSON.stringify({ count, updatedAt: Date.now() }));
    } catch (e) { /* 隐私模式等写入失败时静默（等价于无缓存） */ }
  },
  getDay(orgName, region, dayStart) {
    return TrendCache._get(`${TrendCache.prefix}.day.${orgName}.${region}.${trendUTCDayString(dayStart)}`);
  },
  setDay(orgName, region, dayStart, count) {
    TrendCache._set(`${TrendCache.prefix}.day.${orgName}.${region}.${trendUTCDayString(dayStart)}`, count);
  },
  getMonth(orgName, region, monthStart) {
    return TrendCache._get(`${TrendCache.prefix}.month.${orgName}.${region}.${trendUTCMonthString(monthStart)}`);
  },
  setMonth(orgName, region, monthStart, count) {
    TrendCache._set(`${TrendCache.prefix}.month.${orgName}.${region}.${trendUTCMonthString(monthStart)}`, count);
  },
};

/** 7-AnalysisView.missingOrgTimePointCount：需要请求的 (时间点, 组织) 数（今天/本月必算） */
function trendMissingOrgTimePointCount(users, dayStarts, monthStarts) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let count = 0;
  for (const day of dayStarts) {
    const isToday = day.getTime() === todayStart.getTime();
    for (const user of users) {
      if (isToday || TrendCache.getDay(user.orgName, user.region, day) == null) count += 1;
    }
  }
  for (const month of monthStarts) {
    const isThisMonth = month.getTime() === thisMonthStart.getTime();
    for (const user of users) {
      if (isThisMonth || TrendCache.getMonth(user.orgName, user.region, month) == null) count += 1;
    }
  }
  return count;
}

/** 单时间点聚合：逐账号求和（当前期强制刷新；其余优先缓存，缺失则请求并写缓存） */
async function trendFetchPoint(users, start, end, isCurrent, cacheGet, cacheSet, progress) {
  let sum = 0;
  for (const user of users) {
    if (!isCurrent) {
      const cached = cacheGet(user.orgName, user.region, start);
      if (cached != null) {
        sum += cached;
        continue;
      }
    }
    const info = await APIClient.getMeasurementInfo(
      user.orgName, user.region, null,
      toUTCString(start), end != null ? toUTCString(end) : null, progress
    );
    cacheSet(user.orgName, user.region, start, info.successCount);
    sum += info.successCount;
  }
  return sum;
}

/** 时间点并发（iOS: 最多 5 个时间点并发，点内逐账号串行） */
async function trendFetchAggregated(points, users, isCurrentPoint, nextStart, cacheGet, cacheSet, results, progress) {
  let nextIndex = 0;
  const MAX_CONCURRENT = 5;
  const worker = async () => {
    while (nextIndex < points.length) {
      const index = nextIndex++;
      const start = points[index];
      results[index] = await trendFetchPoint(
        users, start, nextStart(start), isCurrentPoint(start), cacheGet, cacheSet, progress
      );
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENT, points.length); i++) workers.push(worker());
  await Promise.all(workers);
}

/** 近似 iOS Charts 自动刻度：step ∈ {1,2,2.5,5}×10^k，top = ceil(max/step)*step */
function trendNiceTicks(maxValue) {
  const max = Math.max(maxValue, 1);
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = mag * 10;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw) {
      step = m * mag;
      break;
    }
  }
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return { top, ticks };
}

/** Catmull-Rom → 三次贝塞尔（iOS .interpolationMethod(.catmullRom)） */
function trendCatmullRomPath(pts) {
  const f = (v) => v.toFixed(1);
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i > 0 ? pts[i - 1] : pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 < pts.length ? pts[i + 2] : p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

const TREND_GRID = "#DEE3E9";
const TREND_BLUE = "#0064E0";
const TREND_ORANGE = "#FF9500";
const TREND_RULE = "#8595A4";

/** 折线图 SVG（30 天全部展示：宽 1264，点间距均分，无需横向滚动） */
function trendLineChartSVG(data, selectedIndex) {
  const H = 240;
  const plotW = 1264;
  const n = data.length;
  if (n === 0) return "";
  const W = plotW;
  const { top, ticks } = trendNiceTicks(Math.max(...data.map((d) => d.count)));
  const dayW = n > 1 ? W / (n - 1) : 0;
  const pts = data.map((d, i) => [i * dayW, H - (d.count / top) * H]);
  let svg = ticks
    .map((t) => `<path d="M0 ${(H - (t / top) * H).toFixed(1)}H${W}" stroke="${TREND_GRID}" stroke-width="1" stroke-dasharray="4 4"/>`)
    .join("");
  svg += pts
    .map((p) => `<path d="M${p[0].toFixed(1)} 0V${H}" stroke="${TREND_GRID}" stroke-width="1" stroke-dasharray="4 4"/>`)
    .join("");
  if (selectedIndex != null && selectedIndex >= 0 && selectedIndex < n) {
    svg += `<path d="M${pts[selectedIndex][0].toFixed(1)} 0V${H}" stroke="${TREND_RULE}" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="4 4"/>`;
  }
  svg += `<path d="${trendCatmullRomPath(pts)}" stroke="${TREND_BLUE}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
      svg += pts
        .map((p, i) =>
          i === selectedIndex
                  ? `<circle data-idx="${i}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${TREND_ORANGE}"/>`
                  : `<circle data-idx="${i}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="${TREND_BLUE}"/>`)
        .join("");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
}

/** 柱状图 SVG（12 根柱、柱宽固定 48，选中变橙 + 虚线参考线） */
function trendBarChartSVG(data, selectedIndex) {
  const H = 240;
  const W = 1264;
  const n = data.length;
  if (n === 0) return "";
  const { top, ticks } = trendNiceTicks(Math.max(...data.map((d) => d.count)));
  const slot = W / n;
  const bw = 48;
  let svg = ticks
    .map((t) => `<path d="M0 ${(H - (t / top) * H).toFixed(1)}H${W}" stroke="${TREND_GRID}" stroke-width="1" stroke-dasharray="4 4"/>`)
    .join("");
  data.forEach((d, i) => {
    const x = i * slot + (slot - bw) / 2;
    const y = H - (d.count / top) * H;
    svg += `<path data-idx="${i}" d="M${x.toFixed(1)} ${y.toFixed(1)}V${H}H${(x + bw).toFixed(1)}V${y.toFixed(1)}Z" fill="${i === selectedIndex ? TREND_ORANGE : TREND_BLUE}"/>`;
  });
  if (selectedIndex != null && selectedIndex >= 0 && selectedIndex < n) {
    const cx = (selectedIndex * slot + slot / 2).toFixed(1);
    svg += `<path d="M${cx} 0V${H}" stroke="${TREND_RULE}" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="4 4"/>`;
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
}

/** iOS String(format:) 的 %1$@ / %2$@ / %@ 顺序替换 */
function trendFormatArgs(fmt, ...args) {
  let out = String(fmt);
  for (const arg of args) out = out.replace(/%(\d+\$@|@)/, arg);
  return out;
}

const TrendPage = {
  /** StatisticsView 传入的公司名（null = 汇总入口，聚合全部账号，标题「全部」） */
  companyName: null,
  dayData: [],
  monthData: [],
  selectedDayIndex: null,
  selectedMonthIndex: null,
  _seq: 0,

  /**
   * 会话结束（退出登录 / token 过期）：作废在途请求并清空数据。
   * 对应 iOS 视图销毁后 @State 重新初始化；_seq 自增让在途聚合结果落到守卫外，
   * 避免回到登录页后仍被旧请求回调（还会二次触发错误弹框）。
   */
  resetState() {
    TrendPage._seq += 1;
    TrendPage.companyName = null;
    TrendPage.dayData = [];
    TrendPage.monthData = [];
    TrendPage.selectedDayIndex = null;
    TrendPage.selectedMonthIndex = null;
  },

  /** AnalysisView(companyName:)。onAppear → requestData */
  open(companyName = null) {
    TrendPage.companyName = companyName;
    Router.go("trend");
  },

  /** navigationTitleText：公司名去空白后为空 → 「全部」 */
  title() {
    const trimmed = (TrendPage.companyName ?? "").trim();
    return trimmed.length > 0 ? trimmed : Localized("analysis_title_all");
  },

  /** targetUsers：公司入口按组织名 "_" 前缀过滤 SharedUsers */
  targetUsers() {
    if (!TrendPage.companyName) return SharedUsers.slice();
    return SharedUsers.filter((u) => statisticsCompanyNameFrom(u.orgName) === TrendPage.companyName);
  },

  async render() {
    TrendPage._seq += 1;
    const seq = TrendPage._seq;
    TrendPage.selectedDayIndex = null;
    TrendPage.selectedMonthIndex = null;
    TrendPage.dayData = [];
    TrendPage.monthData = [];

    $("trend-title").textContent = TrendPage.title();
    $("trend-crumb").textContent = `${Localized("statistics_billing_title")} / ${TrendPage.title()}`;
    $("trend-day-title").textContent = Localized("analysis_day_title");
    $("trend-month-title").textContent = Localized("analysis_month_title");
    $("trend-loading-text").textContent = Localized("analysis_loading");
    $("trend-loading-tip").textContent = Localized("analysis_loading_tip");
    $("trend-content").style.display = "none";
    $("trend-loading").style.display = "flex";
    $("trend-pct").textContent = "0%";

    const users = TrendPage.targetUsers();
    const dayStarts = trendLast30DayStarts();
    const monthStarts = trendLast12MonthStarts();

    if (users.length === 0) {
      // iOS fetchLast30DaysAggregated：users 为空直接返回空数据
      TrendPage._showCharts(seq);
      return;
    }

    // 进度：每个缺失 (时间点, 组织) 产生 2 次 progress 回调（COMPLETE / PARTIAL 各一次）
    let completed = 0;
    const total = Math.max(trendMissingOrgTimePointCount(users, dayStarts, monthStarts) * 2, 1);
    const progress = () => {
      completed += 1;
      if (seq === TrendPage._seq) {
        $("trend-pct").textContent = `${Math.min(Math.floor((completed / total) * 100), 100)}%`;
      }
    };

    const dayCounts = new Array(dayStarts.length).fill(0);
    const monthCounts = new Array(monthStarts.length).fill(0);
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      await Promise.all([
        trendFetchAggregated(
          dayStarts, users,
          (d) => d.getTime() === todayStart.getTime(),
          (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1),
          (org, region, start) => TrendCache.getDay(org, region, start),
          (org, region, start, count) => TrendCache.setDay(org, region, start, count),
          dayCounts, progress
        ),
        trendFetchAggregated(
          monthStarts, users,
          (m) => m.getTime() === thisMonthStart.getTime(),
          (m) => new Date(m.getFullYear(), m.getMonth() + 1, 1),
          (org, region, start) => TrendCache.getMonth(org, region, start),
          (org, region, start, count) => TrendCache.setMonth(org, region, start, count),
          monthCounts, progress
        ),
      ]);
    } catch (error) {
      if (seq !== TrendPage._seq) return;
      $("trend-loading").style.display = "none";
      showPageError(error, false); // token 过期 → 弹「登录已过期」，点确定回登录页
      return;
    }
    if (seq !== TrendPage._seq) return;
    TrendPage.dayData = dayStarts.map((date, i) => ({ date, count: dayCounts[i] }));
    TrendPage.monthData = monthStarts.map((monthStart, i) => ({ monthStart, count: monthCounts[i] }));
    TrendPage._showCharts(seq);
  },

  _showCharts(seq) {
    if (seq !== TrendPage._seq) return;
    $("trend-loading").style.display = "none";
    $("trend-content").style.display = "flex";
    TrendPage.renderDayChart();
    TrendPage.renderMonthChart();
  },

  renderDayChart() {
    const data = TrendPage.dayData;
    const sel = TrendPage.selectedDayIndex;
    const n = data.length;
    let html = trendLineChartSVG(data, sel);
    if (n > 0) {
      // x 轴标签：30 天全部展示，每天一个 MM/dd，百分比定位在刻度上（随 SVG 等比缩放）
      const dayW = 1264 / Math.max(n - 1, 1);
      const labels = data
        .map((d, i) => `<span class="trend-axis-label" style="left:${((i * dayW) / 1264 * 100).toFixed(2)}%">${_pad(d.date.getMonth() + 1)}/${_pad(d.date.getDate())}</span>`)
        .join("");
      html += `<div class="trend-xrow">${labels}</div>`;
    }
    $("trend-day-plot").innerHTML = html;
    const maxCount = n ? Math.max(...data.map((d) => d.count)) : 0;
    $("trend-day-ylabels").innerHTML = trendNiceTicks(maxCount).ticks
      .slice().reverse()
      .map((t) => `<span class="trend-axis-label">${formatCount(t)}</span>`)
      .join("");
    $("trend-day-hint").textContent =
      sel != null
        ? trendFormatArgs(Localized("analysis_selected_day_format"), trendFullDateLabel(data[sel].date), formatCount(data[sel].count))
        : Localized("analysis_day_hint");
  },

  renderMonthChart() {
    const data = TrendPage.monthData;
    const sel = TrendPage.selectedMonthIndex;
    let html = trendBarChartSVG(data, sel);
    if (data.length > 0) {
      // x 轴标签与柱子对齐：百分比定位在各柱中心（slot 中点，随 SVG 等比缩放）
      const slot = 1264 / data.length;
      const labels = data
        .map((d, i) => `<span class="trend-axis-label" style="left:${(((i * slot + slot / 2) / 1264) * 100).toFixed(2)}%">${trendFormatArgs(Localized("analysis_month_label_format"), _pad(d.monthStart.getMonth() + 1))}</span>`)
        .join("");
      html += `<div class="trend-xrow">${labels}</div>`;
    }
    $("trend-month-plot").innerHTML = html;
    const maxCount = data.length ? Math.max(...data.map((d) => d.count)) : 0;
    $("trend-month-ylabels").innerHTML = trendNiceTicks(maxCount).ticks
      .slice().reverse()
      .map((t) => `<span class="trend-axis-label">${formatCount(t)}</span>`)
      .join("");
    $("trend-month-hint").textContent =
      sel != null
        ? trendFormatArgs(
            Localized("analysis_selected_month_format"),
            `${data[sel].monthStart.getFullYear()}-${_pad(data[sel].monthStart.getMonth() + 1)}`,
            formatCount(data[sel].count)
          )
        : Localized("analysis_month_hint");
  },

  selectDayIndex(index) {
    if (index == null || !TrendPage.dayData.length) return;
    TrendPage.selectedDayIndex = Math.min(Math.max(index, 0), TrendPage.dayData.length - 1);
    TrendPage.renderDayChart();
  },

  selectMonthIndex(index) {
    if (index == null || !TrendPage.monthData.length) return;
    TrendPage.selectedMonthIndex = Math.min(Math.max(index, 0), TrendPage.monthData.length - 1);
    TrendPage.renderMonthChart();
  },

  /** 点击折线图 → 最近一天（iOS ChartOverlayView.handleTap 的 nearestDate） */
  _dayIndexFromEvent(ev) {
    try {
      const n = TrendPage.dayData.length;
      if (n < 2) return null;
      const rect = $("trend-day-plot").getBoundingClientRect();
      if (!rect || !rect.width) return null;
      return Math.round(((ev.clientX - rect.left) / rect.width) * (n - 1));
    } catch (e) {
      return null;
    }
  },

  /** 点击柱状图 → 最近月份（AnalysisMonthView nearestMonth） */
  _monthIndexFromEvent(ev) {
    try {
      const n = TrendPage.monthData.length;
      if (!n) return null;
      const rect = $("trend-month-plot").getBoundingClientRect();
      if (!rect || !rect.width) return null;
      return Math.floor(((ev.clientX - rect.left) / rect.width) * n);
    } catch (e) {
      return null;
    }
  },

  bind() {
    $("trend-back").addEventListener("click", () => Router.go("statistics"));
    $("trend-day-scroll").addEventListener("click", (ev) => {
      // 直接点中圆点时按 data-idx 精确选中；点空白区按 x 坐标取最近一天
      const hit = ev.target && ev.target.dataset ? ev.target.dataset.idx : undefined;
      const idx = hit != null && hit !== "" ? Number(hit) : TrendPage._dayIndexFromEvent(ev);
      if (idx != null) TrendPage.selectDayIndex(idx);
    });
    $("trend-month-plot").addEventListener("click", (ev) => {
      const hit = ev.target && ev.target.dataset ? ev.target.dataset.idx : undefined;
      const idx = hit != null && hit !== "" ? Number(hit) : TrendPage._monthIndexFromEvent(ev);
      if (idx != null) TrendPage.selectMonthIndex(idx);
    });
  },
};

const Router = {
  go(page) {
    AppState.currentPage = page;
    $$(".page").forEach((p) => p.classList.remove("active"));
    $(`page-${page}`).classList.add("active");
    window.scrollTo(0, 0);
    applyI18n(); // 静态文案（data-i18n）；JS 渲染的文案由各页 render() 负责
    if (page === "login") LoginPage.render();
    if (page === "list") ListPage.render();
    if (page === "detail") DetailPage.render();
    if (page === "statistics") StatisticsPage.render();
    if (page === "trend") TrendPage.render();
  },
};

(function init() {
  LoginPage.bind();
  ListPage.bind();
  DetailPage.bind();
  StatisticsPage.bind();
  TrendPage.bind();
  LanguageSwitcher.bind();
  LanguageSwitcher.render();
  applyI18n();
  LoginPage.render();

  // 网络状态（iOS: NWPathMonitor）
  window.addEventListener("online", () => (AppState.isNetworkAvailable = true));
  window.addEventListener("offline", () => (AppState.isNetworkAvailable = false));

  // 启动时若本地已有账号则直接进入列表（iOS: onAppear 中 isFirstCheck）
  const users = UserStorage.load();
  if (users.length > 0) {
    SharedUsers = users;
    Router.go("list");
    ListPage.onAppear();
  } else {
    Router.go("login");
  }
})();
