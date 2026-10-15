import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerRoutes } from '../lib/routes.mjs'
import { createModelSettingsStore } from '../lib/model-settings.mjs'
import { createModelService } from '../lib/model-adapter.mjs'

const model = { id: 'fixture-model', name: 'Fixture', contextWindow: 32000, maxContextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }
const prefix = '/api/dsh-workbuddy-auth'
const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-model-routes-')); t.after(() => rm(dir, { recursive: true, force: true }))
  let notices = 0, failed = false, loads = 0, invalidations = 0
  const settings = createModelSettingsStore({ filePath: join(dir, 'models.json') })
  const models = createModelService({ settings, catalog: { load: async ({ force = false } = {}) => { loads++; return { models: [model], region: 'cn', catalogSource: failed ? 'cache' : 'live', catalogError: failed ? 'TIMEOUT' : null } }, invalidate: () => { invalidations++ } }, notify: () => { notices++ } })
  models.registration(true)
  const routes = [], ctx = { webServer: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } } }
  const dispose = registerRoutes(ctx, { models })
  const call = async (path, method = 'GET', body, customHeaders = headers) => {
    let output, status
    const req = { method, headers: customHeaders, setEncoding() {}, resume() {}, on(event, handler) { if (event === 'data') queueMicrotask(() => handler(typeof body === 'string' ? body : JSON.stringify(body))); if (event === 'end') queueMicrotask(handler); return this } }
    await routes.find((route) => route.path === prefix + path).handler(req, { writeHead(code) { status = code }, end(text) { output = JSON.parse(text) } })
    return { status, output }
  }
  return { models, settings, routes, dispose, call, notices: () => notices, loads: () => loads, fail: () => { failed = true }, invalidations: () => invalidations }
}

test('zero-selection production service registers both paths and returns complete top-level DTO', async (t) => {
  const f = await fixture(t)
  assert.ok(f.routes.some((route) => route.path === prefix + '/models'))
  assert.ok(f.routes.some((route) => route.path === prefix + '/models/refresh'))
  const { status, output } = await f.call('/models')
  assert.equal(status, 200)
  assert.deepEqual(Object.keys(output).sort(), ['ok', 'enabled', 'enabledModelIds', 'defaultReasoningEffort', 'contextWindowOverrides', 'region', 'catalogSource', 'catalogError', 'serving', 'conflict', 'models'].sort())
  assert.deepEqual(output.enabledModelIds, []); assert.equal(output.serving, false)
  assert.equal(output.models[0].enabled, false)
  assert.equal(output.models[0].effectiveContextWindow, 32000)
  assert.equal(output.models[0].effectiveReasoningEffort, 'low')
  f.dispose(); assert.equal(f.routes.length, 0)
})

test('partial persistence, null clear, effective effort, refresh failure preserve selection', async (t) => {
  const f = await fixture(t)
  const saved = await f.call('/models', 'POST', { enabledModelIds: ['fixture-model', 'fixture-model', 'unavailable'], defaultReasoningEffort: 'high', contextWindowOverrides: { 'fixture-model': 64000 } })
  assert.equal(saved.status, 200); assert.equal(saved.output.serving, true)
  assert.equal(saved.output.models[0].effectiveContextWindow, 64000); assert.equal(saved.output.models[0].effectiveReasoningEffort, 'high')
  assert.deepEqual((await f.settings.read()).enabledModelIds, ['fixture-model', 'unavailable'])
  f.fail()
  const refreshed = await f.call('/models/refresh', 'POST')
  assert.equal(refreshed.output.catalogSource, 'cache'); assert.equal(refreshed.output.catalogError, 'TIMEOUT')
  assert.deepEqual(refreshed.output.enabledModelIds, ['fixture-model', 'unavailable'])
  const cleared = await f.call('/models', 'POST', { contextWindowOverrides: { 'fixture-model': null } })
  assert.equal(cleared.output.models[0].contextWindowOverride, null); assert.equal(cleared.output.models[0].effectiveContextWindow, 32000)
  assert.equal(f.notices(), 4)
})

test('method, origin, host, malformed JSON and invalid fields fail before mutation', async (t) => {
  const f = await fixture(t), before = f.loads()
  assert.equal((await f.call('/models', 'DELETE')).status, 405)
  assert.equal((await f.call('/models/refresh')).status, 405)
  assert.equal((await f.call('/models', 'POST', { enabled: false }, { ...headers, origin: 'http://other.invalid' })).status, 403)
  assert.equal((await f.call('/models', 'GET', undefined, { host: 'other.invalid' })).status, 403)
  assert.equal(f.loads(), before)
  for (const patch of [{ enabled: 'yes' }, { extra: 1 }, { contextWindowOverrides: { 'fixture-model': 128001 } }, { enabledModelIds: [1] }, '{']) {
    const result = await f.call('/models', 'POST', patch)
    assert.equal(result.status, 400); assert.equal(result.output.ok, false)
  }
  assert.deepEqual((await f.settings.read()).enabledModelIds, [])
})

test('registration conflict and model failures contain only safe diagnostics', async (t) => {
  const f = await fixture(t)
  f.models.registration(false, 'WORKBUDDY_ADAPTER_CONFLICT')
  const state = await f.call('/models')
  assert.equal(state.output.conflict, 'WORKBUDDY_ADAPTER_CONFLICT'); assert.equal(state.output.serving, false)
  f.models.accountChanged(); assert.equal(f.invalidations(), 1)
  const routes = []
  registerRoutes({ webServer: { register: (route) => { routes.push(route); return () => {} } } }, { models: { status: async () => { throw Object.assign(new Error('Bearer synthetic-token C:\\private\\file'), { code: 'WORKBUDDY_MODELS_READ' }) } } })
  let raw
  await routes.find((route) => route.path === prefix + '/models').handler({ method: 'GET', headers, resume() {} }, { writeHead() {}, end(text) { raw = text } })
  assert.ok(raw.includes('WORKBUDDY_MODELS_READ')); assert.ok(!raw.includes('synthetic-token')); assert.ok(!raw.includes('private'))
})
