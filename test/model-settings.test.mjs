import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelSettingsStore, modelSettingsPath } from '../lib/model-settings.mjs'
const defaults = { enabled: true, enabledModelIds: [], defaultReasoningEffort: null, contextWindowOverrides: {} }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-model-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'models.json')
  return { filePath, store: createModelSettingsStore({ filePath }) }
}
test('missing settings defaults to zero selected; path belongs to this plugin', async (t) => {
  const { store } = await fixture(t)
  assert.deepEqual(await store.read(), defaults)
  assert.equal(modelSettingsPath({ DSH_HOME: 'X:/fixture' }), join('X:/fixture', 'storages', 'workbuddy-auth-models.json'))
})
test('serial patches preserve fields, deduplicate ids and restart', async (t) => {
  const { store, filePath } = await fixture(t)
  await Promise.all([store.patch({ enabled: false }), store.patch({ enabledModelIds: ['a', 'a', 'unknown'] }), store.patch({ defaultReasoningEffort: 'high' })])
  assert.deepEqual(await createModelSettingsStore({ filePath }).read(), { ...defaults, enabled: false, enabledModelIds: ['a', 'unknown'], defaultReasoningEffort: 'high' })
})
test('null removes one context override without losing others', async (t) => {
  const { store } = await fixture(t)
  await store.patch({ contextWindowOverrides: { a: 32000, b: 1000 } })
  await store.patch({ contextWindowOverrides: { a: null } })
  assert.deepEqual((await store.read()).contextWindowOverrides, { b: 1000 })
})
test('invalid patches fail without changing persisted preference', async (t) => {
  const { store } = await fixture(t)
  for (const patch of [null, [], { enabled: 'true' }, { enabledModelIds: [1] }, { defaultReasoningEffort: 'off' }, { extra: 1 }, { contextWindowOverrides: { a: 0 } }, { contextWindowOverrides: { a: 1.5 } }, JSON.parse('{"contextWindowOverrides":{"__proto__":12}}')]) {
    await assert.rejects(store.patch(patch), { code: 'WORKBUDDY_MODELS_INVALID' })
  }
  assert.deepEqual(await store.read(), defaults)
})
test('corrupt and invalid files are reported and never overwritten', async (t) => {
  const { store, filePath } = await fixture(t)
  for (const text of ['{broken', '{"enabledModelIds":"all"}', '{"enabled":true,"unexpected":"not-a-setting"}']) {
    await writeFile(filePath, text)
    await assert.rejects(store.read(), { code: 'WORKBUDDY_MODELS_CORRUPT' })
    await assert.rejects(store.patch({ enabled: false }), { code: 'WORKBUDDY_MODELS_CORRUPT' })
    assert.equal(await readFile(filePath, 'utf8'), text)
  }
})
