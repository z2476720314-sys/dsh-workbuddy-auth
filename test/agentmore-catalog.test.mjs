import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentmoreCatalogCachePath, agentmoreScope, createAgentmoreCatalog, fallbackModels, TTL_MS } from '../lib/agentmore-catalog.mjs'

const liveModel = (id = 'glm-5.3') => ({
  id,
  name: `名称 ${id}`,
  contextWindow: 1_000_000,
  maxContextWindow: 1_000_000,
  maxTokens: 128_000,
  inputModalities: ['text'],
  reasoningEfforts: ['low', 'high', 'max'],
  defaultReasoningEffort: 'max',
})
const credential = (overrides = {}) => ({ id: 'acc-1', userId: 'u-1', deviceId: 'dev-1', ...overrides })

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmore-catalog-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('agentmoreCatalogCachePath：DSH_HOME 优先，空白回落 ~/.dsh', () => {
  assert.equal(agentmoreCatalogCachePath({ env: { DSH_HOME: 'C:\\dsh' }, home: 'C:\\synthetic-home' }), join('C:\\dsh', 'storages', 'agentmore-models.cache'))
  assert.equal(agentmoreCatalogCachePath({ env: { DSH_HOME: '   ' }, home: join('C:', 'synthetic-home') }), join('C:', 'synthetic-home', '.dsh', 'storages', 'agentmore-models.cache'))
  assert.equal(agentmoreCatalogCachePath({ env: {}, home: '/synthetic-home' }), join('/synthetic-home', '.dsh', 'storages', 'agentmore-models.cache'))
})

test('agentmoreScope：三字段 JSON 的 sha256，null 入参返回 null', () => {
  assert.equal(agentmoreScope(null), null)
  assert.equal(agentmoreScope(undefined), null)
  const a = agentmoreScope(credential())
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(agentmoreScope(credential()), a, '同凭据稳定')
  assert.notEqual(agentmoreScope(credential({ userId: 'u-2' })), a)
  assert.notEqual(agentmoreScope(credential({ deviceId: 'dev-2' })), a)
  // 缺字段按空串参与，不抛
  assert.match(agentmoreScope({}), /^[0-9a-f]{64}$/)
})

test('fallbackModels：与动态目录同形状，GLM-5.3 带 reasoning', () => {
  const models = fallbackModels()
  assert.deepEqual(models.map((m) => m.id), ['glm-5.3', 'glm-5.3-flash'])
  for (const model of models) {
    assert.equal(model.contextWindow, 1_000_000)
    assert.equal(model.maxContextWindow, 1_000_000)
    assert.equal(model.maxTokens, 128_000)
    assert.deepEqual(model.inputModalities, ['text'])
    assert.deepEqual(model.reasoningEfforts, ['low', 'high', 'max'])
    assert.equal(model.defaultReasoningEffort, 'max')
  }
  assert.equal(TTL_MS, 30 * 60 * 1000)
})

test('load：无凭据给回退列表且不报错（未登录也要能显示可选项）', async () => {
  let fetched = 0
  const catalog = createAgentmoreCatalog({ readCredential: async () => null, fetchModels: async () => { fetched += 1; return [] } })
  const state = await catalog.load()
  assert.equal(fetched, 0)
  assert.equal(state.catalogSource, 'fallback')
  assert.equal(state.catalogError, null)
  assert.equal(state.scopeKey, null)
  assert.equal(state.models.length, 2)
})

test('load：readCredential 抛错按无凭据处理，不外泄', async () => {
  const catalog = createAgentmoreCatalog({ readCredential: async () => { throw new Error('decrypt failed') }, fetchModels: async () => [liveModel()] })
  const state = await catalog.load()
  assert.equal(state.catalogSource, 'fallback')
  assert.equal(state.catalogError, null)
})

