// 统一账号目录与激活上下文（Host-only）。
//   * 桌面 *.info 与 DPAPI 托管账号合并为同一份目录；对外只给安全 DTO（无路径、无令牌）。
//   * id 由 Host 生成：桌面为文件路径摘要（sourceId），托管为 `managed:` + 存储内 id。
//   * 只有「本次扫描」得到的 id 才能解析/激活；任何错误信息都不回显输入值（防止路径泄漏）。
//   * 激活与凭据文本读写共用同一个 active 上下文，供 sync / status / uidProvider 消费。
import { readdirSync, readFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { listCredentialSources, sourceId } from './multi-account.mjs'
import { MANAGED_ID_PREFIX as MANAGED_PREFIX } from './managed-store.mjs'
import { CN_BACKEND } from './origins.mjs'

const DESKTOP_REGION = 'cn'
// 激活锁的固定键：id 空间里不会出现这个字面量（桌面是路径摘要，托管带 `managed:` 前缀）。
const ACTIVATION_LOCK = '\u0000activation'
const UNKNOWN_SOURCE = 'unknown credential source'

/** 同一 key 串行、不同 key 互不阻塞的异步锁。 */
export function createKeyedLock() {
  const tails = new Map()
  return {
    run(key, task) {
      const previous = tails.get(key) ?? Promise.resolve()
      const next = previous.catch(() => {}).then(task)
      const tail = next.catch(() => {})
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return next
    },
  }
}

function tailOf(value, n) {
  if (typeof value !== 'string' || value === '') return ''
  return value.length <= n ? value : value.slice(-n)
}

/** 读取桌面目录顶层 *.info 的完整稳定身份（uid/uin），仅留在 Host 内部。 */
function scanDesktopIdentities(authDir) {
  const byId = new Map()
  let entries
  try {
    entries = readdirSync(authDir, { withFileTypes: true })
  } catch {
    return byId
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.info')) continue
    const filePath = join(authDir, entry.name)
    let raw
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      continue
    }
    byId.set(sourceId(filePath), {
      filePath,
      uid: typeof raw?.account?.uid === 'string' ? raw.account.uid : '',
      uin: typeof raw?.account?.uin === 'string' ? raw.account.uin : '',
    })
  }
  return byId
}

function toDto(entry) {
  return {
    id: entry.id,
    label: { nickname: entry.label.nickname, phoneMasked: entry.label.phoneMasked, uidTail: entry.label.uidTail },
    region: entry.region,
    source: entry.source,
    accessExpiresAt: entry.accessExpiresAt,
    // 加密信封（桌面端写出的密文凭据）与「已确认失效」都必须如实透出：
    // 设置卡据此把账号标注为「已加密 / 登录态已失效」，而不是让用户对着死凭据反复点。
    encrypted: entry.encrypted === true,
    stale: entry.stale === true,
  }
}

/** 托管记录 → 与桌面 .info 同形的凭据文本（供 sync / status 解析）。 */
function managedToText(record) {
  const tok = record.accessToken
  return JSON.stringify({
    auth: {
      accessToken: tok,
      refreshToken: record.refreshToken,
      expiresAt: record.expiresAt,
      refreshExpiresAt: record.refreshExpiresAt,
    },
    account: { uid: record.uid, uin: record.uin, nickname: record.displayName, phoneNumber: record.phoneMasked },
  })
}

/**
 * @param {{
 *   authDir: string,
 *   managedStore?: ReturnType<typeof import('./managed-store.mjs').createManagedAccountStore>,
 *   initialDesktopFile?: string,
 *   persistDesktopSelection?: (filePath: string) => Promise<boolean>,
 *   readFile?: (path: string) => Promise<string>,
 *   writeFile?: (path: string, text: string) => Promise<void>,
 *   rejectedIds?: () => Set<string>,
 * }} deps
 */
