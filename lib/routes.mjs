// WorkBuddy 设置卡的 Host 路由（设计文档 §10.2 / §10.3）。
//
// 与设置卡客户端半区（后续任务）的契约：
//   GET  /api/dsh-workbuddy-auth/status              脱敏状态 DTO（同 buildStatus 的返回）
//   POST /api/dsh-workbuddy-auth/connection/test     发一次极小请求探测上游
//   POST /api/dsh-workbuddy-auth/credential/refresh  强制刷新一次（会轮换 refresh token）
//   POST /api/dsh-workbuddy-auth/credential/reload   重新读取凭据文件并同步到凭据 seam
//   GET  /api/dsh-workbuddy-auth/credentials/sources 列出可选的凭据来源（桌面文件 + 托管账号）
//   POST /api/dsh-workbuddy-auth/credentials/active  切换 active 来源
//   POST /api/dsh-workbuddy-auth/accounts/login      发起浏览器登录（body: {region:'cn'|'intl'}）
//   GET  /api/dsh-workbuddy-auth/accounts/login/status 只读登录进度/结果（脱敏 DTO）
//   POST /api/dsh-workbuddy-auth/checkin/settings    开/关自动签到（body: {enabled:boolean}）
//   POST /api/dsh-workbuddy-auth/checkin/now         手动触发一次签到（绕过开关与次数上限）
//
// 安全边界（本模块据此实现，改动时请一并维持）：
//   1. **任何响应体都不得含 accessToken / refreshToken 的值**——含错误路径。因此：
//      * /status 只经 `buildStatus` 产出（见 lib/status.mjs 的安全契约）；
//      * 动作类路由**只取白名单字段**（数字/布尔/短字符串），绝不 spread 依赖的返回值，
//        这样即使某个 deps 实现「脏」到把整条凭据记录返回上来，令牌也到不了浏览器；
//      * 登录两路由只回 `lib/web-login.mjs` 的 toDto（id/region/nickname/phoneMasked/uidTail）。
//   2. **所有路由都做两层请求来源校验**，且在触碰任何依赖之前返回 403：
//      * `Host` 必须严格是 loopback（127.0.0.1 / localhost / [::1]，端口任意）；
//      * 带 `Origin` 时，它的 host 必须与 `Host` 完全一致（端口不同也算跨源）。
//      GET /status 虽然不改状态，但它会返回昵称、手机号与 uid 尾号，因此与 POST 同等对待。
//
//      已知限制（设计文档 §10.3，**不要**为此引入新的认证机制）：这些 `kind:'exact'` 路由
//      匹配优先于平台 `/api` 前缀围栏，因此仍没有后者的浏览器会话 cookie。loopback Host
//      校验挡住 DNS rebinding，Origin/Host 校验挡住跨源浏览器请求；残余面仅为**同机进程**，
//      它们可以直接构造 loopback 请求读取 /status 或触发 /credential/refresh。
//   3. 错误统一 `{ ok:false, error }`，只回显**状态码与错误码**，绝不整段回显上游响应体
//      （响应体里可能夹带令牌或其它敏感信息），也绝不回显本地文件路径
//      （`ENOENT: … open 'C:\\synthetic-root\\…'` 会把用户目录带出去）。GET /status 同样走这道白名单。
//   4. webServer 是**可选**依赖：非 web 组合下不注册路由、打一行日志、绝不抛错。
import { credentialErrorHint } from './errors.mjs'
import { originForAuthHost, regionForAuthHost } from './origins.mjs'
import { buildStatus } from './status.mjs'
import {
  DISPLAY_DIAGNOSTIC_FIELDS,
  DISPLAY_REASONS,
  DISPLAY_TRACE_LIMIT,
  displayField,
} from './diagnostic-display.mjs'

/** 路由前缀（客户端半区必须与此一致）。 */
export const ROUTE_PREFIX = '/api/dsh-workbuddy-auth'

/** 路由的逐字路径（客户端半区必须与此一致）。 */
export const ROUTE_PATHS = {
  status: `${ROUTE_PREFIX}/status`,
  connectionTest: `${ROUTE_PREFIX}/connection/test`,
  credentialRefresh: `${ROUTE_PREFIX}/credential/refresh`,
  credentialReload: `${ROUTE_PREFIX}/credential/reload`,
  credentialSources: `${ROUTE_PREFIX}/credentials/sources`,
  credentialActive: `${ROUTE_PREFIX}/credentials/active`,
  login: `${ROUTE_PREFIX}/accounts/login`,
  loginStatus: `${ROUTE_PREFIX}/accounts/login/status`,
  checkinSettings: `${ROUTE_PREFIX}/checkin/settings`,
  checkinNow: `${ROUTE_PREFIX}/checkin/now`,
}

export const MODEL_ROUTE_PATHS = {
  models: `${ROUTE_PREFIX}/models`,
  modelsRefresh: `${ROUTE_PREFIX}/models/refresh`,
}

/**
 * 第二订阅点（智谱清言）的路由。
 *
 * 刻意**不复用** WorkBuddy 的路径名，而是统一挂在 `/agentmore` 子树下：两个上游的
 * 「凭据来源」「登录」「模型」是完全独立的域（不同存储文件、不同签名头、不同错误码），
 * 共用一组路径会让客户端不得不再用一个 query 参数区分，反而更容易串号。
 */
