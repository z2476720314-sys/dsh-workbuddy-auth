import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCredentialRecord, needsRefresh } from '../lib/credential.mjs'

const SAMPLE = JSON.stringify({
  account: { uid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nickname: 'x' },
  auth: {
    accessToken: 'A'.repeat(64),
    refreshToken: 'R'.repeat(32),
    tokenType: 'Bearer',
    expiresAt: 1702592000000,
    refreshExpiresAt: 1705184000000,
    lastRefreshTime: 1700000000000,
  },
})

test('parseCredentialRecord 提取 auth 与 account.uid', () => {
  const r = parseCredentialRecord(SAMPLE)
  assert.equal(r.accessToken, 'A'.repeat(64))
  assert.equal(r.refreshToken, 'R'.repeat(32))
  assert.equal(r.tokenType, 'Bearer')
  assert.equal(r.expiresAt, 1702592000000)
  assert.equal(r.uid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
})

test('parseCredentialRecord 对非 JSON 抛出可读错误', () => {
  assert.throws(() => parseCredentialRecord('not json'), /credential record is not valid JSON/)
})

test('parseCredentialRecord 缺少 accessToken 时抛出', () => {
  assert.throws(() => parseCredentialRecord('{"auth":{}}'), /missing auth.accessToken/)
})

test('needsRefresh 在剩余时间小于阈值时为真', () => {
  const r = parseCredentialRecord(SAMPLE)
  assert.equal(needsRefresh(r, r.expiresAt - 1000, 86400000), true)
  assert.equal(needsRefresh(r, r.expiresAt - 90000000, 86400000), false)
})

test('needsRefresh 对缺失 expiresAt(0) 保守返回真', () => {
  const r = { ...parseCredentialRecord(SAMPLE), expiresAt: 0 }
  assert.equal(needsRefresh(r, Date.now(), 86400000), true)
})
