// 签到状态持久化（Task 2）：缺文件默认、往返、本地日重置、坏文件恢复、原子写失败、无令牌字段。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECKIN_STORE_VERSION, checkinStatePath, createCheckinStore } from '../lib/checkin-store.mjs'
import { localDateString } from '../lib/checkin.mjs'

const T0 = 1_790_000_000_000
const TOKEN_MARK = 'SECRET-TOKEN-'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'wb-checkin-store-'))
}

function makeStore(home, overrides = {}) {
  const filePath = join(home, 'storages', 'workbuddy-auth-checkin.json')
  return { filePath, store: createCheckinStore({ filePath, now: () => T0, timeZone: 'Asia/Shanghai', ...overrides }) }
}

test('缺文件时给出默认值：enabled 为 true、空账号表、零时间戳', async () => {
  const home = makeHome()
  try {
    const { store } = makeStore(home)
    const state = await store.load()
    assert.equal(state.version, CHECKIN_STORE_VERSION)
    assert.equal(state.enabled, true)
    assert.deepEqual(state.accounts, {})
    assert.equal(state.lastRunAt, 0)
    assert.equal(store.getEnabled(), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('往返：设置开关、账号状态与运行时间后重新加载仍然一致', async () => {
  const home = makeHome()
  try {
    const { filePath, store } = makeStore(home)
    await store.load()
    await store.setEnabled(false)
    await store.updateAccount('managed:cn-1', { date: localDateString(T0, 'Asia/Shanghai'), done: true, attempts: 1, outcome: 'done', lastResultAt: T0 })
    await store.setLastRunAt(T0)

    const reopened = createCheckinStore({ filePath, now: () => T0, timeZone: 'Asia/Shanghai' })
    const state = await reopened.load()
    assert.equal(state.enabled, false)
    assert.equal(state.lastRunAt, T0)
    assert.deepEqual(state.accounts['managed:cn-1'], {
      date: localDateString(T0, 'Asia/Shanghai'),
      done: true,
      attempts: 1,
      outcome: 'done',
      lastResultAt: T0,
    })
    assert.equal(reopened.getEnabled(), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('本地日重置：昨天（done/attempts）的条目在加载时被丢弃', async () => {
  const home = makeHome()
  try {
    const { filePath } = makeStore(home)
    const yesterday = localDateString(T0 - 24 * 60 * 60 * 1000, 'Asia/Shanghai')
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(
      filePath,
      JSON.stringify({ version: 1, enabled: true, accounts: { 'managed:cn-1': { date: yesterday, done: true, attempts: 3, outcome: 'done' } }, lastRunAt: T0 - 1000 }),
      'utf8',
    )
    // 父目录不存在时也要能加载默认值（不会因为目录缺失抛错）。
    const fresh = createCheckinStore({ filePath: join(home, 'missing', 'storages', 'workbuddy-auth-checkin.json'), now: () => T0, timeZone: 'Asia/Shanghai' })
    assert.deepEqual((await fresh.load()).accounts, {})

    const store = createCheckinStore({ filePath, now: () => T0, timeZone: 'Asia/Shanghai' })
    const state = await store.load()
    assert.deepEqual(state.accounts, {}, '昨天的条目不得阻止今天的签到')
    assert.equal(state.lastRunAt, T0 - 1000, 'lastRunAt 保留（不是账号状态）')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('坏 JSON 与坏条目都被清洗：加载不抛错，且能继续写入', async () => {
  const home = makeHome()
  try {
    const { filePath, store } = makeStore(home)
    await store.load()
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(filePath, '{ this is not json', 'utf8')

    const recovered = createCheckinStore({ filePath, now: () => T0, timeZone: 'Asia/Shanghai' })
    const state = await recovered.load()
    assert.equal(state.enabled, true)
    assert.deepEqual(state.accounts, {})
    await recovered.setEnabled(false)
    assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).enabled, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('坏条目被逐条丢弃：date 非字符串、attempts 非数字、未知 outcome、非对象', async () => {
  const home = makeHome()
  try {
    const { filePath } = makeStore(home)
    const today = localDateString(T0, 'Asia/Shanghai')
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        enabled: 'yes',
        lastRunAt: 'nope',
        accounts: {
          'bad:1': { date: 123, done: true },
          'bad:2': { date: today, attempts: 'many' },
          'bad:3': { date: today, outcome: 'exploded' },
          'bad:4': 'not-an-object',
          'good:5': { date: today, done: true, attempts: 2, outcome: 'done', lastResultAt: T0 },
        },
      }),
      'utf8',
    )
    const store = createCheckinStore({ filePath, now: () => T0, timeZone: 'Asia/Shanghai' })
    const state = await store.load()
    assert.equal(state.enabled, true, '非布尔 enabled 退回默认 true')
    assert.equal(state.lastRunAt, 0, '非数字 lastRunAt 退回 0')
    assert.deepEqual(Object.keys(state.accounts), ['good:5'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('落盘只保留白名单字段：令牌、路径、昵称一律不进状态文件', async () => {
  const home = makeHome()
  try {
    const { filePath, store } = makeStore(home)
    await store.load()
    mkdirSync(join(home, 'storages'), { recursive: true })
    const tok = `${TOKEN_MARK}access`
    await store.updateAccount('managed:cn-1', {
      date: localDateString(T0, 'Asia/Shanghai'),
      done: false,
      attempts: 1,
      outcome: 'failed',
      lastResultAt: T0,
      accessToken: tok,
      refreshToken: `${TOKEN_MARK}refresh`,
      filePath: 'C:\\synthetic-root\\somebody\\AppData\\Roaming\\Tencent-Cloud.coding-copilot.info',
      uid: 'uid-should-not-be-stored',
      nickname: '昵称也不该落盘',
    })

    const text = readFileSync(filePath, 'utf8')
    assert.ok(!text.includes(TOKEN_MARK), '状态文件不得包含令牌')
    assert.ok(!text.includes('C:\\'), '状态文件不得包含本机路径')
    assert.ok(!text.includes('uid-should-not-be-stored'))
    assert.ok(!text.includes('昵称也不该落盘'))
    const entry = JSON.parse(text).accounts['managed:cn-1']
    assert.deepEqual(Object.keys(entry).sort(), ['attempts', 'date', 'done', 'lastResultAt', 'outcome'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('写入失败：抛固定错误码、不泄漏路径，且旧文件内容保持原样', async () => {
  const home = makeHome()
  try {
    const filePath = join(home, 'storages', 'workbuddy-auth-checkin.json')
    mkdirSync(join(home, 'storages'), { recursive: true })
    const good = createCheckinStore({ filePath, now: () => T0, timeZone: 'Asia/Shanghai' })
    await good.load()
    await good.setEnabled(false)
    const before = readFileSync(filePath, 'utf8')

    const failing = createCheckinStore({
      filePath,
      now: () => T0,
      timeZone: 'Asia/Shanghai',
      writeAtomic: () => {
        throw new Error(`EPERM: operation not permitted, rename '${filePath}'`)
      },
    })
    await failing.load()
    await assert.rejects(
      () => failing.setEnabled(true),
      (error) => {
        assert.equal(error.message, 'CHECKIN_STORE_WRITE_FAILED')
        assert.ok(!error.message.includes(home), '错误信息不得包含本机路径')
        return true
      },
    )
    assert.equal(readFileSync(filePath, 'utf8'), before, '失败后旧文件必须保持原样')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('写入走原子替换并自动建父目录；并发更新不丢条目', async () => {
  const home = makeHome()
  try {
    const filePath = join(home, 'storages', 'nested', 'workbuddy-auth-checkin.json')
    const written = []
    const store = createCheckinStore({
      filePath,
      now: () => T0,
      timeZone: 'Asia/Shanghai',
      writeAtomic: (path, text) => {
        written.push({ path, text })
        writeFileSync(path, text, 'utf8')
      },
    })
    await store.load()
    const today = localDateString(T0, 'Asia/Shanghai')
    await Promise.all([
      store.updateAccount('managed:cn-1', { date: today, done: true, attempts: 0, outcome: 'done', lastResultAt: T0 }),
      store.updateAccount('managed:cn-2', { date: today, done: false, attempts: 1, outcome: 'failed', lastResultAt: T0 }),
    ])

    assert.equal(written.length, 2)
    for (const item of written) assert.equal(item.path, filePath)
    const state = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.deepEqual(Object.keys(state.accounts).sort(), ['managed:cn-1', 'managed:cn-2'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('updateAccount 拒绝空 id 或非对象条目', async () => {
  const home = makeHome()
  try {
    const { store } = makeStore(home)
    await store.load()
    await assert.rejects(() => store.updateAccount('', { date: 'x' }), /CHECKIN_STORE_ENTRY_INVALID/)
    await assert.rejects(() => store.updateAccount('managed:cn-1', null), /CHECKIN_STORE_ENTRY_INVALID/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('状态文件路径：DSH_HOME 优先，否则 ~/.dsh/storages', () => {
  const withHome = checkinStatePath({ env: { DSH_HOME: 'D:\\.dsh' }, home: 'C:\\synthetic-root\\x' })
  assert.equal(withHome, join('D:\\.dsh', 'storages', 'workbuddy-auth-checkin.json'))
  const withoutHome = checkinStatePath({ env: {}, home: 'C:\\synthetic-root\\x' })
  assert.equal(withoutHome, join('C:\\synthetic-root\\x', '.dsh', 'storages', 'workbuddy-auth-checkin.json'))
  const trimmed = checkinStatePath({ env: { DSH_HOME: '  D:\\.dsh  ' }, home: 'C:\\synthetic-root\\x' })
  assert.equal(trimmed, join('D:\\.dsh', 'storages', 'workbuddy-auth-checkin.json'))
})
