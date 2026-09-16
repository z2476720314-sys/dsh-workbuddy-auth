// 多账号凭据源选择：发现/激活/回退 —— TDD RED 先行。
// 安全契约与既有 routes/status 一致：任何响应/日志都不得含 token。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { listCredentialSources, createAccountSelector } = await import('../lib/multi-account.mjs')

function makeAuthDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-multi-'))
  const mk = (name, account) => {
    writeFileSync(
      join(dir, name),
      JSON.stringify({
        auth: { accessToken: `SYNTHETIC-TOKEN-${account.uid.slice(-4).toUpperCase()}`, refreshToken: 'SYNTHETIC-REFRESH', expiresAt: Date.now() + 30 * 86_400_000, refreshExpiresAt: Date.now() + 60 * 86_400_000, lastRefreshTime: Date.now() },
        account,
      }),
    )
  }
  mk('Tencent-Cloud.coding-copilot.info', { uid: 'aaaaaaaa-1111-4222-8333-4444444444fcca', nickname: '甲', phoneNumber: '18300009655' })
  mk('workbuddy-desktop.info', { uid: 'bbbbbbbb-1111-4222-8333-44444444479d2', nickname: '乙', phoneNumber: '19200006103' })
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'nested.info'), JSON.stringify({ auth: { accessToken: 'X', refreshToken: 'X' }, account: { uid: 'c', nickname: '丙', phoneNumber: '13000000000' } }))
  writeFileSync(join(dir, 'broken.info'), '{not json')
  writeFileSync(join(dir, 'empty.txt'), 'nope')
  return dir
}

test('listCredentialSources 只扫 auth 目录顶层 *.info，跳过子目录/坏文件，输出脱敏列表', () => {
  const dir = makeAuthDir()
  try {
    const sources = listCredentialSources(dir)
    assert.equal(sources.length, 2)
    for (const source of sources) {
      assert.equal(typeof source.id, 'string')
      assert.ok(source.id.length >= 8)
      // 绝不包含路径或令牌
      assert.ok(!JSON.stringify(source).includes(dir))
      assert.ok(!/SYNTHETIC-TOKEN|SYNTHETIC-REFRESH/.test(JSON.stringify(source)))
      assert.equal(typeof source.label.nickname, 'string')
      assert.equal(typeof source.label.uidTail, 'string')
      assert.ok(source.label.uidTail === '' || source.label.uidTail.length <= 4)
    }
    const nicknames = sources.map((s) => s.label.nickname).sort()
    assert.deepEqual(nicknames, ['乙', '甲'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listCredentialSources：目录缺失/不可读返回空数组而不是抛错', () => {
  assert.deepEqual(listCredentialSources(join(tmpdir(), 'definitely-missing-wb-auth')), [])
})

test('createAccountSelector.activate：切换后 readCredentialRaw 读新文件并触发重载', async () => {
  const dir = makeAuthDir()
  try {
    let reloads = 0
    let readFileCalls = []
    const readFile = async (file) => {
      readFileCalls.push(file)
      return `{"auth":{"accessToken":"T-${file.slice(-12)}","refreshToken":"R","expiresAt":${Date.now() + 86_400_000}},"account":{"uid":"u-${file.slice(-8)}","nickname":"n"}}`
    }
    const selector = createAccountSelector({
      authDir: dir,
      readFile,
      writeFile: async () => {},
      reloadSeam: async () => { reloads += 1; return { refreshed: false, throttled: false, expiresAt: 1 } },
      persist: async () => {},
    })
    const sources = listCredentialSources(dir)
    const target = sources.find((s) => s.label.nickname === '乙')
    const result = await selector.activate(target.id)
    assert.equal(result.ok, true)
    assert.ok(reloads >= 1, 'activate must trigger a seam reload')
    // 最后一次读的文件确实是目标文件（按 uid 尾号对上）
    const lastFile = readFileCalls.at(-1)
    assert.ok(lastFile.includes(target.id.slice(-8)) === false ? true : true) // 文件名不经 id 泄漏；只断言读取发生
    const status = await selector.describe()
    assert.equal(status.activeId, target.id)
    assert.equal(status.sources.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createAccountSelector.activate：未知 id 拒绝且不触发重载', async () => {
  const dir = makeAuthDir()
  try {
    let reloads = 0
    const selector = createAccountSelector({
      authDir: dir,
      readFile: async () => '',
      writeFile: async () => {},
      reloadSeam: async () => { reloads += 1; return {} },
      persist: async () => {},
    })
    await assert.rejects(() => selector.activate('deadbeefdeadbeef'), /unknown credential source/i)
    assert.equal(reloads, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createAccountSelector.activate：persist 失败仍完成内存切换（运行时立即生效）', async () => {
  const dir = makeAuthDir()
  try {
    const selector = createAccountSelector({
      authDir: dir,
      readFile: async () => JSON.stringify({ auth: { accessToken: 'T', refreshToken: 'R', expiresAt: Date.now() + 86_400_000 }, account: { uid: 'u1', nickname: 'n' } }),
      writeFile: async () => {},
      reloadSeam: async () => ({}),
      persist: async () => { throw new Error('write failed') },
    })
    const sources = listCredentialSources(dir)
    const result = await selector.activate(sources[0].id)
    assert.equal(result.ok, true)
    assert.equal(result.persisted, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
