import { mkdir, readFile as readFileDefault } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeCredentialAtomically } from './writeback.mjs'

const VERSION = 1
const MAX_ID_LENGTH = 256
const MAX_TOKEN_LENGTH = 64 * 1024
const MAX_DISPLAY_LENGTH = 256
const ACCOUNT_FIELDS = new Set([
  'id',
  'region',
  'uid',
  'uin',
  'displayName',
  'phoneMasked',
  'accessToken',
  'refreshToken',
  'expiresAt',
  'refreshExpiresAt',
  'apiOrigin',
])
// 地区与 origin 的定义集中在 lib/origins.mjs（登录/刷新/推理/余额共用一份事实）；
// 这里只把历史导出面转出去，避免既有导入点（web-login 与测试）改道。
import { API_ORIGINS, CN_BACKEND } from './origins.mjs'

export { API_ORIGINS, CN_BACKEND }

/**
 * Host 侧「托管账号 id」的前缀：`managed:<库内 id>`。
 *
 * 目录路由、激活上下文与登录 DTO 都必须用同一个前缀，否则设置卡拿到的 id
 * 在激活接口上是无效的（两个 id 空间对不上）。
 */
export const MANAGED_ID_PREFIX = 'managed:'

/**
 * 托管账号库默认路径：`<DSH_HOME>/storages/workbuddy-accounts.dpapi`。
 *
 * DSH_HOME 的取值方式与 Host/其它插件一致（环境变量优先，否则 `~/.dsh`），
 * 这样测试和用户都能用同一个环境变量把整库重定向到临时目录。
 *
 * @param {{env?:Record<string,string|undefined>,home?:string}} [options]
 * @returns {string}
 */
export function managedAccountsPath({ env = process.env, home = homedir() } = {}) {
  const root = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(home, '.dsh')
  return join(root, 'storages', 'workbuddy-accounts.dpapi')
}

function storeError(code) {
  return Object.assign(new Error(code), { code })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value, maxLength, { optional = false } = {}) {
  if (optional && value === undefined) return ''
  return typeof value === 'string' && value.length <= maxLength ? value : null
}

function expiry(value) {
  if (value === undefined) return 0
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function normalizeAccount(input, { allowMissingId = false } = {}) {
  if (!isRecord(input) || Object.keys(input).some((key) => !ACCOUNT_FIELDS.has(key))) {
    throw storeError('MANAGED_ACCOUNT_INVALID')
  }

  const id = input.id === undefined && allowMissingId ? randomUUID() : boundedString(input.id, MAX_ID_LENGTH)
  const region = input.region
  const uid = boundedString(input.uid ?? '', MAX_ID_LENGTH)
  const uin = boundedString(input.uin ?? '', MAX_ID_LENGTH)
  const displayName = boundedString(input.displayName ?? '', MAX_DISPLAY_LENGTH)
  const phoneMasked = boundedString(input.phoneMasked ?? '', MAX_DISPLAY_LENGTH)
  const tok = boundedString(input.accessToken, MAX_TOKEN_LENGTH)
  const refreshToken = boundedString(input.refreshToken ?? '', MAX_TOKEN_LENGTH)
  const expiresAt = expiry(input.expiresAt)
  const refreshExpiresAt = expiry(input.refreshExpiresAt)
  const apiOrigin = input.apiOrigin

  if (typeof id !== 'string' || id.length === 0 || typeof region !== 'string' || uid === null || uin === null || displayName === null || phoneMasked === null || tok === null || tok.length === 0 || refreshToken === null || expiresAt === null || refreshExpiresAt === null || !API_ORIGINS.get(region)?.has(apiOrigin)) {
    throw storeError('MANAGED_ACCOUNT_INVALID')
  }

  return { id, region, uid, uin, displayName, phoneMasked, accessToken: tok, refreshToken, expiresAt, refreshExpiresAt, apiOrigin }
}

function validatePersistedAccount(input) {
  if (!isRecord(input) || Object.keys(input).length !== ACCOUNT_FIELDS.size || [...ACCOUNT_FIELDS].some((key) => !Object.prototype.hasOwnProperty.call(input, key)) || [...ACCOUNT_FIELDS].some((key) => input[key] === null)) {
    throw storeError('MANAGED_STORE_INVALID')
  }
  const account = normalizeAccount(input)
  if (typeof input.expiresAt !== 'number' || typeof input.refreshExpiresAt !== 'number') {
    throw storeError('MANAGED_STORE_INVALID')
  }
  return account
}

function validateDocument(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !['version', 'activeId', 'accounts'].includes(key)) || value.version !== VERSION || !Array.isArray(value.accounts)) {
    throw storeError('MANAGED_STORE_INVALID')
  }

  const accounts = value.accounts.map(validatePersistedAccount)
  const ids = new Set()
  for (const account of accounts) {
    if (ids.has(account.id)) throw storeError('MANAGED_STORE_INVALID')
    ids.add(account.id)
  }
  if (value.activeId !== null && (typeof value.activeId !== 'string' || !ids.has(value.activeId))) {
    throw storeError('MANAGED_STORE_INVALID')
  }

  return { version: VERSION, activeId: value.activeId, accounts }
}

