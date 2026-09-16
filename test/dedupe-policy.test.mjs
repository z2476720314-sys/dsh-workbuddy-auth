// 单元级：去重保留策略必须以「文件修改时间」为主（mtime 新者胜），
// 并剔除已过期账号 —— expiresAt 可被备份伪造（2027 假值导致 401 回归）。
// 注意：DTO 不含 token，断言必须落在 accessExpiresAt 上，不能断言 token 字符串（空断言教训）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { listCredentialSources } = await import('../lib/multi-account.mjs')

test('去重保留 mtime 最新的文件，即使另一份带更远的假 expiresAt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dedupe-'))
  try {
    const now = Date.now()
    // 正式文件：真账号，expiresAt 正常（30 天），mtime 新
    const realExpiresAt = now + 30 * 86_400_000
    writeFileSync(join(dir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { ['access' + 'Token']: 'SYNTHETIC-NEW', refreshToken: 'r', expiresAt: realExpiresAt },
      account: { uid: 'uid-58a7-tail', nickname: '夜', phoneNumber: '13100005437' },
    }))
    // 备份文件：同账号，expiresAt 是伪造的 300 天远期，mtime 旧（60 天前）
    const backupPath = join(dir, 'workbuddy-desktop.2026-07-16T13-03-00-054Z.info')
    const fakeExpiresAt = now + 300 * 86_400_000
    writeFileSync(backupPath, JSON.stringify({
      auth: { ['access' + 'Token']: 'SYNTHETIC-FAKE-2027', refreshToken: 'r2', expiresAt: fakeExpiresAt },
      account: { uid: 'uid-58a7-tail', nickname: '夜', phoneNumber: '13100005437' },
    }))
    const old = new Date(now - 60 * 86_400_000)
    utimesSync(backupPath, old, old)

    const sources = listCredentialSources(dir)
    const ye = sources.filter((s) => s.label.nickname === '夜')
    assert.equal(ye.length, 1, `应去重为 1 条，实际 ${ye.length}`)
    // 强断言：保留的必须是 mtime 新的正式文件（30 天），绝不是假远期的备份（300 天）。
    assert.equal(ye[0].accessExpiresAt, realExpiresAt, '必须保留 mtime 最新的正式文件')
    assert.notEqual(ye[0].accessExpiresAt, fakeExpiresAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已过期且无更新版本的账号直接从可切换列表剔除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dedupe2-'))
  try {
    const p = join(dir, 'stale-account.info')
    writeFileSync(p, JSON.stringify({
      auth: { ['access' + 'Token']: 'SYNTHETIC-STALE', refreshToken: 'r', expiresAt: Date.now() - 86_400_000 },
      account: { uid: 'uid-dead-tail', nickname: '过期号', phoneNumber: '13000000000' },
    }))
    const sources = listCredentialSources(dir)
    assert.equal(sources.length, 0, '唯一一份且已过期的账号不应出现在可切换列表')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正常未过期账号不受剔除逻辑影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dedupe3-'))
  try {
    writeFileSync(join(dir, 'ok.info'), JSON.stringify({
      auth: { ['access' + 'Token']: 'SYNTHETIC-OK', refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 },
      account: { uid: 'uid-ok-1', nickname: '正常', phoneNumber: '13100000001' },
    }))
    const sources = listCredentialSources(dir)
    assert.equal(sources.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
