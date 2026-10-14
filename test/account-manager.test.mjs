// account-manager：桌面 .info 与 DPAPI 托管账号合并目录、安全 DTO、激活上下文与按账号加锁。
// 全部使用真实的 createManagedAccountStore + 临时目录；DPAPI 以确定性假 protector 替代（真实 DPAPI 由 dpapi.test.mjs 覆盖）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccountManager, createKeyedLock } from '../lib/account-manager.mjs'
import { createManagedAccountStore } from '../lib/managed-store.mjs'

const DAY = 86_400_000
const DESKTOP_TOKEN = 'DESKTOP-TOKEN-SYNTHETIC-0001'
const DESKTOP_REFRESH = 'DESKTOP-REFRESH-SYNTHETIC-0001'
const MG_TOK = 'MANAGED-TOKEN-SYNTHETIC-0002'
const MANAGED_REFRESH = 'MANAGED-REFRESH-SYNTHETIC-0002'
const DESKTOP_FILE = 'Tencent-Cloud.coding-copilot.info'

/** 确定性假 protector：输出是 base64 密文，不含明文子串。 */
function fakeProtector() {
  return {
    async protect(plaintext) {
      return `ENC1:${Buffer.from(plaintext, 'utf8').toString('base64')}`
    },
    async unprotect(ciphertext) {
      if (!ciphertext.startsWith('ENC1:')) throw new Error('not ciphertext')
      return Buffer.from(ciphertext.slice(5), 'base64').toString('utf8')
    },
  }
}

function desktopRecord({ token = DESKTOP_TOKEN, refresh = DESKTOP_REFRESH, uid, nickname, phone, expiresAt = Date.now() + 30 * DAY } = {}) {
  const account = { nickname, phoneNumber: phone }
  if (uid !== undefined) account.uid = uid
  return JSON.stringify({ auth: { accessToken: token, refreshToken: refresh, expiresAt }, account })
}

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'wb-acct-'))
  const authDir = join(home, 'auth')
  mkdirSync(authDir, { recursive: true })
  return { home, authDir, storeFile: join(home, 'storages', 'workbuddy-accounts.dpapi') }
}

function writeDesktop(authDir, name, record) {
  writeFileSync(join(authDir, name), record)
}

function managedAccount(over = {}) {
  return {
    region: 'cn',
    uid: 'uid-managed-1',
    uin: '',
    displayName: '托管甲',
    phoneMasked: '183****9655',
    accessToken: MG_TOK,
    refreshToken: MANAGED_REFRESH,
    expiresAt: Date.now() + 30 * DAY,
    refreshExpiresAt: Date.now() + 60 * DAY,
    apiOrigin: 'https://copilot.tencent.com',
    ...over,
  }
}

async function makeStore(fixture, accounts = []) {
  const store = createManagedAccountStore({ filePath: fixture.storeFile, protector: fakeProtector() })
  for (const account of accounts) await store.upsert(account)
  return store
}

function managerFor(fixture, {
  store,
  patchCalls = [],
  persisted = true,
  initialDesktopFile = join(fixture.authDir, DESKTOP_FILE),
  writeFile = (path, text) => writeFileSync(path, text),
} = {}) {
  return createAccountManager({
    authDir: fixture.authDir,
    managedStore: store,
    initialDesktopFile,
    persistDesktopSelection: async (filePath) => {
      patchCalls.push(filePath)
      return persisted
    },
    writeFile,
  })
}

