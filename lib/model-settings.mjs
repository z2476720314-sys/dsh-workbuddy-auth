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
export function modelSettingsPath(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'workbuddy-auth-models.json')
}
const defaults = () => ({ enabled: true, enabledModelIds: [], defaultReasoningEffort: null, contextWindowOverrides: {} })
export function validateModelPatch(patch) {
  const invalid = () => { throw modelError('WORKBUDDY_MODELS_INVALID') }
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
export function createModelSettingsStore({ filePath = modelSettingsPath() } = {}) {
  let queue = Promise.resolve()
  const read = async () => {
    let text
    try { text = await readFile(filePath, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return defaults()
      throw modelError('WORKBUDDY_MODELS_STORAGE', 500)
    }
    try {
      const parsed = validateModelPatch(JSON.parse(text))
      if (Object.values(parsed.contextWindowOverrides ?? {}).some((value) => value === null)) throw new Error('invalid stored override')
      return { ...defaults(), ...parsed, enabledModelIds: [...new Set(parsed.enabledModelIds ?? [])], contextWindowOverrides: { ...(parsed.contextWindowOverrides ?? {}) } }
    } catch { throw modelError('WORKBUDDY_MODELS_CORRUPT', 500) }
  }
  return {
    read,
    patch(patch) {
      let validated
      try { validated = structuredClone(validateModelPatch(patch)) } catch (error) { return Promise.reject(error) }
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
        } catch { throw modelError('WORKBUDDY_MODELS_STORAGE', 500) }
        finally { await unlink(temporary).catch(() => {}) }
        return next
      })
      queue = update.catch(() => {})
      return update
    },
  }
}
