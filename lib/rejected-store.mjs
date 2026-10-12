// 「已被上游拒绝（401/403）」的账号 id 集合 —— 小 JSON 文件，读写全程容错。
//
// 为什么必须记下来：每次成功刷新都会**轮换** refresh token，历史备份文件里的 refresh token
// 因此立即作废；而备份文件里的 expiresAt 可能是伪造的远期值（真实回归：备份写 2027，
// 用户点过去、再点刷新，永远只有 401）。把「已确认失效」落盘后，切换区就能如实标注，
// 而不是让用户在同一份死凭据上反复撞墙。
//
// 容错约定：文件缺失/损坏/不可写一律降级为空集合或静默失败，绝不让插件装载或路由失败。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * id 白名单：桌面账号 = multi-account.mjs 的 sourceId（sha256 前 16 位 hex），
 * 托管账号 = `managed:<uuid>`。两者都只当**集合成员**用，从不拼进路径，
 * 因此这里只需挡住「不像 id 的脏值」，不必做路径级校验。
 */
const ID_RX = /^(?:managed:)?[0-9a-fA-F-]{1,64}$/
const MAX_IDS = 64

/**
 * 解析 rejected 文件路径。
 *   * 显式字符串原样采用（空串 = 显式关闭该特性）；
 *   * 未配置时落在 DSH 主目录的 storages 下（与其它插件的 storages 同处一地）。
 *
 * @param {{rejectedFile?:string}} [config]
 * @param {Record<string,string|undefined>} [env]
 * @returns {string} 空串表示关闭
 */
export function resolveRejectedFile(config = {}, env = process.env) {
  if (typeof config.rejectedFile === 'string') return config.rejectedFile
  const home = env?.DSH_HOME ?? (env?.USERPROFILE === undefined ? '' : `${env.USERPROFILE}\\.dsh`)
  if (home === '') return ''
  return `${home}\\storages\\workbuddy-auth-rejected.json`
}

function readIds(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id) => typeof id === 'string' && ID_RX.test(id)).slice(0, MAX_IDS)
  } catch {
    return []
  }
}

function writeIds(filePath, ids) {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(ids.slice(0, MAX_IDS)), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 造一个 rejected 集合读写器。
 *
 * @param {string} filePath 空串 → 所有写操作都是 no-op，list() 恒为空（特性关闭）
 * @returns {{list:()=>string[], mark:(id:string)=>void, clear:(id:string)=>void, has:(id:string)=>boolean}}
 */
export function createRejectedStore(filePath) {
  if (typeof filePath !== 'string' || filePath === '') {
    return { list: () => [], mark: () => {}, clear: () => {}, has: () => false }
  }
  const has = (id) => typeof id === 'string' && id !== '' && readIds(filePath).includes(id)
  return {
    list: () => readIds(filePath),
    has,
    mark(id) {
      if (typeof id !== 'string' || !ID_RX.test(id)) return
      const ids = readIds(filePath)
      if (ids.includes(id)) return
      ids.push(id)
      writeIds(filePath, ids)
    },
    clear(id) {
      if (typeof id !== 'string' || id === '') return
      const ids = readIds(filePath)
      const next = ids.filter((value) => value !== id)
      if (next.length === ids.length) return
      writeIds(filePath, next)
    },
  }
}
