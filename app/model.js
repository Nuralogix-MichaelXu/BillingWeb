/* ============================================================================
 * model.js —— 与 iOS 端 Model.swift / Common.swift / 1-LoginView.swift 一一对应
 * 所有计算属性、格式化方法、日期工具均按 Swift 原逻辑移植，保持完全一致
 * ==========================================================================*/

/* ---------------------------------------------------------------- Region */
const Region = {
  china: 0,
  international: 1,
  host(region) {
    return region === Region.china
      ? "https://api.prod.deepaffex.cn"
      : "https://api.as-east.deepaffex.ai";
  },
  name(region) {
    return region === Region.china
      ? Localized("region_china")
      : Localized("region_international");
  },
  tag(region) {
    return `${region}`;
  },
};

/* ------------------------------------------------ 本地化（zh-Hans / en） */
/**
 * 语言表：<语言代码> -> { key: 文案 }
 *
 * - zh-Hans 取自 AnuraHelper/zh-Hans.lproj/Localizable.strings
 * - en     取自 AnuraHelper/en.lproj/Localizable.strings（Web 未实现的「许可证表 /
 *          发送账单」页面文案不收录），并按 Web 现状覆盖两条：
 *            · analysis_month_title：iOS 仍写 6 个月，Web 已改为 12 个月
 *            · analysis_day_hint：Web 无横向滑动，措辞相应调整
 *            · measurement_count / measurement_cost：Web 是单行且带前导「·」，与 iOS 的
 *              「Measurement count:\n」不同，英文沿用 Web 的排版形态
 * - 另有一组 Web 专属 key（iOS 无对应文案）：app_title / settings / logout /
 *   org_list_title / back / back_to_list / back_to_statistics / chart_analysis /
 *   detail_edit_hint / account_info / account_info_email / account_info_region
 */