for (const scenario of ['expired', 'deduplicated', 'late-login']) {
  test(`merged source reads managed credentials: ${scenario}`, async () => {
    const fx = makeFixture()
    try {
      writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({
        uid: 'uid-shared',
        expiresAt: Date.now() + (scenario === 'expired' ? -DAY : 30 * DAY),
      }))
      const store = await makeStore(fx)
      const manager = managerFor(fx, { store })
      if (scenario === 'late-login') {
        assert.equal(JSON.parse((await manager.readActive()).text).auth.accessToken, DESKTOP_TOKEN)
      }
      if (scenario === 'deduplicated') {
        writeDesktop(fx.authDir, 'merged-newer.info', desktopRecord({ uid: 'uid-shared', expiresAt: Date.now() + 60 * DAY }))
      }
      const saved = await store.upsert(managedAccount({ uid: 'uid-shared' }))
      const id = `managed:${saved.id}`
      const active = await manager.readActive()
      assert.equal(active.accountId, id)
      assert.equal((await manager.describe()).activeId, id)
      assert.equal(JSON.parse(active.text).auth.accessToken, MG_TOK)
      assert.equal(JSON.parse(active.text).auth.refreshToken, MANAGED_REFRESH)
      assert.equal(manager.context().accountId, id)
      assert.equal(await manager.isActiveAccount(id), true)
      assert.equal(await store.getActiveId(), null)
    } finally {
      rmSync(fx.home, { recursive: true, force: true })
    }
  })
}

/** 断言拒绝且错误信息不含本机路径（不回显路径）。 */
async function assertRejectsSafely(promise, home) {
  await assert.rejects(promise, (error) => {
    assert.match(String(error?.message), /unknown credential source/)
    assert.equal(String(error.message).includes(home), false, '错误信息不得含本机路径')
    return true
  })
}

