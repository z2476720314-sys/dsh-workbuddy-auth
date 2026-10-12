// status DTO 的多账号字段：enabled/activeId/sources 白名单 + 令牌防泄漏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { buildStatus, withAccounts } = await import('../lib/status.mjs')

const TOKEN = 'synthetic-status-token-never-leaks'

function makeAuthDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-status-'))
  writeFileSync(join(dir, 'a.info'), JSON.stringify({ auth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'uid-aaaa-fcca', nickname: '测试甲', phoneNumber: '13800000001' } }))
  writeFileSync(join(dir, 'b.info'), JSON.stringify({ auth: { accessToken: 'T2', refreshToken: 'r2', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'uid-bbbb-79d2', nickname: '测试乙', phoneNumber: '13900000002' } }))
  return dir
}

test('withAccounts + buildStatus：DTO 携带脱敏账号列表', async () => {
  const dir = makeAuthDir()
  try {
    const { listCredentialSources } = await import('../lib/multi-account.mjs')
    const rawText = JSON.stringify({ auth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'uid-aaaa-fcca', nickname: '测试甲', phoneNumber: '13800000001' } })
    const sources = listCredentialSources(dir)
    const status = buildStatus({ rawText: withAccounts(rawText, { enabled: true, activeId: sources[0].id, sources }), now: Date.now() })
    assert.equal(status.ok, true)
    assert.equal(status.accounts.enabled, true)
    assert.equal(status.accounts.sources.length, 2)
    const nicknames = status.accounts.sources.map((source) => source.label.nickname).sort()
    assert.deepEqual(nicknames, ['测试乙', '测试甲'].sort())
    assert.ok(!JSON.stringify(status).includes(TOKEN))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未启用多账号时 accounts.enabled=false 且不带列表', () => {
  const status = buildStatus({ rawText: JSON.stringify({ auth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'u', nickname: '甲' } }) })
  assert.equal(status.accounts.enabled, false)
  assert.equal(status.accounts.sources.length, 0)
})

// 设置卡的「已加密 / 已失效」标注靠这两个布尔字段；它们曾经在白名单里被吃掉，
// 导致后端算出了标注、前端永远显示不出来。
test('encrypted / stale 两个标注字段穿过白名单，且不夹带凭据', async () => {
  const dir = makeAuthDir()
  try {
    const { listCredentialSources } = await import('../lib/multi-account.mjs')
    const rawText = JSON.stringify({ auth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'u', nickname: '甲' } })
    const sources = listCredentialSources(dir).map((source, index) => ({ ...source, encrypted: index === 0, stale: index === 1 }))
    const status = buildStatus({ rawText: withAccounts(rawText, { enabled: true, activeId: sources[0].id, sources }), now: Date.now() })
    assert.deepEqual(status.accounts.sources.map((source) => source.encrypted), [true, false])
    assert.deepEqual(status.accounts.sources.map((source) => source.stale), [false, true])
    assert.ok(!JSON.stringify(status).includes(TOKEN))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('带账号列表时 Host 脏数据（注入 token 的 source 字段）被白名单丢弃', async () => {
  const dir = makeAuthDir()
  try {
    const rawText = JSON.stringify({ auth: { accessToken: TOKEN, refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 }, account: { uid: 'u', nickname: '甲' } })
    const dirty = {
      enabled: true,
      activeId: 'x',
      sources: [{ id: 'x', label: { nickname: '甲' }, accessExpiresAt: 1, accessToken: TOKEN, refreshToken: TOKEN, extra: TOKEN }],
    }
    const status = buildStatus({ rawText: withAccounts(rawText, dirty) })
    assert.ok(!JSON.stringify(status).includes(TOKEN))
    assert.equal(JSON.stringify(status.accounts.sources).includes('extra'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
