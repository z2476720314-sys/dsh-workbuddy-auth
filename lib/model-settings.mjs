import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const MODEL_EFFORTS = new Set(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'none'])
const FIELDS = new Set(['enabled', 'enabledModelIds', 'defaultReasoningEffort', 'contextWindowOverrides'])
export const isModelId = (id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(id)
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export function modelError(code, status = 400) {
  return Object.assign(new Error(code), { code, status, exposeStatus: true })
}
/** agentmore 的模型偏好单独落盘：两个订阅点的模型 id 空间不同，共用一个文件会互相覆盖。 */
export function agentmoreModelSettingsPath(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'agentmore-models.json')
}
export function modelSettingsPath(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'workbuddy-auth-models.json')
}
const defaults = () => ({ enabled: true, enabledModelIds: [], defaultReasoningEffort: null, contextWindowOverrides: {} })
/**
 * `prefix` 只影响错误码命名（`WORKBUDDY_MODELS_INVALID` / `AGENTMORE_MODELS_INVALID`）。
 *
 * 为什么共用一份实现而不是各写一份：校验规则（id 正则、上限、`__proto__` 防护、
 * 原子写、串行化队列）一旦分叉，就会出现「A 订阅点能存、B 订阅点存不进去」这类
 * 只在一个上游复现的怪 bug。默认值保持 `WORKBUDDY`，既有调用方与测试逐字不变。
 */
export function validateModelPatch(patch, prefix = 'WORKBUDDY') {
  const invalid = () => { throw modelError(`${prefix}_MODELS_INVALID`) }
  if (!record(patch) || Object.keys(patch).some((key) => !FIELDS.has(key))) invalid()
  if ('enabled' in patch && typeof patch.enabled !== 'boolean') invalid()
  if ('enabledModelIds' in patch && (!Array.isArray(patch.enabledModelIds) || patch.enabledModelIds.length > 512 || patch.enabledModelIds.some((id) => !isModelId(id)))) invalid()
  if ('defaultReasoningEffort' in patch && patch.defaultReasoningEffort !== null && !MODEL_EFFORTS.has(patch.defaultReasoningEffort)) invalid()
  if ('contextWindowOverrides' in patch) {
    if (!record(patch.contextWindowOverrides) || Object.keys(patch.contextWindowOverrides).length > 512) invalid()
    for (const [id, size] of Object.entries(patch.contextWindowOverrides)) {
      if (!isModelId(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || (size !== null && (!Number.isSafeInteger(size) || size <= 0))) invalid()
    }
  }
  return patch
}
export function createModelSettingsStore({ filePath = modelSettingsPath(), prefix = 'WORKBUDDY' } = {}) {
  let queue = Promise.resolve()
  const read = async () => {
    let text
    try { text = await readFile(filePath, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return defaults()
      throw modelError(`${prefix}_MODELS_STORAGE`, 500)
    }
    try {
      const parsed = validateModelPatch(JSON.parse(text), prefix)
      if (Object.values(parsed.contextWindowOverrides ?? {}).some((value) => value === null)) throw new Error('invalid stored override')
      return { ...defaults(), ...parsed, enabledModelIds: [...new Set(parsed.enabledModelIds ?? [])], contextWindowOverrides: { ...(parsed.contextWindowOverrides ?? {}) } }
    } catch { throw modelError(`${prefix}_MODELS_CORRUPT`, 500) }
  }
  return {
    read,
    patch(patch) {
      let validated
      try { validated = structuredClone(validateModelPatch(patch, prefix)) } catch (error) { return Promise.reject(error) }
      const update = queue.then(async () => {
        const current = await read()
        const overrides = { ...current.contextWindowOverrides }
        for (const [id, size] of Object.entries(validated.contextWindowOverrides ?? {})) {
          if (size === null) delete overrides[id]
          else overrides[id] = size
        }
        const next = { ...current, ...validated, enabledModelIds: [...new Set(validated.enabledModelIds ?? current.enabledModelIds)], contextWindowOverrides: overrides }
        const temporary = filePath + '.' + randomUUID() + '.tmp'
        try {
          await mkdir(dirname(filePath), { recursive: true })
          await writeFile(temporary, JSON.stringify(next) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
          await rename(temporary, filePath)
        } catch { throw modelError(`${prefix}_MODELS_STORAGE`, 500) }
        finally { await unlink(temporary).catch(() => {}) }
        return next
      })
      queue = update.catch(() => {})
      return update
    },
  }
}
