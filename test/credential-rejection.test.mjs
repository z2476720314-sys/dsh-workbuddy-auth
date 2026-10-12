// RED：上游拒绝凭据（401/403）必须被**分类**，并配一行可行动指引；
// 裸 `refresh failed: HTTP 401` 是截图那句「HTTP 500：HTTP 401」的根因 —— 用户看到
// 状态码却不知道该做什么。服务端故障（5xx）不得被归到「登录态失效」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refreshCredential } from '../lib/refresh.mjs'
import { credentialErrorHint, isCredentialRejection, UPSTREAM_REJECTED_CODE } from '../lib/errors.mjs'

const record = { refreshToken: 'R'.repeat(32) }

test('refreshCredential 在 401 挂上状态码与「凭据被拒」错误码，消息仍含 HTTP 401', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => '{"code":12153}' })
  await assert.rejects(
    () => refreshCredential(record, fakeFetch),
    (error) => {
      assert.match(error.message, /HTTP 401/, '既有契约：界面必须能显示状态码')
      assert.equal(error.status, 401, '状态码必须作为属性暴露，路由层据此给指引')
      assert.equal(error.code, UPSTREAM_REJECTED_CODE)
      return true
    },
  )
})

test('refreshCredential 在 500 不标为凭据拒绝（服务端故障 ≠ 登录态失效）', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' })
  await assert.rejects(
    () => refreshCredential(record, fakeFetch),
    (error) => {
      assert.equal(error.status, 500)
      assert.notEqual(error.code, UPSTREAM_REJECTED_CODE)
      return true
    },
  )
})

test('isCredentialRejection 只认 401/403 与显式错误码', () => {
  assert.equal(isCredentialRejection({ status: 401 }), true)
  assert.equal(isCredentialRejection({ status: 403 }), true)
  assert.equal(isCredentialRejection({ code: UPSTREAM_REJECTED_CODE }), true)
  assert.equal(isCredentialRejection({ status: 500 }), false)
  assert.equal(isCredentialRejection({ status: 429 }), false)
  assert.equal(isCredentialRejection(undefined), false)
  assert.equal(isCredentialRejection(null), false)
})

test('credentialErrorHint 对凭据拒绝给出「切换账号或重新登录」，其它错误返回空串', () => {
  for (const error of [{ status: 401 }, { status: 403 }, { code: UPSTREAM_REJECTED_CODE }]) {
    const hint = credentialErrorHint(error)
    assert.match(hint, /登录态已失效/)
    assert.match(hint, /切换账号/)
    assert.match(hint, /codebuddy/)
  }
  assert.equal(credentialErrorHint({ status: 500 }), '')
  assert.equal(credentialErrorHint(new Error('boom')), '')
  assert.equal(credentialErrorHint(undefined), '')
})
