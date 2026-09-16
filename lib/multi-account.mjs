// 多账号凭据源选择（Host-only）。安全契约与既有模块一致：
//   * 任何输出（列表/状态/日志）都不得含 accessToken / refreshToken；
//   * id 是文件路径的不可逆摘要（sha256 前 16 hex），路径本身不进响应；
//   * 目录不可读/文件坏一律降级为跳过或空数组，绝不抛到路由层。
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** id = 文件绝对路径的 sha256 前 16 位（不可逆，避免把本机路径带给浏览器）。 */
function sourceId(filePath) {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

function maskPhone(value) {
  if (typeof value !== 'string' || value.length < 7) return ''
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

function tail(value, n) {
  if (typeof value !== 'string' || value === '') return ''
  return value.length <= n ? value : value.slice(-n)
}

/** 解析单个凭据文件的**脱敏**展示字段；任何解析失败都返回 null（调用方跳过）。 */
function describeFile(filePath, readFileUtf8Sync) {
  let raw
  try {
    raw = JSON.parse(readFileUtf8Sync(filePath))
  } catch {
    return null
  }
  const account = raw?.account
  const auth = raw?.auth
  if (typeof auth?.accessToken !== 'string' || auth.accessToken === '') return null
  const nickname = typeof account?.nickname === 'string' ? account.nickname.slice(0, 64) : ''
  const phoneMasked = maskPhone(account?.phoneNumber)
  const uidTail = tail(typeof account?.uid === 'string' ? account.uid : '', 4)
  return {
    id: sourceId(filePath),
    label: { nickname, uidTail, phoneMasked },
    // expiresAt 供排序/展示；不是机密。
    accessExpiresAt: Number.isFinite(Number(auth?.expiresAt)) ? Number(auth.expiresAt) : 0,
  }
}

/**
 * 扫描 auth 目录**顶层**的 *.info 凭据文件，返回脱敏账号列表。
 * 只扫顶层：子目录是 CodeBuddy 内部结构，不属于账号登录态。
 * 目录缺失/不可读 → 空数组（路由层据此渲染「未发现账号」）。
 *
 * @param {string} authDir
 * @param {{readFileUtf8Sync?:(path:string)=>string}} [deps]
 * @returns {{id:string,label:{nickname:string,uidTail:string,phoneMasked:string},accessExpiresAt:number}[]}
 */
export function listCredentialSources(authDir, deps = {}) {
  const readFileUtf8Sync = deps.readFileUtf8Sync ?? ((path) => readFileSync(path, 'utf8'))
  let entries
  try {
    entries = readdirSync(authDir, { withFileTypes: true })
  } catch {
    return []
  }
  const sources = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith('.info')) continue
    const filePath = join(authDir, entry.name)
    try {
      if (!statSync(filePath).isFile()) continue
    } catch {
      continue
    }
    const described = describeFile(filePath, readFileUtf8Sync)
    if (described === null) continue
    sources.push(described)
  }
  sources.sort((a, b) => a.label.nickname.localeCompare(b.label.nickname, 'zh-CN'))
  return sources
}

/**
 * 账号选择器：持有「当前激活的凭据文件路径」的可变引用。
 *
 * 与既有 config.credentialFile 的关系：
 *   * 初始值 = config.credentialFile ?? DEFAULT_CREDENTIAL_FILE；
 *   * activate() 立即更新内存引用（下一次读凭据即新文件），随后触发 reloadSeam 把
 *     新 token 写进凭据 seam；persist() 异步把新路径写回插件配置（重启后保持）。
 *   * persist 失败不影响运行时切换（下次重启会回到旧配置，属于可接受的降级并如实上报）。
 *
 * @param {{
 *   authDir: string,
 *   readFile: (path:string)=>Promise<string>,
 *   writeFile: (path:string,text:string)=>Promise<void>,
 *   reloadSeam: ()=>Promise<unknown>,
 *   persist: (filePath:string)=>Promise<void>,
 *   readFileUtf8Sync?: (path:string)=>string,
 *   initialFile?: string,
 * }} deps
 */
export function createAccountSelector(deps) {
  let activeFile = deps.initialFile ?? ''
  const readFileUtf8Sync = deps.readFileUtf8Sync

  const sources = () => listCredentialSources(deps.authDir, { readFileUtf8Sync })

  return {
    /** 当前激活文件的绝对路径（Host 内部用，不进响应体）。 */
    get activeFile() {
      return activeFile
    },

    /** 脱敏列表 + 当前激活 id。 */
    describe() {
      const list = sources()
      return {
        activeId: activeFile === '' ? '' : sourceId(activeFile),
        sources: list,
      }
    },

    /**
     * 切换激活账号：
     *   1. id 必须命中本次扫描列表（未知 id 一律拒绝，不接受任意路径）；
     *   2. 更新内存引用 → 触发一次 seam 重载（新 token 立即对推理生效）；
     *   3. 异步 persist 新路径（失败仅标记 persisted:false，不回滚内存状态）。
     */
    async activate(id) {
      if (typeof id !== 'string' || id === '') throw new Error('unknown credential source: ' + String(id).slice(0, 8))
      const list = sources()
      // 由 id 反查路径：扫描列表是唯一受信任的路径来源（拒绝任意路径注入）。
      const authDirFiles = list.map((source) => source.id)
      if (!authDirFiles.includes(id)) throw new Error(`unknown credential source: ${id}`)
      // 重新扫一遍拿路径（listCredentialSources 不回传路径，避免泄漏）；
      // 这里通过再次读取目录并比对 id 找回 filePath —— 该实现细节只存在于 Host 内存。
      let targetPath = ''
      try {
        const { readdirSync: readdir } = await import('node:fs')
        for (const entry of readdir(deps.authDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.info')) continue
          const filePath = join(deps.authDir, entry.name)
          if (sourceId(filePath) === id) { targetPath = filePath; break }
        }
      } catch {
        /* 扫描失败 → targetPath 保持空串，走下面的 unknown 分支 */
      }
      if (targetPath === '') throw new Error(`unknown credential source: ${id}`)

      // 先确认新文件可读可解析（读一次原文），避免把不可用路径设为激活。
      const probe = await deps.readFile(targetPath)
      if (typeof probe !== 'string' || probe === '') throw new Error(`unknown credential source: ${id}`)

      const previousFile = activeFile
      activeFile = targetPath
      let persisted = true
      try {
        await deps.persist(targetPath)
      } catch {
        persisted = false
      }
      await deps.reloadSeam()
      return { ok: true, activeId: id, previousFileReverted: false, persisted, ...(previousFile === '' ? {} : {}) }
    },
  }
}