export const AGENTMORE_ROUTE_PREFIX = `${ROUTE_PREFIX}/agentmore`

export const AGENTMORE_ROUTE_PATHS = {
  status: `${AGENTMORE_ROUTE_PREFIX}/status`,
  login: `${AGENTMORE_ROUTE_PREFIX}/login`,
  loginStatus: `${AGENTMORE_ROUTE_PREFIX}/login/status`,
  loginCancel: `${AGENTMORE_ROUTE_PREFIX}/login/cancel`,
  accounts: `${AGENTMORE_ROUTE_PREFIX}/accounts`,
  accountActive: `${AGENTMORE_ROUTE_PREFIX}/accounts/active`,
  accountRemove: `${AGENTMORE_ROUTE_PREFIX}/accounts/remove`,
  credits: `${AGENTMORE_ROUTE_PREFIX}/credits`,
  models: `${AGENTMORE_ROUTE_PREFIX}/models`,
  modelsRefresh: `${AGENTMORE_ROUTE_PREFIX}/models/refresh`,
}

/** webServer 缺失时的降级日志（apply 与 registerRoutes 共用同一句，避免文案漂移）。 */
export const NO_WEB_SERVER_LOG =
  '[workbuddy-auth] webServer service is unavailable in this composition; the WorkBuddy settings routes are not registered (credential sync continues normally)'

/**
 * 本插件自身模块可能抛出的**固定、无令牌**的短消息白名单。
 * 只有它们允许被回显到响应体；其它任何 message（可能夹带上游原始响应体）一律替换成
 * 'request failed'。宁可少给信息，也不给出一条可能带令牌的错误行。
 */
const SAFE_ERROR_MESSAGES = new Set([
  'credential record is not valid JSON',
  'credential record is missing auth.accessToken',
  'credential record is missing refreshToken',
  'credential record is unreadable',
  'credential record is encrypted by the WorkBuddy desktop client',
  'refresh response is not valid JSON',
  'refresh response is missing data.accessToken',
  'refreshed record is missing accessToken',
  'upstream response is not a usable stream',
  'network request failed',
])

/** 展示字段长度上限。 */
const FIELD_MAX_LEN = 64

/**
 * 跨源判定：同源（或浏览器未带 Origin 的本地请求）放行，其余一律拒绝。
 * 只看 Origin 的 host 与 Host 头是否一致——端口不同也算跨源。
 * 与 `dsh-quit-button` 的判定同型（本插件不能跨包 import，故此处独立实现）。
 *
 * @param {Record<string, unknown>} [headers]
 * @returns {boolean}
 */