const LocalizedStrings = {
  "zh-Hans": {
    login_title: "请登录",
    login_mode_normal: "普通登录",
    login_mode_multi: "多账号登录",
    login_note: "· 请使用NuraLogix提供的管理员账号登录 ·",
    alert_title: "提示",
    network_unavailable: "网络不可用，请检查您的网络连接",
    alert_fill_all: "请填写完整信息",
    alert_fill_format: "请按指定的格式输入账号信息",
    login_failed: "登录失败",
    login_multi_input_tip: "请按标准格式输入账号相关信息：",
    login_multi_example:
      "格式如下，多账号请换行区分：\n组织名称 账号 密码 已充值金额 单价 计费日期 域名(0:国内,1:海外)\n\n如：\norg1 example1@gmail.com 123456 5000 0.8 2020.01.01 0\norg2 example2@gmail.com 123456 2000 1.0 2022.01.01 0\norg3 example3@gmail.com 123456 1000 1.2 2025.05.04 1",
    org_label: "组织名称",
    email_label: "电子邮箱",
    password_label: "密码",
    region_label: "地区",
    region_china: "国内",
    region_international: "海外",
    login_button: "登录",
    login_loading: "登录中",
    datefilter_none: "无",
    datefilter_all: "全部",
    datefilter_today: "今天",
    datefilter_yesterday: "昨天",
    datefilter_beforeYesterday: "前天",
    datefilter_thisWeek: "本周",
    datefilter_lastWeek: "上周",
    datefilter_thisMonth: "本月",
    datefilter_lastMonth: "上月",
    datefilter_halfYear: "近半年",
    datefilter_oneYear: "近一年",
    datefilter_custom: "自定义",
    org_name_label: "组织名称",
    study_count_label: "研究(个)",
    unit_price_label: "单价(元/次)",
    billing_cost_label: "账单费用(元)",
    balance_label: "余额(元)",
    period_time: "统计周期",
    period_success_label: "周期内成功测量(次)",
    period_cost_label: "周期内消费(元)",
    period_select: "周期选择:",
    start_time: "开始时间",
    end_time: "截止时间",
    reset: "重置",
    confirm: "确定",
    cancel: "取消",
    add_deposits: "追加金额",
    edit_deposits: "修改金额",
    select_start_time: "选择开始时间",
    select_end_time: "选择截止时间",
    until_now: "至今",
    loading: "加载中",
    refresh: "刷新",
    refreshing: "数据更新中，请稍后...",
    last_update_time: "上次更新时间: ",
    last_update_fail: "更新失败: ",
    alert_logout_confirm: "确定要退出登录吗?",
    /* token 过期：任何页面弹出后点「确定」即回登录页（见 app.js showSessionExpiredAlert） */
    alert_token_expired: "登录已过期",
    alert_token_expired_message: "登录状态已失效，请重新登录",
    alert_rate_limited: "请求过于频繁（接口限流），请稍后刷新重试",
    error_prefix: "错误：",
    account_info: "账号信息",
    account_info_email: "邮箱",
    account_info_region: "区域",
    close: "关闭",
    statistics_tab_custom_period: "自定义周期",
    statistics_tab_billing: "账单",
    statistics_total_prefix: "共计",
    statistics_30s_measurement: "30s测量",
    statistics_5s_measurement: "5s测量",
    statistics_all_measurement: "全部测量",
    statistics_company_name: "公司名称",
    measurement_count: "· 测量次数:  ",
    measurement_cost: "· 测量费用:  ",
    study_table_title: "研究表",
    created_date: "创建日期",
    study_name: "研究名称",
    status: "状态",
    period_success: "周期内测量(次)",
    period_cost: "周期费用(元)",
    success_count_label: "账单内测量(次)",
    study_id: "研究ID",
    summary_total: "合计",
    total_deposits_label: "总充值(元)",
    billing_date: "账单开始日期",
    send_bill: "发送账单",
    statistics_billing_title: "统计分析",
    study_status_active: "有效",
    study_status_deleted: "已删除",
    study_status_invalid: "无效",
    input_deposits_title: "编辑充值金额",
    input_deposits_placeholder: "请输入金额",
    input_unit_price_title: "编辑单价",
    input_unit_price_placeholder: "请输入单价",
    select_org_to_view_detail: "加载时间可能较长，请耐心等待...",
    bill_prefix: "NuraLogix账单",
    analysis_title_all: "全部",
    analysis_day_title: "30日测量趋势",
    analysis_month_title: "12个月测量趋势",
    analysis_selected_day_format: "已选中：%1$@，测量次数：%2$@",
    analysis_selected_month_format: "已选中：%1$@，测量次数：%2$@",
    analysis_day_hint: "点击折线图或圆点查看当天测量次数",
    analysis_month_hint: "点击柱子查看该月测量次数",
    analysis_month_label_format: "%@月",
    analysis_loading: "正在加载数据…",
    analysis_loading_tip: "首次加载数据可能会比较久，请耐心等待！",
    /* --- 以下为 Web 专属（iOS 无对应文案） --- */
    app_title: "BillingWeb · NuraLogix 计费系统",
    settings: "设置",
    logout: "退出登录",
    org_list_title: "组织列表",
    back: "返回",
    back_to_list: "返回列表",
    back_to_statistics: "返回统计分析",
    chart_analysis: "图表分析",
    detail_edit_hint: "单价与账单开始日期支持在线修改，点击字段旁的图标即可编辑",
  },
  en: {
    login_title: "Please Login",
    login_mode_normal: "Normal Login",
    login_mode_multi: "Multiple Login",
    login_note: "Please login with the administrator account provided by Nuralogix",
    alert_title: "Notice",
    network_unavailable: "Network unavailable. Please check your internet connection.",
    alert_fill_all: "Please fill in all information",
    alert_fill_format: "Please enter your account information in the specified format",
    login_failed: "Login Failed",
    login_multi_input_tip: "Please enter the account-related information \nin the standard format:",
    login_multi_example:
      "Format is as follows, please break lines to distinguish multiple accounts:\nOrganization Email Password Deposits UnitPrice BillingStartDate Region(0:china,1:Int.)\n\nFor example:\norg1 example1@gmail.com 123456 5000 0.8 2020.01.01 0\norg2 example2@gmail.com 123456 2000 1.0 2022.01.01 0\norg3 example3@gmail.com 123456 1000 1.2 2025.05.04 1",
    org_label: "Organization",
    email_label: "Email",
    password_label: "Password",
    region_label: "Region",
    region_china: "China",
    region_international: "Int.",
    login_button: "Login",
    login_loading: "Logging in",
    datefilter_none: "None",
    datefilter_all: "All",
    datefilter_today: "Today",
    datefilter_yesterday: "Yesterday",
    datefilter_beforeYesterday: "Day Before Yesterday",
    datefilter_thisWeek: "This Week",
    datefilter_lastWeek: "Last Week",
    datefilter_thisMonth: "This Month",
    datefilter_lastMonth: "Last Month",
    datefilter_halfYear: "Last Half Year",
    datefilter_oneYear: "Last Year",
    datefilter_custom: "Custom",
    org_name_label: "Organization",
    study_count_label: "Study(s)",
    unit_price_label: "Unit Price($)",
    billing_cost_label: "Billing Cost($)",
    balance_label: "Balance($)",
    period_time: "Time Period",
    period_success_label: "Success In Period(s)",
    period_cost_label: "Cost In Period($)",
    period_select: "Period:",
    start_time: "Start Time",
    end_time: "End Time",
    reset: "Reset",
    confirm: "Confirm",
    cancel: "Cancel",
    add_deposits: "Add Deposits",
    edit_deposits: "Edit Deposits",
    select_start_time: "Select Start Time",
    select_end_time: "Select End Time",
    until_now: "Until now",
    loading: "Loading",
    refresh: "Refresh",
    refreshing: "Updating data, please wait...",
    last_update_time: "Last update: ",
    last_update_fail: "Update fail: ",
    alert_logout_confirm: "Are you sure you want to log out?",
    /* Session expired: OK on any page returns to the login page */
    alert_token_expired: "Session Expired",
    alert_token_expired_message: "Your session has expired. Please sign in again.",
    alert_rate_limited: "Too many requests (rate limited). Please refresh and retry later.",
    error_prefix: "Error: ",
    account_info: "Account Info",
    account_info_email: "Email",
    account_info_region: "Region",
    close: "Close",
    statistics_tab_custom_period: "Custom Period",
    statistics_tab_billing: "Billing",
    statistics_total_prefix: "Total",
    statistics_30s_measurement: "30s Measurement",
    statistics_5s_measurement: "5s Measurement",
    statistics_all_measurement: "All Measurements",
    statistics_company_name: "Company Name",
    measurement_count: "· Measurement count:  ",
    measurement_cost: "· Measurement cost:  ",
    study_table_title: "Study",
    created_date: "Created Date",
    study_name: "Study Name",
    status: "Status",
    period_success: "Period Success(s)",
    period_cost: "Period Cost($)",
    success_count_label: "Total Success(s)",
    study_id: "Study ID",
    summary_total: "Total",
    total_deposits_label: "Total Deposits($)",
    billing_date: "Billing Start Date",
    send_bill: "Send Bill",
    statistics_billing_title: "Statistics",
    study_status_active: "Active",
    study_status_deleted: "Deleted",
    study_status_invalid: "Invalid",
    input_deposits_title: "Edit Deposits",
    input_deposits_placeholder: "Enter deposits amount",
    input_unit_price_title: "Edit Unit Price",
    input_unit_price_placeholder: "Enter unit price",
    select_org_to_view_detail: "Loading may take a while, please be patient...",
    bill_prefix: "NuraLogix Billing ",
    analysis_title_all: "All",
    analysis_day_title: "30-Day Trend",
    analysis_month_title: "12-Month Trend",
    analysis_selected_day_format: "Selected: %1$@, Measurements: %2$@",
    analysis_selected_month_format: "Selected: %1$@, Measurements: %2$@",
    analysis_day_hint: "Tap the line chart or a dot to see the measurements for a day.",
    analysis_month_hint: "Tap a bar to see the measurements for that month.",
    analysis_month_label_format: "%@",
    analysis_loading: "Loading data…",
    analysis_loading_tip: "The initial load may take a while. Please wait.",
    /* --- Web-only keys (no iOS counterpart) --- */
    app_title: "BillingWeb · NuraLogix Billing",
    settings: "Settings",
    logout: "Log out",
    org_list_title: "Organizations",
    back: "Back",
    back_to_list: "Back to list",
    back_to_statistics: "Back to statistics",
    chart_analysis: "Chart Analysis",
    detail_edit_hint:
      "Unit price and billing start date can be edited online. Tap the icon next to the field to edit.",
  },
};

