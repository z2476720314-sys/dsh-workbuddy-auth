import assert from 'node:assert/strict'
import test from 'node:test'

import { accessTokenExpiry, agentmoreAccountsPath, createAgentmoreStore } from '../lib/agentmore-store.mjs'

/** 内存夹具：protector 用可逆 base64 冒充 DPAPI，落盘内容必须不是明文 JSON。 */
function memoryFile(initial = null) {
  const state = { text: initial, writes: 0 }
  return {
    state,
    readFile: async () => {
      if (state.text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return state.text
    },
    writeAtomic: async (_path, text) => {
      state.writes += 1
      state.text = text
    },
  }
}

function base64Protector() {
  return {
    protect: async (plaintext) => Buffer.from(plaintext, 'utf8').toString('base64'),
    unprotect: async (ciphertext) => Buffer.from(ciphertext, 'base64').toString('utf8'),
  }
}

const file = 'C:\\synthetic\\agentmore-accounts.dpapi'
const account = (overrides = {}) => ({
  accessToken: 'at-1',
  deviceId: 'dev-1',
  userId: 'u-1',
  ...overrides,
})

function makeStore(fixture, protector = base64Protector()) {
  return createAgentmoreStore({
    filePath: file,
    protector,
    readFile: fixture.readFile,
    writeAtomic: fixture.writeAtomic,
  })
}

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.s`

test('agentmoreAccountsPath：默认落在 DSH_HOME 下的 storages', () => {
  assert.equal(agentmoreAccountsPath({ env: { DSH_HOME: 'C:\\h' }, home: 'C:\\home' }), 'C:\\h\\storages\\agentmore-accounts.dpapi')
  assert.equal(agentmoreAccountsPath({ env: {}, home: 'C:\\home' }), 'C:\\home\\.dsh\\storages\\agentmore-accounts.dpapi')
  assert.equal(agentmoreAccountsPath({ env: { DSH_HOME: '   ' }, home: 'C:\\home' }), 'C:\\home\\.dsh\\storages\\agentmore-accounts.dpapi')
})

test('accessTokenExpiry：解 JWT exp，失败返回 null', () => {
  assert.equal(accessTokenExpiry(jwt({ exp: 1_700_000_000 })), 1_700_000_000_000)
  assert.equal(accessTokenExpiry('not-a-jwt'), null)
  assert.equal(accessTokenExpiry('a.'), null)
  assert.equal(accessTokenExpiry('a.!!!.c'), null)
  assert.equal(accessTokenExpiry(jwt({})), null)
  assert.equal(accessTokenExpiry(jwt({ exp: 0 })), null)
  assert.equal(accessTokenExpiry(jwt({ exp: 'abc' })), null)
  assert.equal(accessTokenExpiry(undefined), null)
  assert.equal(accessTokenExpiry(123), null)
})

test('createAgentmoreStore：缺依赖直接 TypeError', () => {
  const protector = base64Protector()
  for (const broken of [
    {},
    { filePath: '' },
    { protector, readFile: async () => '', writeAtomic: async () => {} },
    { filePath: file, readFile: async () => '', writeAtomic: async () => {}, protector: {} },
    { filePath: file, readFile: async () => '', writeAtomic: async () => {}, protector: { protect: async () => '' } },
  ]) {
    assert.throws(() => createAgentmoreStore(broken), TypeError, JSON.stringify(Object.keys(broken)))
  }
})

test('空库：ENOENT 视为空文档，首个 upsert 自动成为 active', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.getActive(), null)
  assert.equal(await store.getById('nope'), null)

  const created = await store.upsert(account())
  assert.match(created.id, /^[0-9a-f-]{36}$/, '缺 id 时自动生成 uuid')
  assert.equal(created.userId, 'u-1')
  assert.equal(created.credits, null)
  assert.equal(created.refreshedAt, 0)
  assert.equal(created.agentId, '')
  assert.deepEqual(await store.getActive(), created)
  assert.equal(fixture.state.writes, 1)
})

test('落盘内容是密文信封，明文永不出现在文件里', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  await store.upsert(account({ ['accessToken']: 'SECRET-TOKEN-CANARY' }))
  assert.equal(fixture.state.text.includes('SECRET-TOKEN-CANARY'), false)
  const decoded = JSON.parse(Buffer.from(fixture.state.text, 'base64').toString('utf8'))
  assert.equal(decoded.version, 1)
  assert.equal(decoded.accounts.length, 1)
})

test('upsert 按 userId 合并身份：重新登录覆盖而非新增', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  const first = await store.upsert(account({ accessToken: 'old', displayName: '旧' }))
  const second = await store.upsert(account({ id: 'other-id', accessToken: 'new', displayName: '新' }))
  assert.equal(second.id, first.id, 'id 沿用首条，不被新 id 覆盖')
  assert.equal(second.accessToken, 'new')
  assert.equal(second.displayName, '新')
  assert.equal((await store.list()).length, 1)
})

test('upsert 按 id 合并：userId 为空时退化为 id 匹配', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  const first = await store.upsert(account({ userId: '' }))
  const again = await store.upsert(account({ id: first.id, userId: '', accessToken: 'at-2' }))
  assert.equal(again.id, first.id)
  assert.equal(again.accessToken, 'at-2')
  assert.equal((await store.list()).length, 1)
})

test('userId 为空不会被当成同一身份合并（避免把两个游客并成一条）', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  await store.upsert(account({ userId: '', accessToken: 'a' }))
  await store.upsert(account({ userId: '', accessToken: 'b' }))
  assert.equal((await store.list()).length, 2)
})

test('setActiveId：切换、置空、未知 id 报 NOT_FOUND', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  const a = await store.upsert(account({ userId: 'u-a' }))
  const b = await store.upsert(account({ userId: 'u-b' }))
  assert.equal((await store.getActive()).id, a.id, '首条保持 active')

  assert.equal(await store.setActiveId(b.id), b.id)
  assert.equal((await store.getActive()).id, b.id)

  assert.equal(await store.setActiveId(null), null)
  assert.equal(await store.getActive(), null)
  await assert.rejects(store.setActiveId('missing'), { code: 'AGENTMORE_ACCOUNT_NOT_FOUND' })
})

test('setActiveId 幂等时不重复写盘', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  const a = await store.upsert(account())
  const before = fixture.state.writes
  await store.setActiveId(a.id)
  assert.equal(fixture.state.writes, before)
})

test('remove：删非 active 保留 active，删 active 置 null，未知 id 报 NOT_FOUND', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  const a = await store.upsert(account({ userId: 'u-a' }))
  const b = await store.upsert(account({ userId: 'u-b' }))
  await store.setActiveId(a.id)

  await store.remove(b.id)
  assert.deepEqual((await store.list()).map((item) => item.id), [a.id])
  assert.equal((await store.getActive()).id, a.id)

  await store.remove(a.id)
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.getActive(), null)
  await assert.rejects(store.remove(a.id), { code: 'AGENTMORE_ACCOUNT_NOT_FOUND' })
})

test('字段白名单：任何非白名单键被拒', async () => {
  const store = makeStore(memoryFile(null))
  for (const extra of [{ region: 'cn' }, { apiOrigin: 'https://x' }, { uin: '1' }, { isGuest: false }]) {
    await assert.rejects(store.upsert(account(extra)), { code: 'AGENTMORE_ACCOUNT_INVALID' })
  }
})

test('必填与类型校验', async () => {
  const store = makeStore(memoryFile(null))
  const invalid = [
    { accessToken: '', deviceId: 'd' },
    { deviceId: 'd' },
    { accessToken: 'a' },
    { accessToken: 'a', deviceId: '' },
    { accessToken: 123, deviceId: 'd' },
    { accessToken: 'a', deviceId: 'd', refreshedAt: -1 },
    { accessToken: 'a', deviceId: 'd', refreshedAt: 1.5 },
    { accessToken: 'a', deviceId: 'd', createdAt: 'now' },
    { accessToken: 'a', deviceId: 'd', credits: 'NaN' },
    { accessToken: 'a', deviceId: 'd', id: '' },
    { accessToken: 'a', deviceId: 'd', userId: 'x'.repeat(257) },
  ]
  for (const input of invalid) {
    await assert.rejects(store.upsert(input), { code: 'AGENTMORE_ACCOUNT_INVALID' }, JSON.stringify(input))
  }
})

test('可选字段接受 null / 空串', async () => {
  const store = makeStore(memoryFile(null))
  const created = await store.upsert(account({ userId: '', displayName: '', refreshToken: '', agentId: '', conversationId: '', credits: null }))
  assert.equal(created.userId, '')
  assert.equal(created.refreshToken, '')
  assert.equal(created.credits, null)
})

test('读盘：解密失败 / 非法密文 / 非法文档分别报对应错误码', async () => {
  const failing = createAgentmoreStore({
    filePath: file,
    protector: { protect: async (text) => text, unprotect: async () => { throw new Error('bad key') } },
    readFile: async () => 'ciphertext',
    writeAtomic: async () => {},
  })
  await assert.rejects(failing.list(), { code: 'AGENTMORE_STORE_DECRYPT_FAILED' })

  const empty = createAgentmoreStore({
    filePath: file,
    protector: base64Protector(),
    readFile: async () => '',
    writeAtomic: async () => {},
  })
  await assert.rejects(empty.list(), { code: 'AGENTMORE_STORE_INVALID' })

  for (const bad of ['not json', JSON.stringify({ version: 2, activeId: null, accounts: [] }), JSON.stringify({ version: 1, activeId: null }), JSON.stringify({ version: 1, activeId: 'x', accounts: [] })]) {
    const store = createAgentmoreStore({
      filePath: file,
      protector: base64Protector(),
      readFile: async () => Buffer.from(bad, 'utf8').toString('base64'),
      writeAtomic: async () => {},
    })
    await assert.rejects(store.list(), { code: 'AGENTMORE_STORE_INVALID' }, bad)
  }
})

test('读盘：重复 id 视为非法文档', async () => {
  const duplicated = {
    version: 1,
    activeId: null,
    accounts: [
      { id: 'same', accessToken: 'a', deviceId: 'd' },
      { id: 'same', accessToken: 'b', deviceId: 'd' },
    ],
  }
  const store = createAgentmoreStore({
    filePath: file,
    protector: base64Protector(),
    readFile: async () => Buffer.from(JSON.stringify(duplicated), 'utf8').toString('base64'),
    writeAtomic: async () => {},
  })
  await assert.rejects(store.list(), { code: 'AGENTMORE_STORE_INVALID' })
})

test('读盘：白名单外的文档键视为非法', async () => {
  const polluted = { version: 1, activeId: null, accounts: [], region: 'cn' }
  const store = createAgentmoreStore({
    filePath: file,
    protector: base64Protector(),
    readFile: async () => Buffer.from(JSON.stringify(polluted), 'utf8').toString('base64'),
    writeAtomic: async () => {},
  })
  await assert.rejects(store.list(), { code: 'AGENTMORE_STORE_INVALID' })
})

test('读盘：非 ENOENT 的 IO 错误报 STORE_READ_FAILED', async () => {
  const store = createAgentmoreStore({
    filePath: file,
    protector: base64Protector(),
    readFile: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
    writeAtomic: async () => {},
  })
  await assert.rejects(store.list(), { code: 'AGENTMORE_STORE_READ_FAILED' })
})

test('写盘失败报 STORE_WRITE_FAILED 且不污染内存文档', async () => {
  const fixture = memoryFile(null)
  const store = createAgentmoreStore({
    filePath: file,
    protector: base64Protector(),
    readFile: fixture.readFile,
    writeAtomic: async () => { throw new Error('disk full') },
  })
  await assert.rejects(store.upsert(account()), { code: 'AGENTMORE_STORE_WRITE_FAILED' })
  assert.deepEqual(await store.list(), [], '写失败后内存里也不应有半个账号')
})

test('加密失败报 STORE_ENCRYPT_FAILED', async () => {
  const store = createAgentmoreStore({
    filePath: file,
    protector: { protect: async () => '', unprotect: async (text) => text },
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    writeAtomic: async () => {},
  })
  await assert.rejects(store.upsert(account()), { code: 'AGENTMORE_STORE_ENCRYPT_FAILED' })
})

test('并发 upsert 串行化：两次写都落盘且不互相覆盖', async () => {
  const fixture = memoryFile(null)
  const store = makeStore(fixture)
  await Promise.all([
    store.upsert(account({ userId: 'u-1' })),
    store.upsert(account({ userId: 'u-2' })),
    store.upsert(account({ userId: 'u-3' })),
  ])
  assert.equal((await store.list()).length, 3)
  assert.equal(fixture.state.writes, 3)
})

test('并发读共享同一次加载', async () => {
  let reads = 0
  const store = createAgentmoreStore({
    filePath: file,
    protector: base64Protector(),
    readFile: async () => {
      reads += 1
      await new Promise((resolve) => setImmediate(resolve))
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    writeAtomic: async () => {},
  })
  await Promise.all([store.list(), store.list(), store.getActive()])
  assert.equal(reads, 1)
})

test('返回的是副本，调用方改不动内部状态', async () => {
  const store = makeStore(memoryFile(null))
  const created = await store.upsert(account())
  created['accessToken'] = 'tampered'
  const listed = await store.list()
  listed[0]['accessToken'] = 'tampered-2'
  assert.equal((await store.getById(created.id)).accessToken, 'at-1')
})