function cloneAccount(account) {
  return { ...account }
}

function sameStableIdentity(left, right) {
  return left.region === right.region && (
    (left.uid !== '' && left.uid === right.uid) ||
    (left.uin !== '' && left.uin === right.uin)
  )
}

export function createManagedAccountStore({
  filePath,
  protector,
  readFile = readFileDefault,
  writeAtomic = writeCredentialAtomically,
} = {}) {
  if (typeof filePath !== 'string' || filePath === '' || typeof readFile !== 'function' || typeof writeAtomic !== 'function' || typeof protector?.protect !== 'function' || typeof protector?.unprotect !== 'function') {
    throw new TypeError('managed account store dependencies are required')
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
        throw storeError('MANAGED_STORE_READ_FAILED')
      }

      if (typeof ciphertext !== 'string' || ciphertext.length === 0) throw storeError('MANAGED_STORE_INVALID')
      let plaintext
      try {
        plaintext = await protector.unprotect(ciphertext)
      } catch {
        throw storeError('MANAGED_STORE_DECRYPT_FAILED')
      }
      if (typeof plaintext !== 'string') throw storeError('MANAGED_STORE_INVALID')

      let parsed
      try {
        parsed = JSON.parse(plaintext)
      } catch {
        throw storeError('MANAGED_STORE_INVALID')
      }
      return validateDocument(parsed)
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
      throw storeError('MANAGED_STORE_ENCRYPT_FAILED')
    }
    if (typeof ciphertext !== 'string' || ciphertext.length === 0) throw storeError('MANAGED_STORE_ENCRYPT_FAILED')
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeAtomic(filePath, ciphertext)
    } catch {
      throw storeError('MANAGED_STORE_WRITE_FAILED')
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
      return (await load()).accounts.map(cloneAccount)
    },
    async getById(id) {
      await writes
      const account = (await load()).accounts.find((item) => item.id === id)
      return account ? cloneAccount(account) : null
    },
    upsert(input) {
      return mutate(async (current) => {
        const incoming = normalizeAccount(input, { allowMissingId: true })
        const identityIndexes = current.accounts
          .map((account, index) => sameStableIdentity(account, incoming) ? index : -1)
          .filter((index) => index >= 0)
        if (identityIndexes.length > 1) throw storeError('MANAGED_ACCOUNT_IDENTITY_CONFLICT')
        const identityIndex = identityIndexes[0] ?? -1
        const idIndex = current.accounts.findIndex((account) => account.id === incoming.id)
        const index = identityIndex >= 0 ? identityIndex : idIndex
        const stableId = index >= 0 ? current.accounts[index].id : incoming.id

        if (idIndex >= 0 && idIndex !== index) throw storeError('MANAGED_ACCOUNT_ID_CONFLICT')
        const account = { ...incoming, id: stableId }
        const accounts = current.accounts.slice()
        if (index >= 0) accounts[index] = account
        else accounts.push(account)
        const next = { ...current, accounts }
        await persist(next)
        return cloneAccount(account)
      })
    },
    async getActiveId() {
      await writes
      return (await load()).activeId
    },
    setActiveId(id) {
      return mutate(async (current) => {
        if (id !== null && (typeof id !== 'string' || !current.accounts.some((account) => account.id === id))) {
          throw storeError('MANAGED_ACCOUNT_NOT_FOUND')
        }
        if (current.activeId === id) return id
        const next = { ...current, activeId: id }
        await persist(next)
        return id
      })
    },
  }
}
