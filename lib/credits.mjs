// WorkBuddy 权威积分余额（Host-only）。本模块只缓存聚合后的安全 DTO；不缓存 token 或资源包明细。
import { createHash } from 'node:crypto'

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
  const accessToken = typeof raw?.auth?.accessToken === 'string' ? raw.auth.accessToken : ''
  const uid = typeof raw?.account?.uid === 'string' ? raw.account.uid : ''
  const enterpriseId = typeof raw?.account?.enterpriseId === 'string' ? raw.account.enterpriseId : ''
  if (accessToken === '') throw new Error('credential record is missing auth.accessToken')
  return { accessToken, uid, enterpriseId }
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

async function requestFreshBalance({ record, fetchImpl, fetchedAt }) {
  const enterprise = record.enterpriseId !== ''
  const url = enterprise ? ENTERPRISE_CREDIT_URL : PERSONAL_CREDIT_URL
  const headers = {
    Authorization: `Bearer ${record.accessToken}`,
    'X-User-Id': record.uid,
    'Accept-Language': 'zh',
    'User-Agent': CREDIT_USER_AGENT,
    'Content-Type': 'application/json',
  }
  if (enterprise) headers['X-Enterprise-Id'] = record.enterpriseId

  const timeout = timeoutSignal()
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: '{}',
      ...(timeout.signal === undefined ? {} : { signal: timeout.signal }),
    })
    if (response?.ok !== true) throw new Error('credit request unavailable')
    const payload = await response.json()
    if (payload?.data === null || typeof payload?.data !== 'object') throw new Error('credit response unavailable')
    const totals = enterprise ? enterpriseTotals(payload.data) : personalTotals(payload.data)
    if (totals === undefined) throw new Error('credit response unavailable')
    return Object.freeze({ ok: true, ...totals, fetchedAt, stale: false })
  } finally {
    timeout.dispose()
  }
}

/**
 * 查询权威余额。所有失败都收敛为固定 unavailable；有旧成功快照时返回 stale 副本。
 * @param {{record?:{accessToken?:unknown,uid?:unknown,enterpriseId?:unknown},fetchImpl?:Function,now?:number}} input
 * @returns {Promise<{ok:true,remaining:number,total:number,used:number,fetchedAt:number,stale:boolean}|{ok:false,error:'unavailable'}>}
 */
export async function fetchCreditBalance(input = {}) {
  const { record, fetchImpl } = input ?? {}
  if (
    typeof fetchImpl !== 'function' ||
    typeof record?.accessToken !== 'string' || record.accessToken === '' ||
    typeof record?.uid !== 'string' || record.uid === ''
  ) {
    return { ok: false, error: 'unavailable' }
  }

  const normalizedRecord = {
    accessToken: record.accessToken,
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
    } catch {
      const lastSuccess = successfulSnapshots.get(scope)
      return lastSuccess === undefined ? { ok: false, error: 'unavailable' } : { ...lastSuccess, stale: true }
    } finally {
      inFlightByScope.delete(scope)
    }
  })()
  inFlightByScope.set(scope, task)
  return task
}