export function isCrossOrigin(headers) {
  const origin = headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = headers?.host
  if (typeof host !== 'string' || host === '') return true
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/**
 * Host 头是否严格指向受信任的 loopback 名称/地址。
 *
 * 只接受 127.0.0.1、localhost、[::1]，端口可省略或为任意有效十进制端口。
 * 不接受其它 127/8 地址、IPv4 数字别名或 localhost 子域，避免 DNS rebinding 页面把攻击者
 * 域名同时放进 Origin 与 Host 后绕过单纯的 Origin/Host 相等检查。
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isTrustedLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  const matched = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(host)
  if (matched === null) return false
  return matched[1] === undefined || Number(matched[1]) <= 65_535
}

/**
 * 读取可选的 webServer 服务。
 *
 * 优先走 `ctx.get('webServer')`：这是 Cordis 官方读取**未在 inject 中声明**的服务的方式，
 * 服务不存在时返回 undefined 而不是抛错。只有在 `get` 完全不存在的语境（最小假 ctx、
 * 非 Cordis 调用方）才退回读 `ctx.webServer` 属性——在真 Cordis ctx 上直接取未声明的
 * 服务属性会抛「cannot get property ... without inject」，所以顺序不能反。
 *
 * @param {any} ctx
 * @returns {any} webServer 服务，或 undefined
 */
export function resolveWebServer(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') return ctx.get('webServer')
  return ctx.webServer
}

/** 统一响应：JSON + 显式 charset，且禁止缓存（响应体含账号脱敏信息）。 */
function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

/** 有限数字则原样返回，否则 0（绝不把任意类型塞进响应体）。 */
function numberOr0(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 余额投影：非数值一律 `null`，**不是 0**。
 *
 * 必须显式挡掉 null / undefined / 空串：`Number(null) === 0`、`Number('') === 0`，
 * 直接用 `Number.isFinite(Number(x))` 会把「上游没给余额」投影成「积分 0」，
 * 设置卡上就成了用户真的用完了额度。
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** 正整数则原样返回，否则 0；用于上下文窗口/令牌上限这类「0 表示未知」的量。 */
function positiveOr0(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/** 正整数则原样返回，否则 null；用于「无覆盖」有独立语义的可选覆盖值。 */
function positiveOrNull(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 读取并解析 JSON 请求体；空体/坏 JSON 一律空对象（active 路由自行校验 id）。 */
function readJsonBody(req, strict = false) {
  return new Promise((resolve, reject) => {
    let oversized = false
    let text = ''
    // 全可选链：测试/内部调用方可能传入没有流接口的最小 req 对象。
    req?.setEncoding?.('utf8')
    req?.on?.('data', (chunk) => {
      if (strict && text.length + String(chunk).length > 4096) oversized = true
      if (text.length < 4096) text += chunk
    })
    req?.on?.('end', () => {
      try {
        if (oversized) throw badRequest('WORKBUDDY_MODELS_INVALID')
        resolve(JSON.parse(text))
      } catch {
        if (strict) reject(badRequest('WORKBUDDY_MODELS_INVALID'))
        else resolve({})
      }
    })
    req?.on?.('error', () => strict ? reject(badRequest('WORKBUDDY_MODELS_INVALID')) : resolve({}))
    // 没有任何流事件的最小对象：立即以空体完成，绝不让请求挂死。
    if (typeof req?.on !== 'function') resolve({})
  })
}

/** 字符串则截断返回，否则空串。 */
function stringOrEmpty(value) {
  return typeof value === 'string' ? value.slice(0, FIELD_MAX_LEN) : ''
}

/** 普通对象判定（数组与 null 都不算）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

/** 登录流程的合法状态集合。 */
const LOGIN_STATUSES = new Set(['idle', 'pending', 'complete', 'error'])
/** agentmore 登录状态机的合法取值（与 lib/agentmore-login.mjs 的 flow.status 同源）。 */
const AGENTMORE_LOGIN_STATUSES = new Set(['idle', 'running', 'complete', 'error', 'cancelled'])
/**
 * agentmore 的地区码。
 *
 * 只有 `cn` 一种：上游 agentmore.chatglm.cn 是单一 origin，不存在 WorkBuddy 那种
 * 国内/国际双后端。常量放这里是为了让 `/models` 的投影能给出与 WorkBuddy
 * 同名路由**同形**的 `region` 字段（客户端据此渲染地区文案而不必分支）。
 */
const AGENTMORE_REGION = 'cn'
/** 授权链接的最大回显长度。 */
const AUTH_URL_MAX_LEN = 2048
/** 托管账号 id 的形状（`managed:<库内 id>`；库内 id 是 UUID）。 */
const MANAGED_ID_PATTERN = /^managed:[A-Za-z0-9_-]{1,64}$/

/**
 * 签到摘要的浏览器可见投影：**逐字段白名单**，绝不 spread 服务返回值。
 *
 * 签到状态本身不含机密（只有开关、计数与时间戳），但投影仍是必需的：服务的 summary
 * 将来若把账号条目（含令牌）或凭据文件路径挂进来，这一层是唯一屏障。
 *
 * @param {unknown} value
 * @returns {object}
 */
function projectCheckin(value) {
  const source = isPlainObject(value) ? value : {}
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)
  return {
    enabled: source.enabled === true,
    totalAccounts: count(source.totalAccounts),
    doneToday: count(source.doneToday),
    skippedToday: count(source.skippedToday),
    failedToday: count(source.failedToday),
    lastRunAt: count(source.lastRunAt),
  }
}

/**
 * 登录结果的浏览器可见投影：**逐字段白名单**，绝不 spread 服务的返回值。
 *
 * 与动作类路由同一条理由：即使 lib/web-login.mjs 的实现将来变「脏」（例如把整条凭据记录
 * 挂进 DTO），令牌也到不了浏览器。授权链接在本层**独立**再做一次受信域校验：只放行
 * HTTPS 且 host 落在该地区认证域白名单内（地区与 host 的映射来自 lib/origins.mjs），
 * 挡掉 `javascript:` / `data:` 之类的协议混淆与「https 但不是 WorkBuddy 域」的链接。
 *
 * @param {unknown} value 服务返回的 DTO
 * @returns {object}
 */
/** 诊断字段白名单（与 lib/web-login.mjs 同源：规则本体在 lib/diagnostic-display.mjs，路由层是最后一道闸门）。 */
const LOGIN_DIAGNOSTIC_FIELDS = DISPLAY_DIAGNOSTIC_FIELDS
/** 允许出现的原因分类（未知取值一律丢弃，避免上游字符串被原样透出）。 */
const LOGIN_DIAGNOSTIC_REASONS = DISPLAY_REASONS
/** 轨迹事件上限（与 lib/web-login.mjs 的 TRACE_LIMIT 一致）。 */
const LOGIN_TRACE_LIMIT = DISPLAY_TRACE_LIMIT

/**
 * 诊断字段的二次投影：只留白名单键，且每个键都按 lib/diagnostic-display.mjs 的规则判
 * （域只认已知集合、阶段/错误名/业务码只认枚举、数值按 key 的范围），不合格就**丢字段**。
 *
 * 复用同一份规则不等于这一层多余：`projectLogin` 是客户端能看到的最终形状，少了这一层，
 * 服务侧攒下的失败原因会在最后一跳被静默丢掉；而少了白名单，一个夹带路径或手机号的
 * 「域 / 错误名 / 业务码」又会从诊断面漏出去。
 *
 * @param {unknown} value
 * @returns {object|undefined}
 */
function loginDiagnostic(value) {
  if (!isPlainObject(value)) return undefined
  const dto = {}
  if (LOGIN_DIAGNOSTIC_REASONS.has(value.reason)) dto.reason = value.reason
  for (const key of LOGIN_DIAGNOSTIC_FIELDS) {
    if (key === 'reason') continue
    const item = displayField(key, value[key])
    if (item !== undefined) dto[key] = item
  }
  return Object.keys(dto).length === 0 ? undefined : dto
}

function projectLogin(value) {
  const source = isPlainObject(value) ? value : {}
  const status = LOGIN_STATUSES.has(source.status) ? source.status : 'idle'
  const body = status === 'error' ? { ok: false, status, error: stringOrEmpty(source.error) } : { ok: true, status }
  const region = source.region === 'cn' || source.region === 'intl' ? source.region : undefined
  if (region !== undefined) body.region = region
  const authUrl = trustedAuthUrl(source.authUrl, region)
  if (authUrl !== '') body.authUrl = authUrl
  if (typeof source.progress === 'string') body.progress = source.progress.slice(0, 128)
  if (Number.isSafeInteger(source.startedAt)) body.startedAt = source.startedAt
  if (Number.isSafeInteger(source.completedAt)) body.completedAt = source.completedAt
  // 诊断在失败态与等待态都要出现：失败态回答「为什么失败」，等待态回答「还在等什么、
  // 上游回了几次、什么时候」——服务层在 pending 时就攒着实时轨迹，路由若在这一跳丢掉，
  // 客户端就只能干等 300 秒。成功态仍然不带任何上游细节，保持既有 DTO 形状不变。
  if (status === 'error' || status === 'pending') {
    const detail = loginDiagnostic(source.detail)
    if (typeof detail?.reason === 'string') body.reason = detail.reason
    if (detail !== undefined) body.detail = detail
    if (Array.isArray(source.trace)) {
      const trace = source.trace.slice(-LOGIN_TRACE_LIMIT).map((event) => loginDiagnostic(event)).filter((event) => event !== undefined)
      if (trace.length > 0) body.trace = trace
    }
  }
  if (isPlainObject(source.account)) {
    const account = {
      id: stringOrEmpty(source.account.id).slice(0, 128),
      region: source.account.region === 'intl' ? 'intl' : 'cn',
      nickname: stringOrEmpty(source.account.nickname),
      phoneMasked: stringOrEmpty(source.account.phoneMasked),
      uidTail: stringOrEmpty(source.account.uidTail),
    }
    // sourceId 必须与目录/激活接口的 id 形状一致，否则设置卡会拿它去激活一个「未知来源」。
    // 注意：这里**不能**走 stringOrEmpty（它按 FIELD_MAX_LEN 截断），否则超长 id 会被静默
    // 截成「看起来合法」的 id——先按原始值校验形状，再原样放行。
    const sourceId = typeof source.account.sourceId === 'string' ? source.account.sourceId : ''
    if (MANAGED_ID_PATTERN.test(sourceId)) account.sourceId = sourceId
    body.account = account
  }
  return body
}

/**
 * 授权链接的受信域校验（本层独立于 lib/web-login.mjs 再挡一次）。
 *
 * @param {unknown} value
 * @param {'cn'|'intl'|undefined} region 投影后的地区（缺省时按「地区未知」处理，直接拒绝）
 * @returns {string} 通过校验的链接，否则 ''
 */
function trustedAuthUrl(value, region) {
  if (typeof value !== 'string' || value === '' || region === undefined) return ''
  const candidate = value.slice(0, AUTH_URL_MAX_LEN)
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:') return ''
  if (regionForAuthHost(parsed.hostname) !== region) return ''
  return originForAuthHost(parsed.hostname) === null ? '' : candidate
}

/**
 * 把任意错误压成一行**可安全回显**的错误信息。
 *
 * 只允许三种来源：错误码（受限字符集）、HTTP 状态码（属性或消息里的 `HTTP <3位>`）、
 * 以及上面的固定消息白名单。其它一律 'request failed'——这样即使某个依赖把上游响应体
 * （可能含令牌）塞进了 error.message，也不会被回显到浏览器。
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const rawCode = error?.code
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(rawCode) ? rawCode : undefined
  let status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : undefined
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (status === undefined) {
    const matched = /\bHTTP (\d{3})\b/.exec(message)
    if (matched !== null) status = Number(matched[1])
  }

  const parts = []
  if (code !== undefined) parts.push(code)
  if (status !== undefined) parts.push(`HTTP ${status}`)
  if (parts.length === 0) parts.push(SAFE_ERROR_MESSAGES.has(message) ? message : 'request failed')
  return parts.join(' / ')
}

/**
 * 造一个「客户端输入错误」：`makeHandler` 会把它转成 **400**（而不是 500）。
 *
 * 只有显式带 `exposeStatus` 标记的错误才会改变 HTTP 状态码——上游/文件系统抛出的
 * 任何错误都不带这个标记，因此既有路由的 500 语义逐字不变（这一点由测试钉住）。
 *
 * @param {string} code 固定错误码（受限字符集，可直接回显）
 * @returns {Error & {status:number, exposeStatus:true}}
 */
function badRequest(code) {
  const error = /** @type {any} */ (new Error(code))
  error.code = code
  error.status = 400
  error.exposeStatus = true
  return error
}

/**
 * 造一个路由处理器：loopback Host 校验 → 方法校验 → Origin/Host 校验 → 执行 → 统一错误封套。
 *
 * `ok` 的语义按路由而异，客户端半区据此渲染：
 *   * /status            → 凭据可读；
 *   * /connection/test   → 上游可用（2xx 且回的是可用流）；
 *   * /credential/*      → 本次动作已完成（细节看 refreshed / throttled）。
 *
 * @param {{method:string, crossOriginGuard:boolean, run:(req:any) => Promise<object>}} spec
 */
function makeHandler(spec) {
  return async (req, res) => {
    // exact 路由绕过平台 /api 的 cookie 围栏：先把 Host 限死在 loopback，防止攻击者域名
    // 同时充当 Origin 与 Host 的 DNS rebinding 请求越过后面的相等检查。
    if (!isTrustedLoopbackHost(req.headers?.host)) {
      json(res, 403, { ok: false, error: 'untrusted host rejected' })
      return
    }
    if (!(Array.isArray(spec.method) ? spec.method.includes(req.method) : req.method === spec.method)) {
      json(res, 405, { ok: false, error: `method not allowed; use ${spec.method}` }, { allow: spec.method })
      return
    }
    if (spec.crossOriginGuard && isCrossOrigin(req.headers)) {
      json(res, 403, { ok: false, error: 'cross-origin request rejected' })
      return
    }
    // 本插件不读请求体；排空它以免半读的 POST 连接悬着（需要体的路由在 run 里自行读取）。
    if (spec.readsBody !== true) req.resume?.()
    try {
      json(res, 200, await spec.run(req))
    } catch (error) {
      // 错误可见性：默认只回错误码；DSH_WB_DEBUG=1 时在宿主 stdout 打出完整堆栈，
      // 便于排查（生产默认关闭；响应体仍走白名单，不回显堆栈）。
      if (process.env.DSH_WB_DEBUG === '1') console.error('[workbuddy-auth] route error:', error)
      const status = error?.exposeStatus === true && Number.isInteger(error.status) ? error.status : 500
      // hint 只来自 errors.mjs 的固定文案（永远不含令牌与本地路径）；不适用的错误不带该键，
      // 避免契约漂移（客户端按「有 hint 就用它当正文」处理）。
      const hint = credentialErrorHint(error)
      json(res, status, { ok: false, error: describeError(error), ...(hint === '' ? {} : { hint }) })
    }
  }
}

/**
 * agentmore 状态 DTO 的浏览器可见投影：**逐字段白名单**，绝不 spread。
 *
 * 状态里**可以**出现账号显示名、积分余额与模型元数据；
 * **绝不**出现 accessToken / refreshToken / deviceId / cookie。
 *
 * @param {unknown} value
 * @returns {object}
 */
function projectAgentmoreStatus(value) {
  const source = isPlainObject(value) ? value : {}
  const account = isPlainObject(source.account) ? source.account : null
  const credits = isPlainObject(source.credits) ? source.credits : {}
  const models = isPlainObject(source.models) ? source.models : {}
  return {
    ok: source.ok === true,
    loggedIn: source.loggedIn === true,
    ...(account === null ? {} : {
      account: {
        id: stringOrEmpty(account.id),
        displayName: stringOrEmpty(account.displayName),
        userId: stringOrEmpty(account.userId),
      },
    }),
    // credits / models 恒定存在：客户端据此直接读 `status.credits.remaining`，
    // 不必为「服务端这次没给」写一遍临时判断——那种判断迟早会和别处漂移。
    credits: {
      remaining: numberOrNull(credits.remaining),
      display: stringOrEmpty(credits.display),
    },
    models: {
      enabled: models.enabled === true,
      serving: models.serving === true,
      catalogSource: stringOrEmpty(models.catalogSource),
      catalogError: stringOrEmpty(models.catalogError),
      conflict: stringOrEmpty(models.conflict),
      enabledModelIds: Array.isArray(models.enabledModelIds) ? models.enabledModelIds.slice(0, 512).filter((id) => typeof id === 'string').map((id) => id.slice(0, 160)) : [],
      defaultReasoningEffort: typeof models.defaultReasoningEffort === 'string' ? models.defaultReasoningEffort.slice(0, 32) : null,
      list: Array.isArray(models.list) ? models.list.slice(0, 512).map((model) => ({
        id: stringOrEmpty(model?.id),
        name: stringOrEmpty(model?.name),
        contextWindow: positiveOr0(model?.contextWindow),
        maxContextWindow: positiveOr0(model?.maxContextWindow),
        effectiveContextWindow: positiveOr0(model?.effectiveContextWindow),
        reasoningEfforts: Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts.filter((effort) => typeof effort === 'string').slice(0, 16) : [],
        enabled: model?.enabled === true,
      })) : [],
    },
    ...(typeof source.error === 'string' && source.error !== '' ? { error: source.error.slice(0, FIELD_MAX_LEN) } : {}),
  }
}

/**
 * agentmore 登录 DTO 投影：只留状态机与账号显示信息。
 *
 * 与 `projectLogin` 的差别：这条流程**没有授权链接**（浏览器是我们自己起的，
 * 不需要把 URL 交给用户去点），因此这里不投影 authUrl。
 *
 * @param {unknown} value
 * @returns {object}
 */
function projectAgentmoreLogin(value) {
  const source = isPlainObject(value) ? value : {}
  const status = AGENTMORE_LOGIN_STATUSES.has(source.status) ? source.status : 'idle'
  const body = { ok: status !== 'error', status }
  if (status === 'error') body.error = stringOrEmpty(source.error)
  // 游客态：running 期间的**事实**，不是错误。客户端据此提示「还需要在窗口里登录」，
  // 否则用户只能盯着「等待登录完成…」猜到底卡在哪。
  if (source.guestPending === true) body.guestPending = true
  if (Number.isSafeInteger(source.startedAt)) body.startedAt = source.startedAt
  if (Number.isSafeInteger(source.completedAt)) body.completedAt = source.completedAt
  if (isPlainObject(source.account)) {
    body.account = {
      id: stringOrEmpty(source.account.id),
      displayName: stringOrEmpty(source.account.displayName),
      userId: stringOrEmpty(source.account.userId),
    }
  }
  return body
}

/**
 * agentmore 的 `/models` 投影：**扁平**契约，与 WorkBuddy 的同名路由逐字段同形。
 *
 * 为什么必须扁平而不是复用 `projectAgentmoreStatus` 的嵌套形状：
 * 客户端半区的 `ModelsPanel` / `normalizeModels` 是**一套**实现，读的是顶层的
 * `enabled` / `enabledModelIds` / `models`。若这里改成 `{models:{list:[…]}}`，
 * 就得在前端再写一份解析与一套取值路径 —— 两份解析必然会漂移，
 * 而漂移的表现是"模型列表空白但保存成功"，极难定位。
 *
 * 因此统一为：`/status` 里 `models` 是**状态摘要**（数组叫 `list`），
 * `/models` 与 `/models/refresh` 是**扁平模型契约**（数组叫 `models`）。
 *
 * @param {unknown} value
 * @returns {object}
 */
function projectAgentmoreModels(value) {
  const source = isPlainObject(value) ? value : {}
  const models = Array.isArray(source.models) ? source.models : []
  return {
    ok: source.ok === true,
    enabled: source.enabled === true,
    enabledModelIds: Array.isArray(source.enabledModelIds)
      ? source.enabledModelIds.slice(0, 512).filter((id) => typeof id === 'string').map((id) => id.slice(0, 160))
      : [],
    defaultReasoningEffort: typeof source.defaultReasoningEffort === 'string' ? source.defaultReasoningEffort.slice(0, 32) : null,
    contextWindowOverrides: isPlainObject(source.contextWindowOverrides)
      ? Object.fromEntries(Object.entries(source.contextWindowOverrides)
        .filter(([id, size]) => typeof id === 'string' && id.length <= 160 && Number.isSafeInteger(size) && size > 0)
        .slice(0, 512))
      : {},
    region: AGENTMORE_REGION,
    catalogSource: stringOrEmpty(source.catalogSource),
    catalogError: stringOrEmpty(source.catalogError),
    serving: source.serving === true,
    conflict: stringOrEmpty(source.conflict),
    models: models.slice(0, 512).map((model) => ({
      id: stringOrEmpty(model?.id),
      name: stringOrEmpty(model?.name),
      // 窗口与令牌上限必须是**正整数**：负数/0 在客户端会被当成「无限上下文」渲染，
      // 比显示 0 更危险（0 至少会被 UI 当成未知）。故一律用 positiveOr0。
      contextWindow: positiveOr0(model?.contextWindow),
      maxContextWindow: positiveOr0(model?.maxContextWindow),
      maxTokens: positiveOr0(model?.maxTokens),
      inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.filter((input) => input === 'text' || input === 'image').slice(0, 4) : [],
      reasoningEfforts: Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts.filter((effort) => typeof effort === 'string').slice(0, 16) : [],
      defaultReasoningEffort: typeof model?.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort.slice(0, 32) : null,
      enabled: model?.enabled === true,
      contextWindowOverride: positiveOrNull(model?.contextWindowOverride),
      effectiveContextWindow: positiveOr0(model?.effectiveContextWindow),
      effectiveReasoningEffort: typeof model?.effectiveReasoningEffort === 'string' ? model.effectiveReasoningEffort.slice(0, 32) : null,
    })),
  }
}

/**
 * agentmore 的 11 条路由。
 *
 * 与 WorkBuddy 侧同一道安全契约：全部 `crossOriginGuard`，全部只回白名单投影。
 * 差别只有一处——`/login` 的 **POST 会启动本机 Chromium**，因此额外要求
 * Host 是 loopback（`makeHandler` 已经做了）且不接受任何 URL/路径参数：
 * 浏览器可执行文件与 profile 目录都由服务端自己决定，客户端无从指定。
 *
 * @param {object} service `createAgentmoreService` 的返回值
 * @param {{now:() => number}} env
 * @returns {Array<[string, (req:any,res:any)=>Promise<void>]>}
 */
function agentmoreHandlers(service, { now }) {
  return [
    [
      AGENTMORE_ROUTE_PATHS.status,
      makeHandler({
        method: 'GET',
        // 状态含账号显示名与积分，跨源页面一律拒绝。
        crossOriginGuard: true,
        run: async () => projectAgentmoreStatus(await service.status()),
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.login,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        run: async () => projectAgentmoreLogin(await service.startLogin()),
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.loginStatus,
      makeHandler({
        method: 'GET',
        crossOriginGuard: true,
        run: async () => projectAgentmoreLogin(await service.loginStatus()),
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.loginCancel,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        run: async () => projectAgentmoreLogin(await service.cancelLogin()),
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.accounts,
      makeHandler({
        method: 'GET',
        crossOriginGuard: true,
        run: async () => {
          const list = await service.listAccounts()
          return {
            ok: true,
            accounts: (Array.isArray(list) ? list : []).slice(0, 64).map((account) => ({
              id: stringOrEmpty(account?.id),
              displayName: stringOrEmpty(account?.displayName),
              userId: stringOrEmpty(account?.userId),
              active: account?.active === true,
            })),
          }
        },
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.accountActive,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        readsBody: true,
        run: async (req) => {
          const body = await readJsonBody(req)
          const id = typeof body?.id === 'string' ? body.id.slice(0, 128) : ''
          if (id === '') throw badRequest('AGENTMORE_ACCOUNT_ID_REQUIRED')
          await service.activateAccount(id)
          return { ok: true, activeId: id }
        },
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.accountRemove,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        readsBody: true,
        run: async (req) => {
          const body = await readJsonBody(req)
          const id = typeof body?.id === 'string' ? body.id.slice(0, 128) : ''
          if (id === '') throw badRequest('AGENTMORE_ACCOUNT_ID_REQUIRED')
          await service.removeAccount(id)
          return { ok: true }
        },
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.credits,
      makeHandler({
        method: 'GET',
        crossOriginGuard: true,
        run: async () => {
          const credits = await service.credits()
          if (credits === null) return { ok: false, error: 'AGENTMORE_NOT_LOGGED_IN' }
          return { ok: true, credits: { remaining: numberOrNull(credits.remaining), display: stringOrEmpty(credits.display) } }
        },
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.models,
      makeHandler({
        method: ['GET', 'POST'],
        crossOriginGuard: true,
        readsBody: true,
        run: async (req) => projectAgentmoreModels(req.method === 'POST'
          ? await service.patchModels(await readJsonBody(req, true))
          : await service.models()),
      }),
    ],
    [
      AGENTMORE_ROUTE_PATHS.modelsRefresh,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        run: async () => projectAgentmoreModels(await service.refreshModels()),
      }),
    ],
  ]
}

/**
 * 注册 4 条路由并返回 disposer（供 `ctx.effect` 使用，卸载时摘除全部路由）。
 *
 * webServer 缺失（非 web 组合）时**降级**：打一行 info、返回 no-op disposer，绝不抛错——
 * 凭据同步与上游 UA 修复完全不依赖本函数。
 *
 * @param {any} ctx Cordis 上下文（只用到 `ctx.get` / `ctx.logger`）
 * @param {{
 *   readCredentialRaw: () => Promise<string>,
 *   testConnection: () => Promise<{status?:number,sseChunks?:boolean,model?:string}>,
 *   refreshNow: () => Promise<{refreshed?:boolean,throttled?:boolean,expiresAt?:number}>,
 *   reloadSeam: () => Promise<{refreshed?:boolean,throttled?:boolean,expiresAt?:number}>,
 *   listCredentialSources?: () => Promise<object>,
 *   activateCredentialSource?: (id: string) => Promise<object>,
 *   startLogin?: (region: string) => Promise<object>,
 *   loginStatus?: () => object,
 *   setCheckinEnabled?: (enabled: boolean) => Promise<object>,
 *   runCheckinNow?: () => Promise<object>,
 *   now?: () => number,
 *   userAgentFix?: boolean,
 *   upstreamHost?: string,
 * }} deps
 * @returns {() => void} disposer（webServer 缺失时是 no-op）
 */
export function registerRoutes(ctx, deps) {
  const server = resolveWebServer(ctx)
  if (server === undefined || typeof server.register !== 'function') {
    ctx?.logger?.info?.(NO_WEB_SERVER_LOG)
    return () => {}
  }

  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now())
  /** 动作类结果的共同形状：只取白名单字段，绝不 spread。 */
  const actionResult = (result) => ({
    ok: true,
    refreshed: result?.refreshed === true,
    throttled: result?.throttled === true,
    expiresAt: numberOr0(result?.expiresAt),
  })

  const handlers = [
    [
      ROUTE_PATHS.status,
      makeHandler({
        method: 'GET',
        // /status 也返回账号脱敏信息（昵称、手机号、uid 尾号），跨源页面一律拒绝。
        crossOriginGuard: true,
        run: async () => {
          let rawText
          let error
          try {
            rawText = await deps.readCredentialRaw()
          } catch (caught) {
            // M4：凭据读取失败时不能把原始 error 交给 buildStatus —— 它会取 error.message，
            // 而 Node 的 ENOENT/EPERM 消息里带**绝对本地路径**（`… open 'C:\synthetic-root\…'`），
            // 直接回显等于把用户目录交给浏览器。这里与 POST 路由走**同一道**白名单，
            // 先压成「错误码 / HTTP 状态码 / 固定消息」再往下传（describeError 只调用一次，
            // 它不幂等：二次处理会把 'ENOENT' 又降级成 'request failed'）。
            error = describeError(caught)
          }
          // buildStatus 自身产出的错误（凭据非 JSON、缺 accessToken 等）都在
          // SAFE_ERROR_MESSAGES 白名单里，因此这条路径不需要二次清洗。
          return buildStatus({
            rawText,
            now: now(),
            userAgentFix: deps.userAgentFix === true,
            upstreamHost: stringOrEmpty(deps.upstreamHost),
            error,
          })
        },
      }),
    ],
    [
      ROUTE_PATHS.connectionTest,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        run: async () => {
          const result = await deps.testConnection()
          const status = numberOr0(result?.status)
          return {
            ok: status >= 200 && status < 300 && result?.sseChunks === true,
            status,
            sseChunks: result?.sseChunks === true,
            model: stringOrEmpty(result?.model),
          }
        },
      }),
    ],
    [
      ROUTE_PATHS.credentialRefresh,
      makeHandler({ method: 'POST', crossOriginGuard: true, run: async () => actionResult(await deps.refreshNow()) }),
    ],
    [
      ROUTE_PATHS.credentialReload,
      makeHandler({ method: 'POST', crossOriginGuard: true, run: async () => actionResult(await deps.reloadSeam()) }),
    ],
    // 多账号路由：仅在 config.authDir 启用时由 index 注入依赖；未启用时返回明确降级。
    [
      ROUTE_PATHS.credentialSources,
      makeHandler({
        method: 'GET',
        crossOriginGuard: true,
        run: async () => {
          if (typeof deps.listCredentialSources !== 'function') return { ok: false, error: 'multi-account disabled' }
          return deps.listCredentialSources()
        },
      }),
    ],
    [
      ROUTE_PATHS.credentialActive,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        // 请求体由 run 里的 readJsonBody 读取；预排空会让 data 事件丢失。
        readsBody: true,
        run: async (req) => {
          if (typeof deps.activateCredentialSource !== 'function') return { ok: false, error: 'multi-account disabled' }
          const body = await readJsonBody(req)
          const id = typeof body?.id === 'string' ? body.id.slice(0, 64) : ''
          return deps.activateCredentialSource(id)
        },
      }),
    ],
    // 登录两条路由：地区白名单与授权 URL 校验都在 lib/web-login.mjs 内完成，
    // 这里只负责来源校验、读取 region 白名单字段与转发（返回值必须是脱敏 DTO）。
    [
      ROUTE_PATHS.login,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        readsBody: true,
        run: async (req) => {
          if (typeof deps.startLogin !== 'function') return { ok: false, error: 'multi-account disabled' }
          const body = await readJsonBody(req)
          // 只把短字符串交给服务；非法值由服务以 WORKBUDDY_LOGIN_REGION 拒绝（fail-closed）。
          const region = typeof body?.region === 'string' ? body.region.trim().toLowerCase().slice(0, 16) : ''
          return projectLogin(await deps.startLogin(region))
        },
      }),
    ],
    [
      ROUTE_PATHS.loginStatus,
      makeHandler({
        method: 'GET',
        // 登录状态含账号昵称/手机号/uid 尾号，与 /status 同级，同样拒绝跨源读取。
        crossOriginGuard: true,
        run: async () => {
          if (typeof deps.loginStatus !== 'function') return { ok: false, error: 'multi-account disabled' }
          return projectLogin(await deps.loginStatus())
        },
      }),
    ],
    // 签到两条路由：服务缺席（authDir 为空 / 非 Windows 之外的组合）时明确降级，
    // 绝不 500——设置卡据此渲染「签到不可用」，而不是一个没有解释的失败。
    [
      ROUTE_PATHS.checkinSettings,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        readsBody: true,
        run: async (req) => {
          if (typeof deps.setCheckinEnabled !== 'function') return { ok: false, error: 'checkin disabled' }
          const body = await readJsonBody(req)
          // 严格布尔：字符串 'true' / 1 / null 一律拒绝，避免「看起来像开了」的静默状态。
          if (typeof body?.enabled !== 'boolean') throw badRequest('CHECKIN_SETTINGS_INVALID')
          return { ok: true, checkin: projectCheckin(await deps.setCheckinEnabled(body.enabled)) }
        },
      }),
    ],
    [
      ROUTE_PATHS.checkinNow,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        run: async () => {
          if (typeof deps.runCheckinNow !== 'function') return { ok: false, error: 'checkin disabled' }
          // 手动轮次：服务内部排队执行（绕过开关与次数上限），这里只投影摘要。
          return { ok: true, checkin: projectCheckin(await deps.runCheckinNow()) }
        },
      }),
    ],
  ]

  if (deps.models) {
    const project = (state) => ({
      ok: state.ok === true, enabled: state.enabled === true,
      enabledModelIds: state.enabledModelIds, defaultReasoningEffort: state.defaultReasoningEffort,
      contextWindowOverrides: state.contextWindowOverrides, region: state.region,
      catalogSource: state.catalogSource, catalogError: state.catalogError,
      serving: state.serving === true, conflict: state.conflict,
      models: state.models.map((model) => Object.fromEntries(['id', 'name', 'contextWindow', 'maxContextWindow', 'maxTokens', 'inputModalities', 'reasoningEfforts', 'defaultReasoningEffort', 'enabled', 'contextWindowOverride', 'effectiveContextWindow', 'effectiveReasoningEffort'].map((key) => [key, model[key]]))),
    })
    handlers.push([MODEL_ROUTE_PATHS.models, makeHandler({ method: ['GET', 'POST'], crossOriginGuard: true, readsBody: true, run: async (req) => project(req.method === 'POST' ? await deps.models.patch(await readJsonBody(req, true)) : await deps.models.status()) })])
    handlers.push([MODEL_ROUTE_PATHS.modelsRefresh, makeHandler({ method: 'POST', crossOriginGuard: true, run: async () => project(await deps.models.refresh()) })])
  }

  if (deps.agentmore) handlers.push(...agentmoreHandlers(deps.agentmore, { now }))

  const disposers = handlers.map(([path, handler]) => server.register({ kind: 'exact', path, handler }))
  return () => {
    for (const dispose of disposers) {
      // 卸载路径不得因为某个 disposer 抛错而半途而废。
      try {
        dispose?.()
      } catch {
        /* 忽略：路由摘除失败不应阻断插件卸载 */
      }
    }
  }
}
