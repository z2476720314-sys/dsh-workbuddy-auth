// 刷新请求构造与响应解析 —— 纯函数测试。
// 所有网络调用一律注入假 fetch：本文件绝不发出真实 HTTPS 请求。
// 反射 token 为运行时合成的假串，不使用任何真实机密。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFRESH_URL, REFRESH_TIMEOUT_MS, buildRefreshRequest, parseRefreshResponse, refreshCredential } from '../lib/refresh.mjs'

const record = { accessToken: 'old', refreshToken: 'REFRESH', tokenType: 'Bearer', expiresAt: 1, refreshExpiresAt: 2, lastRefreshTime: 0, uid: 'u' }

test('REFRESH_URL 指向 /v2/plugin/auth/token/refresh', () => {
  assert.equal(REFRESH_URL, 'https://copilot.tencent.com/v2/plugin/auth/token/refresh')
})

test('buildRefreshRequest 带上 X-Refresh-Token 且不带 Authorization', () => {
  const { url, init } = buildRefreshRequest(record)
  assert.equal(url, REFRESH_URL)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['X-Refresh-Token'], 'REFRESH')
  assert.equal(init.headers.Authorization, undefined)
})

test('parseRefreshResponse 接受 data 包络', () => {
  const got = parseRefreshResponse(JSON.stringify({ data: { accessToken: 'new', refreshToken: 'R2', expiresAt: 999 } }))
  assert.equal(got.accessToken, 'new')
  assert.equal(got.refreshToken, 'R2')
})

test('refreshCredential 对非 2xx 抛出含状态码的错误', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => '{"code":12153}' })
  await assert.rejects(() => refreshCredential(record, fakeFetch), /refresh failed: HTTP 401/)
})

test('refreshCredential 对缺少 accessToken 的响应抛出', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => '{"data":{}}' })
  await assert.rejects(() => refreshCredential(record, fakeFetch), /missing data.accessToken/)
})

// —— 以下为 brief 之外的补充边界用例（不修改上面的断言）——

test('buildRefreshRequest 缺少 refreshToken 时明确报错而不是发出空头', () => {
  assert.throws(() => buildRefreshRequest({ ...record, refreshToken: '' }), /credential record is missing refreshToken/)
  assert.throws(() => buildRefreshRequest(undefined), /credential record is missing refreshToken/)
})

test('parseRefreshResponse 对非 JSON 文本抛出可读错误', () => {
  assert.throws(() => parseRefreshResponse('<html>502 Bad Gateway</html>'), /refresh response is not valid JSON/)
})

test('parseRefreshResponse 对「HTTP 200 但业务码失败」的包络抛出而不是静默吞掉', () => {
  assert.throws(() => parseRefreshResponse('{"code":12153,"msg":"refresh token invalid"}'), /missing data.accessToken/)
})

test('parseRefreshResponse 在响应未带 refreshToken/expiresAt 时返回 undefined 而非空串', () => {
  const got = parseRefreshResponse('{"data":{"accessToken":"new"}}')
  assert.equal(got.accessToken, 'new')
  assert.equal(got.refreshToken, undefined)
  assert.equal(got.expiresAt, undefined)
  assert.equal(got.refreshExpiresAt, undefined)
})

test('refreshCredential 成功时用注入的 fetch 取回新令牌并透传请求头', async () => {
  const seen = []
  const fakeFetch = async (url, init) => {
    seen.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { accessToken: 'new', refreshToken: 'R2', expiresAt: 999, refreshExpiresAt: 1000 } }),
    }
  }
  const got = await refreshCredential(record, fakeFetch)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, REFRESH_URL)
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['X-Refresh-Token'], 'REFRESH')
  assert.equal(got.accessToken, 'new')
  assert.equal(got.refreshToken, 'R2')
  assert.equal(got.expiresAt, 999)
  assert.equal(got.refreshExpiresAt, 1000)
})

