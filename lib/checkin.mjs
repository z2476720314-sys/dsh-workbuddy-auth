// WorkBuddy 自动签到状态机（Host-only）。
//
// 语义对齐参考实现（dsh-chatgpt-subscription `lib/index.js:43603-43701`），差异只在数据来源：
//   * 参考实现从自己的凭据 store 里拿账号；这里通过 seam 从账号管理器拿（桌面明文 + 托管），
//     并且**只处理 CN**：Intl 账号与读不到明文令牌的桌面加密信封一律跳过、零网络调用。
//   * 状态先落盘再推进（每个账号一份 entry），进程重启后不会重复签到或丢失次数上限。
//   * 本模块只写「非机密」的调度与结果元数据；令牌只在一次请求的内存里存在。
import { CN_BACKEND } from './origins.mjs'

export const CHECKIN_STATUS_PATH = '/billing/meter/checkin-activity-status'
export const CHECKIN_DAILY_PATH = '/billing/meter/daily-checkin'
export const CHECKIN_TICK_MS = 600_000
export const CHECKIN_TIMEOUT_MS = 20_000
export const CHECKIN_INACTIVE_RETRY_MS = 3_600_000
export const CHECKIN_MAX_ATTEMPTS = 3
export const CHECKIN_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'
export const CHECKIN_DEFAULT_DOMAIN = 'www.codebuddy.cn'

const STATUS_URL = `${CN_BACKEND}${CHECKIN_STATUS_PATH}`
const DAILY_URL = `${CN_BACKEND}${CHECKIN_DAILY_PATH}`

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 本地日历日（YYYY-MM-DD）。给定时区时按该时区计算，否则用系统本地时区。
 * 上游按「本地日」判定签到，跨日必须重新统计。
 *
 * @param {number} nowMs
 * @param {string} [timeZone]
 */
export function localDateString(nowMs, timeZone = '') {
  const date = new Date(Number.isFinite(nowMs) ? nowMs : Date.now())
  if (typeof timeZone === 'string' && timeZone !== '') {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date)
      const get = (type) => parts.find((part) => part.type === type)?.value ?? ''
      const year = get('year')
      const month = get('month')
      const day = get('day')
      if (/^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day)) return `${year}-${month}-${day}`
    } catch {
      // 时区名非法：退回系统本地时区，绝不因此让整个签到停摆。
    }
  }
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), dispose: () => {} }
  }
  if (typeof AbortController === 'undefined') return { signal: undefined, dispose: () => {} }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  timer.unref?.()
  return { signal: controller.signal, dispose: () => clearTimeout(timer) }
}

/** 兼容 true/1/'1'/'true' 与 false/0/'0'/'false' 两种拼写（上游两种都出现过）。 */
function readBool(data, ...keys) {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'boolean') return value
    if (value === 1 || value === '1' || value === 'true') return true
    if (value === 0 || value === '0' || value === 'false') return false
  }
  return undefined
}

/** 上游用 200 + 文案表达「今天已经签过了」。 */
function isAlreadySignedInMessage(result) {
  if (!isRecord(result)) return false
  const message = typeof result.msg === 'string' ? result.msg : typeof result.message === 'string' ? result.message : ''
  return message.toLowerCase().includes('already') || message.includes('已签') || message.includes('今日')
}

/** 401/403 被网关折成 `{code, msg}` 形式；其余状态码原样返回解析结果。 */
function isUnauthorized(result) {
  return isRecord(result) && result.code === 401
}

/**
 * 只提取签到请求必需字段；不返回 raw 对象、不返回 refreshToken 给调用方之外的任何地方。
 * @param {string} rawText
 */
function parseCheckinCredential(rawText) {
  let raw
  try {
    raw = JSON.parse(rawText)
  } catch {
    return null
  }
  const auth = raw?.auth
  const tok = typeof auth?.accessToken === 'string' ? auth.accessToken : ''
  if (tok === '') return null
  return {
    accessToken: tok,
    uid: typeof raw?.account?.uid === 'string' ? raw.account.uid : '',
    enterpriseId: typeof raw?.account?.enterpriseId === 'string' ? raw.account.enterpriseId : '',
    domain: typeof auth?.domain === 'string' ? auth.domain : '',
  }
}