test('describe 合并桌面与托管账号，DTO 只含安全字段且不泄露路径或令牌', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面乙', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount()])
    const manager = managerFor(fx, { store })

    const described = await manager.describe()
    assert.equal(described.sources.length, 2, '桌面与托管都应可见')
    const byName = Object.fromEntries(described.sources.map((s) => [s.label.nickname, s]))
    assert.equal(byName['托管甲'].source, 'managed')
    assert.equal(byName['桌面乙'].source, 'desktop')
    assert.equal(byName['托管甲'].region, 'cn')
    for (const source of described.sources) {
      // encrypted / stale 是 0.2.3 起的固定字段：设置卡靠它们标注「已加密」「已失效」。
      assert.deepEqual(Object.keys(source).sort(), ['accessExpiresAt', 'encrypted', 'id', 'label', 'region', 'source', 'stale'])
      assert.deepEqual(Object.keys(source.label).sort(), ['nickname', 'phoneMasked', 'uidTail'])
    }
    assert.ok(byName['托管甲'].id.startsWith('managed:'), '托管 id 必须带 managed: 命名空间')
    assert.match(byName['桌面乙'].id, /^[0-9a-f]{16}$/, '桌面 id 为不可逆摘要')

    const text = JSON.stringify(described)
    assert.equal(text.includes(fx.home), false, 'DTO 不得含本机路径')
    assert.equal(text.includes('.info'), false, 'DTO 不得含文件名')
    for (const needle of [DESKTOP_TOKEN, DESKTOP_REFRESH, MG_TOK, MANAGED_REFRESH, 'accessToken', 'refreshToken']) {
      assert.equal(text.includes(needle), false, `DTO 不得含 ${needle.slice(0, 12)}`)
    }
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('去重只在 region 与稳定 uid 同时一致时发生：同 region 同 uid 合并为托管代表', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-shared', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount({ uid: 'uid-shared', displayName: '托管甲' })])
    const manager = managerFor(fx, { store })
    const described = await manager.describe()
    assert.equal(await store.getActiveId(), null)
    const active = await manager.readActive()
    assert.equal(active.accountId, described.activeId)
    assert.equal(JSON.parse(active.text).auth.accessToken, MG_TOK)
    assert.equal(JSON.parse(active.text).auth.refreshToken, MANAGED_REFRESH)
    assert.equal(manager.context().accountId, described.activeId)
    assert.equal(await manager.isActiveAccount(active.accountId), true)
    assert.equal(described.sources.length, 1, '同 region + 同 uid 应合并为一条')
    assert.equal(described.sources[0].source, 'managed', '合并后的代表是托管记录')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('去重：region 不同即使 uid 相同也不合并', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-x', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount({ uid: 'uid-x', region: 'intl', apiOrigin: 'https://www.workbuddy.ai', displayName: '托管甲' })])
    const described = await managerFor(fx, { store }).describe()
    assert.equal(described.sources.length, 2)
    assert.deepEqual(described.sources.map((s) => s.source).sort(), ['desktop', 'managed'])
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('去重：缺少稳定 uid/uin 时绝不因昵称或手机号相同而推测合并', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ nickname: '同名甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount({ uid: '', uin: '', displayName: '同名甲', phoneMasked: '138****0001' })])
    const described = await managerFor(fx, { store }).describe()
    assert.equal(described.sources.length, 2, '无稳定身份不得合并')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('describe 输出顺序确定：两次调用结果逐字一致，且按昵称排序', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '乙桌面', phone: '13800000001' }))
    writeDesktop(fx.authDir, 'other.info', desktopRecord({ token: 'OTHER-TOKEN-0003', uid: 'uid-desk-2', nickname: '甲桌面', phone: '13900000002' }))
    const store = await makeStore(fx, [managedAccount({ displayName: '丙托管', uid: 'uid-managed-9' })])
    const manager = managerFor(fx, { store })
    const first = await manager.describe()
    const second = await manager.describe()
    assert.equal(JSON.stringify(first), JSON.stringify(second))
    const names = first.sources.map((s) => s.label.nickname)
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')))
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('未知 id、路径与空串一律拒绝，错误信息不回显路径', async () => {
  const fx = makeFixture()
  try {
    const desktopPath = join(fx.authDir, DESKTOP_FILE)
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面甲', phone: '13800000001' }))
    const manager = managerFor(fx, { store: await makeStore(fx) })
    await assertRejectsSafely(manager.activate('deadbeefdeadbeef'), fx.home)
    await assertRejectsSafely(manager.activate(''), fx.home)
    await assertRejectsSafely(manager.resolve(desktopPath), fx.home)
    await assertRejectsSafely(manager.resolve(fx.authDir), fx.home)
    // 合法 id 仍可解析（证明拒绝的是未知 id 而不是一律拒绝）
    const [only] = (await manager.describe()).sources
    assert.equal((await manager.resolve(only.id)).id, only.id)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('桌面激活保留 patch 路径持久化，并更新 current 与 readActiveText', async () => {
  const fx = makeFixture()
  try {
    const desktopPath = join(fx.authDir, DESKTOP_FILE)
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面甲', phone: '13800000001' }))
    writeDesktop(fx.authDir, 'workbuddy-desktop.info', desktopRecord({ token: 'DESKTOP-TOKEN-B-0004', refresh: 'DESKTOP-REFRESH-B', uid: 'uid-desk-2', nickname: '桌面乙', phone: '13900000002' }))
    const patchCalls = []
    const manager = managerFor(fx, { store: await makeStore(fx), patchCalls, initialDesktopFile: desktopPath })
    const target = (await manager.describe()).sources.find((s) => s.label.nickname === '桌面乙')

    const result = await manager.activate(target.id)
    assert.deepEqual(result, { ok: true, activeId: target.id, persisted: true })
    assert.equal(patchCalls.length, 1)
    assert.equal(patchCalls[0], join(fx.authDir, 'workbuddy-desktop.info'))
    assert.equal((await manager.current()).id, target.id)
    assert.equal((await manager.describe()).activeId, target.id)
    assert.ok((await manager.readActive()).text.includes('DESKTOP-TOKEN-B-0004'))
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('托管激活把 activeId 写入加密存储并切换同一激活上下文；切回桌面会清除托管 activeId', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount()])
    const managedId = (await store.list())[0].id
    const patchCalls = []
    const manager = managerFor(fx, { store, patchCalls })
    const described = await manager.describe()
    const managedTarget = described.sources.find((s) => s.source === 'managed')
    const desktopTarget = described.sources.find((s) => s.source === 'desktop')

    const result = await manager.activate(managedTarget.id)
    assert.equal(result.activeId, managedTarget.id)
    assert.equal(await store.getActiveId(), managedId)
    assert.equal(patchCalls.length, 0, '托管激活不写 patch 路径')
    assert.equal((await manager.current()).source, 'managed')
    assert.ok((await manager.readActive()).text.includes(MG_TOK), '同一上下文读取到托管凭据')
    const onDisk = readFileSync(fx.storeFile, 'utf8')
    assert.equal(onDisk.includes(MG_TOK), false, '磁盘上只有密文')

    await manager.activate(desktopTarget.id)
    assert.equal(await store.getActiveId(), null, '切回桌面必须清除托管 activeId，避免重启后误回托管')
    assert.equal((await manager.current()).source, 'desktop')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('启动时恢复已持久化的托管 activeId，成为激活上下文', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount()])
    await store.setActiveId((await store.list())[0].id)
    const manager = managerFor(fx, { store })
    const current = await manager.current()
    assert.equal(current.source, 'managed')
    assert.equal(current.label.nickname, '托管甲')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('writeActiveText 对托管记录只更新令牌与到期字段，保留身份与 id', async () => {
  const fx = makeFixture()
  try {
    const store = await makeStore(fx, [managedAccount()])
    const before = (await store.list())[0]
    const manager = managerFor(fx, { store, initialDesktopFile: join(fx.authDir, DESKTOP_FILE) })
    const target = (await manager.describe()).sources.find((s) => s.source === 'managed')
    await manager.activate(target.id)

    const refreshed = JSON.stringify({
      auth: { accessToken: 'mgd-t5', refreshToken: 'MANAGED-REFRESH-NEW-0005', expiresAt: 1800000000000, refreshExpiresAt: 1900000000000 },
      account: { uid: 'uid-managed-1', nickname: 'ignored-by-store' },
    })
    const read = await manager.readActive()
    assert.equal(read.accountId, target.id, '读到的账号 id 必须是激活账号的命名空间 id')
    await manager.writeActiveText(read.accountId, refreshed)

    const after = await store.getById(before.id)
    assert.equal(after.id, before.id)
    assert.equal(after.displayName, '托管甲')
    assert.equal(after.region, 'cn')
    assert.equal(after.accessToken, 'mgd-t5')
    assert.equal(after.refreshToken, 'MANAGED-REFRESH-NEW-0005')
    assert.equal(after.expiresAt, 1800000000000)
    assert.equal(readFileSync(fx.storeFile, 'utf8').includes('mgd-t5'), false, '磁盘上只有密文')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('createKeyedLock：同一 key 串行，不同 key 互不阻塞', async () => {
  const lock = createKeyedLock()
  const events = []
  let releaseA
  const gateA = new Promise((resolve) => { releaseA = resolve })
  const a1 = lock.run('acct-a', async () => {
    events.push('a1:start')
    await gateA
    events.push('a1:end')
  })
  const a2 = lock.run('acct-a', async () => {
    events.push('a2:start')
    events.push('a2:end')
  })
  await lock.run('acct-b', async () => {
    events.push('b1:start')
    events.push('b1:end')
  })
  assert.deepEqual(events.filter((e) => e.startsWith('b1')), ['b1:start', 'b1:end'], '不同 id 不得被阻塞')
  assert.equal(events.includes('a2:start'), false, '同一 id 的第二个任务必须等待第一个')
  releaseA()
  await Promise.all([a1, a2])
  assert.ok(events.indexOf('a2:start') > events.indexOf('a1:end'), '同一 id 严格串行')
})

test('manager.withAccountLock 与 createKeyedLock 语义一致：同 id 串行、异 id 并发', async () => {
  const fx = makeFixture()
  try {
    const manager = managerFor(fx, { store: await makeStore(fx) })
    const events = []
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const first = manager.withAccountLock('same', async () => { events.push('first'); await gate; events.push('first-end') })
    const second = manager.withAccountLock('same', async () => { events.push('second') })
    const other = manager.withAccountLock('other', async () => { events.push('other') })
    await other
    assert.equal(events.includes('second'), false)
    assert.ok(events.includes('other'))
    release()
    await Promise.all([first, second])
    assert.deepEqual(events, ['first', 'other', 'first-end', 'second'])
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

// ---- 复核修复：写回按「读到的账号」定点（身份钉住），激活串行化 ----

test('writeActiveText 定点写回托管账号：切换后到达的在飞写回不得污染新激活账号', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount()])
    const managedId = (await store.list())[0].id
    const manager = managerFor(fx, { store })

    // t0：托管账号处于激活态时被同步读取。
    await manager.activate(`managed:${managedId}`)
    const read = await manager.readActive()
    assert.equal(read.accountId, `managed:${managedId}`)

    // t1：用户切到桌面账号。
    const desktop = (await manager.describe()).sources.find((s) => s.source === 'desktop')
    await manager.activate(desktop.id)

    // t2：属于托管账号的在飞刷新结果写回 —— 必须落回它读到的托管记录，而不是写时的激活桌面文件。
    const refreshed = JSON.stringify({
      auth: { accessToken: 'mgd-t6', refreshToken: 'MANAGED-REFRESH-NEW-0006', expiresAt: 1800000000001, refreshExpiresAt: 1900000000001 },
      account: { uid: 'uid-managed-1' },
    })
    await manager.writeActiveText(read.accountId, refreshed)

    const record = await store.getById(managedId)
    assert.equal(record.accessToken, 'mgd-t6', '刷新结果必须落回它读到的托管账号')
    const desktopText = readFileSync(join(fx.authDir, DESKTOP_FILE), 'utf8')
    assert.equal(desktopText.includes('mgd-t6'), false, '桌面凭据文件不得被托管令牌污染')
    assert.ok(desktopText.includes(DESKTOP_TOKEN), '桌面账号自身凭据保持不变')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('writeActiveText 定点写回桌面账号：切换后到达的在飞写回只改原文件', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount()])
    const managedId = (await store.list())[0].id
    const manager = managerFor(fx, { store })

    const desktop = (await manager.describe()).sources.find((s) => s.source === 'desktop')
    await manager.activate(desktop.id)
    const read = await manager.readActive()
    assert.equal(read.accountId, desktop.id)

    await manager.activate(`managed:${managedId}`)
    const refreshed = JSON.stringify({
      auth: { accessToken: 'dsk-t7', refreshToken: 'DESKTOP-REFRESH-NEW-0007', expiresAt: 1800000000002 },
      account: { uid: 'uid-desk-1' },
    })
    await manager.writeActiveText(read.accountId, refreshed)

    assert.ok(readFileSync(join(fx.authDir, DESKTOP_FILE), 'utf8').includes('dsk-t7'), '桌面刷新结果必须落回原文件')
    const record = await store.getById(managedId)
    assert.equal(record.accessToken, MG_TOK, '托管账号令牌不得被桌面刷新结果覆盖')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('writeActiveText 对未知或空 accountId 一律拒绝，绝不退回「当前激活账号」', async () => {
  const fx = makeFixture()
  try {
    const store = await makeStore(fx, [managedAccount()])
    const managedId = (await store.list())[0].id
    const manager = managerFor(fx, { store })
    await manager.activate(`managed:${managedId}`)
    for (const badId of ['deadbeefdeadbeef', '', undefined, 'managed:not-a-real-id']) {
      await assert.rejects(() => manager.writeActiveText(badId, '{"auth":{"accessToken":"X-0008"}}'), (error) => {
        assert.match(String(error?.message), /unknown credential source/)
        assert.equal(String(error.message).includes(fx.home), false, '错误信息不得含本机路径')
        return true
      })
    }
    assert.equal((await store.getById(managedId)).accessToken, MG_TOK, '拒绝写回时激活账号必须保持原值')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('并发激活不同 id 必须串行：任一时刻只有一个激活在提交 active 状态', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-1', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount()])
    const managedId = (await store.list())[0].id
    let inside = 0
    let overlap = 0
    const gated = {
      ...store,
      async setActiveId(id) {
        inside += 1
        if (inside > 1) overlap += 1
        try {
          await new Promise((resolve) => setTimeout(resolve, 25))
          return await store.setActiveId(id)
        } finally {
          inside -= 1
        }
      },
    }
    const manager = managerFor(fx, { store: gated })
    const desktop = (await manager.describe()).sources.find((s) => s.source === 'desktop')
    const [managedResult, desktopResult] = await Promise.all([manager.activate(`managed:${managedId}`), manager.activate(desktop.id)])
    assert.equal(overlap, 0, '不同 id 的并发激活不得同时在提交 active 状态')
    // 最后一个完成的激活结果必须与落盘状态一致（不会出现「响应说托管、磁盘是桌面」）。
    assert.equal(managedResult.activeId, `managed:${managedId}`)
    assert.equal((await manager.describe()).activeId, desktopResult.activeId)
    assert.equal(await store.getActiveId(), null)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('同步上下文随激活切换：Intl 托管账号给出 Intl origin，绝不回退 CN', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-ctx', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [
      managedAccount({ region: 'intl', uid: 'uid-intl-ctx-1', apiOrigin: 'https://www.workbuddy.ai', displayName: '国际甲' }),
    ])
    const manager = managerFor(fx, { store })

    assert.deepEqual(manager.context(), { accountId: '', region: '', apiOrigin: '', authHost: '', uid: '' }, '未激活时上下文为空，调用方退回默认行为')

    const intlId = (await manager.describe()).sources.find((s) => s.source === 'managed').id
    await manager.activate(intlId)
    const intlContext = manager.context()
    assert.equal(intlContext.accountId, intlId)
    assert.equal(intlContext.region, 'intl')
    assert.equal(intlContext.apiOrigin, 'https://www.workbuddy.ai')
    assert.equal(intlContext.uid, 'uid-intl-ctx-1')

    const desktopId = (await manager.describe()).sources.find((s) => s.source === 'desktop').id
    await manager.activate(desktopId)
    const desktopContext = manager.context()
    assert.equal(desktopContext.accountId, desktopId)
    assert.equal(desktopContext.region, 'cn', '桌面凭据只存在于 CN 目录，切回桌面即回 CN')
    assert.equal(desktopContext.apiOrigin, 'https://copilot.tencent.com')
    assert.equal(desktopContext.uid, 'uid-desk-ctx')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('refreshContext 只认「本次扫描 + 落盘 activeId」，不靠上一次的残留快照', async () => {
  const fx = makeFixture()
  try {
    writeDesktop(fx.authDir, DESKTOP_FILE, desktopRecord({ uid: 'uid-desk-ctx2', nickname: '桌面甲', phone: '13800000001' }))
    const store = await makeStore(fx, [managedAccount({ region: 'intl', uid: 'uid-intl-ctx-2', apiOrigin: 'https://www.codebuddy.ai', displayName: '国际乙' })])
    const manager = managerFor(fx, { store })
    const intlId = (await manager.describe()).sources.find((s) => s.source === 'managed').id

    // 直接在存储里换激活账号（模拟外部/重启后的状态），refreshContext 必须跟上。
    await store.setActiveId((await store.list())[0].id)
    const refreshed = await manager.refreshContext()
    assert.equal(refreshed.accountId, intlId)
    assert.equal(refreshed.region, 'intl')
    assert.equal(refreshed.apiOrigin, 'https://www.codebuddy.ai')

    // 托管 activeId 被清掉后：回落到桌面文件，地区跟着回到 CN。
    await store.setActiveId(null)
    const desktop = await manager.refreshContext()
    assert.equal(desktop.region, 'cn')
    assert.equal(desktop.apiOrigin, 'https://copilot.tencent.com')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})