// —— Task 7 Step 3：实测刷新包络（已实测确认，2026-09-11）——
// 真实成功响应为 HTTP 200 application/json：{ code, msg, requestId, data: {...} }，
// 其中 data 只带**相对秒数** expiresIn / refreshExpiresIn，没有 expiresAt / refreshExpiresAt。
// 换算必须可确定性断言，故一律注入固定 now。

const FIXED_NOW = 1_760_000_000_000

test('parseRefreshResponse 用 data.expiresIn 相对秒数换算绝对到期时间', () => {
  const got = parseRefreshResponse(JSON.stringify({ data: { accessToken: 'new', expiresIn: 7200 } }), FIXED_NOW)
  assert.equal(got.expiresAt, FIXED_NOW + 7200 * 1000)
})

test('parseRefreshResponse 用 data.refreshExpiresIn 相对秒数换算绝对到期时间', () => {
  const got = parseRefreshResponse(JSON.stringify({ data: { accessToken: 'new', refreshExpiresIn: 2592000 } }), FIXED_NOW)
  assert.equal(got.refreshExpiresAt, FIXED_NOW + 2592000 * 1000)
})

test('parseRefreshResponse 在 expiresIn/refreshExpiresIn 都缺失时仍返回 undefined（沿用旧值）', () => {
  const got = parseRefreshResponse(JSON.stringify({ data: { accessToken: 'new' } }), FIXED_NOW)
  assert.equal(got.expiresAt, undefined)
  assert.equal(got.refreshExpiresAt, undefined)
})

test('parseRefreshResponse 绝对字段存在时优先于相对字段', () => {
  const got = parseRefreshResponse(
    JSON.stringify({ data: { accessToken: 'new', expiresAt: 999, expiresIn: 7200, refreshExpiresAt: 1000, refreshExpiresIn: 2592000 } }),
    FIXED_NOW,
  )
  assert.equal(got.expiresAt, 999)
  assert.equal(got.refreshExpiresAt, 1000)
})

test('parseRefreshResponse 解析实测成功包络（code/msg/requestId + data 九字段）', () => {
  const envelope = {
    code: 0,
    msg: 'success',
    requestId: '00000000-0000-0000-0000-000000000000',
    data: {
      accessToken: 'new',
      expiresIn: 7200,
      refreshExpiresIn: 2592000,
      refreshToken: 'R2',
      tokenType: 'Bearer',
      notBeforePolicy: 0,
      sessionState: 'active',
      scope: 'openid profile',
    },
  }
  const got = parseRefreshResponse(JSON.stringify(envelope), FIXED_NOW)
  assert.equal(got.accessToken, 'new')
  assert.equal(got.refreshToken, 'R2')
  assert.equal(got.expiresAt, FIXED_NOW + 7200 * 1000)
  assert.equal(got.refreshExpiresAt, FIXED_NOW + 2592000 * 1000)
})

// —— 刷新超时：一次永不返回的刷新请求会让 syncCredential 永远挂起 ——

test('refreshCredential 默认注入 30s 超时信号（不再可能无限期挂起）', async () => {
  assert.equal(REFRESH_TIMEOUT_MS, 30_000)
  let seen = null
  const fakeFetch = async (url, init) => {
    seen = init
    return { ok: true, status: 200, text: async () => '{"data":{"accessToken":"new"}}' }
  }
  await refreshCredential(record, fakeFetch)
  assert.ok(seen.signal, 'init.signal 必须存在')
  assert.equal(typeof seen.signal.aborted, 'boolean')
  // 注入的假 fetch 仍然拿到完整的原请求契约：超时是 init 上叠加的字段，不是替换。
  assert.equal(seen.method, 'POST')
  assert.equal(seen.headers['X-Refresh-Token'], 'REFRESH')
  assert.equal(seen.body, '{}')
})

test('refreshCredential 的超时是真实生效的（超时后以 AbortError 拒绝）', async () => {
  // 注入 10ms：假 fetch 监听 signal 并模拟"永不返回直到被中止"。
  const fakeFetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  await assert.rejects(() => refreshCredential(record, fakeFetch, { timeoutMs: 10 }), (e) => e.name === 'TimeoutError' || e.name === 'AbortError')
})
