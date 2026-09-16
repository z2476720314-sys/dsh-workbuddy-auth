// /status 路由必须携带多账号字段（enabled/activeId/sources）——修复遗漏的 withAccounts 接线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createRouteDeps, createSyncDeps } = await import('../lib/index.mjs')
const { buildStatus } = await import('../lib/status.mjs')

const TOKEN = 'synthetic-route-status-token'
const UID = 'uid-aaaa-fcca'

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'wb-rstatus-'))
  const authDir = join(home, 'auth')
  mkdirSync(authDir, { recursive: true })
  writeFileSync(
    join(authDir, 'Tencent-Cloud.coding-copilot.info'),
    JSON.stringify({ auth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: UID, nickname: '测试甲', phoneNumber: '13800000001' } }),
  )
  writeFileSync(
    join(authDir, 'workbuddy-desktop.info'),
    JSON.stringify({ auth: { accessToken: 'T2', refreshToken: 'r2', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'uid-bbbb-79d2', nickname: '测试乙', phoneNumber: '13900000002' } }),
  )
  return { home, authDir }
}

function makeCtx() {
  const registered = []
  const webServer = { register: (spec) => { registered.push(spec); return () => {} } }
  const ctx = { logger: { info() {}, warn() {} }, credentials: { set() {} }, get(key) { return key === 'webServer' ? webServer : undefined } }
  return { ctx, registered }
}

test('authDir 启用时：routeDeps.readCredentialRaw 产出的 status DTO 含 enabled:true 与 2 个账号', async () => {
  const fixture = makeFixture()
  try {
    const { ctx } = makeCtx()
    const config = { authDir: fixture.authDir, credentialFile: join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info') }
    const syncDeps = createSyncDeps(ctx, config)
    const deps = createRouteDeps(ctx, config, async () => ({ ok: true, status: 200 }), syncDeps, undefined)
    // createRouteDeps 内部需要 activeFile 才有 selector；这里显式走 activeFile 形态在 apply 集成测试已覆盖。
    // 本测试针对【未传 activeFile 的降级形态】也应带 accounts（enabled 由 config 决定而非 selector）。
    const envelope = await deps.readCredentialRaw()
    // buildStatus 因余额 Promise 返回 Promise，必须 await。
    const status = await buildStatus({ rawText: envelope, now: Date.now() })
    assert.equal(status.ok, true)
    assert.equal(status.accounts.enabled, true, 'authDir 配置必须让 status DTO 的 accounts.enabled=true')
    assert.equal(status.accounts.sources.length, 2)
    assert.ok(!JSON.stringify(status).includes(TOKEN))
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('未配置 authDir 时：默认取凭据文件所在目录，多账号默认启用', async () => {
  const fixture = makeFixture()
  try {
    const { ctx } = makeCtx()
    // 只给 credentialFile，不给 authDir —— 新语义下 authDir 默认 = dirname(credentialFile)。
    const config = { credentialFile: join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info') }
    const syncDeps = createSyncDeps(ctx, config)
    const deps = createRouteDeps(ctx, config, async () => ({ ok: true, status: 200 }), syncDeps, undefined)
    const envelope = await deps.readCredentialRaw()
    const status = await buildStatus({ rawText: envelope, now: Date.now() })
    assert.equal(status.ok, true)
    assert.equal(status.accounts.enabled, true, 'npm 用户不应再需要显式配置 authDir 才有账号切换区')
    assert.equal(status.accounts.sources.length, 2)
    assert.ok(!JSON.stringify(status).includes(TOKEN))
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('显式 authDir: "" 时：多账号被关闭，status DTO 的 accounts.enabled=false', async () => {
  const fixture = makeFixture()
  try {
    const { ctx } = makeCtx()
    const config = { authDir: '', credentialFile: join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info') }
    const syncDeps = createSyncDeps(ctx, config)
    const deps = createRouteDeps(ctx, config, async () => ({ ok: true, status: 200 }), syncDeps, undefined)
    const envelope = await deps.readCredentialRaw()
    const status = await buildStatus({ rawText: envelope, now: Date.now() })
    assert.equal(status.ok, true)
    assert.equal(status.accounts.enabled, false, '空串是显式关闭开关，必须压过默认值')
    assert.equal(status.accounts.sources.length, 0)
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

test('显式 authDir 覆盖默认目录', async () => {
  const fixture = makeFixture()
  const other = mkdtempSync(join(tmpdir(), 'wb-rstatus-other-'))
  try {
    writeFileSync(
      join(other, 'third.info'),
      JSON.stringify({ auth: { accessToken: 'T3', refreshToken: 'r3', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'uid-cccc-9999', nickname: '测试丙', phoneNumber: '13700000003' } }),
    )
    const { ctx } = makeCtx()
    const config = { authDir: other, credentialFile: join(fixture.authDir, 'Tencent-Cloud.coding-copilot.info') }
    const syncDeps = createSyncDeps(ctx, config)
    const deps = createRouteDeps(ctx, config, async () => ({ ok: true, status: 200 }), syncDeps, undefined)
    const envelope = await deps.readCredentialRaw()
    const status = await buildStatus({ rawText: envelope, now: Date.now() })
    assert.equal(status.accounts.enabled, true)
    assert.equal(status.accounts.sources.length, 1, '显式 authDir 必须压过从 credentialFile 推导出的默认目录')
    assert.equal(status.accounts.sources[0].label.nickname, '测试丙')
  } finally {
    rmSync(fixture.home, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})
