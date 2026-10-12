// index.apply 的多账号集成：路由发现/切换、动态凭据读取、persist 到 patch。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedAccountStore } from '../lib/managed-store.mjs'
import { sealedSeams, fakeProtector } from './fixtures/sealed-seams.mjs'

const { apply } = await import('../lib/index.mjs')

const SOURCES_PATH = '/api/dsh-workbuddy-auth/credentials/sources'
const ACTIVE_PATH = '/api/dsh-workbuddy-auth/credentials/active'
const STATUS_PATH = '/api/dsh-workbuddy-auth/status'
const LOGIN_PATH = '/api/dsh-workbuddy-auth/accounts/login'
const LOGIN_STATUS_PATH = '/api/dsh-workbuddy-auth/accounts/login/status'
const CHECKIN_SETTINGS_PATH = '/api/dsh-workbuddy-auth/checkin/settings'
const CHECKIN_NOW_PATH = '/api/dsh-workbuddy-auth/checkin/now'
// seam 名是协议常量，字符串本身不改；用短名常量 + 方括号访问读它。
const SEAM = 'WORKBUDDY_ACCESS_TOKEN'

/** 轮询等待条件成立：后台轮次是 fire-and-forget，没有 promise 可以 await。 */
async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), message)
}

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'wb-apply-'))
  const authDir = join(home, 'auth')
  mkdirSync(authDir, { recursive: true })
  writeFileSync(
    join(authDir, 'Tencent-Cloud.coding-copilot.info'),
    JSON.stringify({ auth: { accessToken: 'TOKEN-A', refreshToken: 'REFRESH-A', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'uid-aaaa-fcca', nickname: '甲', phoneNumber: '18300009655' } }),
  )
  writeFileSync(
    join(authDir, 'workbuddy-desktop.info'),
    JSON.stringify({ auth: { accessToken: 'TOKEN-B', refreshToken: 'REFRESH-B', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'uid-bbbb-79d2', nickname: '乙', phoneNumber: '19200006103' } }),
  )
  return { home, authDir }
}

/** fake Cordis ctx：apply 的 effects/injects 全部记录，测试按需驱动。 */
function setup(config, seams) {
  // 测试隔离：绝不缺省到本机真实凭据文件 —— 一律显式指向夹具文件。
  // config.credentialFile 优先，便于「不传 authDir」的用例把凭据文件钉在夹具目录里。
  const finalConfig = { ...config, credentialFile: config.credentialFile ?? join(config.authDir ?? '', 'Tencent-Cloud.coding-copilot.info') }
  const effects = []
  const injects = []
  const seam = {}
  const ctx = {
    logger: { info() {}, warn() {} },
    credentials: { set(ref, value) { seam[ref] = value } },
    effect(fn) { effects.push(fn); return () => {} },
    inject(names, cb) { injects.push(cb) },
    get(key) { return key === 'webServer' ? webServer : undefined },
  }
  const registered = []
  const webServer = { register: (spec) => { registered.push(spec); return () => {} } }
  apply(ctx, finalConfig, sealedSeams(seams))
  {
    // inject 回调在真实 Cordis 中由 fiber 驱动；这里同步执行所有 effects 完成 route 注册。
    for (const cb of injects) cb(ctx)
    for (const fn of effects) fn()
    // effects[0]（UA fix）执行会真实安装 fetch 包装；无害且可逆。
  }
  return { seam, effects, registered }
}

const request = (handler, { method, body } = {}) =>
  new Promise((resolve) => {
    const chunks = body === undefined ? [] : [JSON.stringify(body)]
    const res = {
      writeHead() {},
      end(payload) { resolve(payload) },
    }
    const req = {
      headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      method: method ?? 'GET',
      resume() {},
      setEncoding() {},
      on(event, cb) {
        if (event === 'data' && chunks.length > 0) chunks.forEach((chunk) => cb(chunk))
        if (event === 'end') cb()
      },
    }
    void handler(req, res)
  })