/**
 * 语言清单。iOS 1-LoginView.swift:520 用 `["zh-Hans": "中文", "en": "Eglish"]` 字典 +
 * `keys.sorted()` 渲染，排序后即 en → zh-Hans，顺序保持一致。
 * ⚠️ iOS 里的英文名拼成了 "Eglish"（笔误），此处用正确拼写 "English"。
 */
const AppLanguages = [
  { code: "en", name: "English", flag: "us" },
  { code: "zh-Hans", name: "中文", flag: "cn" },
];

/** iOS LanguageManager.init：UserDefaults["AppLanguage"] 优先，否则看首选语言是否含 zh */
function initialAppLanguage() {
  let saved = null;
  try {
    saved = localStorage.getItem("AppLanguage");
  } catch (e) {
    saved = null;
  }
  if (saved && LocalizedStrings[saved]) return saved;
  const nav = String((typeof navigator !== "undefined" && navigator.language) || "");
  return nav.toLowerCase().includes("zh") ? "zh-Hans" : "en";
}

const LanguageManager = {
  currentLanguage: initialAppLanguage(),

  /** iOS LanguageManager.setLanguage：同时写 UserDefaults（Web → localStorage） */
  setLanguage(lang) {
    if (!LocalizedStrings[lang]) return;
    this.currentLanguage = lang;
    try {
      localStorage.setItem("AppLanguage", lang);
    } catch (e) {
      /* 无痕模式下 localStorage 不可写，忽略 */
    }
  },

  /** iOS：currentLanguage.contains("zh") */
  isCNLanguage() {
    return String(this.currentLanguage).includes("zh");
  },

  localizedString(key) {
    const table = LocalizedStrings[this.currentLanguage] || LocalizedStrings["zh-Hans"];
    return table[key] ?? LocalizedStrings["zh-Hans"][key] ?? key;
  },
};
function Localized(key) {
  return LanguageManager.localizedString(key);
}

