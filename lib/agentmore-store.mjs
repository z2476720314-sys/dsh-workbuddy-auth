/**
 * agentmore 凭据库。
 *
 * 为什么不复用 `lib/managed-store.mjs`：那边的字段集合（`region` / `apiOrigin` / `uin` /
 * `phoneMasked`）是 WorkBuddy 的账号模型，`normalizeAccount` 会用 `API_ORIGINS` 白名单
 * 硬校验 region+origin 组合。智谱清言只有单一 origin 和完全不同的身份字段，
 * 硬塞进去要么污染 WorkBuddy 的校验面，要么得给它开例外分支 —— 两条都是坏设计。
 *
 * 但**加密与写入纪律完全照抄**：DPAPI（CurrentUser 作用域）信封 + 原子写，
 * 明文永不落盘。
 */
import { mkdir, readFile as readFileDefault } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeCredentialAtomically } from './writeback.mjs'

const VERSION = 1
const MAX_ID_LENGTH = 256
const MAX_TOKEN_LENGTH = 64 * 1024
const MAX_DISPLAY_LENGTH = 256
const MAX_DEVICE_ID_LENGTH = 256

/** 落盘字段白名单。任何不在表里的键都会被拒（防止上游 payload 顺带污染存储）。 */
const ACCOUNT_FIELDS = new Set([
  'id',
  'userId',
  'displayName',
  'accessToken',
  'refreshToken',
  'deviceId',
  'agentId',
  'conversationId',
  'credits',
  'refreshedAt',
  'createdAt',
])

/** 凭据库默认路径：`<DSH_HOME>/storages/agentmore-accounts.dpapi`。 */
export function agentmoreAccountsPath({ env = process.env, home = homedir() } = {}) {
  const root = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(home, '.dsh')
  return join(root, 'storages', 'agentmore-accounts.dpapi')
}

const storeError = (code) => Object.assign(new Error(code), { code })
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function bounded(value, max, { optional = false } = {}) {
  if (optional && value === undefined) return ''
  return typeof value === 'string' && value.length <= max ? value : null
}

function timestamp(value) {
  if (value === undefined) return 0
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * 从 JWT 的**载荷段**读 `exp`（不验签）。
 *
 * 用途只有一个：判断"这次请求会不会因为令牌过期被 401"。上游不返回到期时间，
 * 不解析的话我们只能等撞墙。解析失败一律当作"未知"（返回 null），
 * 而不是当作"已过期" —— 未知时应该冒一次 401 而不是拒绝可用凭据。
 */
export function accessTokenExpiry(accessToken) {
  if (typeof accessToken !== 'string') return null
  const segments = accessToken.split('.')
  if (segments.length < 2) return null
  const payload = segments[1]
  if (typeof payload !== 'string' || payload === '') return null
  try {
    // base64url → base64，补齐 `=` 填充（Node 的 Buffer 能容错，但显式补齐更稳）。
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    const exp = Number(claims?.exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
  } catch {
    return null
  }
}

function normalizeAccount(input, { allowMissingId = false } = {}) {
  if (!isRecord(input) || Object.keys(input).some((key) => !ACCOUNT_FIELDS.has(key))) {
    throw storeError('AGENTMORE_ACCOUNT_INVALID')
  }
  const id = input.id === undefined && allowMissingId ? randomUUID() : bounded(input.id, MAX_ID_LENGTH)
  const userId = bounded(input.userId ?? '', MAX_ID_LENGTH)
  const displayName = bounded(input.displayName ?? '', MAX_DISPLAY_LENGTH)
  const token = bounded(input.accessToken, MAX_TOKEN_LENGTH)
  const refreshToken = bounded(input.refreshToken ?? '', MAX_TOKEN_LENGTH)
  const deviceId = bounded(input.deviceId, MAX_DEVICE_ID_LENGTH)
  const agentId = bounded(input.agentId ?? '', MAX_ID_LENGTH)
  const conversationId = bounded(input.conversationId ?? '', MAX_ID_LENGTH)
  const credits = input.credits === undefined ? null : input.credits === null ? null : Number(input.credits)
  const refreshedAt = timestamp(input.refreshedAt)
  const createdAt = timestamp(input.createdAt)

  if (
    typeof id !== 'string' || id === ''
    || userId === null || displayName === null
    || token === null || token === ''
    || refreshToken === null || deviceId === null || deviceId === ''
    || agentId === null || conversationId === null
    || refreshedAt === null || createdAt === null
    || (credits !== null && !Number.isFinite(credits))
  ) {
    throw storeError('AGENTMORE_ACCOUNT_INVALID')
  }

  return { id, userId, displayName, accessToken: token, refreshToken, deviceId, agentId, conversationId, credits, refreshedAt, createdAt }
}

function validateDocument(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !['version', 'activeId', 'accounts'].includes(key)) || value.version !== VERSION || !Array.isArray(value.accounts)) {
    throw storeError('AGENTMORE_STORE_INVALID')
  }
  const accounts = value.accounts.map((entry) => normalizeAccount(entry))
  const ids = new Set()
  for (const account of accounts) {
    if (ids.has(account.id)) throw storeError('AGENTMORE_STORE_INVALID')
    ids.add(account.id)
  }
  if (value.activeId !== null && (typeof value.activeId !== 'string' || !ids.has(value.activeId))) {
    throw storeError('AGENTMORE_STORE_INVALID')
  }
  return { version: VERSION, activeId: value.activeId, accounts }
}

