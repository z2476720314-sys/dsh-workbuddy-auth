// 地区与 origin 的单一事实来源：映射正确 + **绝不跨地区回退**（fail-closed）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  CN_BACKEND,
  INTL_ORIGINS,
  normalizeRegion,
  regionForAuthHost,
  originForAuthHost,
  refreshSourceForHost,
  resolveWorkBuddyOrigin,
  CLIENT_USER_AGENT,
} = await import('../lib/origins.mjs')

test('normalizeRegion：大小写与空白规范化，其余一律 null', () => {
  assert.equal(normalizeRegion(' CN '), 'cn')
  assert.equal(normalizeRegion('Intl'), 'intl')
  assert.equal(normalizeRegion('zz'), null)
  assert.equal(normalizeRegion(''), null)
  assert.equal(normalizeRegion(undefined), null)
  assert.equal(normalizeRegion(42), null)
})

test('regionForAuthHost：只认两个地区的认证域，伪装后缀不算', () => {
  assert.equal(regionForAuthHost('copilot.tencent.com'), 'cn')
  assert.equal(regionForAuthHost('sub.tencent.com'), 'cn')
  assert.equal(regionForAuthHost('https://login.workbuddy.ai/authorize'), 'intl')
  assert.equal(regionForAuthHost('www.codebuddy.ai'), 'intl')
  assert.equal(regionForAuthHost('workbuddy.ai'), 'intl')
  assert.equal(regionForAuthHost('evil.example.com'), null)
  assert.equal(regionForAuthHost('www.workbuddy.ai.evil.example.com'), null)
  assert.equal(regionForAuthHost('notworkbuddy.ai'), null)
  assert.equal(regionForAuthHost(''), null)
})

test('originForAuthHost：Intl 与其 apex 同源，未知域 null', () => {
  assert.equal(originForAuthHost('copilot.tencent.com'), CN_BACKEND)
  assert.equal(originForAuthHost('login.workbuddy.ai'), 'https://www.workbuddy.ai')
  assert.equal(originForAuthHost('codebuddy.ai'), 'https://www.codebuddy.ai')
  assert.equal(originForAuthHost('evil.example.com'), null)
  assert.equal(INTL_ORIGINS.has('https://www.workbuddy.ai'), true)
})

test('resolveWorkBuddyOrigin：认证域优先，地区冲突宁可 null 也不跨区发送', () => {
  assert.equal(resolveWorkBuddyOrigin({ region: 'intl', authHost: 'www.workbuddy.ai' }), 'https://www.workbuddy.ai')
  assert.equal(resolveWorkBuddyOrigin({ authHost: 'www.codebuddy.ai' }), 'https://www.codebuddy.ai')
  assert.equal(resolveWorkBuddyOrigin({ region: 'cn', authHost: 'login.workbuddy.ai' }), null, '地区冲突必须拒绝')
  assert.equal(resolveWorkBuddyOrigin({ region: 'intl', authHost: 'copilot.tencent.com' }), null, '地区冲突必须拒绝')
  assert.equal(resolveWorkBuddyOrigin({ region: 'intl', authHost: 'evil.example.com' }), null)
  assert.equal(resolveWorkBuddyOrigin(), null)
})

test('resolveWorkBuddyOrigin：无认证域时只信任本地区白名单内的 apiOrigin', () => {
  assert.equal(resolveWorkBuddyOrigin({ region: 'cn', apiOrigin: CN_BACKEND }), CN_BACKEND)
  assert.equal(resolveWorkBuddyOrigin({ region: 'cn', apiOrigin: `${CN_BACKEND}/` }), CN_BACKEND)
  assert.equal(resolveWorkBuddyOrigin({ region: 'intl', apiOrigin: 'https://www.workbuddy.ai' }), 'https://www.workbuddy.ai')
  assert.equal(resolveWorkBuddyOrigin({ region: 'intl', apiOrigin: CN_BACKEND }), null, 'CN origin 不得当作 Intl 回退')
  assert.equal(resolveWorkBuddyOrigin({ region: 'cn', apiOrigin: 'https://evil.example.com' }), null)
  assert.equal(resolveWorkBuddyOrigin({ apiOrigin: 'https://www.workbuddy.ai' }), 'https://www.workbuddy.ai')
  assert.equal(resolveWorkBuddyOrigin({ apiOrigin: 'https://evil.example.com' }), null)
})

test('refreshSourceForHost：只有 workbuddy.ai 域用 workbuddy，其余用 plugin', () => {
  assert.equal(refreshSourceForHost('www.workbuddy.ai'), 'workbuddy')
  assert.equal(refreshSourceForHost('login.workbuddy.ai'), 'workbuddy')
  assert.equal(refreshSourceForHost('www.codebuddy.ai'), 'plugin')
  assert.equal(refreshSourceForHost('copilot.tencent.com'), 'plugin')
})

test('CLIENT_USER_AGENT 是实测被两个地区同时接受的 CLI 身份', () => {
  assert.equal(CLIENT_USER_AGENT, 'CLI/2.63.2 CodeBuddy/2.63.2')
})
