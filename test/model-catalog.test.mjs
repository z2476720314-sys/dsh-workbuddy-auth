import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createModelCatalog, parseModelCatalog } from '../lib/model-catalog.mjs'
const model = { id: 'fixture-model', name: 'Fixture', maxAllowedSize: 128000, contextWindow: { defaultLength: 32000 }, maxOutputTokens: 8192, supportsImages: true, reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'low' } }
const payload = { code: 0, data: { models: [model] } }
const credential = (accountId='a', region='cn') => ({ accountId, region, backend: region === 'cn' ? 'https://copilot.tencent.com' : 'https://www.workbuddy.ai', headers: { ['Authorization']: 'Bearer synthetic-' + accountId } })
const response = (data=payload) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
test('maps WorkBuddy fields, optional unknowns, deduplication and image filtering', () => {
  const list = parseModelCatalog({ data: { models: [model, model, { ...model, id: 'image-only', tags: ['text-to-image'] }, { id: 'broken' }, { id: 'text', maxInputTokens: 10000 }] } }, 'cn')
  assert.equal(list.length, 2)
  assert.deepEqual(list[0], { id: 'fixture-model', name: 'Fixture', region: 'cn', contextWindow: 32000, maxContextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' })
  assert.equal(list[1].maxTokens, null)
  assert.deepEqual(list[1].reasoningEfforts, [])
  assert.throws(() => parseModelCatalog({ code: 100, data: { models: [] } }, 'cn'), { code: 'WORKBUDDY_CATALOG_FAILED' })
  assert.throws(() => parseModelCatalog({ data: {} }, 'cn'), { code: 'WORKBUDDY_CATALOG_FAILED' })
})
test('zero-network absent account; empty success stays empty; same-account failure uses cache', async () => {
  let active = null, calls = 0, fail = false, empty = false
  const catalog = createModelCatalog({ readCredential: async () => active, fetchImpl: async (url, init) => { calls++; assert.equal(init.method, 'GET'); assert.equal(url, active.backend + '/v3/config'); if (fail) throw new Error('secret-canary'); return response(empty ? { data: { models: [] } } : payload) } })
  assert.equal((await catalog.load()).catalogSource, 'none'); assert.equal(calls, 0)
  active = credential(); assert.equal((await catalog.load()).catalogSource, 'live')
  fail = true; const cached = await catalog.load({ force: true }); assert.equal(cached.catalogSource, 'cache'); assert.equal(cached.catalogError, 'WORKBUDDY_CATALOG_FAILED'); assert.equal(JSON.stringify(cached).includes('secret-canary'), false)
  fail = false; empty = true; assert.deepEqual((await catalog.load({ force: true })).models, [])
  fail = true; assert.deepEqual((await catalog.load({ force: true })).models, [])
})
test('inflight deduplication and late old account never publish to current scope', async () => {
  let active = credential(), release, calls = 0
  const catalog = createModelCatalog({ readCredential: async () => active, fetchImpl: async () => { calls++; if (calls === 1) await new Promise((r) => { release = r }); return response() } })
  const a = catalog.load(); const a2 = catalog.load()
  await new Promise((r) => setImmediate(r)); assert.equal(calls, 1)
  active = credential('b', 'intl'); const b = await catalog.load(); assert.equal(b.region, 'intl')
  release(); const old = await a; await a2; assert.equal(old.catalogSource, 'none')
  const current = await catalog.load(); assert.equal(current.region, 'intl'); assert.equal(calls, 2)
  active = null; assert.equal((await catalog.load()).catalogSource, 'none')
  active = credential(); assert.equal((await catalog.load()).catalogSource, 'live'); assert.equal(calls, 3)
})
test('timeout and caller abort are bounded even with an uncooperative fetch', async () => {
  const catalog = createModelCatalog({ readCredential: async () => credential(), timeoutMs: 15, fetchImpl: async () => new Promise(() => {}) })
  assert.equal((await catalog.load()).catalogError, 'WORKBUDDY_CATALOG_TIMEOUT')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(catalog.load({ force: true, signal: controller.signal }), { code: 'ABORTED' })
})

test('invalidation cancels an uncooperative inflight fetch and releases its waiters', async () => {
  let signal
  const catalog = createModelCatalog({ readCredential: async () => credential(), timeoutMs: 80, fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}) } })
  const pending = catalog.load()
  await new Promise((resolve) => setImmediate(resolve))
  catalog.invalidate()
  assert.equal(signal.aborted, true)
  const state = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('invalidated catalog waiter remained active')), 30))])
  assert.equal(state.catalogSource, 'none')
})