/* ------------------------------------------------------------- 格式化函数 */
function _groupedFormatter(minFraction, maxFraction) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: minFraction,
    maximumFractionDigits: maxFraction,
    roundingMode: "halfExpand", // NumberFormatter.roundingMode = .halfUp
    useGrouping: true,
  });
}
const _fmtCount = _groupedFormatter(0, 0);
const _fmtAmount = _groupedFormatter(0, 2);
const _fmtUnitPrice = _groupedFormatter(1, 2);

function formatCount(value) {
  try {
    return _fmtCount.format(value);
  } catch (e) {
    return `${value}`;
  }
}
function formatAmount(value) {
  try {
    return _fmtAmount.format(value);
  } catch (e) {
    return `${value}`;
  }
}
function formatUnitPrice(value) {
  try {
    return _fmtUnitPrice.format(value);
  } catch (e) {
    return `${value}`;
  }
}
function encryptUUID(key) {
  if (key.length < 8) return key;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/* --------------------------------------------------------------- 日期工具 */
const kInitialStartDate = new Date(2020, 0, 1); // 2020-01-01

function _pad(n, len = 2) {
  return String(n).padStart(len, "0");
}
/** Common.swift: TimeInterval.toDateString() → yyyy-MM-dd（本地时区） */
function timeIntervalToDateString(seconds) {
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
}
/** Date.yyyyMMddDateString：中文 yyyy.MM.dd，英文 MM/dd/yyyy */
function yyyyMMddDateString(date) {
  if (LanguageManager.isCNLanguage()) {
    return `${date.getFullYear()}.${_pad(date.getMonth() + 1)}.${_pad(date.getDate())}`;
  }
  return `${_pad(date.getMonth() + 1)}/${_pad(date.getDate())}/${date.getFullYear()}`;
}
/** Date.yyyyMMddhhmmssDateString */
function yyyyMMddhhmmssDateString(date) {
  return (
    `${date.getFullYear()}${_pad(date.getMonth() + 1)}${_pad(date.getDate())}` +
    `${_pad(date.getHours())}${_pad(date.getMinutes())}${_pad(date.getSeconds())}`
  );
}
/** Date.yyyyMMddhhmmssDateString2 */
function yyyyMMddhhmmssDateString2(date) {
  return (
    `${date.getFullYear()}-${_pad(date.getMonth() + 1)}-${_pad(date.getDate())} ` +
    `${_pad(date.getHours())}:${_pad(date.getMinutes())}:${_pad(date.getSeconds())}`
  );
}
/** Date.toUTCString()：UTC 时区 "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" */
function toUTCString(date) {
  const ms = _pad(date.getUTCMilliseconds(), 3);
  return (
    `${date.getUTCFullYear()}-${_pad(date.getUTCMonth() + 1)}-${_pad(date.getUTCDate())}` +
    `T${_pad(date.getUTCHours())}:${_pad(date.getUTCMinutes())}:${_pad(date.getUTCSeconds())}.${ms}Z`
  );
}
/** String.dateFromYyyyMMddString（ICU DateFormatter "yyyy.MM.dd" / "MM/dd/yyyy" 语义） */
function dateFromYyyyMMddString(str) {
  const cn = LanguageManager.isCNLanguage();
  const m = (cn ? /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/ : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/).exec(
    String(str ?? "").trim()
  );
  if (!m) return null;
  // ICU 的 MM/dd 字段宽度是「最少位数」，所以 "2020.1.1" 也能解析（旧实现要求两位 → 会误判为非法）
  const y = Number(cn ? m[1] : m[3]);
  const mo = Number(cn ? m[2] : m[1]);
  const d = Number(cn ? m[3] : m[2]);
  // ICU 对越界月/日返回 nil，而 JS Date 会静默进位（2020.13.45 → 2021.02.14），
  // 这里做严格回读校验，保持与 iOS 一致（非法 → 回落 kInitialStartDate）。
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/* ----------------------------------------------------------- 业务数据模型 */
/** APIClient.swift: MeasurementInfo */
class MeasurementInfo {
  constructor(orgName, studyID, successCount) {
    this.orgName = orgName;
    this.studyID = studyID;
    this.successCount = successCount;
  }
}
/** Model.swift: LoginResponse */
class LoginResponse {
  constructor(json) {
    this.Token = json.Token;
    this.RefreshToken = json.RefreshToken;
  }
}
/** APIClient.swift: ErrorResponse */
class APIError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "APIError";
    this.code = code; // iOS 中 APIClient 层错误统一为 -1
  }
}
class DecodingError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecodingError";
  }
}

