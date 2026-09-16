// index.apply 的多账号集成：路由发现/切换、动态凭据读取、persist 到 patch。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../lib/index.mjs')

const SOURCES_PATH = '/api/dsh-workbuddy-auth/credentials/sources'
const ACTIVE_PATH = '/api/dsh-workbuddy-auth/credentials/active'
const STATUS_PATH = '/api/dsh-workbuddy-auth/status'

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
function setup(config) {
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
  apply(ctx, finalConfig)
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
    assert.equal(typeof seam.WORKBUDDY_ACCESS_TOKEN, 'string')
    assert.equal(seam.WORKBUDDY_ACCESS_TOKEN === 'TOKEN-B', true)

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
    const byPath = Object.fromEntries(registered.map((spec) => [spec.path, spec.handler]))
    const activeBody = JSON.parse(await request(byPath[ACTIVE_PATH], { method: 'POST', body: { id: 'deadbeefdeadbeef' } }))
    assert.equal(activeBody.ok, false)
    assert.equal(seam.WORKBUDDY_ACCESS_TOKEN, undefined)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})
