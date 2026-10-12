// RED：WorkBuddy 桌面端 2026-10 起把 auth.accessToken / refreshToken 写成
// `{$wbEncrypted:1, envelope:"<base64 AES-GCM 包>"}`。同一目录下的 CodeBuddy CLI 明文
// 凭据被 mark 掉后，这个文件就是**唯一**的登录态来源：
//   * 插件此前把它当成「缺少 auth.accessToken」——用户按提示去重新登录，问题却依旧；
//   * 账号列表此前把它整份跳过 —— 用户在切换区看不到自己正在用的账号。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCredentialRecord, ENCRYPTED_ENVELOPE_MESSAGE } from '../lib/credential.mjs'
import { listCredentialSources } from '../lib/multi-account.mjs'

// envelope 凭据的压缩形态：accessToken / refreshToken 共用的同一份加密包。
const ENV = { $wbEncrypted: 1, envelope: 'eyJzdWl0ZSI6MX0=' }

function envelopeFile(over = {}) {
  return JSON.stringify({
    account: { uid: 'uid-of-account-58a7', uin: '330106711008', nickname: { $wbEncrypted: 1, envelope: 'n' }, phoneNumber: { $wbEncrypted: 1, envelope: 'p' } },
    auth: {
      accessToken: ENV,
      refreshToken: ENV,
      tokenType: 'Bearer',
      expiresAt: Date.now() + 30 * 86_400_000,
      refreshExpiresAt: Date.now() + 60 * 86_400_000,
      lastRefreshTime: Date.now() - 3_600_000,
    },
    ...over,
  })
}

test('parseCredentialRecord 把 envelope 凭据识别为「加密」，而不是「缺少 accessToken」', () => {
  assert.throws(() => parseCredentialRecord(envelopeFile()), new RegExp(ENCRYPTED_ENVELOPE_MESSAGE))
  assert.doesNotMatch(ENCRYPTED_ENVELOPE_MESSAGE, /missing auth\.accessToken/)
})

test('parseCredentialRecord 对真正的缺失仍是原来的 missing accessToken（不能把两种病因混为一谈）', () => {
  assert.throws(() => parseCredentialRecord('{"auth":{}}'), /missing auth\.accessToken/)
})

test('listCredentialSources 保留 envelope 条目并标注 encrypted，uid 尾号仍可取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-envelope-'))
  try {
    writeFileSync(join(dir, 'workbuddy-desktop.info'), envelopeFile())
    const sources = listCredentialSources(dir)
    assert.equal(sources.length, 1, 'envelope 文件是真实登录态，不能被整份跳过')
    assert.equal(sources[0].encrypted, true)
    assert.equal(sources[0].label.uidTail, '58a7', 'uid 是明文，尾号照常可显示')
    assert.equal(sources[0].label.nickname, '', '昵称被加密，留空而不是显示垃圾')
    assert.ok(sources[0].accessExpiresAt > Date.now(), '明文 expiresAt 可用于排序与过期剔除')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('明文凭据条目的 encrypted 为 false（默认值必须显式可断言）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-plain-'))
  try {
    writeFileSync(join(dir, 'plain.info'), JSON.stringify({
      auth: { accessToken: 'A'.repeat(40), refreshToken: 'r', expiresAt: Date.now() + 30 * 86_400_000 },
      account: { uid: 'uid-plain-4444', nickname: '明文号', phoneNumber: '13800004444' },
    }))
    const sources = listCredentialSources(dir)
    assert.equal(sources.length, 1)
    assert.equal(sources[0].encrypted, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('envelope 文件与其明文历史备份去重时，mtime 更新的 envelope 文件胜出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-envelope-dedupe-'))
  try {
    const backup = join(dir, 'workbuddy-desktop.2026-07-16T13-03-00-054Z.info')
    writeFileSync(backup, JSON.stringify({
      auth: { accessToken: 'A'.repeat(40), refreshToken: 'r', expiresAt: Date.now() + 300 * 86_400_000 },
      account: { uid: 'uid-of-account-58a7', nickname: '夜', phoneNumber: '13100005437' },
    }))
    const old = new Date(Date.now() - 60 * 86_400_000)
    utimesSync(backup, old, old)
    writeFileSync(join(dir, 'workbuddy-desktop.info'), envelopeFile())

    const sources = listCredentialSources(dir)
    assert.equal(sources.length, 1, '同一账号只应出现一个按钮')
    assert.equal(sources[0].encrypted, true, '桌面端正在用的 envelope 文件才是当前登录态')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
