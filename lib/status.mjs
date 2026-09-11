// WorkBuddy 设置卡的脱敏状态 DTO —— 纯函数：不读盘、不联网、不打日志。
//
// 安全契约（设计文档 §10.3，改动前请先读）：
//   `buildStatus` 的返回值是本插件唯一会送到浏览器的东西，**任何情况下都不得包含
//   accessToken / refreshToken 的值**。因此：
//     * 只输出下面显式列出的字段，绝不 spread 整条凭据记录；
//     * 令牌本身从不被读取进返回值（只读 expiresAt / refreshExpiresAt / lastRefreshTime / uid）；
//     * 字段级片段策略：nickname 的完整值若是令牌的 >=4 字符子串，或内部嵌入 >=8 字符片段，
//       则清空；phoneNumber 的完整原值若是令牌的 >=4 字符子串，则在打码前清空；uid 的原值
//       与截断 tail 都要检查，命中同一策略即清空（避免异常记录或字段串位把令牌送进 DTO）；
//     * 字段策略后再检查最终三个展示值，任何 >=4 字符连续 token 片段都会令整字段清空；
//     * 未命中守卫的手机号只保留前 3 位与后 4 位。
//   本会话此前已发生过两次凭据误打印，`test/status.test.mjs` 用「整串扫描」与
//   「字段白名单」两种反向断言把这条契约钉住。
import { parseCredentialRecord } from './credential.mjs'

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000
/** 展示字段长度上限：凭据文件是不可信输入，避免异常记录把响应体撑大。 */
const DISPLAY_MAX_LEN = 64
/** 整个展示值就是令牌子串时的最短危险长度。 */
const MIN_WHOLE_SUBSTRING_LEN = 4
/** 展示值内部夹带令牌片段时的最短危险长度。 */
const MIN_EMBEDDED_FRAGMENT_LEN = 8
/** Host 内部用的余额载体；Symbol 防止它与凭据 JSON 字段碰撞或被 JSON.stringify。 */
const CREDIT_ENVELOPE = Symbol('dsh-workbuddy-auth.credits')

/**
 * 把余额 Promise 挂在一个 String 包装对象上，供既有路由无侵入地传入 buildStatus。
 * buildStatus 会先同步完成凭据解析，再 await 余额，因此两项工作并发推进；载体属性不可枚举，
 * JSON.stringify/日志不会包含余额之外的任何内部数据。
 */
export function withCredits(rawText, credits) {
  const envelope = new String(rawText)
  Object.defineProperty(envelope, CREDIT_ENVELOPE, { value: credits, enumerable: false })
  return envelope
}

function finalizeCredits(status, credits) {
  if (credits === undefined) return status
  if (credits !== null && typeof credits.then === 'function') {
    return Promise.resolve(credits).then(
      (value) => attachCredits(status, value),
      () => attachCredits(status, { ok: false, error: 'unavailable' }),
    )
  }
  return attachCredits(status, credits)
}

/**
 * 取字符串末尾 n 个字符；不足 n 个时原样返回。
 * 非字符串一律返回空串（永不抛错：DTO 必须总能构造出来）。
 *
 * @param {unknown} value
 * @param {number} n
 * @returns {string}
 */
export function tail(value, n) {
  if (typeof value !== 'string' || value === '') return ''
  const width = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  if (width === 0) return ''
  return value.length <= width ? value : value.slice(-width)
}

/**
 * 手机号打码：保留前 3 位与后 4 位，中间固定 4 个星号。
 * 长度不足 7 位时无法在不重叠的前提下打码，原样返回（调用方保证不用于超短串）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function maskPhone(value) {
  if (typeof value !== 'string') return ''
  if (value.length < 7) return value
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

/**
 * 剩余天数：向下取整，且绝不为负（已过期一律 0）。
 *
 * @param {number} expiresAt 绝对到期毫秒
 * @param {number} now 当前绝对毫秒
 * @returns {number}
 */
