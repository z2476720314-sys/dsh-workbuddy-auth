/**
 * agentmore 模型目录：动态拉 + 内置回退。
 *
 * 与 WorkBuddy 那份（`lib/model-catalog.mjs`）的差异：
 *   * 上游 `/operation/detail?tag=available_models` **需要签名头与 Bearer**，
 *     所以目录加载必须拿到凭据，不能匿名；
 *   * 上游不提供 contextWindow / maxTokens，模型元数据由 `parseModelList` 给保守默认值；
 *   * 目录**不可用不是错误**：回退到内置 GLM-5.3 / GLM-Flash 两项，
 *     让用户在目录接口抖动时仍然能发消息（这是用户明确选定的行为）。
 */
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AGENTMORE_FALLBACK_MODELS } from './agentmore-protocol.mjs'
import { parseModelList } from './agentmore-client.mjs'

/** 目录缓存 TTL：30 分钟（与 WorkBuddy 侧一致，便于两处行为对称）。 */
const TTL_MS = 30 * 60 * 1000
const TIMEOUT_MS = 10_000

/** 目录缓存默认路径：`<DSH_HOME>/storages/agentmore-models.cache`。 */
export function agentmoreCatalogCachePath({ env = process.env, home = homedir() } = {}) {
  const root = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(home, '.dsh')
  return join(root, 'storages', 'agentmore-models.cache')
}

/** 凭据作用域：换账号必须换缓存，否则会把 A 的模型列表给 B 用。 */
export function agentmoreScope(credential) {
  if (credential === null || credential === undefined) return null
  return createHash('sha256').update(JSON.stringify([credential.userId ?? '', credential.deviceId ?? '', credential.id ?? ''])).digest('hex')
}

/** 内置回退列表 → 与动态目录同形状。数值口径与 `parseModelList` 保持一致。 */
function fallbackModels() {
  return AGENTMORE_FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: 1_000_000,
    maxContextWindow: 1_000_000,
    maxTokens: 128_000,
    inputModalities: ['text'],
    // 官方三档：low / high / max，默认 max。
    reasoningEfforts: model.reasoning ? ['low', 'high', 'max'] : [],
    defaultReasoningEffort: model.reasoning ? 'max' : null,
  }))
}

/**
 * 从缓存文件恢复。只恢复"模型元数据"，绝不缓存 token 或签名头。
 * 与 scopeKey 不匹配、版本不符、文件损坏都静默忽略。
 */
async function readCache(filePath, scopeKey, now) {
  if (!filePath) return null
  try {
    const stored = JSON.parse(await readFile(filePath, 'utf8'))
    // 版本 2：口径从「128K 上下文 / 单档 default」改成「1M / 128K / low-high-max」。
    // 旧缓存里的 128000 与 'default' 必须失效，否则升级后仍旧显示错值。
    if (stored?.version !== 2 || stored.scopeKey !== scopeKey) return null
    if (!Number.isSafeInteger(stored.at) || stored.at < 0 || stored.at > now) return null
    if (!Array.isArray(stored.models)) return null
    return stored.models
  } catch {
    return null
  }
}

async function writeCache(filePath, scopeKey, at, models) {
  if (!filePath) return
  const temporary = `${filePath}.${randomUUID()}.tmp`
  // 只落模型元数据：模型 id / 名称 / 上下文与输出上限 / 模态 / effort。
  const stored = {
    version: 2,
    scopeKey,
    at,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxContextWindow: model.maxContextWindow,
      maxTokens: model.maxTokens,
      inputModalities: model.inputModalities,
      reasoningEfforts: model.reasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
    })),
  }
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, filePath)
  } catch {
    // 缓存写失败不得丢掉已经拿到的目录。
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/**
 * @param {object} options
 * @param {() => Promise<object|null>} options.readCredential 当前激活凭据
 * @param {(credential:object, signal?:AbortSignal) => Promise<Array>} options.fetchModels 真实拉取（应已带签名头）
 * @param {string} [options.cacheFile]
 */
export function createAgentmoreCatalog({ readCredential, fetchModels, cacheFile, now = Date.now, ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS } = {}) {
  let scope = null
  let cache = null
  let inFlight = null
  let epoch = 0

  const invalidate = ({ keepCache = false } = {}) => {
    epoch += 1
    if (!keepCache) { cache = null; scope = null }
    inFlight = null
  }

  const observe = (next) => {
    if (next === scope) return
    invalidate()
    scope = next
  }

  const snapshot = (models, { source, error, scopeKey }) => ({
    scopeKey,
    catalogSource: source,
    catalogError: error,
    models,
  })

  async function load({ force = false, signal } = {}) {
    let credential = null
    try {
      credential = await readCredential()
    } catch {
      credential = null
    }
    const scopeKey = agentmoreScope(credential)
    observe(scopeKey)

    // 没有凭据：目录接口要签名+Bearer，只能给回退列表。
    // 这不是错误态（用户还没登录时设置卡也要能显示可选项）。
    if (credential === null) {
      return snapshot(fallbackModels(), { source: 'fallback', error: null, scopeKey: null })
    }

    if (!force && cache !== null && now() - cache.at < ttlMs) {
      return snapshot(cache.models, { source: 'cache', error: null, scopeKey })
    }
    if (inFlight !== null) return inFlight

    const generation = epoch
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer
    const request = (async () => {
      let live = null
      let failure = null
      try {
        const models = await Promise.race([
          fetchModels(credential, controller?.signal),
          new Promise((_, reject) => {
            if (!controller) return
            timer = setTimeout(() => {
              // 先 reject 再 abort：abort 会让 fetch 立刻以自身的错误码失败，
              // 若顺序反过来，race 拿到的是 fetch 的通用错误，超时就被误判成 CATALOG_FAILED。
              reject(Object.assign(new Error('AGENTMORE_CATALOG_TIMEOUT'), { code: 'AGENTMORE_CATALOG_TIMEOUT' }))
              controller.abort()
            }, timeoutMs)
          }),
        ])
        if (Array.isArray(models) && models.length > 0) live = models
      } catch (error) {
        failure = error?.code === 'AGENTMORE_CATALOG_TIMEOUT' ? 'AGENTMORE_CATALOG_TIMEOUT' : 'AGENTMORE_CATALOG_FAILED'
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (generation !== epoch) return snapshot(fallbackModels(), { source: 'fallback', error: null, scopeKey })

      if (live !== null) {
        cache = { at: now(), models: live }
        await writeCache(cacheFile, scopeKey, cache.at, live)
        return snapshot(live, { source: 'live', error: null, scopeKey })
      }

      // 活取失败：先试磁盘缓存，再退回内置列表。
      const stored = await readCache(cacheFile, scopeKey, now())
      if (stored !== null && stored.length > 0) {
        cache = { at: now(), models: stored }
        return snapshot(stored, { source: 'cache', error: failure, scopeKey })
      }
      return snapshot(fallbackModels(), { source: 'fallback', error: failure, scopeKey })
    })().finally(() => {
      if (inFlight === request) inFlight = null
    })

    inFlight = request
    if (!signal) return request

    let onAbort
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(Object.assign(new Error('ABORTED'), { code: 'ABORTED' }))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try {
      return await Promise.race([request, cancelled])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  return { load, invalidate }
}

export { fallbackModels, parseModelList, TTL_MS }
