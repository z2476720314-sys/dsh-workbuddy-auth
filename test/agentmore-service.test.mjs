import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentmoreService } from '../lib/agentmore-service.mjs'

/** store 的错误码不对外导出，这里按字符串契约断言。 */
const AGENTMORE_ACCOUNT_NOT_FOUND = 'AGENTMORE_ACCOUNT_NOT_FOUND'

/** 造一个 base64url JWT，只要 `exp` 段；解密不是测试目标。 */
function jwt(expSeconds) {
  const enc = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${enc({ alg: 'HS256' })}.${enc({ exp: expSeconds })}.sig`
}

function memoryStore(accounts = []) {
  let list = accounts.map((account) => ({ ...account }))
  let activeId = list[0]?.id ?? null
  const calls = { list: 0, upsert: 0, setActiveId: [], remove: [] }
  const store = {
    calls,
    set(list_, active = activeId) {
      list = list_.map((account) => ({ ...account }))
      activeId = active
    },
    async list() {
      calls.list += 1
      return list.map((account) => ({ ...account }))
    },
    async getActive() {
      const found = list.find((account) => account.id === activeId)
      return found === undefined ? null : { ...found }
    },
    async upsert(account) {
      calls.upsert += 1
      const index = list.findIndex((entry) => entry.id === account.id)
      const merged = { id: account.id ?? `acc-${list.length + 1}`, ...account }
      if (index === -1) list.push(merged)
      else list[index] = merged
      if (activeId === null) activeId = merged.id
      return { ...merged }
    },
    async setActiveId(id) {
      calls.setActiveId.push(id)
      if (id === null) {
        activeId = null
        return
      }
      if (!list.some((account) => account.id === id)) {
        throw Object.assign(new Error(AGENTMORE_ACCOUNT_NOT_FOUND), { code: AGENTMORE_ACCOUNT_NOT_FOUND })
      }
      activeId = id
    },
    async remove(id) {
      calls.remove.push(id)
      list = list.filter((account) => account.id !== id)
      if (activeId === id) activeId = list[0]?.id ?? null
    },
  }
  return store
}

const baseAccount = (overrides = {}) => ({
  id: 'acc-1',
  displayName: '清言 123456',
  userId: 'u-1',
  ['accessToken']: jwt(Math.floor(Date.now() / 1000) + 86_400),
  refreshToken: 'ref-1',
  deviceId: 'dev-1',
  refreshedAt: 1_000,
  createdAt: 1_000,
  credits: null,
  ...overrides,
})

function logging() {
  const entries = []
  return { entries, info: (line) => entries.push(line), warn: (line) => entries.push(line), debug: (line) => entries.push(line) }
}

function harness({ accounts = [baseAccount()], account = null, catalogState = null, now = () => 1_000_000 } = {}) {
  const store = memoryStore(accounts)
  const clientCalls = { refresh: 0, credits: 0 }
  const accountState = account === null ? accounts[0] : account
  const client = {
    async refresh(credential) {
      clientCalls.refresh += 1
      return { ['accessToken']: jwt(Math.floor(Date.now() / 1000) + 86_400), refreshToken: 'ref-2' }
    },
    async credits() {
      clientCalls.credits += 1
      return { remaining: 42, display: '42' }
    },
  }
  const catalogCalls = []
  const catalog = {
    invalidate(options) { catalogCalls.push(options ?? {}) },
  }
  const modelCalls = { accountChanged: 0, refresh: 0, patch: [] }
  const catalogStatus = catalogState ?? {
    enabled: true,
    serving: true,
    catalogSource: 'live',
    catalogError: '',
    conflict: '',
    enabledModelIds: ['glm-5.3'],
    defaultReasoningEffort: 'default',
    models: [{ id: 'glm-5.3' }],
  }
  const modelService = {
    async status() { return catalogStatus },
    async patch(patch) { modelCalls.patch.push(patch); return { ok: true } },
    async refresh() { modelCalls.refresh += 1; return { ok: true } },
    accountChanged() { modelCalls.accountChanged += 1 },
  }
  const loginCalls = []
  const login = {
    async start() { loginCalls.push('start'); return { status: 'running' } },
    status() { loginCalls.push('status'); return { status: 'idle' } },
    async cancel() { loginCalls.push('cancel'); return { status: 'idle' } },
    async dispose() { loginCalls.push('dispose') },
  }
  const logger = logging()
  const service = createAgentmoreService({
    store,
    client,
    catalog,
    modelService,
    login,
    logger,
    now,
  })
  return { service, store, client, catalog, catalogCalls, modelService, modelCalls, login, loginCalls, logger, clientCalls, accountState }
}

test('status：未登录时不含 account，loggedIn=false', async () => {
  const { service } = harness({ accounts: [], account: null })
  const status = await service.status()
  assert.equal(status.ok, true)
  assert.equal(status.loggedIn, false)
  assert.equal('account' in status, false)
  assert.equal(status.credits.remaining, null)
  assert.equal(status.credits.display, '')
})

test('status：已登录时投影三段身份，且不含令牌', async () => {
  const { service } = harness()
  const status = await service.status()
  assert.equal(status.loggedIn, true)
  assert.deepEqual(status.account, { id: 'acc-1', displayName: '清言 123456', userId: 'u-1' })
  const flat = JSON.stringify(status)
  assert.equal(flat.includes('ref-1'), false)
  assert.equal(flat.includes('dev-1'), false)
})

test('status：模型摘要把数组放进 list，顶层 models 是状态块', async () => {
  const { service } = harness()
  const status = await service.status()
  assert.deepEqual(status.models, {
    enabled: true,
    serving: true,
    catalogSource: 'live',
    catalogError: '',
    conflict: '',
    enabledModelIds: ['glm-5.3'],
    defaultReasoningEffort: 'default',
    list: [{ id: 'glm-5.3' }],
  })
})

test('status：modelService 返回 undefined 时给出安全默认值', async () => {
  const { service } = harness({ catalogState: {} })
  const status = await service.status()
  assert.deepEqual(status.models, {
    enabled: false,
    serving: false,
    catalogSource: '',
    catalogError: '',
    conflict: '',
    enabledModelIds: [],
    defaultReasoningEffort: null,
    list: [],
  })
})

test('status：credits 先读账号余额，display 用字符串投影', async () => {
  const { service } = harness({ accounts: [baseAccount({ credits: 7 })] })
  const status = await service.status()
  assert.deepEqual(status.credits, { remaining: 7, display: '7' })
})

for (const credits of [null, undefined, '']) {
  test(`status：已登录但余额 ${String(credits)} 时保持未知`, async () => {
    const { service, clientCalls } = harness({ accounts: [baseAccount({ credits })] })
    assert.deepEqual((await service.status()).credits, { remaining: null, display: '' })
    assert.equal(clientCalls.credits, 0)
  })
}

test('status：真实零余额仍显示 0', async () => {
  const { service } = harness({ accounts: [baseAccount({ credits: 0 })] })
  assert.deepEqual((await service.status()).credits, { remaining: 0, display: '0' })
})

test('login 三个方法直接透传', async () => {
  const { service, loginCalls } = harness()
  assert.deepEqual(await service.startLogin(), { status: 'running' })
  assert.deepEqual(service.loginStatus(), { status: 'idle' })
  assert.deepEqual(await service.cancelLogin(), { status: 'idle' })
  assert.deepEqual(loginCalls, ['start', 'status', 'cancel'])
  await service.dispose()
  assert.equal(loginCalls.at(-1), 'dispose')
})

test('readCredential：未登录返回 null', async () => {
  const { service } = harness({ accounts: [], account: null })
  assert.equal(await service.readCredential(), null)
})

test('readCredential：令牌新鲜时直接返回，不续期', async () => {
  const future = Math.floor(Date.now() / 1000) + 86_400
  const { service, clientCalls } = harness({ accounts: [baseAccount({ ['accessToken']: jwt(future) })] })
  const credential = await service.readCredential()
  assert.equal(credential.id, 'acc-1')
  assert.equal(clientCalls.refresh, 0)
})

test('readCredential：距过期 <= 300s 时续期，且结果落盘', async () => {
  const soon = Math.floor(1_000_000 / 1000) + 200
  const { service, store, clientCalls } = harness({
    accounts: [baseAccount({ ['accessToken']: jwt(soon) })],
    now: () => 1_000_000,
  })
  const credential = await service.readCredential()
  assert.equal(clientCalls.refresh, 1)
  assert.equal(credential.refreshToken, 'ref-2')
  assert.equal(store.calls.upsert, 1)
})

test('readCredential：无 exp 时按 refreshedAt 判定 30 分钟', async () => {
  const fresh = harness({ accounts: [baseAccount({ accessToken: 'opaque', refreshedAt: 1_000_000 - 60_000 })] })
  await fresh.service.readCredential()
  assert.equal(fresh.clientCalls.refresh, 0)

  const stale = harness({ accounts: [baseAccount({ accessToken: 'opaque', refreshedAt: 1_000_000 - 1_800_000 })] })
  await stale.service.readCredential()
  assert.equal(stale.clientCalls.refresh, 1)
})

test('readCredential：refresh=false 时不续期', async () => {
  const soon = Math.floor(1_000_000 / 1000) + 10
  const { service, clientCalls } = harness({
    accounts: [baseAccount({ ['accessToken']: jwt(soon) })],
    now: () => 1_000_000,
  })
  await service.readCredential({ refresh: false })
  assert.equal(clientCalls.refresh, 0)
})

test('readCredential：续期失败只告警，仍返回旧账号', async () => {
  const soon = Math.floor(1_000_000 / 1000) + 10
  const { service, client, logger } = harness({
    accounts: [baseAccount({ ['accessToken']: jwt(soon) })],
    now: () => 1_000_000,
  })
  client.refresh = async () => { throw Object.assign(new Error('boom'), { code: 'AGENTMORE_REFRESH' }) }
  const credential = await service.readCredential()
  assert.equal(credential.id, 'acc-1')
  assert.equal(logger.entries.some((line) => line.includes('token refresh failed')), true)
  assert.equal(logger.entries.some((line) => line.includes('AGENTMORE_REFRESH')), true)
})

test('readCredential：并发续期只打一次上游', async () => {
  const soon = Math.floor(1_000_000 / 1000) + 10
  const { service, clientCalls } = harness({
    accounts: [baseAccount({ ['accessToken']: jwt(soon) })],
    now: () => 1_000_000,
  })
  await Promise.all([service.readCredential(), service.readCredential(), service.readCredential()])
  assert.equal(clientCalls.refresh, 1)
})

test('readCredential：refresh 返回空 refreshToken 时保留旧值', async () => {
  const soon = Math.floor(1_000_000 / 1000) + 10
  const { service, client, store } = harness({
    accounts: [baseAccount({ ['accessToken']: jwt(soon) })],
    now: () => 1_000_000,
  })
  client.refresh = async () => ({ ['accessToken']: jwt(7_000_000_000), refreshToken: '' })
  await service.readCredential()
  assert.equal(store.calls.upsert, 1)
})

test('onCredentialRejected：清缓存并告警，不删账号', async () => {
  const { service, store, logger } = harness()
  await service.onCredentialRejected({ id: 'acc-1' })
  assert.equal(store.calls.remove.length, 0)
  assert.equal(logger.entries.some((line) => line.includes('credential rejected for account acc-1')), true)
})

test('onCredentialRejected：账号为空也不抛', async () => {
  const { service } = harness()
  await service.onCredentialRejected(null)
  await service.onCredentialRejected({})
})

test('listAccounts：投影四字段并标出 active', async () => {
  const { service } = harness({
    accounts: [baseAccount(), baseAccount({ id: 'acc-2', userId: 'u-2' })],
  })
  const accounts = await service.listAccounts()
  assert.deepEqual(accounts, [
    { id: 'acc-1', displayName: '清言 123456', userId: 'u-1', active: true },
    { id: 'acc-2', displayName: '清言 123456', userId: 'u-2', active: false },
  ])
})

test('listAccounts：空列表返回空数组', async () => {
  const { service } = harness({ accounts: [], account: null })
  assert.deepEqual(await service.listAccounts(), [])
})

test('activateAccount：换号后目录保留缓存但失效、清积分、通知 adapter', async () => {
  const { service, store, catalogCalls, modelCalls } = harness({
    accounts: [baseAccount(), baseAccount({ id: 'acc-2', userId: 'u-2' })],
  })
  await service.activateAccount('acc-2')
  assert.deepEqual(store.calls.setActiveId, ['acc-2'])
  assert.deepEqual(catalogCalls, [{ keepCache: true }])
  assert.equal(modelCalls.accountChanged, 1)
})

test('activateAccount：未知 id 抛 AGENTMORE_ACCOUNT_NOT_FOUND', async () => {
  const { service } = harness()
  await assert.rejects(() => service.activateAccount('nope'), (error) => error.code === AGENTMORE_ACCOUNT_NOT_FOUND)
})

test('removeAccount：删号后目录与缓存全失效', async () => {
  const { service, store, catalogCalls, modelCalls } = harness({
    accounts: [baseAccount(), baseAccount({ id: 'acc-2', userId: 'u-2' })],
  })
  await service.removeAccount('acc-1')
  assert.deepEqual(store.calls.remove, ['acc-1'])
  assert.deepEqual(catalogCalls, [{}])
  assert.equal(modelCalls.accountChanged, 1)
})

test('removeAccount：删掉最后一个账号后 status 变成未登录', async () => {
  const { service } = harness()
  await service.removeAccount('acc-1')
  const status = await service.status()
  assert.equal(status.loggedIn, false)
})

test('credits：未登录返回 null', async () => {
  const { service } = harness({ accounts: [], account: null })
  assert.equal(await service.credits(), null)
})

test('credits：真查一次并缓存，TTL 内复用', async () => {
  const { service, clientCalls } = harness()
  const first = await service.credits()
  const second = await service.credits()
  assert.deepEqual(first, { remaining: 42, display: '42' })
  assert.deepEqual(second, first)
  assert.equal(clientCalls.credits, 1)
})

test('credits：超过 60s 重查', async () => {
  let clock = 1_000_000
  const { service, clientCalls } = harness({ now: () => clock })
  await service.credits()
  clock += 61_000
  await service.credits()
  assert.equal(clientCalls.credits, 2)
})

test('credits：结果写回账号，refreshModels 会清掉积分缓存', async () => {
  const { service, store, clientCalls, modelCalls } = harness()
  await service.credits()
  assert.equal(store.calls.upsert, 1)
  await service.refreshModels()
  assert.equal(modelCalls.refresh, 1)
  await service.credits()
  assert.equal(clientCalls.credits, 2)
})

test('credits：上游 remaining 为 null 时如实透出（不折成 0）', async () => {
  const { service, client } = harness()
  client.credits = async () => ({ remaining: null, display: '' })
  assert.deepEqual(await service.credits(), { remaining: null, display: '' })
})

test('credits：上游抛错原样外抛，不写缓存', async () => {
  const { service, client, clientCalls } = harness()
  client.credits = async () => {
    clientCalls.credits += 1
    throw Object.assign(new Error('quota'), { code: 'AGENTMORE_QUOTA' })
  }
  await assert.rejects(() => service.credits(), (error) => error.code === 'AGENTMORE_QUOTA')
  // 失败不缓存：换回成功实现后必须真的再打一次上游
  client.credits = async () => {
    clientCalls.credits += 1
    return { remaining: 1, display: '1' }
  }
  assert.deepEqual(await service.credits(), { remaining: 1, display: '1' })
  assert.equal(clientCalls.credits, 2)
})

test('models：扁平契约直通 modelService.status()', async () => {
  const { service } = harness()
  const models = await service.models()
  assert.deepEqual(models, {
    enabled: true,
    serving: true,
    catalogSource: 'live',
    catalogError: '',
    conflict: '',
    enabledModelIds: ['glm-5.3'],
    defaultReasoningEffort: 'default',
    models: [{ id: 'glm-5.3' }],
  })
})

test('patchModels / refreshModels 直通', async () => {
  const { service, modelCalls } = harness()
  assert.deepEqual(await service.patchModels({ enabled: false }), { ok: true })
  assert.deepEqual(modelCalls.patch, [{ enabled: false }])
  assert.deepEqual(await service.refreshModels(), { ok: true })
  assert.equal(modelCalls.refresh, 1)
})

test('resolveAgentId：默认实现抛 AGENTMORE_AGENT_NOT_FOUND', async () => {
  const { service } = harness()
  await assert.rejects(() => service.resolveAgentId(), (error) => error.code === 'AGENTMORE_AGENT_NOT_FOUND')
})

test('resolveAgentId：注入后直接透传', async () => {
  const store = memoryStore([baseAccount()])
  const service = createAgentmoreService({
    store,
    client: { async refresh() { throw new Error('unused') }, async credits() { return { remaining: 0, display: '' } } },
    catalog: { invalidate() {} },
    modelService: { async status() { return {} }, async patch() {}, async refresh() {}, accountChanged() {} },
    login: { async start() {}, status() {}, async cancel() {}, async dispose() {} },
    resolveAgentId: async () => 'ag-from-injection',
  })
  assert.equal(await service.resolveAgentId(), 'ag-from-injection')
})
