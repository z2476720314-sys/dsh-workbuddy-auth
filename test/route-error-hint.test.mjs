// RED：路由错误封套必须带**可行动**的 hint。截图里的 `HTTP 500: HTTP 401` 只有状态码，
// 用户无从下手；401/403 与「凭据被加密」这两种病因各不相同，指引也必须不同。
// 契约不变：仍 500 + {ok:false,error}，error 仍只含错误码/状态码/白名单文案。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes, ROUTE_PATHS } from '../lib/routes.mjs'
import { ENCRYPTED_ENVELOPE_MESSAGE } from '../lib/credential.mjs'
import { UPSTREAM_REJECTED_CODE } from '../lib/errors.mjs'

const REFRESH = ROUTE_PATHS.credentialRefresh
const STATUS = ROUTE_PATHS.status
const SAME_ORIGIN = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }
const SEC_A = 'SECRET-A'.repeat(20)
// envelope 凭据的压缩形态：accessToken / refreshToken 共用的同一份加密包。
const ENV = { $wbEncrypted: 1, envelope: 'e' }

function makeWebServer() {
  const routes = []
  return { routes, register(route) { routes.push(route); return () => {} } }
}

function setup(over = {}) {
  const webServer = makeWebServer()
  const ctx = { webServer, logger: { info() {}, warn() {} } }
  const deps = {
    readCredentialRaw: async () => JSON.stringify({ account: { uid: 'u' }, auth: { accessToken: SEC_A, refreshToken: 'r', expiresAt: 9e15 } }),
    refreshNow: async () => ({ refreshed: false, throttled: false, expiresAt: 0 }),
    reloadSeam: async () => ({ refreshed: false, throttled: false, expiresAt: 0 }),
    testConnection: async () => ({ status: 200, sseChunks: true, model: 'hy3' }),
    ...over,
  }
  registerRoutes(ctx, deps)
  return webServer.routes
}

async function call(routes, path, method = 'POST') {
  const route = routes.find((r) => r.path === path)
  assert.ok(route !== undefined, `路由 ${path} 必须已注册`)
  const state = { status: 0, raw: '' }
  await route.handler({ method, headers: SAME_ORIGIN, resume() {} }, {
    writeHead(status) { state.status = status },
    end(body) { state.raw = body ?? '' },
  })
  return { state, body: JSON.parse(state.raw) }
}

test('刷新被上游拒绝（401）：500 + 原始错误码，并附「登录态已失效」的可行动 hint', async () => {
  const rejected = new Error('refresh failed: HTTP 401')
  rejected.status = 401
  rejected.code = UPSTREAM_REJECTED_CODE
  const routes = setup({ refreshNow: async () => { throw rejected } })

  const { state, body } = await call(routes, REFRESH)

  assert.equal(state.status, 500)
  assert.equal(body.ok, false)
  assert.match(body.error, /HTTP 401/)
  assert.match(body.hint, /登录态已失效/)
  assert.match(body.hint, /切换账号/)
  assert.match(body.hint, /codebuddy/)
  assert.equal(state.raw.includes(SEC_A), false, 'hint 里也不得夹带令牌')
})

test('上游 5xx（服务端故障）不带「登录态失效」hint —— 别把人指向错误的病因', async () => {
  const boom = new Error('refresh failed: HTTP 503')
  boom.status = 503
  const routes = setup({ refreshNow: async () => { throw boom } })

  const { body } = await call(routes, REFRESH)
  assert.match(body.error, /HTTP 503/)
  assert.equal(body.hint, undefined, '不是凭据问题就不给登录指引')
})

test('凭据被加密（envelope）：hint 指向 WorkBuddy 桌面端，而不是「运行 codebuddy 登录」', async () => {
  const routes = setup({ refreshNow: async () => { throw new Error(ENCRYPTED_ENVELOPE_MESSAGE) } })

  const { state, body } = await call(routes, REFRESH)
  assert.equal(state.status, 500)
  assert.equal(body.error, ENCRYPTED_ENVELOPE_MESSAGE)
  assert.match(body.hint, /WorkBuddy/)
  assert.doesNotMatch(body.hint, /运行 `codebuddy`/)
})

test('成功路径不出现 hint 字段（错误封套专属，避免契约漂移）', async () => {
  const routes = setup()
  const { body } = await call(routes, REFRESH)
  assert.equal(body.ok, true)
  assert.equal('hint' in body, false)
})

test('GET /status 在凭据加密时也带 hint（状态查询同样是用户看得到的那一面）', async () => {
  const routes = setup({
    readCredentialRaw: async () => JSON.stringify({
      account: { uid: 'u-58a7' },
      auth: {
        accessToken: ENV,
        refreshToken: ENV,
        expiresAt: 9e15,
      },
    }),
  })
  const { state, body } = await call(routes, STATUS, 'GET')
  assert.equal(state.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.error, ENCRYPTED_ENVELOPE_MESSAGE)
  assert.match(body.state.credentialHint, /WorkBuddy/)
})
