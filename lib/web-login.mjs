// Host 侧 WorkBuddy 浏览器登录（设计文档 §「登录和账号库」）。
//
// 职责边界：
//   * token 只在 Host 进程内流动。本模块产出的 DTO 只允许含 status / region / authUrl /
//     progress / startedAt / completedAt / error（安全错误码）与脱敏账号摘要
//     （id / region / nickname / phoneMasked / uidTail）——**永不**含 accessToken、
//     refreshToken、原始上游响应体或本地路径。
//   * 登录流为**单例**：新流程先 `cancel()` 旧流程（abort 在途请求、停轮询），旧流程的
//     任何迟到结果都不得改写新流程状态（每个流程持有自己的 flow 引用做身份判定）。
//   * 登录**只添加**账号：写入走 managed store 的 upsert，绝不调用 setActiveId，
//     也绝不触碰 DSH 凭据 seam——激活仍是设置卡里显式的独立动作。
//
// 协议事实（来自订阅插件的只读参考实现与对两个部署的实测）：
//   POST {backend}/v2/plugin/auth/state?platform=cli   body "{}"  → { code:0, data:{ state, authUrl } }
//   GET  {backend}/v2/plugin/auth/token?platform=cli&state=…      → code 11217 仍在等待；code 0 出凭据
//   GET  {backend}/v2/plugin/account（Bearer）                     → 账号资料（uid/昵称/uin）
// CN backend 固定 `https://copilot.tencent.com`；Intl 与其认证域同 apex（`https://www.workbuddy.ai`
// 或 `https://www.codebuddy.ai`）。
import { MANAGED_ID_PREFIX } from './managed-store.mjs'
import { CLIENT_USER_AGENT, CN_BACKEND, INTL_ORIGINS, originForAuthHost, regionForAuthHost } from './origins.mjs'

// 兼容既有导入面：地区的真正定义在 lib/origins.mjs（登录/刷新/推理共用同一份）。
export { CN_BACKEND, INTL_ORIGINS, regionForAuthHost }
export const apiOriginForAuthHost = originForAuthHost

/** 浏览器授权状态与凭据轮询面（与上游一致，不要改）。 */
export const LOGIN_STATE_PATH = '/v2/plugin/auth/state'
export const LOGIN_TOKEN_PATH = '/v2/plugin/auth/token'
export const ACCOUNT_PATH = '/v2/plugin/account'

/** 轮询节奏与总时长（设计文档：约 1.5 秒一次，最长 300 秒）。 */
export const LOGIN_POLL_INTERVAL_MS = 1500
export const LOGIN_TIMEOUT_MS = 300 * 1e3
/** 单个上游请求超时（state / token / account 共用）。 */
export const LOGIN_REQUEST_TIMEOUT_MS = 20 * 1e3

/** 上游网关按客户端身份放行，CLI 身份在两个地区都被接受（事实定义在 origins）。 */
const HEADER_DOMAIN = 'x-domain'
const HEADER_PRODUCT = 'x-product'
const HEADER_IDE_NAME = 'x-ide-name'
const HEADER_REQUESTED_WITH = 'x-requested-with'
const CLIENT_PRODUCT = 'SaaS'

/** 轮询等待码：授权尚未完成，不是错误。 */
const LOGIN_PENDING_CODE = 11217

/** 安全错误码（DTO 里只出现这些常量，绝不出现上游 msg / 响应体）。 */
export const LOGIN_ERRORS = {
  region: 'WORKBUDDY_LOGIN_REGION_INVALID',
  init: 'WORKBUDDY_LOGIN_INIT_FAILED',
  response: 'WORKBUDDY_LOGIN_RESPONSE_INVALID',
  authUrl: 'WORKBUDDY_LOGIN_AUTH_URL_INVALID',
  token: 'WORKBUDDY_LOGIN_TOKEN_MISSING',
  poll: 'WORKBUDDY_LOGIN_POLL_FAILED',
  store: 'WORKBUDDY_LOGIN_STORE_FAILED',
  timeout: 'WORKBUDDY_LOGIN_TIMEOUT',
}

const ID_TAIL = 4
const MAX_DISPLAY_LENGTH = 64

