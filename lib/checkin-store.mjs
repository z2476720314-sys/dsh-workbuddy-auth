// 签到状态持久化（Host-only）：`<DSH_HOME>/storages/workbuddy-auth-checkin.json`。
//
// 只存「非机密」的调度与结果元数据：开关、每账号的本地日/次数/结果/时间戳。
// 白名单化落盘 —— 令牌、路径、昵称、uid 这些字段**永远不写**（写入口先清洗，读入口再清洗一次）。
// 写入走 lib/writeback.mjs 的原子替换（同目录临时文件 + fsync + rename），失败保留旧文件。
import { mkdir, readFile as readFileDefault } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeCredentialAtomically } from './writeback.mjs'
import { localDateString } from './checkin.mjs'

export const CHECKIN_STORE_VERSION = 1
export const CHECKIN_STORE_READ_FAILED = 'CHECKIN_STORE_READ_FAILED'
export const CHECKIN_STORE_WRITE_FAILED = 'CHECKIN_STORE_WRITE_FAILED'
export const CHECKIN_STORE_ENTRY_INVALID = 'CHECKIN_STORE_ENTRY_INVALID'

const OUTCOMES = new Set(['done', 'skipped', 'failed'])
// 每账号条目**只允许**这些键：任何额外字段（尤其令牌/路径）在写入口与读入口都会被丢掉。
const ENTRY_KEYS = ['date', 'done', 'attempts', 'inactive', 'inactiveAt', 'outcome', 'lastResultAt', 'nextEligibleAt', 'streakDays', 'totalCredits']

/** 签到状态文件路径：`<DSH_HOME>/storages/workbuddy-auth-checkin.json`（DSH_HOME 未设则 `~/.dsh`）。 */
export function checkinStatePath({ env = process.env, home = homedir() } = {}) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const base = configured === '' ? join(home, '.dsh') : configured
  return join(base, 'storages', 'workbuddy-auth-checkin.json')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonNegativeInt(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.floor(number)
}