function checkinHeaders(credential) {
  const bearer = `Bearer ${credential.accessToken}`
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: bearer,
    'User-Agent': CHECKIN_USER_AGENT,
    'X-Domain': credential.domain === '' ? CHECKIN_DEFAULT_DOMAIN : credential.domain,
    'X-Product': 'SaaS',
    'X-Ide-Name': 'CodeBuddyIDE',
    'X-Requested-With': 'XMLHttpRequest',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  return headers
}

/**
 * @param {{
 *   listAccounts: () => Promise<{id:string,region?:string,source?:string,encrypted?:boolean}[]>,
 *   readAccount: (id:string) => Promise<{text:string}>,
 *   refreshAccount: (id:string) => Promise<unknown>,
 *   fetchImpl: Function,
 *   store: {load():Promise<object>,getState():object,updateAccount(id:string,entry:object):Promise<void>,setLastRunAt(ts:number):Promise<void>},
 *   now?: () => number,
 *   timeZone?: string,
 *   logger?: {info?:Function,warn?:Function},
 *   setTimer?: (fn:Function,ms:number)=>unknown,
 *   clearTimer?: (id:unknown)=>void,
 * }} deps
 */
export function createCheckinService({
  listAccounts,
  readAccount,
  refreshAccount,
  fetchImpl,
  store,
  now = () => Date.now(),
  timeZone = '',
  logger,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
} = {}) {
  // 所有轮次（自动 + 手动）共用一条串行链：手动请求排队而不是被丢弃，自动 tick 不会与任何轮次重叠。
  let chain = Promise.resolve()
  let automaticInFlight = null
  let timerId

  const nowMs = () => {
    const value = typeof now === 'function' ? now() : Date.now()
    return Number.isFinite(value) ? value : Date.now()
  }

  const log = (level, message) => {
    const fn = logger?.[level]
    if (typeof fn === 'function') fn.call(logger, `[workbuddy-auth-checkin] ${message}`)
  }

  async function postJson(url, headers) {
    const timeout = timeoutSignal(CHECKIN_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: '{}',
        ...(timeout.signal === undefined ? {} : { signal: timeout.signal }),
      })
      // 与参考实现一致：**先解析响应体**，只有解析不出对象时才按状态码兜底。
      // （网关会用 200 + `{code:500}` 这类形态表达失败，看 ok 会把失败误判成成功。）
      let parsed = null
      try {
        const text = typeof response?.text === 'function' ? await response.text() : ''
        const value = text === '' ? undefined : JSON.parse(text)
        parsed = isRecord(value) ? value : null
      } catch {
        parsed = null
      }
      if (parsed !== null) return parsed
      if (typeof response?.json === 'function') {
        try {
          const value = await response.json()
          if (isRecord(value)) return value
        } catch {
          parsed = null
        }
      }
      const status = Number(response?.status ?? 0)
      if (status === 401 || status === 403) return { code: status, msg: `HTTP ${status}` }
      return null
    } finally {
      timeout.dispose()
    }
  }

  /** 带「401 → 强制刷新一次 → 重试一次」的单次请求（参考实现同样按请求计一次）。 */
  async function postWithRetry(url, accountId, credential) {
    let result = await postJson(url, checkinHeaders(credential))
    if (!isUnauthorized(result)) return result
    log('warn', `${accountId} rejected the token; refreshing once`)
    await refreshAccount(accountId)
    const refreshed = await readCredential(accountId)
    if (refreshed === null) return result
    result = await postJson(url, checkinHeaders(refreshed))
    return result
  }

  async function readCredential(accountId) {
    const record = await readAccount(accountId)
    const text = typeof record === 'string' ? record : record?.text
    if (typeof text !== 'string' || text === '') return null
    return parseCheckinCredential(text)
  }

  async function persist(accountId, entry) {
    await store.updateAccount(accountId, entry)
  }

  /** 单个账号：选择规则 → status-first → daily；结果先落盘再返回。 */
  async function checkinAccount(account, context) {
    const { manual, today, nowValue, previous } = context
    const sameDay = previous?.date === today
    if (sameDay && previous.done === true) return 'skipped'
    const attempts = sameDay && Number.isFinite(previous.attempts) ? previous.attempts : 0
    if (!manual && sameDay && attempts >= CHECKIN_MAX_ATTEMPTS) return 'skipped'
    if (
      !manual &&
      sameDay &&
      previous.inactive === true &&
      nowValue - (Number.isFinite(previous.inactiveAt) ? previous.inactiveAt : 0) < CHECKIN_INACTIVE_RETRY_MS
    ) {
      return 'skipped'
    }

    // 先按「失败」落盘：任何中途异常都不会让这次尝试在状态里消失。
    const entry = {
      date: today,
      done: sameDay && previous.done === true,
      attempts,
      inactive: false,
      outcome: 'failed',
      lastResultAt: nowValue,
    }
    const settle = async (outcome, patch = {}) => {
      Object.assign(entry, patch, { outcome })
      entry.lastResultAt = nowMs()
      await persist(account.id, entry)
      return outcome
    }

    let credential
    try {
      credential = await readCredential(account.id)
    } catch (error) {
      log('warn', `${account.id} credentials unreadable: ${error instanceof Error ? error.message : String(error)}`)
      return settle('skipped')
    }
    if (credential === null) return settle('skipped')

    try {
      const status = await postWithRetry(STATUS_URL, account.id, credential)
      const statusData = isRecord(status?.data) ? status.data : {}
      if (readBool(statusData, 'today_checked_in', 'todayCheckedIn') === true) {
        log('info', `${account.id} already signed in today`)
        return settle('done', { done: true, inactive: false })
      }
      if (readBool(statusData, 'active', 'Active') === false) {
        // 活动未开放：不是失败，一小时后复查。
        log('info', `${account.id} has no active check-in activity; will re-check later`)
        return settle('skipped', { inactive: true, inactiveAt: nowMs() })
      }

      const daily = await postWithRetry(DAILY_URL, account.id, credential)
      if (isRecord(daily) && daily.code === 0) {
        log('info', `${account.id} signed in`)
        return settle('done', { done: true, inactive: false })
      }
      if (isAlreadySignedInMessage(daily)) {
        log('info', `${account.id} already signed in today (upstream confirmed)`)
        return settle('done', { done: true, inactive: false })
      }
      const code = isRecord(daily) ? String(daily.code ?? 'no-response') : 'no-response'
      log('warn', `${account.id} attempt ${attempts + 1}/${CHECKIN_MAX_ATTEMPTS} failed: code ${code}`)
      return settle('failed', { attempts: attempts + 1 })
    } catch (error) {
      log('warn', `${account.id} attempt ${attempts + 1}/${CHECKIN_MAX_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`)
      return settle('failed', { attempts: attempts + 1 })
    }
  }

  /** 聚合只暴露计数与时间戳：不含 id、令牌或路径。 */
  function summarize(state, accounts) {
    const nowValue = nowMs()
    const today = localDateString(nowValue, timeZone)
    let doneToday = 0
    let failedToday = 0
    let skippedToday = 0
    for (const account of accounts) {
      const entry = state?.accounts?.[account.id]
      if (entry?.date === today && entry.done === true) doneToday += 1
      else if (entry?.date === today && entry.outcome === 'failed') failedToday += 1
      else skippedToday += 1
    }
    return {
      enabled: state?.enabled === true,
      totalAccounts: accounts.length,
      doneToday,
      skippedToday,
      failedToday,
      lastRunAt: Number.isFinite(state?.lastRunAt) ? state.lastRunAt : 0,
    }
  }

  async function runRound(mode) {
    const manual = mode === 'manual'
    const state = await store.load()
    if (!manual && state?.enabled !== true) return summarize(state, [])

    let accounts = []
    try {
      const listed = await listAccounts()
      accounts = Array.isArray(listed) ? listed : []
    } catch (error) {
      log('warn', `account scan failed: ${error instanceof Error ? error.message : String(error)}`)
      accounts = []
    }

    const nowValue = nowMs()
    const today = localDateString(nowValue, timeZone)
    for (const account of accounts) {
      // CN-only：Intl 账号与读不到明文的桌面加密信封一律跳过，一次请求都不发。
      if (account?.region !== 'cn') continue
      if (account?.encrypted === true) continue
      if (typeof account?.id !== 'string' || account.id === '') continue
      try {
        await checkinAccount(account, { manual, today, nowValue, previous: state?.accounts?.[account.id] })
      } catch (error) {
        // 单账号异常绝不影响后续账号。
        log('warn', `${account.id} skipped after error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // lastRunAt 落盘失败**不得**让整轮崩掉：每个账号的结果已经尽力落过盘，
    // 这里再失败只是少一个时间戳。放任它抛出去会变成 fire-and-forget 的未处理拒绝
    // （start()/定时器都没有 await 方），在宿主进程里表现为噪音甚至崩溃。
    try {
      await store.setLastRunAt(nowValue)
    } catch (error) {
      log('warn', `failed to record lastRunAt: ${error instanceof Error ? error.message : String(error)}`)
    }
    const latest = store.getState?.() ?? state
    return summarize(latest, accounts)
  }

  function enqueue(mode) {
    const task = chain.catch(() => {}).then(() => runRound(mode))
    chain = task.catch(() => {})
    return task
  }

  return {
    /** 自动运行：同一时刻只允许一轮，进行中的调用复用同一 promise。 */
    runAutomatic() {
      if (automaticInFlight !== null) return automaticInFlight
      // 清理动作挂在**返回给调用方的那个 promise** 上：await 返回时 inFlight 已经归位，
      // 否则「刚 await 完就再调一次」会拿到已经结束的旧轮次（静默不跑）。
      const task = enqueue('auto').then(
        (value) => {
          if (automaticInFlight === task) automaticInFlight = null
          return value
        },
        (error) => {
          if (automaticInFlight === task) automaticInFlight = null
          throw error
        },
      )
      automaticInFlight = task
      return task
    },

    /** 手动运行：排队等当前工作结束，绝不丢弃；绕过开关与次数上限。 */
    runManual() {
      return enqueue('manual')
    },

    /** 只读本地状态；不触发任何网络请求。 */
    async summary() {
      const state = await store.load()
      let accounts = []
      try {
        const listed = await listAccounts()
        accounts = Array.isArray(listed) ? listed : []
      } catch {
        accounts = []
      }
      return summarize(state, accounts)
    },

    /**
     * 设置卡的开关：先落盘再回最新摘要。
     *
     * 语义边界（写清楚以免误判为缺陷）：已经读完 `enabled: true` 的那一轮不会被中断，
     * 它照常跑完并落盘结果；开关影响的是**下一轮**是否发起请求。这是有意的取舍——
     * 中途取消已发出的请求会让部分账号处于「已发请求、结果未记录」的模糊态。
     */
    async setEnabled(enabled) {
      await store.setEnabled(enabled === true)
      return this.summary()
    },

    /** 启动：立即跑一轮，之后每 CHECKIN_TICK_MS 一轮。 */
    start() {
      // fire-and-forget 的两个入口都必须自带 catch：这里没有 await 方，
      // 一个漏出来的拒绝就是宿主进程里的 unhandledRejection。
      const runQuietly = () => { void this.runAutomatic().catch((error) => log('warn', `round failed: ${error instanceof Error ? error.message : String(error)}`)) }
      runQuietly()
      if (timerId === undefined) {
        timerId = setTimer(runQuietly, CHECKIN_TICK_MS)
        timerId?.unref?.()
      }
    },

    stop() {
      if (timerId === undefined) return
      clearTimer(timerId)
      timerId = undefined
    },
  }
}