export function createAccountManager({
  authDir,
  managedStore,
  initialDesktopFile = '',
  persistDesktopSelection = async () => false,
  readFile = (path) => readFileAsync(path, 'utf8'),
  writeFile,
  rejectedIds,
} = {}) {
  let activeDesktopFile = initialDesktopFile
  let activeUid = ''
  // 已知被上游拒绝（401/403）的账号 id 集合；由调用方注入（落盘记录的唯一读取者）。
  const rejectedNow = () => (typeof rejectedIds === 'function' ? rejectedIds() : new Set())
  // 同步可读的激活上下文快照（地区 / origin / 认证域 / uid）。
  // 为什么必须是**同步**可读的：fetch 包装层与刷新头构造在发请求的那一瞬间就要决定
  // 「打哪个地区、带哪套头」，没有 await 的机会；异步扫描只能用来**刷新**这份快照。
  /** @type {{accountId:string,region:string,apiOrigin:string,authHost:string,uid:string}} */
  const context = { accountId: '', region: '', apiOrigin: '', authHost: '', uid: '' }
  const lock = createKeyedLock()

  /** 用条目信息刷新同步上下文（条目来自本次扫描，路径等内部字段不外泄）。 */
  function rememberContext(accountId, entry) {
    context.accountId = typeof accountId === 'string' ? accountId : ''
    context.region = entry?.region === 'intl' ? 'intl' : entry?.region === 'cn' ? 'cn' : ''
    context.apiOrigin = typeof entry?.apiOrigin === 'string' ? entry.apiOrigin : ''
    // 认证域优先取托管记录里的 domain 信息源：记录只存 apiOrigin，故这里用它的 host。
    context.authHost = typeof entry?.authHost === 'string' ? entry.authHost : ''
    context.uid = typeof entry?.uid === 'string' ? entry.uid : ''
  }

  /** 托管记录 → 同步上下文（region + apiOrigin 足以解析 origin）。 */
  function rememberManagedContext(record) {
    context.accountId = `${MANAGED_PREFIX}${record.id}`
    context.region = record.region === 'intl' ? 'intl' : 'cn'
    context.apiOrigin = typeof record.apiOrigin === 'string' ? record.apiOrigin : ''
    context.authHost = ''
    context.uid = typeof record.uid === 'string' ? record.uid : ''
  }

  async function managedRecords() {
    if (!managedStore) return []
    try {
      return await managedStore.list()
    } catch {
      // 托管存储不可用（解密失败等）按「无托管账号」降级，绝不让目录或状态路由抛错。
      return []
    }
  }

  /** 托管记录只更新令牌与到期字段：身份、id、地区、origin 一律保持。 */
  async function writeManagedTokens(record, text) {
    let auth = {}
    try {
      auth = JSON.parse(text)?.auth ?? {}
    } catch {
      auth = {}
    }
    const tok = auth.accessToken
    await managedStore.upsert({
      ...record,
      accessToken: tok,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresAt,
      refreshExpiresAt: auth.refreshExpiresAt,
    })
  }

  /** 一次新鲜合并扫描：返回带内部字段的条目（路径/存储 id 不出 Host）。 */
  async function scan() {
    // 每次扫描都重新取一次 rejected 集合：用户刚被 401 拒绝过的账号要立刻显示为失效。
    const rejected = rejectedNow()
    const desktopDtos = authDir ? listCredentialSources(authDir, { rejectedIds: rejected }) : []
    const identities = authDir ? scanDesktopIdentities(authDir) : new Map()
    const managed = await managedRecords()

    const managedByStableId = new Map()
    for (const record of managed) {
      if (record.uid) managedByStableId.set(`${record.region}\u0000uid\u0000${record.uid}`, record)
      if (record.uin) managedByStableId.set(`${record.region}\u0000uin\u0000${record.uin}`, record)
    }

    const entries = []
    const desktopMergedInto = new Map()
    for (const [id, meta] of identities) {
      // 去重只认 region + 稳定 uid/uin；缺少稳定身份绝不推测合并。
      const hit =
        (meta.uid && managedByStableId.get(`${DESKTOP_REGION}\u0000uid\u0000${meta.uid}`)) ||
        (meta.uin && managedByStableId.get(`${DESKTOP_REGION}\u0000uin\u0000${meta.uin}`))
      if (hit) {
        desktopMergedInto.set(id, hit)
      }
    }
    for (const dto of desktopDtos) {
      const meta = identities.get(dto.id)
      if (meta === undefined || desktopMergedInto.has(dto.id)) continue
      entries.push({
        id: dto.id,
        source: 'desktop',
        region: DESKTOP_REGION,
        apiOrigin: CN_BACKEND,
        label: dto.label,
        accessExpiresAt: dto.accessExpiresAt,
        filePath: meta.filePath,
        uid: meta.uid,
        encrypted: dto.encrypted === true,
        stale: dto.stale === true,
      })
    }
    for (const record of managed) {
      const managedId = `${MANAGED_PREFIX}${record.id}`
      entries.push({
        id: managedId,
        source: 'managed',
        region: record.region,
        apiOrigin: typeof record.apiOrigin === 'string' ? record.apiOrigin : '',
        label: {
          nickname: record.displayName.slice(0, 64),
          phoneMasked: record.phoneMasked,
          uidTail: tailOf(record.uid, 4),
        },
        accessExpiresAt: Number.isFinite(Number(record.expiresAt)) ? Number(record.expiresAt) : 0,
        storeId: record.id,
        uid: record.uid,
        // 托管记录本身就是明文（我们自己的加密库），不存在信封；失效同样要如实标注。
        encrypted: false,
        stale: rejected.has(managedId),
      })
    }
    entries.sort((a, b) => a.label.nickname.localeCompare(b.label.nickname, 'zh-CN') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    // identities 只留在 Host 内部：writeActiveText 需要按 id 反查桌面文件路径。
    return { entries, desktopMergedInto, identities, managed }
  }

  /** 当前激活账号的 id：托管 activeId 优先；否则桌面激活文件（若被合并则指向托管代表）。 */
  async function activeIdOf(scanned) {
    const storeActive = managedStore ? await managedStore.getActiveId() : null
    if (storeActive !== null && scanned.managed.some((record) => record.id === storeActive)) {
      return `${MANAGED_PREFIX}${storeActive}`
    }
    if (activeDesktopFile === '') return ''
    const desktopId = sourceId(activeDesktopFile)
    const merged = scanned.desktopMergedInto.get(desktopId)
    if (merged !== undefined) return `${MANAGED_PREFIX}${merged.id}`
    return scanned.entries.some((entry) => entry.id === desktopId) ? desktopId : ''
  }

  return {
    /** 安全目录：{activeId, sources}，sources 为确定性排序的 DTO。 */
    async describe() {
      const scanned = await scan()
      return { activeId: await activeIdOf(scanned), sources: scanned.entries.map(toDto) }
    },

    /** 只接受本次扫描得到的 id；其余（含路径）一律拒绝，错误不回显输入。 */
    async resolve(id) {
      const scanned = await scan()
      const entry = typeof id === 'string' && id !== '' ? scanned.entries.find((item) => item.id === id) : undefined
      if (entry === undefined) throw new Error(UNKNOWN_SOURCE)
      return toDto(entry)
    },

    /** 当前激活账号的 DTO；没有可用激活账号时为 null。 */
    async current() {
      const scanned = await scan()
      const activeId = await activeIdOf(scanned)
      const entry = scanned.entries.find((item) => item.id === activeId)
      return entry === undefined ? null : toDto(entry)
    },

    /**
     * 激活：
     *   * 桌面：读通过才切换；清除托管 activeId（避免重启后误回托管）；经 persistDesktopSelection 写回 patch。
     *   * 托管：activeId 写入加密存储；不写 patch。
     */
    async activate(id) {
      const scanned = await scan()
      const entry = typeof id === 'string' && id !== '' ? scanned.entries.find((item) => item.id === id) : undefined
      if (entry === undefined) throw new Error(UNKNOWN_SOURCE)

      // 固定锁键：激活改的是**全局** active 上下文，不是某个账号的内部状态。
      // 按目标 id 加锁会让两次并发激活（不同 id）交错提交 —— 落盘的 active 与响应回显不一致。
      return lock.run(ACTIVATION_LOCK, async () => {
        if (entry.source === 'desktop') {
          const probe = await readFile(entry.filePath)
          if (typeof probe !== 'string' || probe === '') throw new Error(UNKNOWN_SOURCE)
          activeDesktopFile = entry.filePath
          activeUid = entry.uid
          rememberContext(id, entry)
          if (managedStore) await managedStore.setActiveId(null)
          let persisted = false
          try {
            persisted = (await persistDesktopSelection(entry.filePath)) === true
          } catch {
            persisted = false
          }
          return { ok: true, activeId: id, persisted }
        }
        await managedStore.setActiveId(entry.storeId)
        activeUid = entry.uid
        rememberContext(id, entry)
        return { ok: true, activeId: id, persisted: true }
      })
    },

    /**
     * 当前激活账号的凭据文本 + **读到时**的账号 id。
     *
     * 返回 accountId 是「身份钉住」的前提：刷新往返期间激活账号可能已经改变，
     * 写回必须落回**读它的那个账号**，而不是「写回时的当前激活账号」。
     */
    async readActive() {
      const storeActive = managedStore ? await managedStore.getActiveId() : null
      let record = storeActive === null ? null : await managedStore.getById(storeActive)
      if (record === null) {
        // Read the same canonical source shown by describe() after a same-identity login.
        record = (await scan()).desktopMergedInto.get(sourceId(activeDesktopFile)) ?? null
      }
      if (record !== null) {
        activeUid = record.uid
        rememberManagedContext(record)
        return { accountId: `${MANAGED_PREFIX}${record.id}`, text: managedToText(record) }
      }
      const text = await readFile(activeDesktopFile)
      try {
        activeUid = JSON.parse(text)?.account?.uid ?? ''
      } catch {
        activeUid = ''
      }
      context.accountId = sourceId(activeDesktopFile)
      context.region = DESKTOP_REGION
      context.apiOrigin = CN_BACKEND
      context.authHost = ''
      context.uid = activeUid
      return { accountId: sourceId(activeDesktopFile), text }
    },

    /**
     * **按账号 id 定点**读取凭据文本（不要求它是激活账号）。
     *
     * 用途：签到要对**所有**可用 CN 账号逐个发请求，不能只碰激活账号；与 writeActiveText
     * 同一套 id 空间，读到的 accountId 必须原样交给写回（身份钉住）。
     * 未知/空 id 一律拒绝，绝不退回「当前激活账号」。
     */
    async readById(accountId) {
      if (typeof accountId !== 'string' || accountId === '') throw new Error(UNKNOWN_SOURCE)
      if (accountId.startsWith(MANAGED_PREFIX)) {
        const record = managedStore ? await managedStore.getById(accountId.slice(MANAGED_PREFIX.length)) : null
        if (record === null) throw new Error(UNKNOWN_SOURCE)
        return { accountId, text: managedToText(record) }
      }
      const scanned = await scan()
      const merged = scanned.desktopMergedInto.get(accountId)
      if (merged !== undefined) return { accountId: `${MANAGED_PREFIX}${merged.id}`, text: managedToText(merged) }
      const meta = scanned.identities.get(accountId)
      const filePath = meta?.filePath ?? (sourceId(activeDesktopFile) === accountId ? activeDesktopFile : undefined)
      if (filePath === undefined) throw new Error(UNKNOWN_SOURCE)
      const text = await readFile(filePath)
      if (typeof text !== 'string' || text === '') throw new Error(UNKNOWN_SOURCE)
      return { accountId, text }
    },

    /**
     * 同步可读的激活上下文：刷新头构造与 fetch 路由改写要在发请求那一瞬间做决定，
     * 没有 await 的机会。快照由 readActive / activate / refreshContext 维护。
     */
    context() {
      return { ...context }
    },

    /** 用一次新鲜扫描刷新同步上下文（apply 启动预热、激活后调用）。 */
    async refreshContext() {
      const scanned = await scan()
      const activeId = await activeIdOf(scanned)
      const entry = scanned.entries.find((item) => item.id === activeId)
      if (entry === undefined) {
        context.accountId = ''
        context.region = ''
        context.apiOrigin = ''
        context.authHost = ''
        context.uid = ''
        return this.context()
      }
      rememberContext(entry.id, entry)
      return this.context()
    },

    /** 给定账号 id 是否就是此刻的激活账号（刷新回写据此决定要不要更新 seam）。 */
    async isActiveAccount(accountId) {
      if (typeof accountId !== 'string' || accountId === '') return false
      const scanned = await scan()
      return (await activeIdOf(scanned)) === accountId
    },

    /**
     * **按账号 id 定点**写回（不是「当前激活账号」）。
     *
     * 激活可能在刷新往返期间改变；按当前激活写回会把旧账号的凭据写进新账号 —— 令牌污染，
     * 且新账号的登录态被静默作废（review P1）。因此这里只认调用方读到的那个 id，
     * 未知/空 id 一律拒绝，绝不退回「当前激活账号」。
     */
    async writeActiveText(accountId, text) {
      if (typeof accountId !== 'string' || accountId === '') throw new Error(UNKNOWN_SOURCE)
      const scanned = await scan()
      if (accountId.startsWith(MANAGED_PREFIX)) {
        const record = managedStore ? await managedStore.getById(accountId.slice(MANAGED_PREFIX.length)) : null
        if (record === null) throw new Error(UNKNOWN_SOURCE)
        await writeManagedTokens(record, text)
        return
      }
      // 桌面账号：文件可能已被去重合并进某个托管代表 —— 那要写托管代表，否则会造出一份陈旧副本。
      const merged = scanned.desktopMergedInto.get(accountId)
      if (merged !== undefined) {
        await writeManagedTokens(merged, text)
        return
      }
      const meta = scanned.identities.get(accountId)
      const filePath = meta?.filePath ?? (sourceId(activeDesktopFile) === accountId ? activeDesktopFile : undefined)
      if (filePath === undefined) throw new Error(UNKNOWN_SOURCE)
      if (typeof writeFile !== 'function') throw new Error('desktop writeback is not configured')
      await writeFile(filePath, text)
    },

    /** 同步可读的激活 uid（设置 uidProvider 用）；由 readActive / activate 维护。 */
    activeUidSync() {
      return activeUid
    },

    /** 同一账号 id 的 refresh / writeback / check-in 串行；不同 id 可并发。 */
    withAccountLock(key, task) {
      return lock.run(key, task)
    },
  }
}