function timestamp(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

/**
 * 读入口清洗：坏条目整条丢弃，好条目只留白名单字段。
 *
 * 计数与结果字段是**拒收**而非归零：把 `attempts: 'many'` 静默折算成 0 会让当天失败次数上限
 * 被悄悄重置（重复打上游），所以形状不对就整条丢掉——丢一条只意味着今天重新尝试一次，代价更小。
 */
function sanitizeEntry(value, today) {
  if (!isRecord(value)) return null
  if (typeof value.date !== 'string' || value.date !== today) return null
  if (value.attempts !== undefined && (!Number.isFinite(Number(value.attempts)) || Number(value.attempts) < 0)) return null
  if (value.outcome !== undefined && !OUTCOMES.has(value.outcome)) return null
  const outcome = OUTCOMES.has(value.outcome) ? value.outcome : 'failed'
  const entry = { date: value.date, done: value.done === true, attempts: nonNegativeInt(value.attempts), outcome, lastResultAt: timestamp(value.lastResultAt) }
  if (value.inactive === true) {
    entry.inactive = true
    entry.inactiveAt = timestamp(value.inactiveAt)
  }
  if (Number.isFinite(Number(value.nextEligibleAt)) && Number(value.nextEligibleAt) > 0) entry.nextEligibleAt = Number(value.nextEligibleAt)
  if (Number.isFinite(Number(value.streakDays))) entry.streakDays = nonNegativeInt(value.streakDays)
  if (Number.isFinite(Number(value.totalCredits))) entry.totalCredits = nonNegativeInt(value.totalCredits)
  return entry
}

/** 写入口清洗：只保留白名单键，未识别的字段（令牌/路径/昵称…）直接丢弃。 */
function sanitizeForWrite(entry) {
  if (!isRecord(entry)) throw new Error(CHECKIN_STORE_ENTRY_INVALID)
  const out = {}
  for (const key of ENTRY_KEYS) {
    if (!(key in entry)) continue
    const value = entry[key]
    if (key === 'date') {
      if (typeof value !== 'string' || value === '') throw new Error(CHECKIN_STORE_ENTRY_INVALID)
      out.date = value
    } else if (key === 'done') {
      out.done = value === true
    } else if (key === 'inactive') {
      if (value === true) out.inactive = true
    } else if (key === 'outcome') {
      out.outcome = OUTCOMES.has(value) ? value : 'failed'
    } else {
      out[key] = timestamp(value)
    }
  }
  if (out.date === undefined) throw new Error(CHECKIN_STORE_ENTRY_INVALID)
  if (out.outcome === undefined) out.outcome = 'failed'
  if (out.attempts === undefined) out.attempts = 0
  if (out.lastResultAt === undefined) out.lastResultAt = 0
  return out
}

/**
 * @param {{
 *   filePath: string,
 *   readFile?: (path:string)=>Promise<string>,
 *   writeAtomic?: (path:string, content:string)=>void,
 *   now?: () => number,
 *   timeZone?: string,
 * }} deps
 */
export function createCheckinStore({
  filePath,
  readFile = readFileDefault,
  writeAtomic = writeCredentialAtomically,
  now = () => Date.now(),
  timeZone = '',
} = {}) {
  let state
  let loaded = false
  // 写操作串行：并发 updateAccount 不允许互相覆盖（否则后写的快照会丢掉先写的账号）。
  let writeChain = Promise.resolve()

  const nowMs = () => {
    const value = typeof now === 'function' ? now() : Date.now()
    return Number.isFinite(value) ? value : Date.now()
  }

  const today = () => localDateString(nowMs(), timeZone)

  function defaults() {
    return { version: CHECKIN_STORE_VERSION, enabled: true, accounts: {}, lastRunAt: 0 }
  }

  /** 读盘 → 清洗 → 丢掉非本地日的账号条目（新的一天从零统计）。 */
  async function readState() {
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return defaults()
      throw new Error(CHECKIN_STORE_READ_FAILED)
    }
    let raw = null
    try {
      const value = JSON.parse(text)
      raw = isRecord(value) ? value : null
    } catch {
      raw = null // 坏文件按默认值恢复：签到状态不是关键数据，绝不能因此让 Host 起不来。
    }
    if (raw === null) return defaults()

    const current = today()
    const accounts = {}
    if (isRecord(raw.accounts)) {
      for (const [id, entry] of Object.entries(raw.accounts)) {
        if (typeof id !== 'string' || id === '') continue
        const sanitized = sanitizeEntry(entry, current)
        if (sanitized !== null) accounts[id] = sanitized
      }
    }
    return {
      version: CHECKIN_STORE_VERSION,
      enabled: raw.enabled !== false,
      accounts,
      lastRunAt: timestamp(raw.lastRunAt),
    }
  }

  async function ensureLoaded() {
    if (!loaded) {
      state = await readState()
      loaded = true
    }
    return state
  }

  /** 原子落盘；失败抛固定错误码，绝不把本机路径带进错误信息。 */
  function persist() {
    const snapshot = JSON.stringify(state, null, 2)
    const task = writeChain.catch(() => {}).then(async () => {
      try {
        await mkdir(dirname(filePath), { recursive: true })
        await writeAtomic(filePath, snapshot)
      } catch {
        throw new Error(CHECKIN_STORE_WRITE_FAILED)
      }
    })
    writeChain = task.catch(() => {})
    return task
  }

  return {
    async load() {
      return ensureLoaded()
    },

    getState() {
      return state ?? defaults()
    },

    getEnabled() {
      return (state ?? defaults()).enabled === true
    },

    async setEnabled(enabled) {
      await ensureLoaded()
      state.enabled = enabled === true
      await persist()
      return state.enabled
    },

    async updateAccount(id, entry) {
      if (typeof id !== 'string' || id === '') throw new Error(CHECKIN_STORE_ENTRY_INVALID)
      const sanitized = sanitizeForWrite(entry)
      await ensureLoaded()
      state.accounts[id] = sanitized
      await persist()
      return sanitized
    },

    async setLastRunAt(value) {
      await ensureLoaded()
      state.lastRunAt = timestamp(value)
      await persist()
      return state.lastRunAt
    },
  }
}