/** 同一用户（userId 相同）视为同一账号：重新登录应覆盖而不是新增一条。 */
const sameIdentity = (left, right) => left.userId !== '' && left.userId === right.userId

export function createAgentmoreStore({ filePath, protector, readFile = readFileDefault, writeAtomic = writeCredentialAtomically } = {}) {
  if (typeof filePath !== 'string' || filePath === '' || typeof readFile !== 'function' || typeof writeAtomic !== 'function' || typeof protector?.protect !== 'function' || typeof protector?.unprotect !== 'function') {
    throw new TypeError('agentmore store dependencies are required')
  }

  let document
  let loading
  let writes = Promise.resolve()

  async function load() {
    if (document) return document
    if (loading) return loading
    loading = (async () => {
      let ciphertext
      try {
        ciphertext = await readFile(filePath, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') return { version: VERSION, activeId: null, accounts: [] }
        throw storeError('AGENTMORE_STORE_READ_FAILED')
      }
      if (typeof ciphertext !== 'string' || ciphertext === '') throw storeError('AGENTMORE_STORE_INVALID')
      let plaintext
      try {
        plaintext = await protector.unprotect(ciphertext)
      } catch {
        throw storeError('AGENTMORE_STORE_DECRYPT_FAILED')
      }
      if (typeof plaintext !== 'string') throw storeError('AGENTMORE_STORE_INVALID')
      try {
        return validateDocument(JSON.parse(plaintext))
      } catch {
        throw storeError('AGENTMORE_STORE_INVALID')
      }
    })()
    try {
      document = await loading
      return document
    } finally {
      loading = undefined
    }
  }

  async function persist(next) {
    let ciphertext
    try {
      ciphertext = await protector.protect(JSON.stringify(next))
    } catch {
      throw storeError('AGENTMORE_STORE_ENCRYPT_FAILED')
    }
    if (typeof ciphertext !== 'string' || ciphertext === '') throw storeError('AGENTMORE_STORE_ENCRYPT_FAILED')
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeAtomic(filePath, ciphertext)
    } catch {
      throw storeError('AGENTMORE_STORE_WRITE_FAILED')
    }
    document = next
  }

  function mutate(operation) {
    const result = writes.then(async () => operation(await load()))
    writes = result.catch(() => {})
    return result
  }

  return {
    async list() {
      await writes
      return (await load()).accounts.map((account) => ({ ...account }))
    },
    async getById(id) {
      await writes
      const account = (await load()).accounts.find((item) => item.id === id)
      return account ? { ...account } : null
    },
    async getActive() {
      await writes
      const current = await load()
      if (current.activeId === null) return null
      const account = current.accounts.find((item) => item.id === current.activeId)
      return account ? { ...account } : null
    },
    upsert(input) {
      return mutate(async (current) => {
        const incoming = normalizeAccount(input, { allowMissingId: true })
        const identityIndex = current.accounts.findIndex((account) => sameIdentity(account, incoming))
        const idIndex = current.accounts.findIndex((account) => account.id === incoming.id)
        const index = identityIndex >= 0 ? identityIndex : idIndex
        const stableId = index >= 0 ? current.accounts[index].id : incoming.id
        const account = { ...incoming, id: stableId }
        const accounts = current.accounts.slice()
        if (index >= 0) accounts[index] = account
        else accounts.push(account)
        const activeId = current.activeId ?? stableId
        await persist({ ...current, accounts, activeId })
        return { ...account }
      })
    },
    setActiveId(id) {
      return mutate(async (current) => {
        if (id !== null && (typeof id !== 'string' || !current.accounts.some((account) => account.id === id))) {
          throw storeError('AGENTMORE_ACCOUNT_NOT_FOUND')
        }
        if (current.activeId === id) return id
        await persist({ ...current, activeId: id })
        return id
      })
    },
    remove(id) {
      return mutate(async (current) => {
        const accounts = current.accounts.filter((account) => account.id !== id)
        if (accounts.length === current.accounts.length) throw storeError('AGENTMORE_ACCOUNT_NOT_FOUND')
        const activeId = current.activeId === id ? null : current.activeId
        await persist({ ...current, accounts, activeId })
      })
    },
  }
}