function loginError(code) {
  return Object.assign(new Error(code), { code })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 非空字符串（数字也接受，上游 uid/uin 有时是 number）。 */
function stringOf(record, key) {
  const value = record?.[key]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function numberOf(record, key) {
  const value = record?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * 校验浏览器授权 URL 并映射出后端 origin。
 *
 * 授权 URL 会交给用户的浏览器，因此**只**接受 HTTPS 且 host 落在该地区的认证域白名单内；
 * 地区不一致（例如 CN 流程拿到 Intl 授权页）同样拒绝。
 *
 * @param {unknown} authUrl
 * @param {'cn'|'intl'} region
 * @returns {string} 后端 origin
 */
export function validateAuthUrl(authUrl, region) {
  if (typeof authUrl !== 'string' || authUrl === '') throw loginError(LOGIN_ERRORS.authUrl)
  let parsed
  try {
    parsed = new URL(authUrl)
  } catch {
    throw loginError(LOGIN_ERRORS.authUrl)
  }
  if (parsed.protocol !== 'https:') throw loginError(LOGIN_ERRORS.authUrl)
  if (regionForAuthHost(parsed.hostname) !== region) throw loginError(LOGIN_ERRORS.authUrl)
  const origin = originForAuthHost(parsed.hostname)
  if (origin === null) throw loginError(LOGIN_ERRORS.authUrl)
  return origin
}

/**
 * 不验签地解出 access token 里陈述的身份事实。
 *
 * 这不是安全判定：claims 只用来给账号起名去重，令牌本身每次请求都由上游校验，
 * 伪造的 claim 最多让两个账号看起来一样，请求路径自会拒绝。非 JWT / 畸形令牌返回 {}
 * （不透明 access token 是合法形态，必须继续可用）。
 *
 * @param {unknown} accessToken
 * @returns {{uid?:string, nickname?:string, uin?:string, enterpriseId?:string}}
 */
export function identityFromAccessToken(accessToken) {
  if (typeof accessToken !== 'string') return {}
  const parts = accessToken.split('.')
  if (parts.length < 2 || parts[1] === '') return {}
  let claims
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (!isRecord(parsed)) return {}
    claims = parsed
  } catch {
    return {}
  }
  const identity = {}
  const uid = stringOf(claims, 'sub')
  const nickname = stringOf(claims, 'nickname') ?? stringOf(claims, 'preferred_username') ?? stringOf(claims, 'name')
  const uin = stringOf(claims, 'uin')
  const enterpriseId = stringOf(claims, 'enterprise_id') ?? stringOf(claims, 'enterpriseId') ?? stringOf(claims, 'tenant_id')
  if (uid !== undefined) identity.uid = uid
  if (nickname !== undefined) identity.nickname = nickname
  if (uin !== undefined) identity.uin = uin
  if (enterpriseId !== undefined) identity.enterpriseId = enterpriseId
  return identity
}

function tailOf(value, length) {
  if (typeof value !== 'string' || value === '') return ''
  return value.length <= length ? value : value.slice(-length)
}

/** flow → 浏览器可见 DTO：白名单字段，逐字段拷贝，绝不 spread 内部对象。 */
function toDto(flow) {
  const dto = { status: flow.status }
  if (typeof flow.region === 'string') dto.region = flow.region
  if (typeof flow.authUrl === 'string') dto.authUrl = flow.authUrl
  if (typeof flow.progress === 'string') dto.progress = flow.progress.slice(0, 128)
  if (Number.isSafeInteger(flow.startedAt)) dto.startedAt = flow.startedAt
  if (Number.isSafeInteger(flow.completedAt)) dto.completedAt = flow.completedAt
  if (typeof flow.error === 'string') dto.error = flow.error
  if (isRecord(flow.account)) {
    dto.account = {
      id: String(flow.account.id ?? '').slice(0, 256),
      region: flow.account.region === 'intl' ? 'intl' : 'cn',
      nickname: String(flow.account.nickname ?? '').slice(0, MAX_DISPLAY_LENGTH),
      phoneMasked: String(flow.account.phoneMasked ?? '').slice(0, MAX_DISPLAY_LENGTH),
      uidTail: tailOf(flow.account.uidTail, ID_TAIL),
    }
  }
  return dto
}

/**
 * 造一个登录服务。
 *
 * @param {{
 *   store: { upsert: (record:object) => Promise<object> },
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} deps
 */
export function createWebLoginService({ store, fetchImpl, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!isRecord(store) || typeof store.upsert !== 'function') throw loginError(LOGIN_ERRORS.store)
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch

  let flow = { status: 'idle' }
  let controller = null
  /** 在途的轮询等待：{ handle, resolve }，取消时立刻结算，让旧循环自行退出。 */
  let pending = null

  function requestSignal(active) {
    const timeout = AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS)
    return active === null ? timeout : AbortSignal.any([active.signal, timeout])
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const handle = setTimer(() => {
        pending = null
        resolve()
      }, ms)
      pending = { handle, resolve }
    })
  }

  function reset() {
    controller?.abort()
    controller = null
    if (pending !== null) {
      clearTimer?.(pending.handle)
      const { resolve } = pending
      pending = null
      resolve()
    }
    flow = { status: 'idle' }
  }

  /** 请求授权 state 与授权 URL。非 2xx / code≠0 / 缺字段一律安全错误码。 */
  async function requestLoginState(region, active) {
    const apiOrigin = region === 'intl' ? 'https://www.workbuddy.ai' : CN_BACKEND
    const domain = apiOrigin.replace('https://', '')
    let response
    try {
      response = await doFetch(`${apiOrigin}${LOGIN_STATE_PATH}?platform=cli`, {
        method: 'POST',
        headers: loginHeaders(domain),
        body: '{}',
        signal: requestSignal(active),
      })
    } catch {
      throw loginError(LOGIN_ERRORS.init)
    }
    const text = await response.text().catch(() => '')
    let root
    try {
      const parsed = JSON.parse(text)
      root = isRecord(parsed) ? parsed : undefined
    } catch {
      root = undefined
    }
    if (response.ok !== true || root?.code !== 0 || !isRecord(root.data)) throw loginError(LOGIN_ERRORS.init)
    const state = stringOf(root.data, 'state')
    const authUrl = stringOf(root.data, 'authUrl')
    if (state === undefined || authUrl === undefined) throw loginError(LOGIN_ERRORS.response)
    // 授权 URL 只做「交给用户浏览器」前的白名单校验；轮询仍打发起流程的那个 backend。
    validateAuthUrl(authUrl, region)
    return { state, authUrl, region, domain, backend: apiOrigin }
  }

  function loginHeaders(domain) {
    const intl = regionForAuthHost(domain) === 'intl'
    const backend = apiOriginForAuthHost(domain) ?? CN_BACKEND
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      [HEADER_DOMAIN]: domain,
      [HEADER_PRODUCT]: CLIENT_PRODUCT,
      [HEADER_IDE_NAME]: 'CodeBuddyIDE',
      [HEADER_REQUESTED_WITH]: 'XMLHttpRequest',
      'user-agent': CLIENT_USER_AGENT,
      ...(intl ? { origin: backend, referer: `${backend}/` } : {}),
    }
  }

  /** 轮询一次：null = 仍在等待；对象 = 凭据。 */
  async function pollLogin(attempt, active) {
    let response
    try {
      response = await doFetch(`${attempt.backend}${LOGIN_TOKEN_PATH}?platform=cli&state=${encodeURIComponent(attempt.state)}`, {
        headers: loginHeaders(attempt.domain),
        signal: requestSignal(active),
      })
    } catch {
      throw loginError(LOGIN_ERRORS.poll)
    }
    const text = await response.text().catch(() => '')
    if (response.ok !== true) throw loginError(LOGIN_ERRORS.poll)
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw loginError(LOGIN_ERRORS.response)
    }
    if (!isRecord(payload)) throw loginError(LOGIN_ERRORS.response)
    const code = numberOf(payload, 'code')
    if (code === LOGIN_PENDING_CODE) return null
    if (code !== 0) throw loginError(LOGIN_ERRORS.poll)
    return parseCredential(payload, attempt)
  }

  /** 解析登录成功的凭据（兼容 data/auth 两种包装）。 */
  function parseCredential(payload, attempt) {
    const data = isRecord(payload.data) ? payload.data : payload
    const auth = isRecord(data.auth) ? data.auth : data
    const tok = stringOf(auth, 'accessToken') ?? stringOf(auth, 'access_token') ?? stringOf(data, 'token')
    if (tok === undefined) throw loginError(LOGIN_ERRORS.token)
    const refreshToken =
      stringOf(auth, 'refreshToken') ?? stringOf(auth, 'refresh_token') ?? stringOf(data, 'refreshToken') ?? stringOf(data, 'refresh_token') ?? ''
    const expiresIn = numberOf(auth, 'expiresIn') ?? numberOf(auth, 'expires_in')
    const expiresAt = numberOf(auth, 'expiresAt') ?? numberOf(auth, 'expires_at') ?? now() + (expiresIn === undefined ? 3600 : expiresIn) * 1e3
    const refreshExpiresAt = numberOf(auth, 'refreshExpiresAt') ?? numberOf(auth, 'refresh_expires_at') ?? 0
    // 令牌自述的域必须与本次流程地区一致，否则 fail-closed（绝不把 Intl token 当 CN 账号入库）。
    const domain = stringOf(auth, 'domain') ?? stringOf(data, 'domain') ?? attempt.domain
    const apiOrigin = regionForAuthHost(domain) === attempt.region ? apiOriginForAuthHost(domain) : null
    if (apiOrigin === null) throw loginError(LOGIN_ERRORS.poll)
    return {
      accessToken: tok,
      refreshToken,
      expiresAt: Number.isSafeInteger(Math.trunc(expiresAt)) && expiresAt >= 0 ? Math.trunc(expiresAt) : now() + 3600 * 1e3,
      refreshExpiresAt: Number.isSafeInteger(Math.trunc(refreshExpiresAt)) && refreshExpiresAt >= 0 ? Math.trunc(refreshExpiresAt) : 0,
      region: attempt.region,
      apiOrigin,
      claims: identityFromAccessToken(tok),
      account: accountRecord(data),
    }
  }

  /** best-effort 读取账号资料：失败只回 {}，登录流程绝不因它失败。 */
  async function fetchAccountIdentity(credential, active) {
    try {
      const bearer = `Bearer ${credential.accessToken}`
      const response = await doFetch(`${credential.apiOrigin}${ACCOUNT_PATH}`, {
        headers: {
          ...loginHeaders(credential.apiOrigin.replace('https://', '')),
          authorization: bearer,
        },
        signal: requestSignal(active),
      })
      if (response.ok !== true) return {}
      const text = await response.text().catch(() => '')
      const parsed = JSON.parse(text)
      if (!isRecord(parsed)) return {}
      const data = isRecord(parsed.data) ? parsed.data : parsed
      const account = isRecord(data.account) ? data.account : data
      return accountRecord(account)
    } catch {
      return {}
    }
  }

  function accountRecord(source) {
    const account = isRecord(source?.account) ? source.account : source
    const record = {}
    const uid = stringOf(account, 'uid') ?? stringOf(source, 'uid')
    const nickname = stringOf(account, 'nickname') ?? stringOf(account, 'name') ?? stringOf(source, 'nickname')
    const uin = stringOf(account, 'uin') ?? stringOf(source, 'uin')
    const phone = stringOf(account, 'phoneNumber') ?? stringOf(account, 'phone') ?? stringOf(account, 'mobile')
    if (uid !== undefined) record.uid = uid
    if (nickname !== undefined) record.nickname = nickname
    if (uin !== undefined) record.uin = uin
    if (phone !== undefined) record.phoneMasked = maskPhone(phone)
    return record
  }

  /** 合并身份：token claims 先，其次登录响应自带的 account，最后 best-effort 账号资料补缺。 */
  async function resolveIdentity(credential, active) {
    const loginAccount = credential.account ?? {}
    const profile = await fetchAccountIdentity(credential, active)
    const claims = credential.claims
    const identity = {
      uid: claims.uid ?? loginAccount.uid ?? profile.uid ?? '',
      uin: claims.uin ?? loginAccount.uin ?? profile.uin ?? '',
      nickname: claims.nickname ?? loginAccount.nickname ?? profile.nickname ?? '',
      phoneMasked: loginAccount.phoneMasked ?? profile.phoneMasked ?? '',
    }
    return identity
  }

  /** 轮询循环：只在 flow 身份仍是自己时改写状态。 */
  async function pollLoop(myFlow, active, attempt) {
    const deadline = myFlow.startedAt + LOGIN_TIMEOUT_MS
    try {
      while (now() < deadline) {
        await sleep(LOGIN_POLL_INTERVAL_MS)
        if (active.signal.aborted || flow !== myFlow) return
        const credential = await pollLogin(attempt, active)
        if (flow !== myFlow) return
        if (credential === null) {
          myFlow.progress = `等待浏览器授权…（${Math.floor((now() - myFlow.startedAt) / 1000)} 秒）`
          continue
        }
        const identity = await resolveIdentity(credential, active)
        if (flow !== myFlow) return
        let saved
        try {
          const tok = credential.accessToken
          saved = await store.upsert({
            region: credential.region,
            uid: identity.uid,
            uin: identity.uin,
            displayName: identity.nickname,
            phoneMasked: identity.phoneMasked,
            accessToken: tok,
            refreshToken: credential.refreshToken,
            expiresAt: credential.expiresAt,
            refreshExpiresAt: credential.refreshExpiresAt,
            apiOrigin: credential.apiOrigin,
          })
        } catch (error) {
          if (flow !== myFlow) return
          const code = error?.code === 'MANAGED_ACCOUNT_IDENTITY_CONFLICT' ? error.code : LOGIN_ERRORS.store
          flow = errorFlow(myFlow, code)
          return
        }
        if (flow !== myFlow) return
        flow = {
          status: 'complete',
          region: credential.region,
          authUrl: myFlow.authUrl,
          progress: '授权完成',
          startedAt: myFlow.startedAt,
          completedAt: now(),
          account: {
            id: saved?.id,
            // sourceId 是**目录/激活接口认可的 id**（`managed:<库内 id>`）。登录只添加账号，
            // 设置卡要激活新账号必须用这个 id；只给库内 id 会让激活请求被判为未知来源。
            sourceId: typeof saved?.id === 'string' && saved.id !== '' ? `${MANAGED_ID_PREFIX}${saved.id}` : undefined,
            region: saved?.region,
            nickname: saved?.displayName,
            phoneMasked: saved?.phoneMasked,
            uidTail: tailOf(saved?.uid, ID_TAIL),
          },
        }
        return
      }
      if (flow === myFlow) flow = errorFlow(myFlow, LOGIN_ERRORS.timeout)
    } catch (error) {
      if (active.signal.aborted || flow !== myFlow) return
      flow = errorFlow(myFlow, typeof error?.code === 'string' ? error.code : LOGIN_ERRORS.poll)
    } finally {
      if (controller === active) controller = null
    }
  }

  function errorFlow(previous, code) {
    return {
      status: 'error',
      region: previous.region,
      authUrl: previous.authUrl,
      startedAt: previous.startedAt,
      completedAt: now(),
      error: code,
      progress: progressForError(code),
    }
  }

  return {
    /**
     * 启动一次登录（单例：新流程取代旧流程）。
     *
     * @param {unknown} region 'cn' | 'intl'
     * @returns {Promise<object>} 脱敏流程 DTO
     */
    async start(region) {
      if (region !== 'cn' && region !== 'intl') throw loginError(LOGIN_ERRORS.region)
      reset()
      const active = new AbortController()
      controller = active
      const myFlow = { status: 'pending', region, progress: '正在获取授权链接…', startedAt: now() }
      flow = myFlow
      let attempt
      try {
        attempt = await requestLoginState(region, active)
      } catch (error) {
        if (flow === myFlow) flow = errorFlow(myFlow, typeof error?.code === 'string' ? error.code : LOGIN_ERRORS.init)
        throw error
      }
      if (flow !== myFlow) return toDto(flow)
      myFlow.authUrl = attempt.authUrl
      myFlow.progress = '等待浏览器授权…'
      void pollLoop(myFlow, active, attempt)
      return toDto(myFlow)
    },
    /** 当前流程的脱敏状态（只读本地状态）。 */
    status() {
      return toDto(flow)
    },
    /** 停止在途流程（旧流程的任何迟到结果都不会再改写状态）。 */
    cancel() {
      reset()
      return toDto(flow)
    },
  }
}

/** 手机号脱敏展示（登录响应里的号码只在内存里过一遍，不落库明文）。 */
function maskPhone(value) {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 7) return ''
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

function progressForError(code) {
  if (code === LOGIN_ERRORS.timeout) return '登录超时，请重新添加账号。'
  if (code === LOGIN_ERRORS.region) return '登录地区无效。'
  if (code === LOGIN_ERRORS.authUrl) return '授权链接不是受信任的 WorkBuddy 地址。'
  if (code === LOGIN_ERRORS.token) return '登录成功响应缺少 access token。'
  if (code === LOGIN_ERRORS.response) return '上游返回了无法解析的响应。'
  if (code === LOGIN_ERRORS.store) return '账号库写入失败，已保留原账号。'
  if (code === 'MANAGED_ACCOUNT_IDENTITY_CONFLICT') return '账号库存在重复身份，请先处理冲突。'
  return '登录初始化或轮询失败。'
}
