/* ============================================================================
 * api.js —— 与 iOS 端 APIClient.swift 完全一致
 *
 *  · 请求路径 / 方法 / URL 参数 / Body / 鉴权头 与 iOS 端逐字对应
 *  · 错误判定：响应体可解码为 ErrorResponse{Code,Message} 时视为接口错误，
 *    错误码 -1，消息为空时用 "发生错误：<Code>"（与 iOS 一致）
 *  · sendRequestWithTokenRefresh：**不自动续期** —— 会话失效（token 过期 / 401 /
 *    拿不到 token）直接抛给页面，由页面弹「登录已过期」并在点确定后回登录页；
 *    限流（429）与网络抖动（-1009）不算会话失效，不踢人。
 *  · getMeasurements 解码失败自动重试（最多 100 次，与 iOS 一致）
 *  · updateStudies 每个组织内最多 10 个并发（与 iOS TaskGroup 一致）
 *
 *  传输层：页面走「同源 /__proxy 中继优先」——本机由 node server.js 提供，
 *  线上（Vercel 等）由 api/proxy.js 经 /__proxy → /api/proxy 的 rewrite 提供。
 *  中继只做传输层转发 —— 请求 URL、参数、Header、Body 完全不变，因此接口行为与
 *  iOS 端一致；而浏览器直连每个业务请求还要额外付一次 CORS 预检（被拦时再回退重发），
 *  服务端看到的请求量是 iOS 的 2~3 倍，海外接口会因此触发 429 限流，
 *  故统一改用「同源单跳」对齐 iOS 的请求量。
 *  中继不可达（server.js 没在跑 / rewrite 没生效）会被记住 5 秒，期间不再逐请求去撞，
 *  报错文案也会按「本机 / 线上」分别点明处置办法。
 * ==========================================================================*/

const APIConfig = {
  timeoutInterval: 120, // URLRequest.timeoutInterval = 120
};

const SESSION_EXPIRED_CODES = ["INVALID_TOKEN", "UNAUTHORIZED", "TOKEN_EXPIRED"];

function _isSessionExpiredCode(code) {
  return typeof code === "string" && SESSION_EXPIRED_CODES.includes(code);
}

/* --------------------------------------------------------------- 传输层策略
 * iOS 端直连 https://api.prod.deepaffex.cn / https://api.as-east.deepaffex.ai。
 * 浏览器里能否直连取决于接口的 CORS 策略（实测：接口会回显请求的 Origin，
 * 所以 http(s) 页面可以直连；但 file:// 打开时 Origin 为 "null"，接口拒绝，
 * Safari 会报 "Load failed"）。
 * 本地中继 server.js / 线上 api/proxy.js 的 /__proxy 只做传输层转发，
 * URL / Query / Header / Body 原样透传。
 *
 * 为什么「中继优先」而不是「直连优先」：
 *   跨域直连的每个业务请求，浏览器都要先发一次 OPTIONS 预检（服务端把它计入
 *   限流），被拦时还要回退中继重发一次 —— 服务端看到的请求量是 iOS 的 2~3 倍。
 *   海外接口（api.as-east.deepaffex.ai）对突发很敏感，于是频繁 429
 *   「请求过于频繁」，而 iOS 用原生 URLSession 没有预检，从不触发。
 *   中继与页面同源：浏览器不发预检、不必回退，服务端每个业务请求只看到 1 次
 *   —— 与 iOS 完全一致。
 *
 * 策略：本机页面 / 线上页面 / file:// → 中继优先（同源单跳，请求量对齐 iOS）；
 *      本机用绝对地址指到 127.0.0.1:4173，线上用同源相对路径 /__proxy。
 *      仅在**传输层**失败（CORS / 连接失败 / 中继自身故障）时才换通道，
 *      接口自身返回的错误（401/400/429）绝不换通道。
 *
 * 中继不可用时的兜底（2026-09-18，为「本地不开中继也能用」而加）：
 *   · 回落跨域直连 → 每个业务请求额外带一次 OPTIONS 预检（接口没有
 *     Access-Control-Max-Age，预检结果不缓存），服务端命中数翻倍，
 *     因此对**有限流层的主机**把速率上限压到 _DIRECT_MODE_MAX_RATE；
 *     国内接口没有限流层，不压（详见 _hasRateLimitLayer）。
 *   · 传输层全失败 → 退避后整体重试（_TRANSPORT_RETRY_DELAYS），
 *     兜住「预检 429 导致业务请求被判死成 net::ERR_FAILED」这种一次性失败。
 *   实测：不开 server.js 海外 22.7s / 国内 8.9s，均能正常加载（原先海外 7s 直接报错）。
 */
const RelayConfig = {
  // server.js 默认端口；若用 node server.js 8080 起了别的端口，
  // 可用 ?relay=http://127.0.0.1:8080 覆盖
  base: (function () {
    try {
      if (typeof location !== "undefined" && location.search) {
        const override = new URLSearchParams(location.search).get("relay");
        if (override) return String(override).replace(/\/+$/, "");
      }
    } catch (e) {
      /* 忽略，用默认值 */
    }
    return "http://127.0.0.1:4173";
  })(),
};

