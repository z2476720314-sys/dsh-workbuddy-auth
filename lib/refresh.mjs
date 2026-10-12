// WorkBuddy（CodeBuddy）刷新请求构造与响应解析。
// 纯函数：本模块自身不读盘、不发起网络请求，也不打印/记录任何 token。
import { CLIENT_USER_AGENT, CN_BACKEND, hostnameOf, refreshSourceForHost, resolveWorkBuddyOrigin } from './origins.mjs'
import { UPSTREAM_REJECTED_CODE } from './errors.mjs'

/** 刷新面路径（CN / Intl 同一个面，只有 origin 不同）。 */
export const REFRESH_PATH = '/v2/plugin/auth/token/refresh'
export const REFRESH_URL = `${CN_BACKEND}${REFRESH_PATH}`

/**
 * 地区无法确定（或与认证域冲突）时的固定错误。
 *
 * 为什么宁可抛错也不发请求：刷新会**不可逆地轮换** refresh token。把 Intl 的令牌发到 CN
 * 网关（或反过来）不但会失败，还可能让用户手上唯一可用的 refresh token 失效。
 */
export const REFRESH_ORIGIN_ERROR = 'refresh origin is not trusted'

/**
 * 刷新请求超时：30s。没有超时的话，一次「连接建立后永不返回」的请求会让
 * `syncCredential` 永远挂起 —— 首次同步永远不写 seam（模型调用报 MISSING_CREDENTIAL），
 * 定时器里的重入保护也会把后续所有 tick 一直挡在门外，且不会有任何日志。
 * 与 `scripts/workbuddy/verify-credential.mjs` 的只读探针保持同一取值。
 */
export const REFRESH_TIMEOUT_MS = 30_000

/**
 * 构造超时信号；运行时不提供 `AbortSignal.timeout` 时退化为「不设超时」（不抛错）。
 * @returns {AbortSignal|undefined}
 */
export function refreshTimeoutSignal(ms = REFRESH_TIMEOUT_MS) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

/**
 * CN 刷新头集：**实测可用，逐字节冻结**。
 *
 * 刷新会不可逆轮换 refresh token，所以这条已经验证通过的头集不允许被「顺手统一」成
 * Intl 那一套（多一个头就可能换一条上游分支）。
 */
function cnHeaders(record) {
  return {
    'Content-Type': 'application/json',
    'X-Refresh-Token': record.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
  }
}

/**
 * Intl 刷新头集（来自参考实现与实测）：CLI 身份 + 账号身份头 + 同源 origin/referer。
 *
 * Intl 网关按客户端身份放行——CodeBuddyIDE 的 UA 在 Intl chat 面被 401 拒，CLI 身份通过。
 *
 * @param {{refreshToken:string}} record
 * @param {{origin:string, authHost:string, uid?:unknown, domain?:unknown}} context
 */
function intlHeaders(record, context) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Refresh-Token': record.refreshToken,
    'X-Auth-Refresh-Source': refreshSourceForHost(context.authHost),
    'X-Domain': typeof context.domain === 'string' && context.domain !== '' ? context.domain : context.authHost,
    Origin: context.origin,
    Referer: `${context.origin}/`,
    'User-Agent': CLIENT_USER_AGENT,
  }
  if (typeof context.uid === 'string' && context.uid !== '') headers['X-User-Id'] = context.uid
  return headers
}

/**
 * 构造刷新请求（不打印任何机密）。
 *
 * `context` 缺省（或三个地区字段都为 undefined）时，走与改动前**逐字节一致**的 CN 请求；
 * 给了上下文则按地区选 origin 与头集，地区无法确定时抛 `REFRESH_ORIGIN_ERROR`。
 *
 * @param {{refreshToken:string}} record
 * @param {{region?:unknown, authHost?:unknown, apiOrigin?:unknown, uid?:unknown, domain?:unknown}} [context]
 * @returns {{url:string, init:{method:string, headers:Record<string,string>, body:string}}}
 */
export function buildRefreshRequest(record, context = {}) {
  if (!record || typeof record.refreshToken !== 'string' || record.refreshToken === '') {
    throw new Error('credential record is missing refreshToken')
  }
  const asked = context !== null && typeof context === 'object' ? context : {}
  const hasContext = asked.region !== undefined || asked.authHost !== undefined || asked.apiOrigin !== undefined
  if (!hasContext) {
    return { url: REFRESH_URL, init: { method: 'POST', headers: cnHeaders(record), body: '{}' } }
  }
  const origin = resolveWorkBuddyOrigin({ region: asked.region, authHost: asked.authHost, apiOrigin: asked.apiOrigin })
  if (origin === null) throw new Error(REFRESH_ORIGIN_ERROR)
  if (origin === CN_BACKEND) {
    return { url: `${origin}${REFRESH_PATH}`, init: { method: 'POST', headers: cnHeaders(record), body: '{}' } }
  }
  const authHost = hostnameOf(asked.authHost) || hostnameOf(origin)
  return {
    url: `${origin}${REFRESH_PATH}`,
    init: { method: 'POST', headers: intlHeaders(record, { origin, authHost, uid: asked.uid, domain: asked.domain }), body: '{}' },
  }
}