function daysLeft(expiresAt, now) {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return 0
  return Math.max(0, Math.floor((expiresAt - now) / DAY_MS))
}

/**
 * 给状态 DTO 增加经过白名单过滤的余额字段。
 * 即使 Host seam 返回脏对象，也只允许六个公开字段进入响应。
 */
export function attachCredits(status, credits) {
  const safe = credits?.ok === true
    ? {
        ok: true,
        remaining: finiteOr0(credits.remaining),
        total: finiteNonNegativeOr0(credits.total),
        used: finiteNonNegativeOr0(credits.used),
        fetchedAt: finiteNonNegativeOr0(credits.fetchedAt),
        stale: credits.stale === true,
      }
    : { ok: false, error: 'unavailable' }
  return { ...status, credits: safe }
}

function finiteNonNegativeOr0(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function finiteOr0(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** 从原文里读「账号展示字段」；原文不可解析时留空（此时 parseCredentialRecord 已先行报错）。 */
function readDisplayAccount(rawText) {
  try {
    const raw = JSON.parse(rawText)
    const account = raw?.account
    const text = (v) => (typeof v === 'string' ? v.slice(0, DISPLAY_MAX_LEN) : '')
    return { nickname: text(account?.nickname), phoneNumber: text(account?.phoneNumber) }
  } catch {
    return { nickname: '', phoneNumber: '' }
  }
}

/**
 * `value` 整体是否是某个令牌的任意子串。
 *
 * 只对长度至少 4 的完整字段启用：这样能拦住短手机号、uid 尾号和 4–7 字符昵称串位，
 * 又不会把任意 1 个常见字符当成泄漏而误伤正常昵称。
 *
 * @param {string} value
 * @param {string[]} secrets
 * @returns {boolean}
 */
function isWholeTokenSubstring(value, secrets) {
  return value.length >= MIN_WHOLE_SUBSTRING_LEN && secrets.some((secret) => secret.includes(value))
}

/**
 * `value` 中是否嵌入了某个令牌至少 8 个连续字符的片段。
 *
 * 这是 nickname 的第二种风险形态：令牌片段前后还有正常文本时，不能用 4 字符窗口，
 * 否则普通英文或数字昵称很容易碰撞；8 字符窗口覆盖长片段串位，同时控制误报。
 *
 * @param {string} value
 * @param {string[]} secrets
 * @returns {boolean}
 */
function containsEmbeddedTokenFragment(value, secrets) {
  for (const secret of secrets) {
    if (secret.length < MIN_EMBEDDED_FRAGMENT_LEN) continue
    for (let start = 0; start + MIN_EMBEDDED_FRAGMENT_LEN <= secret.length; start += 1) {
      if (value.includes(secret.slice(start, start + MIN_EMBEDDED_FRAGMENT_LEN))) return true
    }
  }
  return false
}

/** nickname 策略：完整值是 >=4 的令牌子串，或内部夹带 >=8 的令牌片段。 */
function nicknameLeaksToken(value, secrets) {
  return isWholeTokenSubstring(value, secrets) || containsEmbeddedTokenFragment(value, secrets)
}

/** phoneNumber / uid 策略：只在整个原值（或 uid tail）就是 >=4 的令牌子串时清空。 */
function identifierLeaksToken(value, secrets) {
  return isWholeTokenSubstring(value, secrets)
}

/** 最终 DTO 字符串里是否还残留任一令牌至少 4 个连续字符。 */
function containsTokenRun(value, secrets) {
  if (value === '') return false
  for (const secret of secrets) {
    for (let start = 0; start + MIN_WHOLE_SUBSTRING_LEN <= secret.length; start += 1) {
      if (value.includes(secret.slice(start, start + MIN_WHOLE_SUBSTRING_LEN))) return true
    }
  }
  return false
}

/**
 * 构造设置卡要用的脱敏状态。
 *
 * 永不抛错：凭据文件缺失、内容非法、字段缺失都映射成 `ok:false` + 可读 `error`。
 *
 * @param {{
 *   rawText?: string,
 *   now?: number,
 *   userAgentFix?: boolean,
 *   upstreamHost?: string,
 *   error?: unknown,
 * }} [input]
 *   `rawText` 凭据文件原文；`now` 当前毫秒（可注入）；`userAgentFix` 上游 UA 修复是否生效；
 *   `upstreamHost` 实际生效的上游域名；`error` 调用方读取凭据文件时捕获的错误（有则不解析原文）。
 * @returns {{
 *   ok: boolean,
 *   account: {nickname: string, uidTail: string, phoneMasked: string},
 *   token: {accessExpiresAt: number, accessDaysLeft: number, refreshExpiresAt: number, refreshDaysLeft: number, lastRefreshTime: number},
 *   state: {credentialReadable: boolean, userAgentFix: boolean, upstreamHost: string},
 *   error?: string,
 * }}
 */
export function buildStatus(input = {}) {
  const { rawText, now = Date.now(), userAgentFix = false, upstreamHost = '', error } = input ?? {}
  const credits = rawText?.[CREDIT_ENVELOPE]
  const credentialText = typeof rawText === 'string' || rawText instanceof String ? String(rawText) : rawText

  const state = {
    credentialReadable: false,
    userAgentFix: userAgentFix === true,
    upstreamHost: typeof upstreamHost === 'string' ? upstreamHost.slice(0, DISPLAY_MAX_LEN) : '',
  }
  const account = { nickname: '', uidTail: '', phoneMasked: '' }
  const token = { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 }

  let failure = error === undefined || error === null ? undefined : error instanceof Error ? error.message : String(error)

  if (failure === undefined) {
    try {
      const record = parseCredentialRecord(credentialText)
      const display = readDisplayAccount(credentialText)
      const secrets = [record.accessToken, record.refreshToken].filter((v) => typeof v === 'string' && v !== '')
      const uid = typeof record.uid === 'string' ? record.uid : ''
      const uidTail = tail(uid, 4)

      // 第一层按字段语义判定：昵称允许普通文本，仅完整值 >=4 或嵌入片段 >=8 时触发；手机号
      // 在 maskPhone 前判原值；uid 同时判原值与截断 tail，防止截断本身制造出 4 字符泄漏。
      const nickname = nicknameLeaksToken(display.nickname, secrets) ? '' : display.nickname
      const safeUidTail = nicknameLeaksToken(uid, secrets) || identifierLeaksToken(uidTail, secrets) ? '' : uidTail
      const phoneMasked = identifierLeaksToken(display.phoneNumber, secrets) ? '' : maskPhone(display.phoneNumber)

      // 第二层是最终 DTO 不变量：即使第一层的 8 字符嵌入阈值或 maskPhone 的星号分隔改变了
      // 字段形态，任何实际输出仍不得含令牌的 >=4 字符连续片段。命中时清空整个字段。
      account.nickname = containsTokenRun(nickname, secrets) ? '' : nickname
      account.uidTail = containsTokenRun(safeUidTail, secrets) ? '' : safeUidTail
      account.phoneMasked = containsTokenRun(phoneMasked, secrets) ? '' : phoneMasked
      token.accessExpiresAt = record.expiresAt
      token.accessDaysLeft = daysLeft(record.expiresAt, now)
      token.refreshExpiresAt = record.refreshExpiresAt
      token.refreshDaysLeft = daysLeft(record.refreshExpiresAt, now)
      token.lastRefreshTime = record.lastRefreshTime
      state.credentialReadable = true
      return finalizeCredits({ ok: true, account, token, state }, credits)
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught)
    }
  }

  const message = typeof failure === 'string' && failure !== '' ? failure : 'credential record is unreadable'
  return finalizeCredits({ ok: false, account, token, state, error: message }, credits)
}