function _isFileProtocol() {
  return typeof location !== "undefined" && location.protocol === "file:";
}
/**
 * 页面是否由本机服务提供（node server.js 起的 127.0.0.1 / localhost）。
 * 此时 `/__proxy` 与页面同源，可用「同源单跳」把请求量降到 iOS 水平。
 */
function _isLocalPage() {
  if (typeof location === "undefined") return false;
  try {
    const origin = location.origin;
    if (!origin || origin === "null" || origin.startsWith("file:")) return false;
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch (e) {
    return false;
  }
}
/**
 * 页面是否部署在线上环境（http(s) 且不是本机）。
 * 线上（Vercel / 任意反向代理）会把 /__proxy 转发到 api/proxy.js：
 * 中继与页面同源 → 用相对路径即可，既不发跨域预检，也不会有混合内容问题。
 */
function _isDeployedPage() {
  if (typeof location === "undefined" || _isFileProtocol()) return false;
  try {
    const origin = location.origin;
    if (!origin || origin === "null") return false;
    return !_isLocalPage();
  } catch (e) {
    return false;
  }
}
/** 页面是否正好由本地中继服务提供（此时用相对路径，避免混合内容拦截） */
function _servedByRelay() {
  if (typeof location === "undefined") return false;
  return location.origin === RelayConfig.base || location.origin === RelayConfig.base.replace("127.0.0.1", "localhost");
}
/** 中继请求该用同源相对路径，还是绝对地址 */
function _useRelativeRelay() {
  // 线上：/__proxy 与页面同源（vercel.json 的 rewrite / 反向代理），必须用相对路径
  if (_isDeployedPage()) return true;
  // 本机：只有页面正好由中继提供时才用相对路径；Live Preview 等其它端口要用绝对地址指到 4173
  return _servedByRelay();
}
function relayURL(absURL) {
  const path = `/__proxy?url=${encodeURIComponent(absURL)}`;
  return _useRelativeRelay() ? path : RelayConfig.base + path;
}
/** 中继的「人话地址」，用于报错文案与日志 */
function _relayLabel() {
  return _isDeployedPage() ? `${location.origin}/__proxy` : RelayConfig.base;
}
/** 按优先级返回候选传输地址 */
/**
 * 通道粘性缓存：接口 origin -> "direct" | "relay"。
 *
 * 为什么需要：浏览器里每个跨域请求都伴随一次 OPTIONS 预检，且直连被拦后
 * 回退中继等于同一请求发两遍 —— 测量接口按「每研究 × COMPLETE/PARTIAL ×
 * 10 并发」编排，请求量本就是 iOS 的 3 倍，直接触发海外接口限流（429），
 * 限流升级后连接被重置，表现就是「Load failed」。
 * 某域名一旦在传输层失败，后续请求直接走已验证可用的通道，把请求量降回 iOS 水平。
 */
const _transportCache = new Map();
/** 直连在传输层失败过的 origin：本次会话内粘住中继，避免通道来回翻转产生双份预检 */
const _relayLocked = new Set();

/* ------------------------------------------------- 中继不可达的「记忆」
 * 现场故障（2026-09-18）：页面不是 node server.js 提供的，4173 上没有任何监听。
 * 旧逻辑下每个业务请求都要先去撞一次这个死端口（实测一次列表刷新白撞 68 次），
 * 既拖慢一倍、又把真正的病因（中继没起）淹没在一堆传输失败里。
 *
 * 现在的规则：
 *   · 中继地址 fetch 直接抛错（server.js 没在跑）或返回 404（4173 被别的服务占了）
 *     → 判定「中继不可用」并记住 RELAY_RETRY_MS，期间所有请求不再去撞它；
 *   · 只是上游转发失败（502 PROXY_ERROR）不记 —— 那说明中继本身活着，
 *     逐请求回退直连即可，否则会把「上游抖动」误升级成「放弃中继」；
 *   · 超时后重新放行一次（自愈窗口）：先开页面后起 server.js 的用户，
 *     点刷新就能自动恢复正常，不必重开页面；
 *   · file:// 页面例外：它直连必失败（Origin: null），中继是唯一出路，永远保留。
 */
const RELAY_RETRY_MS = 5000;
const _relayHealth = { downUntil: 0, everFailed: false };

function _relayKnownDown() {
  return _relayHealth.downUntil > Date.now();
}
function _noteRelayDown(reason) {
  if (!_relayHealth.everFailed) {
    const advice = _isDeployedPage()
      ? `请检查部署是否包含 api/proxy.js，以及 vercel.json 里 /__proxy → /api/proxy 的 rewrite 是否生效。`
      : `请运行 node server.js 后刷新页面。`;
    console.warn(
      `[BillingWeb] 接口中继不可达（${_relayLabel()}${reason ? "：" + reason : ""}），` +
        `本次会话改为直连接口域名。${advice}`
    );
  }
  _relayHealth.downUntil = Date.now() + RELAY_RETRY_MS;
  _relayHealth.everFailed = true;
}
function _noteRelayUp() {
  _relayHealth.downUntil = 0;
  _relayHealth.everFailed = false;
}

function _channelOf(target) {
  return target.includes("/__proxy") ? "relay" : "direct";
}

function transportCandidates(absURL) {
  let origin = null;
  try {
    origin = new URL(absURL).origin;
  } catch (e) {
    /* 忽略，走默认顺序 */
  }
  // file://：Origin=null 必被接口拒绝 → 中继优先
  // 本机页面 / 线上部署页面：中继与页面同源（不发预检、服务端请求量 = iOS，见文件头说明）
  // 若线上没配 /__proxy（纯静态托管），第一次会 404 → 记「不可用」→ 自动降级直连，不会卡死
  const preferRelay = _isFileProtocol() || _isLocalPage() || _isDeployedPage();
  let base = preferRelay ? ["relay", "direct"] : ["direct", "relay"];
  // 中继已知不可用 → 本机/远程页面都别再逐请求去撞（file:// 除外，见上面注释）
  if (!_isFileProtocol() && _relayKnownDown()) base = base.filter((c) => c !== "relay");
  const locked = origin ? _relayLocked.has(origin) : false;
  const cached = origin ? _transportCache.get(origin) : null;
  // 中继优先场景只信任 relay 的缓存：direct 只是中继不可用时的临时退路，
  // 不能因为它成功过一次就把后续请求都拉回跨域直连（预检开销会重新出现）。
  const cachedUsable = !!cached && (!preferRelay || cached === "relay");
  let order;
  if (cachedUsable && base.includes(cached)) order = [cached, ...base.filter((c) => c !== cached)];
  else if (locked && base.includes("relay")) order = ["relay", "direct"];
  else order = base;
  return order.map((c) => (c === "relay" ? relayURL(absURL) : absURL));
}

/**
 * 中继自身的故障（不是上游接口的响应）。判据靠中继响应头 `X-Billing-Relay`
 * （由 api/_lib/proxy.js 写入，见 RELAY_HEADERS）：
 *   · 有标记 = 响应确实来自我们的中继 → 上游什么状态码都是正常透传
 *     （上游自己的 404/500 页面也是 HTML，绝不能误判成「中继不存在」），
 *     只有中继自己写出来的 502 PROXY_ERROR 才算「这次转发失败」；
 *   · 无标记 = 这个地址上根本不是我们的中继 —— 平台错误页（Vercel 404/504）、
 *     静态托管的 HTML 兜底页、4173 被别的服务占了、rewrite 没生效 ——
 *     一律按传输层失败处理，换通道重试。
 * 注意「中继地址根本没在跑」不会走到这里 —— 那是 fetch 直接抛错，走 `_noteRelayDown`。
 */
/** 响应体像不像「静态托管的 HTML 兜底页」 */
function _looksLikeHtmlFallback(text) {
  if (typeof text !== "string") return false;
  const head = text.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}
/** 读取中继标记头（测试桩没有 headers，视为无标记） */
function _relayMarker(resp) {
  try {
    return resp && resp.headers && typeof resp.headers.get === "function"
      ? resp.headers.get("x-billing-relay")
      : null;
  } catch (e) {
    return null;
  }
}
/** 是否值得「记成中继不可用」：没有标记就说明中继压根不在那儿 */
function _relayDownWorthy(marker) {
  return !marker;
}
function _isRelayFailure(status, text, marker) {
  if (marker) return status >= 500 && String(text || "").includes("PROXY_ERROR");
  if (status === 404) return true;
  if (_looksLikeHtmlFallback(text)) return true;
  return status >= 500;
}

/* ------------------------------------------------------------ 限流自适应降速
 * 实测：海外接口（api.as-east.deepaffex.ai）返回
 *   x-ratelimit-limit: 5, 5;w=1  →  每秒 5 个请求（Istio/Envoy），国内接口无此限制。
 * 而列表页一次刷新要发「每研究 × COMPLETE/PARTIAL × 3 个口径」个请求
 * （15 个研究 ≈ 90 个），iOS 端同样的编排也一样会撞上 —— 区别只在于
 * iOS 遇到 429 空响应体会走「解码失败 → 重试 100 次」硬磨，最终把数据磨出来，
 * 而 Web 若直接报错就成了「反复提示请求过于频繁」。
 *
 * 做法（只影响「已经撞上 429」的场景，正常路径完全不变）：
 *   · 撞到 429 → 全局发送速率降到 4 请求/秒（低于接口的 5/s），再撞再降 3、2
 *   · 429 瞬间加一个短冷却，避免刚好在窗口边界继续撞
 *   · 连续成功若干次 → 速率逐级回升，最终恢复到不限速
 * 于是限流期间请求变成「慢而稳」地逐个通过，而不是整页失败。
 */
const _RATE_STEPS = [12, 4, 3, 2]; // penalty 0..3 对应的每秒请求数（12 ≈ 不限速）
/**
 * 跨域直连时的速率上限（见 `_noteCrossOriginDirect`）：
 * 直连时每个业务请求还额外带一次 OPTIONS 预检，服务端命中数是 2 倍，
 * 而闸门只按业务请求计数 —— 不限速等效于 24 次/秒 打一个 5 次/秒 的接口。
 */
const _DIRECT_MODE_MAX_RATE = 2;
/** 传输层全失败后的整体重试间隔（ms）；数组长度 = 最大重试次数 */
const _TRANSPORT_RETRY_DELAYS = [500, 1200];
const _throttle = {
  rate: _RATE_STEPS[0],
  cap: _RATE_STEPS[0], // 速率上限（跨域直连场景会被压到 _DIRECT_MODE_MAX_RATE）
  minRate: 2,
  // 初始令牌只给 2 个：一上来就放 12 个并发，在中继不可用（回落跨域直连）时
  // 会瞬间把限流撞爆 —— 每个请求还各带一次 OPTIONS 预检。补充速率 12/s 很快，正常场景无感。
  tokens: 2,
  lastRefill: Date.now(),
  inflight: 0,
  penalty: 0,
  streak: 0,
  cooldownUntil: 0,
  cooldownScale: 1, // 仅供测试压缩等待时长使用，生产恒为 1
};

/** 令牌桶：以不超过 _throttle.rate 的速率放行请求 */
async function _acquireSlot() {
  for (;;) {
    const now = Date.now();
    const elapsed = (now - _throttle.lastRefill) / 1000;
    if (elapsed > 0) {
      _throttle.tokens = Math.min(_throttle.rate, _throttle.tokens + elapsed * _throttle.rate);
      _throttle.lastRefill = now;
    }
    if (_throttle.tokens >= 1) {
      _throttle.tokens -= 1;
      _throttle.inflight += 1;
      return;
    }
    const needMs = ((1 - _throttle.tokens) / _throttle.rate) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(10, Math.ceil(needMs * _throttle.cooldownScale))));
  }
}
function _releaseSlot() {
  _throttle.inflight = Math.max(0, _throttle.inflight - 1);
}
/** 冷却期内先等一等再发，避免在限流窗口里继续加压 */
async function _respectCooldown() {
  const wait = _throttle.cooldownUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
/** 实际发送速率 = min(自适应档位, 场景上限) */
function _applyRate() {
  _throttle.rate = Math.min(_RATE_STEPS[_throttle.penalty], _throttle.cap);
}
/** 撞到限流：降速 + 短冷却（12 → 4 → 3 → 2 请求/秒；冷却 0.4s/0.8s/1.6s） */
function _noteRateLimited() {
  _throttle.penalty = Math.min(_throttle.penalty + 1, _RATE_STEPS.length - 1);
  _throttle.streak = 0;
  _applyRate();
  _throttle.tokens = Math.min(_throttle.tokens, 1); // 立即清掉积压令牌，马上开始降速
  _throttle.cooldownUntil =
    Date.now() + 400 * Math.pow(2, _throttle.penalty - 1) * _throttle.cooldownScale;
}
/** 正常响应：连续成功足够多后逐级恢复速率（但不会越过 _throttle.cap） */
function _noteSuccess() {
  if (_throttle.penalty === 0) return;
  _throttle.streak += 1;
  if (_throttle.streak >= 10) {
    _throttle.streak = 0;
    _throttle.penalty -= 1;
    _applyRate();
  }
}
/**
 * 进入「跨域直连」模式：把速率上限压到 _DIRECT_MODE_MAX_RATE。
 *
 * 现场故障（2026-09-18）：本机页面没开 server.js（中继不可用）→ 全部回落跨域直连，
 * 7 秒就整页报「无法连接接口服务」。抓到的现场是 5 次 429 **全打在 OPTIONS 预检上**，
 * 而预检被限流时浏览器会把业务请求直接判死（Chrome `net::ERR_FAILED` / Safari `Load failed`），
 * 单次传输失败又是致命错误 —— 于是整页报错。
 * 根因是预算算错了：跨域直连下一个业务请求 = 服务端 2 次命中（预检 + 业务），
 * 闸门却只按业务请求计数，12 req/s 实际是 24 次/秒。
 * 实测压到 2 req/s 后：24.9s 加载完成、429 仅 2 次、零失败。
 */
function _noteCrossOriginDirect(absURL) {
  if (_throttle.cap <= _DIRECT_MODE_MAX_RATE) return;
  _throttle.cap = _DIRECT_MODE_MAX_RATE;
  _applyRate();
  _throttle.tokens = Math.min(_throttle.tokens, 1); // 清掉积压令牌，立刻生效，不再第一波突发
  const advice = _isDeployedPage()
    ? "请确认部署里 /__proxy → api/proxy.js 的 rewrite 生效（同源中继没有预检开销）。"
    : "运行 node server.js 走本地中继可恢复全速。";
  console.warn(
    `[BillingWeb] 接口 ${_hostOf(absURL) || ""}为跨域直连（每个业务请求额外带一次 OPTIONS 预检，` +
      `服务端请求量翻倍），发送速率上限已压到 ${_DIRECT_MODE_MAX_RATE} req/s。${advice}`
  );
}
/** 该响应是不是「跨域直连」拿到的？同源（中继）没有预检开销，不压速 */
function _isCrossOriginDirect(channel, absURL) {
  if (channel !== "direct") return false;
  if (typeof location === "undefined" || _isFileProtocol()) return false;
  try {
    return new URL(absURL).origin !== location.origin;
  } catch (e) {
    return false;
  }
}
function _hostOf(absURL) {
  try {
    return new URL(absURL).hostname;
  } catch (e) {
    return null;
  }
}
/**
 * 这个接口主机是否装在限流层后面？（决定跨域直连时要不要压速）
 *
 * 实测 2026-09-18：
 *   · 海外 api.as-east.deepaffex.ai —— Envoy/Istio 后面，响应带
 *     `x-ratelimit-limit: 5, 5;w=1`（5 请求/秒），而且**没有 Access-Control-Max-Age**
 *     → 每个跨域请求都必带一次 OPTIONS 预检，突发一撞就 429；预检 429 时浏览器
 *     直接把业务请求判死（net::ERR_FAILED）。不压速实测 7 秒整页报错。
 *   · 国内 api.prod.deepaffex.cn —— 无 x-ratelimit-limit 头，12 req/s 突发也不出 429。
 *     对它压速纯属损失：实测不压 8.9s / 压了 29.7s。
 * 判据取自 model.js 的 Region（不在这里重复写死域名），并用**反向豁免**：
 * 判不出来或未知主机一律按「有限流」处理（保守）。
 */
function _hasRateLimitLayer(absURL) {
  const host = _hostOf(absURL);
  if (!host) return true;
  try {
    return host !== new URL(Region.host(Region.china)).hostname;
  } catch (e) {
    return true; // Region 取不到（理论上不会）→ 保守压速
  }
}

/**
 * 传输层全失败时的提示，给出可执行的排查方向。
 * `rounds` = 两条通道一共尝试了几轮（首轮 + _TRANSPORT_RETRY_DELAYS 的重试）。
 */
function _transportError(lastErr, rounds = 1) {
  const detail = lastErr?.message || "网络错误";
  let hint;
  if (_isFileProtocol()) {
    hint = `当前页面以 file:// 直接打开，接口不接受该来源（Origin: null）。请先运行 node server.js，再通过 ${RelayConfig.base}/ 访问页面。`;
  } else if (_isDeployedPage()) {
    hint = _relayHealth.everFailed
      ? `本站接口中转 ${_relayLabel()} 不可用。请确认部署包含 api/proxy.js，且 /__proxy → /api/proxy 的 rewrite 已生效（可在浏览器直接打开 ${_relayLabel()}?url=https%3A%2F%2Fapi.prod.deepaffex.cn 自查）。`
      : `接口域名不可达。请确认部署环境能访问接口域名（海外 api.as-east.deepaffex.ai / 国内 api.prod.deepaffex.cn），并确认中继本身可用（浏览器打开 ${_relayLabel()}?url=https%3A%2F%2Fapi.prod.deepaffex.cn 自查）。`;
  } else if (_relayHealth.everFailed) {
    // 中继尝试过且不可用 = 页面不是中继提供的 / server.js 没在跑。
    // 这才是本机使用场景下最可能的原因，直说，别让用户去猜网络。
    hint = `未检测到本地中继服务（${RelayConfig.base} 无响应）。请先在本项目目录运行 node server.js 并保持常驻，然后刷新页面——页面地址不用换（VS Code Live Preview 等本机地址均可，跨端口访问中继是允许的）。`;
  } else {
    hint = `请确认网络可访问接口域名；若浏览器直连被跨域策略拦截，可运行 node server.js 后重试（本地中继地址 ${RelayConfig.base}）。`;
  }
  const retryNote = rounds > 1 ? `（两条通道已自动重试 ${rounds - 1} 次）` : "";
  const err = new Error(`无法连接接口服务（${detail}）· ${hint}${retryNote}`);
  err.name = "NetworkError";
  err.code = -1009;
  return err;
}

function _buildURL(urlString, urlParameters) {
  const url = new URL(urlString);
  if (urlParameters) {
    for (const [key, value] of Object.entries(urlParameters)) {
      url.searchParams.append(key, `${value}`);
    }
  }
  return url.toString();
}

const APIClient = {
  /**
   * APIClient.request + sendRequest（async 版本）
   * GET 参数拼到 query，POST body 以 JSON 发送并带 Content-Type
   */
  async sendRequest({ urlString, method = "GET", urlParameters = null, body = null, headers = null }) {
    const url = _buildURL(urlString, method === "GET" ? urlParameters : null);
    const finalHeaders = {};
    if (headers) for (const [k, v] of Object.entries(headers)) finalHeaders[k] = v;
    let requestBody = null;
    if (method === "POST" && body) {
      finalHeaders["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    // 每次尝试都构造全新的 options 与超时信号（信号一旦 abort 就不能复用）
    const makeOptions = () => {
      const options = {
        method,
        headers: finalHeaders,
        credentials: "omit", // httpShouldHandleCookies = false
        cache: "no-store",
      };
      if (requestBody !== null) options.body = requestBody;
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        options.signal = AbortSignal.timeout(APIConfig.timeoutInterval * 1000);
      } else if (typeof AbortController !== "undefined") {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), APIConfig.timeoutInterval * 1000);
        options.signal = ac.signal;
      }
      return options;
    };

    // 限流自适应：冷却期内先等，并受全局并发闸门约束（见 _throttle 注释）
    await _respectCooldown();
    // 中继已判死、页面本该走同源中继 → 接下来全是跨域直连。
    // 该主机有限流层（海外）就提前压速，别让第一波再撞限流（见 _noteCrossOriginDirect）。
    if (_relayKnownDown() && (_isLocalPage() || _isDeployedPage()) && _hasRateLimitLayer(url)) {
      _noteCrossOriginDirect(url);
    }

    // 传输层失败自动换通道；两条通道都失败则整体退避重试（见 _TRANSPORT_RETRY_DELAYS）
    let response = null;
    let text = null;
    let lastErr = null;
    let usedChannel = null;
    let rounds = 0;
    for (;;) {
      await _acquireSlot();
      try {
        for (const target of transportCandidates(url)) {
          const channel = _channelOf(target);
          try {
            const r = await fetch(target, makeOptions());
            const t = await r.text();
            // 中继自身故障（中继不在那儿 / 转发上游失败）不是接口响应 → 换通道重试
            if (channel === "relay" && _isRelayFailure(r.status, t, _relayMarker(r))) {
              const marker = _relayMarker(r);
              // 没有我们的标记 = 这个地址上不是我们的中继 → 记下来，别再逐请求去撞；
              // 有标记（= 中继活着，只是这次转发上游失败）→ 不记，避免把上游抖动
              // 误升级成「放弃中继」（放弃后直连的请求量翻倍，反而更容易撞限流）。
              if (_relayDownWorthy(marker)) _noteRelayDown(`HTTP ${r.status}`);
              lastErr = new Error(`中继不可用（HTTP ${r.status}）`);
              continue;
            }
            if (channel === "relay") _noteRelayUp();
            response = r;
            text = t;
            usedChannel = channel;
            break;
          } catch (e) {
            lastErr = e;
            if (channel === "relay") {
              // 中继地址连不上 = node server.js 没在跑 → 记住，本会话不再逐请求去撞（见 _relayHealth 注释）
              _noteRelayDown(e?.message || "连接失败");
            } else {
              // 直连在传输层失败 → 该域名本次会话内粘住中继（见 _relayLocked 注释）
              try {
                _relayLocked.add(new URL(url).origin);
              } catch (e2) {
                /* 忽略 */
              }
            }
          }
        }
      } finally {
        _releaseSlot();
      }
      if (response) break;
      // 两条通道都失败 → 退避后再来一轮。
      // 跨域直连下最常见成因是「突发的 OPTIONS 预检撞上接口限流」：浏览器把业务请求
      // 判死成 net::ERR_FAILED，但等到冷却过后重试就能过（此时闸门已经降过速）。
      if (rounds >= _TRANSPORT_RETRY_DELAYS.length) throw _transportError(lastErr, rounds + 1);
      await new Promise((r) => setTimeout(r, _TRANSPORT_RETRY_DELAYS[rounds] * _throttle.cooldownScale));
      rounds += 1;
      await _respectCooldown();
    }
    // 跨域直连时压速（详见 _hasRateLimitLayer / _noteCrossOriginDirect）：
    //   · 已知有限流层的主机（海外）：立刻压，进入下一波前生效；
    //   · 其它主机（国内）平时不压 —— 但**一旦真的出现 429** 也压，
    //     防止限流层是后来才加上的（那时突发已经足以打垮整页）。
    if (
      _isCrossOriginDirect(usedChannel, url) &&
      (_hasRateLimitLayer(url) || response.status === 429)
    ) {
      _noteCrossOriginDirect(url);
    }
    // 记住该接口域名本次验证可用的通道（见 _transportCache 注释）
    try {
      _transportCache.set(new URL(url).origin, usedChannel);
    } catch (e) {
      /* 忽略 */
    }

    // 通道健康度：非限流的正常响应计入「连续成功」，足够多后逐步放宽并发
    if (response.status !== 429) _noteSuccess();

    // iOS：先尝试把响应当作 ErrorResponse 解码，成功即视为接口错误
    let decoded = null;
    try {
      decoded = JSON.parse(text);
    } catch (e) {
      decoded = null;
    }
    if (
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded) &&
      typeof decoded.Code === "string" &&
      typeof decoded.Message === "string"
    ) {
      let errorMsg = decoded.Message;
      if (!errorMsg) errorMsg = `发生错误：${decoded.Code}`;
      const err = new APIError(errorMsg, -1);
      err.apiCode = decoded.Code;
      if (_isSessionExpiredCode(decoded.Code)) err.isSessionExpired = true;
      throw err;
    }

    // 429 但响应体不是标准 {Code,Message}（实测海外接口限流时返回空体）：
    // 必须显式按接口错误抛出。若放行成 "No data"/DecodingError，
    // getMeasurements 的重试（最多 100 次）会放大成重试风暴 —— 浏览器端每个请求
    // 还伴随预检与中继回退，请求量是 iOS 的数倍，限流会升级到连接被重置，
    // 最终表现为直连与中继两条通道同时 "Load failed"（组织列表页数据加载失败）。
    if (response.status === 429) {
      _noteRateLimited(); // 收紧并发 + 冷却：后续请求自动降速，避免越重试越限流
      const err = new APIError(decoded?.Message || Localized("alert_rate_limited"), -1);
      err.apiCode = decoded?.Code || "TOO_MANY_REQUESTS";
      throw err;
    }

    // 401 但响应体不是标准 {Code,Message}：仍按会话失效处理，避免上层误走普通错误弹窗。
    if (response.status === 401) {
      const apiCode =
        decoded && typeof decoded === "object" && !Array.isArray(decoded) && typeof decoded.Code === "string"
          ? decoded.Code
          : "UNAUTHORIZED";
      const message =
        decoded && typeof decoded === "object" && !Array.isArray(decoded) && typeof decoded.Message === "string" && decoded.Message
          ? decoded.Message
          : "UNAUTHORIZED";
      const err = new APIError(message, -1);
      err.apiCode = apiCode;
      err.isSessionExpired = true;
      throw err;
    }
    if (text.length === 0) {
      throw new Error("No data");
    }
    return text;
  },

  /**
   * APIClient.sendRequestWithTokenRefresh
   *
   * ⚠️ 本版**不做自动续期**（按项目要求）：token 过期后不再静默重新登录，
   * 而是把「会话失效」直接抛给页面 → 弹「登录已过期」→ 点确定回登录页。
   *
   * 判定为会话失效（交页面处理）：
   *   · 接口 Code = INVALID_TOKEN / UNAUTHORIZED / TOKEN_EXPIRED
   *   · 响应是 401 但报文非标准 ErrorResponse（网关 HTML / 空体 / 缺字段）
   *   · authHeader 找不到该组织的授权 Token（code -4）
   * 不判定为会话失效，原样抛出（不踢人）：
   *   · 429 限流（TOO_MANY_REQUESTS）—— 瞬时状态，会话仍然有效
   *   · 传输层失败（NetworkError / 超时，code -1009）—— 网络抖动不该清掉登录态
   *
   * key 参数保留：与 iOS 调用签名一致（标识请求所属组织），本版不再用于续期。
   */
  async sendRequestWithTokenRefresh({ urlString, method = "GET", urlParameters = null, body = null, headers = null, key }) {
    try {
      return await this.sendRequest({ urlString, method, urlParameters, body, headers });
    } catch (error) {
      if (isSessionExpiredError(error)) error.isSessionExpired = true;
      throw error;
    }
  },

  /** APIClient.authHeader */
  authHeader(key) {
    const user = SharedUsers.find((u) => u.key === key);
    const token = user?.token ?? UserStorage.load().find((u) => u.key === key)?.token;
    if (!token) {
      const err = new Error("未找到对应组织的授权Token");
      err.code = -4;
      err.isSessionExpired = true; // 拿不到 token = 登录态已失效
      throw err;
    }
    return { Authorization: `Bearer ${token}` };
  },

  /* ------------------------------------------------------ APIClient.login */
  async login(email, password, org, region) {
    const body = {
      Email: email,
      Password: password,
      Identifier: org,
      TokenExpiresIn: 3600 * 24, // 与 iOS APIClient.swift:134 一致：一天
    };
    const data = await this.sendRequest({
      urlString: Region.host(region) + "/organizations/auth",
      method: "POST",
      urlParameters: null,
      body,
      headers: null,
    });
    try {
      const json = JSON.parse(data);
      if (typeof json?.Token !== "string") throw new Error("Token missing");
      return new LoginResponse(json);
    } catch (e) {
      throw new DecodingError(`登录响应解析失败: ${e.message}`);
    }
  },

  /* --------------------------------------------- GET /licenses/organization */
  async getLicences(orgName, region, limit) {
    const data = await this.sendRequestWithTokenRefresh({
      urlString: Region.host(region) + "/licenses/organization",
      method: "GET",
      urlParameters: { Limit: limit },
      body: null,
      headers: this.authHeader(orgName + Region.tag(region)),
      key: orgName + Region.tag(region),
    });
    try {
      const json = JSON.parse(data);
      if (!Array.isArray(json)) throw new Error("not an array");
      return json;
    } catch (e) {
      throw new DecodingError(`许可证列表解析失败: ${e.message}`);
    }
  },

  /* -------------------------------------------------------- GET /studies */
  async getStudies(orgName, region, limit) {
    const data = await this.sendRequestWithTokenRefresh({
      urlString: Region.host(region) + "/studies",
      method: "GET",
      urlParameters: { Limit: limit },
      body: null,
      headers: this.authHeader(orgName + Region.tag(region)),
      key: orgName + Region.tag(region),
    });
    try {
      const json = JSON.parse(data);
      if (!Array.isArray(json)) throw new Error("not an array");
      return json.map((item) => {
        if (typeof item?.ID !== "string" || typeof item?.Created !== "number") {
          throw new Error("StudyResponse 字段缺失");
        }
        return new StudyResponse(item);
      });
    } catch (e) {
      throw new DecodingError(`研究列表解析失败: ${e.message}`);
    }
  },

  /** APIClient.getStudies()：并发拉取全部组织的 studies */
  async getAllStudies() {
    const studiesDic = {};
    const errors = [];
    await Promise.all(
      SharedUsers.map(async (user) => {
        try {
          const studies = await this.getStudies(user.orgName, user.region, 25);
          studiesDic[user.orgName + Region.tag(user.region)] = studies;
        } catch (error) {
          errors.push(error);
        }
      })
    );
    if (errors.length) throw errors[0];
    return studiesDic;
  },

  /* --------------------------------- GET /organizations/measurements（带重试） */
  async getMeasurements(orgName, region, studyID, statusID = null, date = null, endDate = null) {
    return this._getMeasurementsWithRetry(orgName, region, studyID, statusID, date, endDate, 0);
  },

  async _getMeasurementsWithRetry(orgName, region, studyID, statusID, date, endDate, retryCount, rateLimitRetry = 0) {
    try {
      const urlParameters = { Limit: 1 };
      if (studyID != null) urlParameters.StudyID = studyID;
      if (date != null) urlParameters.Date = date;
      if (endDate != null) urlParameters.EndDate = endDate;
      if (statusID != null) urlParameters.StatusID = statusID;

      const data = await this.sendRequestWithTokenRefresh({
        urlString: Region.host(region) + "/organizations/measurements",
        method: "GET",
        urlParameters,
        body: null,
        headers: this.authHeader(orgName + Region.tag(region)),
        key: orgName + Region.tag(region),
      });
      let json;
      try {
        json = JSON.parse(data);
        if (!Array.isArray(json)) throw new Error("not an array");
      } catch (e) {
        throw new DecodingError(`测量数据解析失败: ${e.message}`);
      }
      return json;
    } catch (error) {
      // 429 限流：全局闸门已收紧并发并设了冷却（见 _throttle），这里直接重试即可 ——
      // 重试会先等冷却结束再发，形成「慢而稳」地逐个通过（GET 幂等）。
      // iOS 请求量低几乎不撞限流；浏览器端靠这一层把限流影响吸收掉，
      // 次数用尽仍失败才抛给页面提示，用户稍后刷新即可。
      if (error?.apiCode === "TOO_MANY_REQUESTS" && rateLimitRetry < 4) {
        return this._getMeasurementsWithRetry(
          orgName, region, studyID, statusID, date, endDate, retryCount, rateLimitRetry + 1
        );
      }
      // iOS：仅 DecodingError 会重试，最多 100 次。
      // Web 在此之上加防护性间隔：iOS 请求量小可以零间隔，浏览器端零间隔重试
      // 会触发接口限流升级（见 sendRequest 的 429 注释），最坏情况被连接重置。
      if (error instanceof DecodingError && retryCount < 100) {
        await new Promise((r) => setTimeout(r, Math.min(100 * (retryCount + 1), 500)));
        return this._getMeasurementsWithRetry(orgName, region, studyID, statusID, date, endDate, retryCount + 1);
      }
      throw error;
    }
  },

  /** APIClient.getMeasurementInfo：COMPLETE + PARTIAL 合计 */
  async getMeasurementInfo(orgName, region, studyID, date = null, endDate = null, progress = () => {}) {
    const completeMeasurements = await this.getMeasurements(orgName, region, studyID, "COMPLETE", date, endDate);
    progress();
    const partialMeasurements = await this.getMeasurements(orgName, region, studyID, "PARTIAL", date, endDate);
    progress();
    const completeCount = completeMeasurements[0]?.TotalCount ?? 0;
    const partialCount = partialMeasurements[0]?.TotalCount ?? 0;
    return new MeasurementInfo(orgName, studyID, completeCount + partialCount);
  },

  /**
   * APIClient.updateStudies
   * 依次处理每个组织；组织内最多 10 个并发任务（与 iOS TaskGroup 一致），
   * 每完成一个补一个新的，结果写入 study.totalSuccessMeasurements
   */
  async updateStudies(studyDic, billingDateDic = null, startDate = null, endDate = null, progress = () => {}) {
    let dateStr = null;
    let endDateStr = null;
    if (startDate) dateStr = toUTCString(startDate);
    if (endDate) endDateStr = toUTCString(endDate);

    for (const key of Object.keys(studyDic)) {
      const studies = studyDic[key];
      // Swift：var updatedStudies = studies 是值拷贝，结果只写进这份拷贝，
      // 调用方通过 studyDic 读回结果；这里用 clone() 还原该语义，
      // 避免直接改写调用方仍在使用的 study 对象（列表页/详情页共享引用）。
      const updatedStudies = studies.map((s) => s.clone());
      const user = SharedUsers.find((u) => u.key === key);
      const startDateStr = billingDateDic?.[key] ? toUTCString(billingDateDic[key]) : dateStr;
      const region = user?.region ?? Region.china;
      const orgName = user?.orgName ?? "";

      const results = new Array(studies.length).fill(undefined);
      let nextIndex = 0;
      const MAX_CONCURRENCY = 10;

      const runOne = async (index) => {
        const study = studies[index];
        try {
          const info = await this.getMeasurementInfo(orgName, region, study.ID, startDateStr, endDateStr, progress);
          results[index] = info.successCount;
        } catch (e) {
          results[index] = undefined;
          throw e;
        }
      };
      const worker = async () => {
        while (nextIndex < studies.length) {
          const index = nextIndex++;
          await runOne(index);
        }
      };
      const workers = [];
      for (let i = 0; i < Math.min(MAX_CONCURRENCY, studies.length); i++) workers.push(worker());
      await Promise.all(workers);

      results.forEach((count, index) => {
        if (count != null) updatedStudies[index].totalSuccessMeasurements = count;
      });
      studyDic[key] = updatedStudies;
    }
  },
};