/**
 * 把「相对秒数」换算成绝对到期毫秒。
 *
 * 服务端用 0/非数字表达「本次响应没给」，此处一律映射为 undefined，
 * 以维持下游 mergeRefreshedRecord / needsRefresh 依赖的「undefined = 沿用旧值」语义
 * （若返回 NaN，mergeRefreshedRecord 的 `!== undefined` 守卫会把 NaN 写进凭据文件）。
 *
 * @param {unknown} value 相对秒数
 * @param {number} now 绝对毫秒基准
 * @returns {number|undefined}
 */
function relativeToAbsolute(value, now) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return now + seconds * 1000
}

/**
 * 解析刷新响应。
 *
 * 成功包络已实测确认（2026-09-11，真实刷新实验）：HTTP 200 `application/json`，
 * 形状为 `{ code, msg, requestId, data: {...} }`，`data` 含
 * `accessToken, expiresIn, refreshExpiresIn, refreshToken, tokenType, notBeforePolicy, sessionState, scope`。
 * 关键点：`data` 给的是**相对秒数** `expiresIn` / `refreshExpiresIn`，**没有** `expiresAt` /
 * `refreshExpiresAt` 这类绝对时间戳 —— 故此处用注入的 `now` 换算绝对到期毫秒；
 * 绝对字段若将来出现则优先。失败路径此前已实测（HTTP 401 + `code:12153`），非 2xx 由
 * refreshCredential 先行抛出。此处仍兼容平铺 `{ ... }` 形状；一旦取不到 accessToken
 * 就明确报错，绝不静默返回空令牌。
 *
 * @param {string} text 响应体原文
 * @param {number} [now] 换算相对秒数用的绝对毫秒基准（可注入，便于确定性测试）
 * @returns {{accessToken:string, refreshToken:string|undefined, expiresAt:number|undefined, refreshExpiresAt:number|undefined}}
 */
export function parseRefreshResponse(text, now = Date.now()) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('refresh response is not valid JSON')
  }
  const data = payload?.data ?? payload
  if (!data || typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw new Error('refresh response is missing data.accessToken')
  }
  const tok = data.accessToken
  return {
    accessToken: tok,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : undefined,
    // 绝对字段优先；缺失或不可用时退回相对秒数换算；两者都没有 → undefined（沿用旧值）。
    expiresAt: Number(data.expiresAt) || relativeToAbsolute(data.expiresIn, now),
    refreshExpiresAt: Number(data.refreshExpiresAt) || relativeToAbsolute(data.refreshExpiresIn, now),
  }
}

/**
 * 执行刷新。fetchImpl 必须可注入，测试一律传假实现，避免真实请求轮换 refresh token。
 *
 * 超时通过 `init.signal` 注入，而不是包一层 `Promise.race`：这样假 fetch 仍是「被调用一次
 * 并拿到完整 init」的原样契约（既有测试断言的 `init.headers` 与调用次数不受影响），
 * `signal` 只是 init 上多出来的一个字段。`buildRefreshRequest` 保持纯函数、不接触运行时全局量。
 *
 * @param {{refreshToken:string}} record
 * @param {typeof fetch} [fetchImpl]
 * @param {{timeoutMs?:number, context?:{region?:unknown,authHost?:unknown,apiOrigin?:unknown,uid?:unknown,domain?:unknown}}} [options]
 */
export async function refreshCredential(record, fetchImpl = fetch, options = {}) {
  const { url, init } = buildRefreshRequest(record, options.context ?? {})
  const signal = refreshTimeoutSignal(options.timeoutMs ?? REFRESH_TIMEOUT_MS)
  const res = await fetchImpl(url, signal === undefined ? init : { ...init, signal })
  if (!res.ok) {
    const error = new Error(`refresh failed: HTTP ${res.status}`)
    error.status = res.status
    // 401/403 = 上游明确拒绝这份凭据（登录态失效），与 5xx/超时等「服务端或网络故障」区分开：
    // 前者要引导用户重新登录/切账号，后者不该被指向凭据。分类只在这里做一次。
    if (res.status === 401 || res.status === 403) error.code = UPSTREAM_REJECTED_CODE
    throw error
  }
  const text = await res.text()
  return parseRefreshResponse(text)
}