test('credential renewal retains same-account cache while account changes discard it', async () => {
  let active = credential(), fail = false
  const catalog = createModelCatalog({ readCredential: async () => active, fetchImpl: async () => { if (fail) throw new Error('offline'); return response() } })
  await catalog.load()
  active = { ...credential(), headers: { ['Authorization']: 'Bearer renewed-synthetic' } }
  catalog.invalidate({ keepCache: true })
  fail = true
  const cached = await catalog.load({ force: true })
  assert.equal(cached.catalogSource, 'cache')
  assert.equal(cached.models[0]?.id, 'fixture-model')
  active = credential('b')
  assert.deepEqual((await catalog.load()).models, [])
})

test('successful catalog survives restart offline, remains account scoped and persists empty results', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-catalog-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cacheFile = join(dir, 'catalog.json')
  let active = credential()
  const online = createModelCatalog({ cacheFile, readCredential: async () => active, fetchImpl: async () => response({ ...payload, privateCanary: 'not-for-disk' }) })
  await online.load()
  const disk = await readFile(cacheFile, 'utf8')
  assert.equal(disk.includes('synthetic-a'), false)
  assert.equal(disk.includes('not-for-disk'), false)
  const restart = () => createModelCatalog({ cacheFile, readCredential: async () => active, fetchImpl: async () => { throw new Error('offline') } })
  const cached = await restart().load()
  assert.equal(cached.catalogSource, 'cache')
  assert.equal(cached.catalogError, 'WORKBUDDY_CATALOG_FAILED')
  assert.deepEqual(cached.models, parseModelCatalog(payload, 'cn'))
  active = credential('b')
  assert.deepEqual((await restart().load()).models, [])
  active = credential('a', 'intl')
  assert.deepEqual((await restart().load()).models, [])
  active = credential()
  const empty = createModelCatalog({ cacheFile, readCredential: async () => active, fetchImpl: async () => response({ data: { models: [] } }) })
  await empty.load()
  assert.deepEqual((await restart().load()).models, [])
  await writeFile(cacheFile, '{broken')
  assert.equal((await restart().load()).catalogSource, 'none')
})

test('a different UID in the same credential source cannot reuse the previous account catalog', async () => {
  let active = { ...credential(), headers: { 'X-User-Id': 'synthetic-a' } }, fail = false
  const catalog = createModelCatalog({ readCredential: async () => active, fetchImpl: async () => { if (fail) throw new Error('offline'); return response() } })
  await catalog.load()
  active = { ...credential(), headers: { 'x-user-id': 'synthetic-b' } }
  fail = true
  assert.deepEqual((await catalog.load()).models, [])
})

for (const replaceInstance of [false, true]) {
test(`a delayed old cache write cannot resurrect models after a newer empty catalog (replacement: ${replaceInstance})`, async (t) => {
  const files = new Map()
  let release, entered, firstRename = true, empty = false
  const blocked = new Promise((resolve) => { entered = resolve })
  const resume = new Promise((resolve) => { release = resolve })
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  t.mock.method(fs, 'mkdir', async () => {})
  t.mock.method(fs, 'writeFile', async (path, text) => { files.set(path, text) })
  t.mock.method(fs, 'readFile', async (path) => { if (!files.has(path)) throw new Error('missing'); return files.get(path) })
  t.mock.method(fs, 'unlink', async (path) => { files.delete(path) })
  t.mock.method(fs, 'rename', async (from, to) => {
    if (firstRename) { firstRename = false; entered(); await resume }
    files.set(to, files.get(from)); files.delete(from)
  })
  syncBuiltinESMExports()
  const deps = { cacheFile: 'synthetic-catalog.json', readCredential: async () => credential() }
  const fetchImpl = async () => response(empty ? { data: { models: [] } } : payload)
  const catalog = createModelCatalog({ ...deps, fetchImpl })
  const old = catalog.load()
  await blocked
  catalog.invalidate({ keepCache: !replaceInstance })
  empty = true
  const current = replaceInstance ? createModelCatalog({ ...deps, fetchImpl }) : catalog
  const latest = current.load({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await Promise.all([old, latest])
  const restarted = createModelCatalog({ ...deps, fetchImpl: async () => { throw new Error('offline') } })
  assert.deepEqual((await restarted.load()).models, [])
})
}