test('load：活取成功 → source live、error null、写盘只含模型元数据', async () => {
  await withTemporaryDirectory(async (directory) => {
    const cacheFile = join(directory, 'nested', 'models.cache')
    const catalog = createAgentmoreCatalog({ readCredential: async () => credential(), fetchModels: async () => [liveModel('m-1')], cacheFile })
    const state = await catalog.load()
    assert.equal(state.catalogSource, 'live')
    assert.equal(state.catalogError, null)
    assert.match(state.scopeKey, /^[0-9a-f]{64}$/)
    assert.deepEqual(state.models.map((m) => m.id), ['m-1'])

    const stored = JSON.parse(await readFile(cacheFile, 'utf8'))
    assert.equal(stored.version, 2)
    assert.equal(stored.scopeKey, state.scopeKey)
    assert.deepEqual(stored.models.map((m) => m.id), ['m-1'])
    // 只落元数据，绝不落令牌
    assert.equal(JSON.stringify(stored).includes('accessToken'), false)
    assert.deepEqual(Object.keys(stored.models[0]).sort(), [
      'contextWindow', 'defaultReasoningEffort', 'id', 'inputModalities', 'maxContextWindow', 'maxTokens', 'name', 'reasoningEfforts',
    ])
  })
})

test('load：TTL 内命中内存缓存，不再请求，force 才穿透', async () => {
  let fetched = 0
  let clock = 1_000
  const catalog = createAgentmoreCatalog({
    readCredential: async () => credential(),
    fetchModels: async () => { fetched += 1; return [liveModel()] },
    now: () => clock,
  })
  assert.equal((await catalog.load()).catalogSource, 'live')
  assert.equal(fetched, 1)

  clock += TTL_MS - 1
  const cached = await catalog.load()
  assert.equal(cached.catalogSource, 'cache')
  assert.equal(cached.catalogError, null)
  assert.equal(fetched, 1)

  clock += 2
  assert.equal((await catalog.load()).catalogSource, 'live')
  assert.equal(fetched, 2)

  const forced = await catalog.load({ force: true })
  assert.equal(forced.catalogSource, 'live')
  assert.equal(fetched, 3)
})

test('load：活取返回空数组视为无结果，退回磁盘缓存（不算错误）', async () => {
  await withTemporaryDirectory(async (directory) => {
    const cacheFile = join(directory, 'models.cache')
    let clock = 1_000
    let live = [liveModel('m-1')]
    const catalog = createAgentmoreCatalog({ readCredential: async () => credential(), fetchModels: async () => live, cacheFile, now: () => clock })
    await catalog.load()

    // 空列表不是异常，只是"这次没拿到"，因此不带错误码。
    live = []
    clock += TTL_MS + 1
    catalog.invalidate({ keepCache: true })
    const state = await catalog.load()
    assert.equal(state.catalogSource, 'cache')
    assert.equal(state.catalogError, null)
    assert.deepEqual(state.models.map((m) => m.id), ['m-1'])
  })
})

test('load：活取抛错且无磁盘缓存 → fallback 并带错误码', async () => {
  await withTemporaryDirectory(async (directory) => {
    const catalog = createAgentmoreCatalog({
      readCredential: async () => credential(),
      fetchModels: async () => { throw new Error('network down') },
      cacheFile: join(directory, 'missing', 'models.cache'),
    })
    const state = await catalog.load()
    assert.equal(state.catalogSource, 'fallback')
    assert.equal(state.catalogError, 'AGENTMORE_CATALOG_FAILED')
    assert.equal(state.models.length, 2)
    // 错误里不得泄漏上游文案
    assert.equal(JSON.stringify(state).includes('network down'), false)
  })
})

test('load：超时错误码是 CATALOG_TIMEOUT，且会 abort 在飞请求', async () => {
  let aborted = false
  const catalog = createAgentmoreCatalog({
    readCredential: async () => credential(),
    fetchModels: (_cred, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) { aborted = true; reject(new Error('aborted')); return }
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    }),
    timeoutMs: 20,
  })
  const state = await catalog.load()
  assert.equal(state.catalogSource, 'fallback')
  assert.equal(state.catalogError, 'AGENTMORE_CATALOG_TIMEOUT')
  assert.equal(aborted, true)
})