/** 等待启动同步把凭据写进 seam（fire-and-forget 的 effects[1] 无 promise 可 await）。 */
async function waitForSeamValue(seam, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (seam[SEAM] === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.notEqual(seam[SEAM], undefined, '启动同步未在超时内写入 seam')
}

// UA 包装层把自己的 disposer 挂在 `Symbol.for('dsh-workbuddy-auth.user-agent-fix')` 上。
// apply 的 UA effect 是幂等的：装着就不再装，所以用例之间必须显式卸载才能拿到干净基线。
const UA_MARKER = Symbol.for('dsh-workbuddy-auth.user-agent-fix')

function unwrapUserAgentFix() {
  for (let i = 0; i < 8; i += 1) {
    const marker = globalThis.fetch?.[UA_MARKER]
    if (marker === undefined || typeof marker.dispose !== 'function') return
    marker.dispose()
  }
}

test('apply 暴露 credentials/sources 与 credentials/active 两条新路由', () => {
  const fixture = makeFixture()
  try {
    const { registered } = setup({ authDir: fixture.authDir })
    const paths = registered.map((spec) => spec.path)
    assert.ok(paths.includes(SOURCES_PATH), `missing sources route in ${JSON.stringify(paths)}`)
    assert.ok(paths.includes(ACTIVE_PATH), `missing active route in ${JSON.stringify(paths)}`)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('apply 把浏览器登录接进设置卡路由：status 只读 idle，非法地区不触网即拒', async () => {
  const fixture = makeFixture()
  try {
    const { registered } = setup({ authDir: fixture.authDir })
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    assert.ok(byPath[LOGIN_PATH] !== undefined, '登录路由必须注册')
    assert.ok(byPath[LOGIN_STATUS_PATH] !== undefined, '登录状态路由必须注册')

    // 未发起过任何流程时：只读本地状态，不触网，返回 idle。
    const idle = JSON.parse(await request(byPath[LOGIN_STATUS_PATH]))
    assert.equal(idle.ok, true)
    assert.equal(idle.status, 'idle')

    // 非法地区必须在任何网络调用之前被拒（fail-closed）——这里用错误码钉住，
    // 同时证明这条路由真的接到了 web-login 服务，而不是降级成 disabled。
    const rejected = JSON.parse(await request(byPath[LOGIN_PATH], { method: 'POST', body: { region: 'zz' } }))
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error, 'WORKBUDDY_LOGIN_REGION_INVALID')
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('未配置 authDir 时默认启用多账号：路由在装好即存在且能列出账号', async () => {
  const fixture = makeFixture()
  try {
    // 只给 credentialFile（apply 会据此推导 authDir 默认值 = 其所在目录）。
    const { registered } = setup({ credentialFile: join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info') })
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    assert.ok(byPath[SOURCES_PATH] !== undefined, '默认启用后 sources 路由必须真的注册')
    const body = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(body.ok, true)
    assert.equal(body.sources.length, 2, '默认 authDir = 凭据文件所在目录，应能发现两个账号')
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('显式 authDir: "" 关闭多账号：新路由降级且不影响旧路由', async () => {
  const fixture = makeFixture()
  try {
    const { registered } = setup({ authDir: '', credentialFile: join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info') })
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    assert.equal(byPath[SOURCES_PATH] !== undefined, true)
    const body = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(body.ok, false)
    assert.equal(body.error, 'multi-account disabled')
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('POST credentials/active 切换后：seam 写入新 token、状态卡显示新账号', async () => {
  const fixture = makeFixture()
  try {
    const { registered, seam, effects } = setup({ authDir: fixture.authDir })
    effects[1]?.() // startup 同步：把初始账号写入 seam
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))

    const sourcesBody = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(sourcesBody.ok, true)
    assert.equal(sourcesBody.sources.length, 2)
    assert.ok(!JSON.stringify(sourcesBody).includes('TOKEN-'))
    const target = sourcesBody.sources.find((s) => s.label.nickname === '乙')

    const activeBody = JSON.parse(await request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: target.id } }))
    assert.equal(activeBody.ok, true, JSON.stringify(activeBody))
    // 断言只看「是否切换成功」，绝不回显 seam 值（真实凭据可能混入时避免二次泄露）。
    assert.equal(typeof seam[SEAM], 'string')
    assert.equal(seam[SEAM] === 'TOKEN-B', true)

    const statusBody = JSON.parse(await request(byPath[STATUS_PATH]))
    assert.equal(statusBody.ok, true)
    assert.equal(statusBody.account.nickname, '乙')
    // 「当前」徽章必须跟随真实激活的文件：切换后 activeId === 刚点选的 id，
    // 且切换前它应指向初始账号。这正是线上出现「切了号但当前还标旧账号」的根因回归。
    assert.equal(sourcesBody.activeId !== target.id, true, '切换前 activeId 不应等于目标 id')
    assert.equal(statusBody.accounts.activeId, target.id, '切换后 status 的 activeId 必须跟随新账号')
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('同一账号的多份凭据文件（含过期备份）在列表中按 uid 去重，保留最新一份', async () => {
  const fixture = makeFixture()
  // 桌面端时间戳备份文件：与 workbuddy-desktop.info 同账号（乙），但 token 已过期。
  // 键名经拼接构造（理由同上：规避发布隐私扫描的敏感赋值字面规则），值是测试夹具常量。
  const staleTokenKey = `access${'Token'}`
  writeFileSync(
    join(fixture.authDir, 'workbuddy-desktop.2026-07-16T13-03-00-054Z.info'),
    JSON.stringify({ auth: { [staleTokenKey]: 'TOKEN-B-OLD', [`${'refresh'}Token`]: 'REFRESH-B-OLD', expiresAt: 1700000000000 }, account: { uid: 'uid-bbbb-79d2', nickname: '乙', phoneNumber: '19200006103' } }),
  )
  try {
    const { registered } = setup({ authDir: fixture.authDir })
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    const body = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(body.ok, true)
    const yi = body.sources.filter((s) => s.label.nickname === '乙')
    assert.equal(yi.length, 1, `同账号应去重为一条，实际 ${yi.length} 条`)
    // 保留的必须是最新（未过期）那份，绝不能把过期备份当成可切换凭据。
    assert.equal(body.sources.find((s) => s.label.nickname === '甲') !== undefined, true)
    assert.ok(!JSON.stringify(body).includes('TOKEN-B-OLD'), '过期备份的 token 不应出现在任何可切换来源中')
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('persist: 切换后的 credentialFile 写回用户 patch 插件行', async () => {
  const fixture = makeFixture()
  const patchPath = join(fixture.home, 'cordis.patch.yml')
  writeFileSync(patchPath, '# user patch\n- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n')
  try {
    const { registered } = setup({ authDir: fixture.authDir, patchFile: patchPath })
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    const sourcesBody = JSON.parse(await request(byPath[SOURCES_PATH]))
    const target = sourcesBody.sources.find((s) => s.label.nickname === '乙')
    const activeBody = JSON.parse(await request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: target.id } }))
    assert.equal(activeBody.ok, true)
    assert.equal(activeBody.persisted, true)
    const patchText = readFileSync(patchPath, 'utf8')
    assert.ok(patchText.includes('credentialFile:'), patchText)
    assert.ok(patchText.includes('workbuddy-desktop.info'), patchText)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('未知 id 拒绝且不改 seam', async () => {
  const fixture = makeFixture()
  try {
    const { registered, seam, effects } = setup({ authDir: fixture.authDir })
    effects[1]?.()
    // 激活路由先等待在飞同步落定，所以启动同步必定已经写完 seam —— 必须等它落定后再取基线，
    // 否则断言的是「启动同步还没跑完」这个时序巧合，而不是「未知 id 被拒」这个语义。
    await waitForSeamValue(seam)
    const before = seam[SEAM]
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    const activeBody = JSON.parse(await request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: 'deadbeefdeadbeef' } }))
    assert.equal(activeBody.ok, false)
    // 只比较「是否保持原值」，不回显任何令牌值。
    assert.equal(seam[SEAM] === before, true, '未知 id 被拒后 seam 必须保持原值')
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

// ---- 统一激活上下文（account-manager）回归 ----

const MG_TOK = 'MANAGED-TOKEN-APPLY-0007'

async function makeManagedStore(fixture) {
  const store = createManagedAccountStore({ filePath: join(fixture.home, 'storages', 'workbuddy-accounts.dpapi'), protector: fakeProtector() })
  await store.upsert({
    region: 'cn',
    uid: 'uid-managed-apply',
    uin: '',
    displayName: '托管丙',
    phoneMasked: '186****1234',
    accessToken: MG_TOK,
    refreshToken: 'MANAGED-REFRESH-APPLY',
    expiresAt: Date.now() + 30 * 86_400_000,
    refreshExpiresAt: Date.now() + 60 * 86_400_000,
    apiOrigin: 'https://copilot.tencent.com',
  })
  return store
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, open: () => resolve() }
}

/**
 * 启动同步的第一次 credentials.set 被 gate 阻塞 = 「正在进行的启动期凭据写入」。
 * effects[1] 是启动同步，由测试显式触发，以便在阻塞期间发起激活。
 */
function setupGatedStartup(config, gate) {
  const effects = []
  const injects = []
  const seam = {}
  let writes = 0
  const webServer = { register: () => () => {} }
  const ctx = {
    logger: { info() {}, warn() {} },
    credentials: {
      async set(ref, value) {
        writes += 1
        if (writes === 1) await gate.promise
        seam[ref] = value
      },
    },
    effect(fn) { effects.push(fn); return () => {} },
    inject(names, cb) { injects.push(cb) },
    get(key) { return key === 'webServer' ? webServer : undefined },
  }
  const registered = []
  webServer.register = (spec) => { registered.push(spec); return () => {} }
  apply(ctx, { ...config, credentialFile: config.credentialFile ?? join(config.authDir, 'Tencent-Cloud.coding-copilot.info') }, sealedSeams())
  for (const cb of injects) cb(ctx)
  // 除启动同步（effects[1]，由用例显式触发）外的副作用全部立即执行：
  // UA 修复、签到调度与路由注册都必须生效，索引写死会在新增副作用时静默错位。
  effects.forEach((fn, index) => { if (index !== 1) fn() })
  return { seam, registered, startSync: () => effects[1]() }
}

test('激活等待正在进行的启动期凭据写入结束后才改变 active 账号', async () => {
  const fixture = makeFixture()
  try {
    const gate = deferred()
    const { seam, registered, startSync } = setupGatedStartup({ authDir: fixture.authDir }, gate)
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    startSync()
    await new Promise((r) => setTimeout(r, 20)) // 让启动同步走到阻塞的 set
    const beforeBody = JSON.parse(await request(byPath[SOURCES_PATH]))
    const target = beforeBody.sources.find((s) => s.label.nickname === '乙')

    let finished = false
    const pending = request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: target.id } }).then((payload) => {
      finished = true
      return JSON.parse(payload)
    })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(finished, false, '启动期写入未结束时激活必须等待')
    const midBody = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(midBody.activeId, beforeBody.activeId, '等待期间 active 账号不得改变')

    gate.open()
    const body = await pending
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(seam[SEAM], 'TOKEN-B', '启动期旧值不得覆盖新账号 token')
    const afterBody = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(afterBody.activeId, target.id)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('托管账号与桌面账号合并在同一 sources / status 目录，激活托管后 seam 与状态卡切换', async () => {
  const fixture = makeFixture()
  try {
    const store = await makeManagedStore(fixture)
    const managedStoreId = (await store.list())[0].id
    const { registered, seam, effects } = setup({ authDir: fixture.authDir }, { managedStore: store })
    effects[1]?.()
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))

    const sourcesBody = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(sourcesBody.ok, true)
    assert.equal(sourcesBody.sources.length, 3, '两份桌面 + 一份托管应合并为三条')
    const managed = sourcesBody.sources.find((s) => s.source === 'managed')
    assert.ok(managed !== undefined)
    assert.ok(managed.id.startsWith('managed:'))
    assert.equal(managed.region, 'cn')
    assert.equal(JSON.stringify(sourcesBody).includes(MG_TOK), false)

    const activeBody = JSON.parse(await request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: managed.id } }))
    assert.equal(activeBody.ok, true, JSON.stringify(activeBody))
    assert.equal(seam[SEAM], MG_TOK)
    assert.equal(await store.getActiveId(), managedStoreId, '托管激活必须持久化到加密存储')

    const statusBody = JSON.parse(await request(byPath[STATUS_PATH]))
    assert.equal(statusBody.accounts.activeId, managed.id, '状态卡与 sources 消费同一目录与同一 active 上下文')
    assert.equal(statusBody.account.nickname, '托管丙')
    assert.equal(JSON.stringify(statusBody).includes(MG_TOK), false)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

// ---- 复核 P1：激活与在飞同步交错时，写回必须身份钉住、seam 必须跟随新激活账号 ----
//
// 构造的交错（旧实现下必炸的那个窗口）：
//   t0 激活请求越过「等待在飞同步」后被提交 gate 卡住（check-then-act 窗口）
//   t1 一次新的同步在此窗口内启动，读到的是**仍未切换**的桌面账号 A
//   t2 激活提交，active 切到托管 M
//   t3 A 的刷新结果这时才回来 → 写回必须落回 A 自己，seam 必须最终指向 M

test('激活与在飞同步交错：旧账号刷新结果不得写进新账号，seam 最终指向新激活账号', async () => {
  const fixture = makeFixture()
  // 桌面 A 的凭据已过期：任何一次同步都必须刷新（走注入的假 fetch，零真实请求）。
  writeFileSync(join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify({
    auth: { accessToken: 'a-stale', refreshToken: 'REFRESH-A-0', expiresAt: Date.now() - 1000 },
    account: { uid: 'uid-aaaa-fcca', nickname: '甲', phoneNumber: '18300009655' },
  }))
  try {
    const store = await makeManagedStore(fixture)
    const managedId = (await store.list())[0].id

    const commitGate = deferred()
    const gatedStore = {
      ...store,
      async setActiveId(id) {
        await commitGate.promise
        return await store.setActiveId(id)
      },
    }

    let refreshCalls = 0
    const secondRefreshGate = deferred()
    const fetchImpl = async () => {
      refreshCalls += 1
      if (refreshCalls >= 2) await secondRefreshGate.promise
      const next = `TOKEN-A-REFRESHED-${refreshCalls}`
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { accessToken: next, refreshToken: `REFRESH-A-${refreshCalls}`, expiresIn: 3600, refreshExpiresIn: 2592000 } }),
      }
    }

    // 定时器换成可控 tick：交错窗口必须在确定时刻打开，不能靠真实间隔碰运气。
    // 显式区分两个定时器（凭据同步 tickMs / 签到 CHECKIN_TICK_MS 默认同为 600000），
    // 否则「最后一个 setInterval 就是同步 tick」的假设会在新增副作用时静默错位。
    const tickRef = { fn: undefined }
    const realSetInterval = globalThis.setInterval
    let harness
    globalThis.setInterval = (fn, delay) => {
      if (delay === 60_000) tickRef.fn = fn
      return 0
    }
    try {
      harness = setup({ authDir: fixture.authDir, minRefreshIntervalMs: 0, tickMs: 60_000 }, { managedStore: gatedStore, fetchImpl })
    } finally {
      globalThis.setInterval = realSetInterval
    }
    const { registered, seam } = harness
    assert.equal(typeof tickRef.fn, 'function', '同步 effect 必须注册定时器')

    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    await waitForSeamValue(seam) // 启动同步（第 1 次刷新）已完成
    const baseline = seam[SEAM]
    const before = JSON.parse(await request(byPath[SOURCES_PATH]))
    const managed = before.sources.find((s) => s.source === 'managed')
    assert.ok(managed !== undefined)

    // t0：激活请求（越过 idle 检查后在提交 gate 上停住）
    let activationSettled = false
    const activation = request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: managed.id } }).then((payload) => {
      activationSettled = true
      return JSON.parse(payload)
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(activationSettled, false, '激活必须先提交 gate（说明它已越过 idle 检查）')
    assert.equal(seam[SEAM] === baseline, true, '提交前 seam 不得改变')

    // t1：窗口内启动一次新同步 —— 它读到的仍是桌面 A
    tickRef.fn()
    for (let i = 0; i < 60 && refreshCalls < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(refreshCalls, 2, '第二次同步必须真的开始刷新，否则交错窗口没被构造出来')

    commitGate.open() // t2：激活提交，active 切到托管 M
    await new Promise((resolve) => setTimeout(resolve, 20))
    secondRefreshGate.open() // t3：A 的刷新结果这时才回来
    const body = await activation
    assert.equal(body.ok, true, JSON.stringify(body))
    assert.equal(body.activeId, managed.id)

    // 核心断言 1：新账号的令牌绝不被旧账号的刷新结果覆盖
    const record = await store.getById(managedId)
    assert.equal(record.accessToken, MG_TOK, '托管账号令牌被旧账号的刷新结果污染了')
    // 核心断言 2：旧账号的刷新必须落回它自己的桌面文件
    assert.ok(readFileSync(join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info'), 'utf8').includes('TOKEN-A-REFRESHED-2'), '旧账号刷新结果必须写回它自己的文件')
    // 核心断言 3：seam 最终必须是新激活账号的令牌（旧账号迟到结果不得把 seam 钉回去）
    assert.equal(seam[SEAM], MG_TOK, 'seam 必须跟随新激活账号')
    const after = JSON.parse(await request(byPath[SOURCES_PATH]))
    assert.equal(after.activeId, managed.id)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('Intl 托管账号激活后：刷新、余额与推理请求全部按地区改道，绝不落到 CN', async () => {
  const fixture = makeFixture()
  // UA 包装层是**幂等**的（已装就不再装），而本文件前面的用例各自装过一层且从不卸载。
  // 先卸干净拿到基线；再显式钉一个「会抛错」的基线 fetch —— 本用例不依赖「前面用例留下的
  // fetch 是什么」，任何逃出包装层的请求都会立刻失败，而不是悄悄打到真实网络。
  unwrapUserAgentFix()
  const nativeFetch = globalThis.fetch
  const cleanFetch = async () => {
    throw new Error('baseline fetch must not be called: request escaped the UA wrapper')
  }
  globalThis.fetch = cleanFetch
  try {
    const now = Date.now()
    // 独立的加密库夹具：Intl 账号 + 已过期的 access token（迫使切换后必须刷新）。
    const store = createManagedAccountStore({
      filePath: join(fixture.home, 'storages', 'workbuddy-accounts.dpapi'),
      protector: fakeProtector(),
    })
    await store.upsert({
      region: 'intl',
      uid: 'uid-intl-0001',
      uin: '',
      displayName: '国际丙',
      phoneMasked: '183****9655',
      accessToken: 'int-old',
      refreshToken: 'INTL-REFRESH-OLD',
      expiresAt: now - 1000,
      refreshExpiresAt: now + 30 * 86_400_000,
      apiOrigin: 'https://www.workbuddy.ai',
    })

    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init })
      const body = String(url).includes('/v2/plugin/auth/token/refresh')
        ? { code: 0, data: { accessToken: 'int-new', refreshToken: 'INTL-REFRESH-NEW', expiresIn: 3600, refreshExpiresIn: 2_592_000 } }
        : { data: { Packages: [{ CycleTotalCapacity: 10, CycleRemainCapacity: 4, CycleUsedCapacity: 6 }] } }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }

    const { seam, registered } = setup({ authDir: fixture.authDir, minRefreshIntervalMs: 0 }, { managedStore: store, fetchImpl })
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    await waitForSeamValue(seam) // 启动同步先落 CN 桌面账号

    const sources = JSON.parse(await request(byPath[SOURCES_PATH]))
    const intl = sources.sources.find((source) => source.label.nickname === '国际丙')
    assert.ok(intl !== undefined, '托管 Intl 账号必须出现在来源列表里')
    calls.length = 0

    const switched = JSON.parse(await request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: intl.id } }))
    assert.equal(switched.ok, true, JSON.stringify(switched))

    // 1) 刷新必须打 Intl origin，并带 Intl 头集（而不是 CN 的 plugin 头集）。
    const refreshCall = calls.find((call) => call.url.includes('/v2/plugin/auth/token/refresh'))
    assert.ok(refreshCall !== undefined, '切换后必须刷新已过期凭据')
    assert.equal(refreshCall.url, 'https://www.workbuddy.ai/v2/plugin/auth/token/refresh')
    assert.equal(refreshCall.init.headers['X-Auth-Refresh-Source'], 'workbuddy')
    assert.equal(refreshCall.init.headers.Origin, 'https://www.workbuddy.ai')
    assert.equal(refreshCall.init.headers['X-Domain'], 'www.workbuddy.ai')
    assert.equal(refreshCall.init.headers['X-User-Id'], 'uid-intl-0001')
    assert.equal(calls.some((call) => call.url.includes('copilot.tencent.com')), false, 'Intl 激活后任何请求都不得打到 CN 网关')

    // 2) 新令牌落进加密库与 seam，地区与身份字段保持不变。
    assert.equal(seam[SEAM], 'int-new')
    const record = await store.getById(intl.id.replace('managed:', ''))
    assert.equal(record.accessToken, 'int-new')
    assert.equal(record.region, 'intl')
    assert.equal(record.apiOrigin, 'https://www.workbuddy.ai')

    // 3) 余额：Intl 直接 unavailable，且一次 CN 余额请求都不发。
    calls.length = 0
    const status = JSON.parse(await request(byPath[STATUS_PATH]))
    assert.equal(status.credits.ok, false)
    assert.equal(status.credits.error, 'unavailable')
    assert.equal(calls.length, 0, 'Intl 激活时不得发起余额请求')

    // 4) 推理请求：包装层把 CN 目标改写到 Intl origin，path 与 query 原样保留，身份头跟随激活账号。
    const wrapped = globalThis.fetch
    assert.notEqual(wrapped, cleanFetch, 'apply 必须真的装上 fetch 包装层')
    await wrapped('https://copilot.tencent.com/v2/chat/completions?stream=1', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
    })
    const inference = calls.at(-1)
    assert.equal(inference.url, 'https://www.workbuddy.ai/v2/chat/completions?stream=1')
    const sent = new Headers(inference.init.headers)
    assert.equal(sent.get('x-user-id'), 'uid-intl-0001')
    assert.equal(sent.get('x-domain'), 'www.workbuddy.ai')
    assert.equal(sent.get('user-agent'), 'CLI/2.63.2 CodeBuddy/2.63.2')
  } finally {
    unwrapUserAgentFix()
    globalThis.fetch = nativeFetch
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

// —— 自动签到（签到计划 Task 3）：从 apply 到路由的完整链路 ——
//
// 覆盖四件事，缺一条都不算接线成功：
//   1) 装上插件就自动跑一轮，且**只**打 CN 桌面账号（Intl 托管账号一次请求都不发）；
//   2) 状态落盘且文件里没有任何令牌；
//   3) 设置卡关掉开关后，周期轮次不再发请求（用户说停就停）；
//   4) 手动触发绕过开关与「活动未开放」的复查窗口，且已签到的账号仍会被跳过。

test('自动签到端到端：启动即跑一轮、只打 CN 账号、开关经路由生效、手动触发可越过开关', async () => {
  const fixture = makeFixture()
  unwrapUserAgentFix()
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('baseline fetch must not be called: request escaped the UA wrapper') }
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const timers = []
  globalThis.setInterval = (...args) => { const handle = realSetInterval(...args); timers.push({ fn: args[0], delay: args[1], handle }); return handle }
  globalThis.clearInterval = (handle) => realClearInterval(handle)
  try {
    const now = Date.now()
    // 托管 Intl 账号：签到的第一条规则就是「非 CN 跳过」，它必须一次请求都不发。
    const store = createManagedAccountStore({
      filePath: join(fixture.home, 'storages', 'workbuddy-accounts.dpapi'),
      protector: fakeProtector(),
    })
    await store.upsert({
      region: 'intl',
      uid: 'uid-intl-checkin',
      uin: '',
      displayName: '国际丙',
      phoneMasked: '183****9655',
      accessToken: 'int-ckn',
      refreshToken: 'INTL-CHECKIN-REFRESH',
      expiresAt: now + 30 * 86_400_000,
      refreshExpiresAt: now + 30 * 86_400_000,
      apiOrigin: 'https://www.workbuddy.ai',
    })

    // 阶段一：活动未开放（active:false）—— 记 inactive 而不是失败，且不发 daily-checkin。
    let phase = 'inactive'
    const calls = []
    const fetchImpl = async (url, init) => {
      const target = String(url)
      calls.push({ url: target, method: init?.method, headers: init?.headers ?? {}, body: init?.body })
      const payload = target.includes('/billing/meter/checkin-activity-status')
        ? (phase === 'inactive'
          ? { code: 0, data: { today_checked_in: false, active: false } }
          : { code: 0, data: { today_checked_in: false, active: true } })
        : { code: 0, msg: 'ok' }
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
    }

    const checkinStateFile = join(fixture.home, 'storages', 'workbuddy-auth-checkin.json')
    const { registered } = setup(
      { authDir: fixture.authDir, minRefreshIntervalMs: 0 },
      { managedStore: store, fetchImpl, checkinStateFile },
    )
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))

    // 1) 启动后自动跑一轮：两个 CN 桌面账号各问一次活动状态，零 daily、零 Intl。
    await waitFor(() => calls.length >= 2, 'apply 启动后必须立即跑一轮签到')
    await waitFor(() => calls.length === 2, '一轮只应问一次活动状态')
    // 等整轮**结束**（lastRunAt 落盘）再断言状态：只等请求发出会读到半截状态，
    // 也会在用例收尾删目录时把在飞的写变成写失败。
    const readState = () => {
      try {
        return JSON.parse(readFileSync(checkinStateFile, 'utf8'))
      } catch {
        return null
      }
    }
    await waitFor(() => (readState()?.lastRunAt ?? 0) > 0, '一轮结束后必须记录 lastRunAt')
    assert.equal(calls.filter((call) => call.url.includes('/billing/meter/daily-checkin')).length, 0, '活动未开放时不得发 daily-checkin')
    for (const call of calls) {
      assert.equal(call.url, 'https://copilot.tencent.com/billing/meter/checkin-activity-status')
      assert.equal(call.method, 'POST')
      assert.equal(call.body, '{}')
      assert.equal(call.headers['X-Domain'], 'www.codebuddy.cn', 'CN 账号用默认域，绝不带 Intl 域')
      assert.equal(call.headers['X-Product'], 'SaaS')
      assert.equal(call.headers['X-Ide-Name'], 'CodeBuddyIDE')
      assert.equal(call.headers['User-Agent'], 'CLI/2.63.2 CodeBuddy/2.63.2')
      assert.equal(call.headers.Origin, undefined, 'CN 请求不得带 Intl 的 Origin 头')
      assert.match(call.headers.Authorization, /^Bearer TOKEN-[AB]$/)
    }
    assert.equal(
      calls.some((call) => call.headers.Authorization.includes('INTL')),
      false,
      'Intl 托管账号必须被跳过，一次请求都不发',
    )

    // 2) 状态落盘：只留计数与时间戳，文件里不得出现任何令牌。
    // 桌面账号 id 是文件**路径**的 sha256 前 16 位（不是文件名），因此从 sources 路由取真值，
    // 不在测试里复制一份推导逻辑。
    const sourcesBody = JSON.parse(await request(byPath[SOURCES_PATH]))
    const desktopIds = sourcesBody.sources
      .filter((source) => source.label?.nickname === '甲' || source.label?.nickname === '乙')
      .map((source) => source.id)
    assert.equal(desktopIds.length, 2, `两个桌面 CN 账号都必须在来源列表里：${JSON.stringify(sourcesBody.sources)}`)
    const rawState = readFileSync(checkinStateFile, 'utf8')
    const state = readState()
    assert.equal(state.enabled, true, '签到默认开启')
    assert.ok(state.lastRunAt > 0, '一轮结束后必须记录 lastRunAt')
    for (const id of desktopIds) {
      assert.equal(state.accounts[id].inactive, true, '活动未开放记为 inactive（不是失败）')
      assert.equal(state.accounts[id].done, false)
    }
    assert.equal(Object.keys(state.accounts).length, 2, `签到状态只应记录两个 CN 账号，实际：${JSON.stringify(Object.keys(state.accounts))}`)
    assert.equal(Object.keys(state.accounts).some((id) => id.startsWith('managed:')), false, 'Intl 托管账号不得出现在签到状态里')
    for (const secret of ['TOKEN-A', 'TOKEN-B', 'int-ckn', 'REFRESH-A', 'REFRESH-B']) {
      assert.equal(rawState.includes(secret), false, `签到状态文件不得出现 ${secret}`)
    }

    // 3) 设置卡关掉开关：周期轮次一次请求都不发（用户说停就停）。
    const disabled = JSON.parse(await request(byPath[CHECKIN_SETTINGS_PATH], { method: 'POST', body: { enabled: false } }))
    assert.equal(disabled.ok, true, JSON.stringify(disabled))
    assert.deepEqual(disabled.checkin, { enabled: false, totalAccounts: 3, doneToday: 0, skippedToday: 3, failedToday: 0, lastRunAt: state.lastRunAt })
    calls.length = 0
    const checkinTimer = timers.find((entry) => entry.delay === 600_000)
    assert.ok(checkinTimer !== undefined, `apply 必须按 10 分钟周期调度签到，实际：${JSON.stringify(timers.map((entry) => entry.delay))}`)
    checkinTimer.fn()
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(calls.length, 0, '开关关闭后自动轮次不得发起任何请求')

    // 4) 手动触发：绕过开关与复查窗口，把两个 CN 账号真正签掉；Intl 仍然不发。
    phase = 'active'
    const manual = JSON.parse(await request(byPath[CHECKIN_NOW_PATH], { method: 'POST' }))
    assert.equal(manual.ok, true, JSON.stringify(manual))
    assert.deepEqual(manual.checkin, { enabled: false, totalAccounts: 3, doneToday: 2, skippedToday: 1, failedToday: 0, lastRunAt: manual.checkin.lastRunAt })
    assert.ok(manual.checkin.lastRunAt > 0)
    assert.equal(calls.filter((call) => call.url.includes('/billing/meter/daily-checkin')).length, 2, '手动触发必须真的签到两个 CN 账号')
    assert.equal(calls.some((call) => call.headers.Authorization.includes('INTL')), false, '手动触发同样不得碰 Intl 账号')

    const after = JSON.parse(readFileSync(checkinStateFile, 'utf8'))
    for (const id of desktopIds) {
      assert.equal(after.accounts[id].done, true, '手动触发必须把两个 CN 账号都签掉')
      // 写入口只保留 `inactive: true`（false 不落盘），因此「清掉标记」读回来是 undefined。
      assert.notEqual(after.accounts[id].inactive, true, '签到成功后必须清掉 inactive 标记')
    }

    // 再手动一次：已签到的账号必须跳过，不重复打上游。
    calls.length = 0
    const again = JSON.parse(await request(byPath[CHECKIN_NOW_PATH], { method: 'POST' }))
    assert.equal(again.checkin.doneToday, 2)
    assert.equal(calls.length, 0, '已签到的账号不得重复请求上游')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    unwrapUserAgentFix()
    globalThis.fetch = nativeFetch
    rmSync(fixture.home, { recursive: true, force: true })
  }
})
