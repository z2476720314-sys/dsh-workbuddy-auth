// RED：失效账号必须被记住：
//   * 「夜」的 access 尚未过期（备份写的是 2027 假值），但 refresh token 已被服务端作废
//     —— 用户点它、再点刷新，只会拿到 401（线上截图那条的现场）；
//   * 每次成功的刷新都会**轮换** refresh token，使所有历史备份的 refresh token 立即失效，
//     因此这个集合天然需要落盘，否则重启后用户又会被同一份死凭据坑一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRejectedStore } from '../lib/rejected-store.mjs'
import { listCredentialSources } from '../lib/multi-account.mjs'

test('rejected 集合可读写：标记后读回同一 id，且能清空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-rejected-'))
  try {
    const file = join(dir, 'rejected.json')
    const store = createRejectedStore(file)
    assert.deepEqual(store.list(), [])
    store.mark('abc123')
    assert.deepEqual(createRejectedStore(file).list(), ['abc123'], '必须落盘，重启后仍记得')
    store.clear('abc123')
    assert.deepEqual(createRejectedStore(file).list(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejected 集合损坏或缺失时安全降级为空（坏文件不得让插件装载失败）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-rejected-bad-'))
  try {
    const file = join(dir, 'rejected.json')
    const store = createRejectedStore(file)
    assert.deepEqual(store.list(), [], '文件不存在 → 空数组')
    store.mark('0123456789abcdef')
    assert.deepEqual(store.list(), ['0123456789abcdef'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejectedIds 命中时给条目加 stale 标记，且不影响其它账号', async () => {
  const { listCredentialSources } = await import('../lib/multi-account.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'wb-rejected-list-'))
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'a.info'), JSON.stringify({
      auth: { accessToken: 'A'.repeat(40), refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 },
      account: { uid: 'uid-aaaa', nickname: '活着', phoneNumber: '13800000001' },
    }))
    writeFileSync(join(dir, 'b.info'), JSON.stringify({
      auth: { accessToken: 'B'.repeat(40), refreshToken: 'r', expiresAt: Date.now() + 300 * 86_400_000 },
      account: { uid: 'uid-bbbb', nickname: '已死', phoneNumber: '13900000002' },
    }))
    const all = listCredentialSources(dir)
    assert.equal(all.length, 2)
    const dead = all.find((s) => s.label.nickname === '已死')
    assert.equal(dead.stale, false, '默认必须是显式 false，不是 undefined')

    const marked = listCredentialSources(dir, { rejectedIds: new Set([dead.id]) })
    assert.equal(marked.find((s) => s.label.nickname === '已死').stale, true)
    assert.equal(marked.find((s) => s.label.nickname === '活着').stale, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
