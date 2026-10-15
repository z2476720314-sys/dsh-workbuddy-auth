import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createKeyedLock } from './account-manager.mjs'
import { isModelId, MODEL_EFFORTS, modelError } from './model-settings.mjs'
const positive = (n) => Number.isSafeInteger(n) && n > 0 ? n : null
export function credentialScope(credential) {
  return credential === null ? null : createHash('sha256').update(JSON.stringify([credential.backend, credential.region, credential.accountId, new Headers(credential.headers).get('x-user-id')])).digest('hex')
}
export function parseModelCatalog(payload, region) {
  if (payload === null || typeof payload !== 'object' || (payload.code !== undefined && ![0, '0'].includes(payload.code))) throw modelError('WORKBUDDY_CATALOG_FAILED', 502)
  const list = (payload.data ?? payload).models
  if (!Array.isArray(list)) throw modelError('WORKBUDDY_CATALOG_FAILED', 502)
  const seen = new Set(), models = []
  for (const entry of list) {
    if (!entry || !isModelId(entry.id) || seen.has(entry.id)) continue
    if (Array.isArray(entry.tags) && entry.tags.some((tag) => ['text-to-image', 'image-to-image'].includes(tag))) continue
    const maxContextWindow = positive(entry.maxAllowedSize) ?? positive(entry.maxInputTokens)
    const declaredContext = positive(entry.contextWindow?.defaultLength)
    const contextWindow = declaredContext ?? maxContextWindow
    if (contextWindow === null || (maxContextWindow !== null && contextWindow > maxContextWindow)) continue
    const reasoning = entry.reasoning ?? {}
    const reasoningEfforts = [...new Set((Array.isArray(reasoning.supportedEfforts) ? reasoning.supportedEfforts : [reasoning.effort]).filter((effort) => MODEL_EFFORTS.has(effort)))]
    const declaredDefault = reasoning.defaultEffort ?? reasoning.effort
    seen.add(entry.id)
    models.push({ id: entry.id, name: typeof entry.name === 'string' ? entry.name.slice(0, 160) : entry.id, region, contextWindow, maxContextWindow, maxTokens: positive(entry.maxOutputTokens), inputModalities: entry.supportsImages === true ? ['text', 'image'] : ['text'], reasoningEfforts, defaultReasoningEffort: reasoningEfforts.includes(declaredDefault) ? declaredDefault : null })
  }
  return models
}
const none = (region = null, error = null, scopeKey = null) => ({ region, catalogSource: 'none', catalogError: error, models: [], scopeKey })
const cacheWrites = createKeyedLock()
export function createModelCatalog({ readCredential, fetchImpl = fetch, cacheFile, timeoutMs = 10000, ttlMs = 1800000, now = Date.now, onAccountChange = () => {} }) {
  let scope = null, epoch = 0, cache = null, inFlight = null, activeController = null
  const invalidate = ({ keepCache = false } = {}) => { epoch++; if (!keepCache) { cache = null; scope = null }; inFlight = null; activeController?.abort(); activeController = null }
  const observe = (next) => {
    if (next === scope) return
    invalidate(); scope = next; onAccountChange()
  }
  async function load({ force = false, signal } = {}) {
    if (signal?.aborted) throw modelError('ABORTED', 499)
    let credential
    try { credential = await readCredential() } catch { credential = null }
    const key = credentialScope(credential)
    observe(key)
    if (credential === null) return none()
    if (!force && cache && now() - cache.at < ttlMs) return { ...cache.value, catalogSource: 'cache' }
    if (!inFlight) {
      const generation = epoch
      const controller = new AbortController()
      activeController = controller
      let timer
      const work = async () => {
        const res = await fetchImpl(credential.backend + '/v3/config', { method: 'GET', headers: credential.headers, signal: controller.signal })
        if (!res.ok) throw modelError('WORKBUDDY_CATALOG_FAILED', 502)
        return parseModelCatalog(await res.json(), credential.region)
      }
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const error = modelError('WORKBUDDY_CATALOG_TIMEOUT', 504); controller.abort(error); reject(error) }, timeoutMs) })
      const request = Promise.race([work(), timeout, aborted]).then(async (models) => {
        const current = await readCredential().catch(() => null)
        if (generation !== epoch || credentialScope(current) !== key) return none()
        const value = { region: credential.region, catalogSource: 'live', catalogError: null, models, scopeKey: key }
        cache = { at: now(), value }
        if (cacheFile) {
          await cacheWrites.run(resolve(cacheFile), async () => {
            if (generation !== epoch) return
            const temporary = cacheFile + '.' + randomUUID() + '.tmp'
            // Persist only model metadata; the upstream config and credential headers may contain secrets.
            const stored = { version: 1, scopeKey: key, at: cache.at, models: models.map((model) => ({
              id: model.id, name: model.name, maxAllowedSize: model.maxContextWindow,
              contextWindow: { defaultLength: model.contextWindow }, maxOutputTokens: model.maxTokens,
              supportsImages: model.inputModalities.includes('image'),
              reasoning: { supportedEfforts: model.reasoningEfforts, defaultEffort: model.defaultReasoningEffort },
            })) }
            try {
              await mkdir(dirname(cacheFile), { recursive: true })
              await writeFile(temporary, JSON.stringify(stored) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
              if (generation !== epoch) return
              await rename(temporary, cacheFile)
            } catch { /* A cache write must not discard a successfully fetched catalog. */ }
            finally { await unlink(temporary).catch(() => {}) }
          })
        }
        if (generation !== epoch) return none()
        return value
      }).catch(async (error) => {
        const current = await readCredential().catch(() => null)
        if (generation !== epoch || credentialScope(current) !== key) return none()
        if (!cache && cacheFile) {
          try {
            const stored = JSON.parse(await readFile(cacheFile, 'utf8'))
            if (stored.version === 1 && stored.scopeKey === key && Number.isSafeInteger(stored.at) && stored.at >= 0 && stored.at <= now()) {
              const models = parseModelCatalog({ data: stored }, credential.region)
              if (generation !== epoch) return none()
              if (models.length === stored.models.length) cache = { at: stored.at, value: { region: credential.region, catalogSource: 'cache', catalogError: null, models, scopeKey: key } }
            }
          } catch { /* Missing or corrupt cache leaves the original catalog error visible. */ }
        }
        if (generation !== epoch) return none()
        const code = error?.code === 'WORKBUDDY_CATALOG_TIMEOUT' ? error.code : 'WORKBUDDY_CATALOG_FAILED'
        return cache ? { ...cache.value, catalogSource: 'cache', catalogError: code } : none(credential.region, code, key)
      }).finally(() => { clearTimeout(timer); if (inFlight === request) inFlight = null; if (activeController === controller) activeController = null })
      inFlight = request
    }
    if (!signal) return inFlight
    let aborted
    const cancelled = new Promise((_, reject) => { aborted = () => reject(modelError('ABORTED', 499)); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted() })
    try { return await Promise.race([inFlight, cancelled]) } finally { signal.removeEventListener('abort', aborted) }
  }
  return { load, invalidate }
}
