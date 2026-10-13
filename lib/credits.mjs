// WorkBuddy 权威积分余额（Host-only）。本模块只缓存聚合后的安全 DTO；不缓存 token 或资源包明细。
import { createHash } from 'node:crypto'
import { normalizeRegion } from './origins.mjs'

export const PERSONAL_CREDIT_URL = 'https://copilot.tencent.com/billing/meter/get-user-resource-summary'
export const ENTERPRISE_CREDIT_URL = 'https://copilot.tencent.com/billing/meter/get-enterprise-user-usage'
export const CREDIT_TIMEOUT_MS = 30_000
export const CREDIT_TTL_MS = 60_000
export const CREDIT_USER_AGENT = 'dsh-workbuddy/0.1'

/** @type {Map<string, {ok:true,remaining:number,total:number,used:number,fetchedAt:number,stale:false}>} */
const successfulSnapshots = new Map()
/** @type {Map<string, Promise<object>>} */
const inFlightByScope = new Map()

/** 无效、负数或非有限数字按 0。 */
function nonNegativeNumber(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

/** scope key 只保留不可逆摘要，缓存中不保存 uid / enterpriseId 原值。 */
function scopeKey(record) {
  const accountType = record.enterpriseId === '' ? 'personal' : 'enterprise'
  return createHash('sha256').update(`${accountType}\0${record.uid}\0${record.enterpriseId}`).digest('hex')
}

/**
 * 从凭据原文中只提取余额请求必需的三个字段；不返回 raw 对象或 refreshToken。
 * @param {string} rawText
 * @returns {{accessToken:string,uid:string,enterpriseId:string}}
 */
export function parseCreditCredential(rawText) {
  let raw
  try {
    raw = JSON.parse(rawText)
  } catch {
    throw new Error('credential record is not valid JSON')
  }
  const tok = typeof raw?.auth?.accessToken === 'string' ? raw.auth.accessToken : ''
  const uid = typeof raw?.account?.uid === 'string' ? raw.account.uid : ''
  const enterpriseId = typeof raw?.account?.enterpriseId === 'string' ? raw.account.enterpriseId : ''
  if (tok === '') throw new Error('credential record is missing auth.accessToken')
  return { accessToken: tok, uid, enterpriseId }
}

function personalTotals(data) {
  if (!Array.isArray(data?.Packages)) return undefined
  const totals = data.Packages.reduce(
    (sum, item) => ({
      total: sum.total + nonNegativeNumber(item?.CycleTotalCapacity),
      remaining: sum.remaining + nonNegativeNumber(item?.CycleRemainCapacity),
      used: sum.used + nonNegativeNumber(item?.CycleUsedCapacity),
    }),
    { remaining: 0, total: 0, used: 0 },
  )
  return {
    remaining: nonNegativeNumber(totals.remaining),
    total: nonNegativeNumber(totals.total),
    used: nonNegativeNumber(totals.used),
  }
}

function enterpriseTotals(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const total = nonNegativeNumber(data.limitNum)
  const used = nonNegativeNumber(data.credit)
  return { remaining: total - used, total, used }
}

function timeoutSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS), dispose: () => {} }
  }
  if (typeof AbortController === 'undefined') return { signal: undefined, dispose: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CREDIT_TIMEOUT_MS)
  timer.unref?.()
  return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

/** 已知失败分类枚举：只允许这四个值进入 DTO，见 status.mjs 的同款白名单。 */
export const CREDIT_ERROR_CODES = ['unavailable', 'auth-rejected', 'request-failed', 'upstream-invalid']