test('load：磁盘缓存 scopeKey 不匹配 / 版本不符 / 时间在未来 都忽略', async () => {
  await withTemporaryDirectory(async (directory) => {
    const cacheFile = join(directory, 'models.cache')
    const poisoned = [
      { version: 2, scopeKey: 'other', at: 1, models: [liveModel('poison')] },
      // 版本 1 是旧口径（128K 上下文 / 单档 default），必须整份失效。
      { version: 1, scopeKey: agentmoreScope(credential()), at: 1, models: [liveModel('poison')] },
      { version: 3, scopeKey: agentmoreScope(credential()), at: 1, models: [liveModel('poison')] },
      { version: 2, scopeKey: agentmoreScope(credential()), at: 10 ** 12, models: [liveModel('poison')] },
      { version: 2, scopeKey: agentmoreScope(credential()), at: 1, models: 'not-array' },
      'not-json',
    ]
    for (const stored of poisoned) {
      await writeFile(cacheFile, typeof stored === 'string' ? stored : JSON.stringify(stored), 'utf8')
      const catalog = createAgentmoreCatalog({
        readCredential: async () => credential(),
        fetchModels: async () => { throw new Error('x') },
        cacheFile,
        now: () => 5_000,
      })
      const state = await catalog.load()
      assert.equal(state.catalogSource, 'fallback', JSON.stringify(stored))
      assert.equal(state.models.some((m) => m.id === 'poison'), false)
    }
  })
})

test('load：并发共享一次在飞请求', async () => {
  let fetched = 0
  const catalog = createAgentmoreCatalog({
    readCredential: async () => credential(),
    fetchModels: async () => { fetched += 1; await new Promise((resolve) => setImmediate(resolve)); return [liveModel()] },
  })
  const states = await Promise.all([catalog.load(), catalog.load(), catalog.load()])
  assert.equal(fetched, 1)
  for (const state of states) assert.equal(state.catalogSource, 'live')
})

test('load：凭据 scope 变化自动作废缓存', async () => {
  let fetched = 0
  let current = credential()
  const catalog = createAgentmoreCatalog({
    readCredential: async () => current,
    fetchModels: async () => { fetched += 1; return [liveModel(`m-${fetched}`)] },
  })
  assert.deepEqual((await catalog.load()).models.map((m) => m.id), ['m-1'])
  assert.deepEqual((await catalog.load()).models.map((m) => m.id), ['m-1'])
  assert.equal(fetched, 1)

  current = credential({ userId: 'u-2' })
  const switched = await catalog.load()
  assert.equal(switched.catalogSource, 'live')
  assert.deepEqual(switched.models.map((m) => m.id), ['m-2'])
  assert.equal(fetched, 2)
})

test('invalidate：在飞请求的结果被丢弃并回落 fallback（不乱认别的账号的目录）', async () => {
  let release
  const catalog = createAgentmoreCatalog({
    readCredential: async () => credential(),
    fetchModels: async () => {
      await new Promise((resolve) => { release = resolve })
      return [liveModel('stale')]
    },
  })
  const pending = catalog.load()
  await new Promise((resolve) => setImmediate(resolve))
  catalog.invalidate()
  release()
  const state = await pending
  assert.equal(state.catalogSource, 'fallback')
  assert.equal(state.catalogError, null)
})

test('load：外部 signal abort → ABORTED，且不影响后续加载', async () => {
  const controller = new AbortController()
  const catalog = createAgentmoreCatalog({
    readCredential: async () => credential(),
    fetchModels: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return [liveModel()] },
  })
  const pending = catalog.load({ signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'ABORTED' })

  const state = await catalog.load()
  assert.equal(state.catalogSource, 'live')
})

test('load：已 aborted 的 signal 立刻拒绝', async () => {
  const controller = new AbortController()
  controller.abort()
  const catalog = createAgentmoreCatalog({ readCredential: async () => credential(), fetchModels: async () => [liveModel()] })
  await assert.rejects(catalog.load({ signal: controller.signal }), { code: 'ABORTED' })
})

test('cacheFile 省略时一切照常，不抛', async () => {
  const catalog = createAgentmoreCatalog({ readCredential: async () => credential(), fetchModels: async () => [liveModel('m-1')] })
  assert.equal((await catalog.load()).catalogSource, 'live')
})