/* ------------------------------------------------- 会话失效（token 过期）
 * 判定依据来自真实接口实测（2026-09-17，support 组织）：
 *   · token 失效        → 401 {"Code":"INVALID_TOKEN","Message":"Invalid token"}
 *   · 未携带鉴权头      → 401 {"Code":"UNAUTHORIZED", "Message":"UNAUTHORIZED"}
 *   · 跨组织访问        → 403 {"Code":"RESTRICTED_ACCESS","Message":""}
 * 前两类表示「当前登录态已不可用」，只能回登录页重新登录；
 * 第三类是正常的越权提示，**不能**当成过期（否则会把用户误踢出登录态）。
 */
const SessionExpiredCodes = ["INVALID_TOKEN", "UNAUTHORIZED", "TOKEN_EXPIRED"];

/** 该错误是否表示「登录态已失效，需要重新登录」 */
function isSessionExpiredError(error) {
  if (!error) return false;
  if (error.isSessionExpired === true) return true;
  if (error.code === -4) return true; // APIClient.authHeader：找不到该组织的授权 Token
  return typeof error.apiCode === "string" && SessionExpiredCodes.includes(error.apiCode);
}

/** Model.swift: StudyResponse（含全部计算属性） */
class StudyResponse {
  constructor(json = {}) {
    this.Created = json.Created ?? 0;
    this.ID = json.ID ?? "";
    this.Name = json.Name ?? "";
    this.Description = json.Description ?? "";
    this.StatusID = json.StatusID ?? "";
    this.Measurements = json.Measurements ?? 0;
    // 以下为可变派生值（与 Swift 中 var 字段一致）
    this.TotalCount = json.TotalCount ?? null;
    this.totalSuccessMeasurements = json.totalSuccessMeasurements ?? null;
    this.periodSuccessMeasurements = json.periodSuccessMeasurements ?? null;
    this.billingSuccessMeasurements = json.billingSuccessMeasurements ?? null;
    this.periodBillingSuccessMeasurements = json.periodBillingSuccessMeasurements ?? null;
    this.isPerioContainBilling = json.isPerioContainBilling ?? null;
    this.unitPrice = json.unitPrice ?? null;
  }
  /** periodCost：周期内消费 */
  get periodCost() {
    if (this.periodSuccessMeasurements == null) return null;
    if (this.isPerioContainBilling === true) {
      return (this.unitPrice ?? 0) * (this.billingSuccessMeasurements ?? 0);
    }
    const periodSuccessMeasurements =
      this.periodBillingSuccessMeasurements ??
      this.periodSuccessMeasurements ??
      this.totalSuccessMeasurements ??
      0;
    return (this.unitPrice ?? 0) * Number(periodSuccessMeasurements);
  }
  /** billingCost：账单费用 */
  get billingCost() {
    return (
      (this.unitPrice ?? 0) *
      Number(this.billingSuccessMeasurements ?? this.totalSuccessMeasurements ?? 0)
    );
  }
  get statusString() {
    switch (this.StatusID) {
      case "ACTIVE":
        return Localized("study_status_active");
      case "DELETED":
        return Localized("study_status_deleted");
      default:
        return Localized("study_status_invalid");
    }
  }
  get createdDateString() {
    return timeIntervalToDateString(this.Created);
  }
  get encryptedKey() {
    return encryptUUID(this.ID);
  }
  reset() {
    this.TotalCount = 0;
    this.totalSuccessMeasurements = null;
    this.periodSuccessMeasurements = null;
    this.billingSuccessMeasurements = null;
    this.periodBillingSuccessMeasurements = null;
    this.isPerioContainBilling = null;
  }
  /**
   * 值拷贝（对应 Swift struct 的赋值语义）。
   * JS 里对象是引用，requestData 的 studies / studiesCopy / studiesCopy3 / studiesCopy4
   * 若共享同一批实例，reset() 与三路测量回写会互相污染；
   * Swift 中它们各自是独立副本，这里用 clone() 还原这一语义。
   */
  clone() {
    return new StudyResponse({
      Created: this.Created,
      ID: this.ID,
      Name: this.Name,
      Description: this.Description,
      StatusID: this.StatusID,
      Measurements: this.Measurements,
      TotalCount: this.TotalCount,
      totalSuccessMeasurements: this.totalSuccessMeasurements,
      periodSuccessMeasurements: this.periodSuccessMeasurements,
      billingSuccessMeasurements: this.billingSuccessMeasurements,
      periodBillingSuccessMeasurements: this.periodBillingSuccessMeasurements,
      isPerioContainBilling: this.isPerioContainBilling,
      unitPrice: this.unitPrice,
    });
  }
}