/** 构造带稳定 code 的失败：错误原文只进日志语义层，绝不会进入返回 DTO。 */
function creditFailure(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function requestFreshBalance({ record, fetchImpl, fetchedAt }) {
  const enterprise = record.enterpriseId !== ''
  const url = enterprise ? ENTERPRISE_CREDIT_URL : PERSONAL_CREDIT_URL
  const bearer = `Bearer ${record.accessToken}`
  const headers = {
    Authorization: bearer,
    'X-User-Id': record.uid,
    'Accept-Language': 'zh',
    'User-Agent': CREDIT_USER_AGENT,
    'Content-Type': 'application/json',
  }
  if (enterprise) headers['X-Enterprise-Id'] = record.enterpriseId

  const timeout = timeoutSignal()
  try {
    let response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: '{}',
        ...(timeout.signal === undefined ? {} : { signal: timeout.signal }),
      })
    } catch (cause) {
      // 网络层失败（连接重置 / 超时 / DNS 等）：原文不进 DTO，只留分类。
      throw creditFailure('request-failed', `credit request failed: ${String(cause?.message ?? 'unknown')}`)
    }
    if (response?.ok !== true) {
      const status = typeof response?.status === 'number' ? response.status : 0
      // 401/403 = 凭据被上游拒绝；其余（5xx 等）= 请求失败可重试。
      throw creditFailure(status === 401 || status === 403 ? 'auth-rejected' : 'request-failed', `credit request unavailable (HTTP ${status})`)
    }
    let payload
    try {
      payload = await response.json()
    } catch (cause) {
      // 读体阶段才断的流是传输层失败（SyntaxError 之外的 TypeError: terminated / AbortError），
      // 报「请求失败」才是可行动的；只有语法错（报文本身坏了）才算上游报文无效。
      const reason = cause instanceof SyntaxError ? 'upstream-invalid' : 'request-failed'
      throw creditFailure(reason, `credit response body unusable: ${String(cause?.message ?? 'unknown')}`)
    }
    if (payload?.data === null || typeof payload?.data !== 'object') throw creditFailure('upstream-invalid', 'credit response unavailable')
    const totals = enterprise ? enterpriseTotals(payload.data) : personalTotals(payload.data)
    if (totals === undefined) throw creditFailure('upstream-invalid', 'credit response unavailable')
    return Object.freeze({ ok: true, ...totals, fetchedAt, stale: false })
  } finally {
    timeout.dispose()
  }
}

/**
 * 查询权威余额。失败按阶段收敛为稳定枚举：auth-rejected（401/403 凭据被拒）、
 * request-failed（网络/超时/其它非 2xx）、upstream-invalid（2xx 报文不可解析）、
 * unavailable（地区不支持或凭据缺失，一次请求都不发）。有旧成功快照时返回 stale 副本。
 *
 * 地区语义（Task 5）：余额端点只存在于 CN 网关。激活账号属于 Intl 时直接返回 unavailable，
 * **一次请求都不发** —— 拿 Intl 令牌去打 CN 端点既拿不到数据，又等于把令牌送到错误的地区。
 * `region` 未给出时保持改动前的行为（按 CN 处理）；给了但无法识别（拼错等）时 fail-closed。
 *
 * @param {{record?:{accessToken?:unknown,uid?:unknown,enterpriseId?:unknown},fetchImpl?:Function,now?:number,region?:unknown}} input
 * @returns {Promise<{ok:true,remaining:number,total:number,used:number,fetchedAt:number,stale:boolean}|{ok:false,error:'unavailable'|'auth-rejected'|'request-failed'|'upstream-invalid'}>}
 */
export async function fetchCreditBalance(input = {}) {
  const { record, fetchImpl } = input ?? {}
  if (input?.region !== undefined && normalizeRegion(input.region) !== 'cn') {
    // 'intl' 与任何无法识别的取值一律不可用：绝不「猜成 CN」把请求发出去。
    return { ok: false, error: 'unavailable' }
  }
  if (
    typeof fetchImpl !== 'function' ||
    typeof record?.accessToken !== 'string' || record.accessToken === '' ||
    typeof record?.uid !== 'string' || record.uid === ''
  ) {
    return { ok: false, error: 'unavailable' }
  }

  const tok = record.accessToken
  const normalizedRecord = {
    accessToken: tok,
    uid: record.uid,
    enterpriseId: typeof record.enterpriseId === 'string' ? record.enterpriseId.trim() : '',
  }
  const fetchedAt = Number.isFinite(input.now) ? input.now : Date.now()
  const scope = scopeKey(normalizedRecord)
  const cached = successfulSnapshots.get(scope)
  const cacheAge = cached === undefined ? undefined : fetchedAt - cached.fetchedAt
  if (cached !== undefined && cacheAge >= 0 && cacheAge < CREDIT_TTL_MS) return { ...cached }

  const existing = inFlightByScope.get(scope)
  if (existing !== undefined) return existing

  const task = (async () => {
    try {
      const fresh = await requestFreshBalance({ record: normalizedRecord, fetchImpl, fetchedAt })
      successfulSnapshots.set(scope, fresh)
      return { ...fresh }
    } catch (error) {
      // 已知分类原样透传；未知失败一律按「请求失败」收敛，绝不让自由文本离开本模块。
      const code = typeof error?.code === 'string' && CREDIT_ERROR_CODES.includes(error.code) ? error.code : 'request-failed'
      const lastSuccess = successfulSnapshots.get(scope)
      return lastSuccess === undefined ? { ok: false, error: code } : { ...lastSuccess, stale: true }
    } finally {
      inFlightByScope.delete(scope)
    }
  })()
  inFlightByScope.set(scope, task)
  return task
}