/** Model.swift: OrgInfo（含全部计算属性） */
class OrgInfo {
  constructor({
    key,
    region,
    name,
    successCount,
    totalDeposits,
    unitPrice,
    periodSuccess,
    billingDate,
    startDate,
    endDate,
    studies,
  }) {
    this.key = key;
    this.region = region;
    this.name = name;
    this.successCount = successCount;
    this.totalDeposits = totalDeposits;
    this.unitPrice = unitPrice;
    this.periodSuccess = periodSuccess; // Int? —— null 表示“无”周期
    this.billingDate = billingDate;
    this.startDate = startDate;
    this.endDate = endDate;
    this.studies = studies ?? [];
  }
  get studyCount() {
    return this.studies.length;
  }
  get balance() {
    return this.totalDeposits - this.billingCost;
  }
  get totalDepositsString() {
    return formatAmount(this.totalDeposits);
  }
  get billingSuccessMeasurements() {
    return this.studies.reduce(
      (acc, s) => acc + (s.billingSuccessMeasurements ?? s.totalSuccessMeasurements ?? 0),
      0
    );
  }
  get billingCost() {
    return this.studies.reduce((acc, s) => acc + s.billingCost, 0);
  }
  get periodCost() {
    if (this.periodSuccess == null) return null;
    return this.studies.reduce((acc, s) => acc + (s.periodCost ?? 0), 0);
  }
  get periodCostString() {
    return this.periodCost == null ? "-" : formatAmount(this.periodCost);
  }
  get periodSuccessString() {
    return this.periodSuccess == null ? "-" : formatCount(this.periodSuccess);
  }
  get billingCostString() {
    return formatAmount(this.billingCost);
  }
  get balanceString() {
    return formatAmount(this.balance);
  }
  /** balanceColor: !=0 时 正→绿 负→红，否则正文色（映射到 CSS 变量） */
  get balanceColor() {
    if (this.balance !== 0) {
      return this.balance > 0 ? "var(--green-text)" : "var(--red-text)";
    }
    return "var(--ink)";
  }
  get unitPriceString() {
    const prices = this.studies
      .map((s) => s.unitPrice ?? this.unitPrice)
      .filter((v) => v != null);
    const uniquePrices = Array.from(new Set(prices)).sort((a, b) => a - b);
    if (uniquePrices.length <= 1) {
      return formatUnitPrice(uniquePrices.length ? uniquePrices[0] : this.unitPrice);
    }
    return uniquePrices.slice(0, 5).map((v) => formatUnitPrice(v)).join("/");
  }
  get leftSuccessCount() {
    return Math.max(Math.trunc(this.balance / this.unitPrice), 0);
  }
  resetStudyUnitPrice() {
    for (const s of this.studies) s.unitPrice = this.unitPrice;
  }
}

/* ------------------------------------------------- 持久化（UserStorage） */
const UserStorage = {
  key: "userList",
  save(users) {
    try {
      localStorage.setItem(this.key, JSON.stringify(users));
    } catch (e) {
      /* 与 iOS try? 行为一致：静默失败 */
    }
  },
  load() {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(UserStorage._revive) : [];
    } catch (e) {
      return [];
    }
  },
  clear() {
    localStorage.removeItem(this.key);
  },
  _revive(u) {
    const x = { ...u };
    if (x.billingDate != null) x.billingDate = new Date(x.billingDate);
    if (x.customPeriodStartDate != null) x.customPeriodStartDate = new Date(x.customPeriodStartDate);
    if (x.customPeriodEndDate != null) x.customPeriodEndDate = new Date(x.customPeriodEndDate);
    return x;
  },
};

/** 1-LoginView.swift: var SharedUsers = [User]() */
var SharedUsers = [];

/** 构造 User（对应 Swift 的 User 初始化） */
function makeUser({
  key,
  orgName,
  email,
  password,
  region,
  deposits = 0,
  unitPrice = 1.0,
  billingDate = kInitialStartDate,
  token = null,
  period = null,
  customPeriodStartDate = null,
  customPeriodEndDate = null,
  studyUnitPrices = null,
}) {
  return {
    key: key ?? orgName + Region.tag(region),
    orgName,
    email,
    password,
    region,
    deposits,
    unitPrice,
    billingDate,
    period,
    customPeriodStartDate,
    customPeriodEndDate,
    studyUnitPrices,
    token,
  };
}
