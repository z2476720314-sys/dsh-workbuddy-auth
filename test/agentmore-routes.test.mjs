// agentmore 的 10 条 HTTP 路由测试 —— 假 ctx / 假 service，零真实网络、零真实文件。
//
// 契约（与 WorkBuddy 那 10 条同型）：
//   * 全部 `kind:'exact'`，前缀 `/api/dsh-workbuddy-auth/agentmore`；
//   * 先要求 Host 为 loopback，再做 Origin/Host 同源校验（两条围栏都在 `makeHandler`）；
//   * 响应恒为 `application/json; charset=utf-8`；
//   * 响应体**逐字段白名单投影**，绝不含 accessToken / refreshToken / deviceId；
//   * 错误统一 `{ ok:false, error }`，只回错误码与状态码，绝不回显上游文案。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerRoutes, AGENTMORE_ROUTE_PATHS, AGENTMORE_ROUTE_PREFIX, ROUTE_PREFIX } from '../lib/routes.mjs'

const SAME_ORIGIN = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }
const CROSS_ORIGIN = { origin: 'http://evil.example', host: '127.0.0.1:3080' }

/** 令牌值：任意响应里出现即失败。 */
const TOKENS = ['SECRET-ACCESS', 'SECRET-REFRESH', 'SECRET-DEVICE']

function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at !== -1) routes.splice(at, 1)
      }
    },
  }
}

function makeCtx() {
  const webServer = makeWebServer()
  const infos = []
  const ctx = {
    webServer,
    logger: { info: (m) => infos.push(String(m)), warn: (m) => infos.push(String(m)) },
  }
  return { ctx, routes: webServer.routes, infos }
}

function makeReq({ method = 'GET', headers = SAME_ORIGIN, body } = {}) {
  if (body === undefined) return { method, headers }
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method,
    headers,
    setEncoding() {},
    on(event, handler) {
      if (event === 'data') queueMicrotask(() => handler(text))
      if (event === 'end') queueMicrotask(() => handler())
      return this
    },
    resume() {},
  }
}

function makeRes() {
  const state = { status: 0, headers: {}, raw: undefined }
  return {
    state,
    jsonBody: () => JSON.parse(state.raw),
    writeHead(status, headers = {}) {
      state.status = status
      state.headers = { ...headers }
    },
    end(body) {
      state.raw = body ?? ''
    },
  }
}

async function call(routes, path, options = {}) {
  const route = routes.find((entry) => entry.path === path)
  assert.ok(route !== undefined, `路由 ${path} 必须已注册`)
  const res = makeRes()
  await route.handler(makeReq(options), res)
  return res
}

function assertNoSecret(text, label) {
  const raw = String(text)
  for (const needle of TOKENS) {
    assert.equal(raw.includes(needle), false, `${label} 不得含令牌值（命中 ${needle}）`)
  }
}

/** 假 agentmore service：记录调用，默认返回可投影的正常 DTO。 */
function makeAgentmore(over = {}) {
  const calls = {
    status: 0,
    startLogin: 0,
    loginStatus: 0,
    cancelLogin: 0,
    listAccounts: 0,
    activateAccount: 0,
    removeAccount: 0,
    credits: 0,
    models: 0,
    patchModels: 0,
    refreshModels: 0,
  }
  const service = {
    async status() {
      calls.status += 1
      return {
        ok: true,
        loggedIn: true,
        account: { id: 'acc-1', displayName: '清言 123456', userId: 'u-1', ['accessToken']: TOKENS[0] },
        credits: { remaining: 42, display: '42' },
        models: {
          enabled: true,
          serving: true,
          catalogSource: 'live',
          catalogError: '',
          conflict: '',
          enabledModelIds: ['glm-5.3'],
          defaultReasoningEffort: 'max',
          list: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, enabled: true }],
          refreshToken: TOKENS[1],
        },
        ['accessToken']: TOKENS[0],
        refreshToken: TOKENS[1],
        deviceId: TOKENS[2],
      }
    },
    async startLogin() {
      calls.startLogin += 1
      return { status: 'running', startedAt: 1_700_000_000_000, ['accessToken']: TOKENS[0] }
    },
    loginStatus() {
      calls.loginStatus += 1
      return { status: 'complete', completedAt: 1_700_000_001_000, account: { id: 'acc-1', displayName: '清言 123456', userId: 'u-1', refreshToken: TOKENS[1] } }
    },
    async cancelLogin() {
      calls.cancelLogin += 1
      return { status: 'cancelled', completedAt: 1_700_000_002_000 }
    },
    async listAccounts() {
      calls.listAccounts += 1
      return [
        { id: 'acc-1', displayName: '清言 123456', userId: 'u-1', active: true },
        { id: 'acc-2', displayName: '清言 654321', userId: 'u-2', active: false },
      ]
    },
    async activateAccount(id) {
      calls.activateAccount += 1
      return { activeId: id }
    },
    async removeAccount(id) {
      calls.removeAccount += 1
      return { id }
    },
    async credits() {
      calls.credits += 1
      return { remaining: 42, display: '42', ['accessToken']: TOKENS[0] }
    },
    async models() {
      calls.models += 1
      return {
        ok: true,
        enabled: true,
        enabledModelIds: ['glm-5.3'],
        defaultReasoningEffort: 'max',
        contextWindowOverrides: { 'glm-5.3': 64000 },
        region: 'cn',
        catalogSource: 'live',
        catalogError: '',
        serving: true,
        conflict: '',
        models: [{
          id: 'glm-5.3',
          name: 'GLM-5.3',
          contextWindow: 1000000,
          maxContextWindow: 1000000,
          maxTokens: 128000,
          inputModalities: ['text'],
          reasoningEfforts: ['low', 'high', 'max'],
          defaultReasoningEffort: 'max',
          enabled: true,
          contextWindowOverride: 64000,
          effectiveContextWindow: 64000,
          effectiveReasoningEffort: 'max',
          refreshToken: TOKENS[1],
        }],
      }
    },
    async patchModels() {
      calls.patchModels += 1
      return { ok: true, enabled: false, enabledModelIds: [], defaultReasoningEffort: null, contextWindowOverrides: {}, region: 'cn', catalogSource: 'cache', catalogError: '', serving: true, conflict: '', models: [] }
    },
    async refreshModels() {
      calls.refreshModels += 1
      return { ok: true, enabled: true, enabledModelIds: ['glm-5.3'], defaultReasoningEffort: 'default', contextWindowOverrides: {}, region: 'cn', catalogSource: 'live', catalogError: '', serving: true, conflict: '', models: [] }
    },
    ...over,
  }
  return { service, calls }
}

function setup(agentmoreOver) {
  const { ctx, routes } = makeCtx()
  const { service, calls } = makeAgentmore(agentmoreOver)
  const dispose = registerRoutes(ctx, { agentmore: service, now: () => 1_700_000_000_000 })
  return { routes, calls, service, dispose }
}

const ALL = Object.values(AGENTMORE_ROUTE_PATHS)

test('装配 agentmore 后 10 条 agentmore 路由全部就位', () => {
  const { routes } = setup()
  // WorkBuddy 那 10 条恒定注册，agentmore 是**追加**的一组，不是替代。
  const paths = routes.map((route) => route.path)
  assert.equal(paths.filter((path) => path.startsWith(AGENTMORE_ROUTE_PREFIX)).length, 10)
  assert.deepEqual(paths.filter((path) => path.startsWith(AGENTMORE_ROUTE_PREFIX)).sort(), [...ALL].sort())
  assert.ok(routes.every((route) => route.kind === 'exact'))
})

test('路由路径挂在前缀下且逐字固定（客户端按这些路径硬编码）', () => {
  assert.equal(AGENTMORE_ROUTE_PREFIX, `${ROUTE_PREFIX}/agentmore`)
  assert.deepEqual(AGENTMORE_ROUTE_PATHS, {
    status: '/api/dsh-workbuddy-auth/agentmore/status',
    login: '/api/dsh-workbuddy-auth/agentmore/login',
    loginStatus: '/api/dsh-workbuddy-auth/agentmore/login/status',
    loginCancel: '/api/dsh-workbuddy-auth/agentmore/login/cancel',
    accounts: '/api/dsh-workbuddy-auth/agentmore/accounts',
    accountActive: '/api/dsh-workbuddy-auth/agentmore/accounts/active',
    accountRemove: '/api/dsh-workbuddy-auth/agentmore/accounts/remove',
    credits: '/api/dsh-workbuddy-auth/agentmore/credits',
    models: '/api/dsh-workbuddy-auth/agentmore/models',
    modelsRefresh: '/api/dsh-workbuddy-auth/agentmore/models/refresh',
  })
})

test('未装配 agentmore 时 agentmore 子树整块缺席', () => {
  const { ctx, routes } = makeCtx()
  registerRoutes(ctx, { now: () => 0 })
  assert.equal(routes.filter((route) => route.path.startsWith(AGENTMORE_ROUTE_PREFIX)).length, 0)
})

test('disposer 摘掉全部 10 条 agentmore 路由', () => {
  const { routes, dispose } = setup()
  dispose()
  assert.deepEqual(routes.filter((route) => route.path.startsWith(AGENTMORE_ROUTE_PREFIX)), [])
})

test('GET /status：投影三段身份 + 积分 + 模型摘要，不含任何令牌', async () => {
  const { routes } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.status)
  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['content-type'], 'application/json; charset=utf-8')
  const body = res.jsonBody()
  assert.equal(body.ok, true)
  assert.equal(body.loggedIn, true)
  assert.deepEqual(body.account, { id: 'acc-1', displayName: '清言 123456', userId: 'u-1' })
  assert.deepEqual(body.credits, { remaining: 42, display: '42' })
  assert.deepEqual(body.models.list, [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxContextWindow: 0, effectiveContextWindow: 0, reasoningEfforts: [], enabled: true }])
  assertNoSecret(res.state.raw, 'GET /agentmore/status')
})

test('GET /status：未登录时没有 account 键', async () => {
  const { routes } = setup({
    async status() {
      return { ok: true, loggedIn: false, credits: { remaining: null, display: '' }, models: {} }
    },
  })
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.status)).jsonBody()
  assert.equal(body.loggedIn, false)
  assert.equal('account' in body, false)
  assert.deepEqual(body.credits, { remaining: null, display: '' })
})

test('GET /status：service 返回非法值时给安全默认值而不是崩', async () => {
  const { routes } = setup({ async status() { return null } })
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.status)
  assert.equal(res.state.status, 200)
  const body = res.jsonBody()
  assert.equal(body.ok, false)
  assert.equal(body.loggedIn, false)
  assert.deepEqual(body.credits.remaining, null)
})

test('GET /status：service 抛错 → 500，error 只回错误码', async () => {
  const { routes } = setup({
    async status() {
      throw Object.assign(new Error('ENOENT: no such file C:\\synthetic-home'), { code: 'AGENTMORE_STORE_READ_FAILED' })
    },
  })
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.status)
  assert.equal(res.state.status, 500)
  const body = res.jsonBody()
  assert.equal(body.ok, false)
  assert.equal(body.error, 'AGENTMORE_STORE_READ_FAILED')
  assert.equal(res.state.raw.includes('Users'), false, '不得回显本地路径')
})

test('POST /login：返回 running 投影，不含授权链接与令牌', async () => {
  const { routes, calls } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.login, { method: 'POST' })
  assert.equal(res.state.status, 200)
  assert.deepEqual(res.jsonBody(), { ok: true, status: 'running', startedAt: 1_700_000_000_000 })
  assert.equal(calls.startLogin, 1)
  assertNoSecret(res.state.raw, 'POST /agentmore/login')
})

test('GET /login/status：complete 时带账号投影', async () => {
  const { routes } = setup()
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.loginStatus)).jsonBody()
  assert.equal(body.status, 'complete')
  assert.equal(body.ok, true)
  assert.deepEqual(body.account, { id: 'acc-1', displayName: '清言 123456', userId: 'u-1' })
})

test('login/status 的 error 态：ok=false 且带 error 文案', async () => {
  const { routes } = setup({
    loginStatus: () => ({ status: 'error', error: '登录超时，请重试' }),
  })
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.loginStatus)).jsonBody()
  assert.equal(body.ok, false)
  assert.equal(body.error, '登录超时，请重试')
})

test('login/status 的未知状态回落 idle', async () => {
  const { routes } = setup({ loginStatus: () => ({ status: 'weird' }) })
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.loginStatus)).jsonBody()
  assert.equal(body.status, 'idle')
  assert.equal(body.ok, true)
})

test('POST /login/cancel：透传 cancelled', async () => {
  const { routes, calls } = setup()
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.loginCancel, { method: 'POST' })).jsonBody()
  assert.equal(body.status, 'cancelled')
  assert.equal(calls.cancelLogin, 1)
})

test('GET /accounts：投影四字段', async () => {
  const { routes } = setup()
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.accounts)).jsonBody()
  assert.deepEqual(body, {
    ok: true,
    accounts: [
      { id: 'acc-1', displayName: '清言 123456', userId: 'u-1', active: true },
      { id: 'acc-2', displayName: '清言 654321', userId: 'u-2', active: false },
    ],
  })
})

test('POST /accounts/active：切号并回 activeId', async () => {
  const { routes, calls } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.accountActive, { method: 'POST', body: { id: 'acc-2' } })
  assert.equal(res.state.status, 200)
  assert.deepEqual(res.jsonBody(), { ok: true, activeId: 'acc-2' })
  assert.equal(calls.activateAccount, 1)
})

test('POST /accounts/active：缺 id → 400 AGENTMORE_ACCOUNT_ID_REQUIRED', async () => {
  const { routes, calls } = setup()
  for (const body of [{}, { id: '' }, { id: 42 }]) {
    const res = await call(routes, AGENTMORE_ROUTE_PATHS.accountActive, { method: 'POST', body })
    assert.equal(res.state.status, 400)
    // describeError 把错误码与状态码拼成一行；两条都要在，才能既定位又看出这是 4xx。
    assert.equal(res.jsonBody().error, 'AGENTMORE_ACCOUNT_ID_REQUIRED / HTTP 400')
  }
  assert.equal(calls.activateAccount, 0)
})

test('POST /accounts/remove：删号并回 ok', async () => {
  const { routes, calls } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.accountRemove, { method: 'POST', body: { id: 'acc-1' } })
  assert.deepEqual(res.jsonBody(), { ok: true })
  assert.equal(calls.removeAccount, 1)
})

test('POST /accounts/remove：缺 id → 400', async () => {
  const { routes } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.accountRemove, { method: 'POST', body: {} })
  assert.equal(res.state.status, 400)
  assert.equal(res.jsonBody().error, 'AGENTMORE_ACCOUNT_ID_REQUIRED / HTTP 400')
})

test('GET /credits：成功投影 remaining/display，不带令牌', async () => {
  const { routes, calls } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.credits)
  assert.deepEqual(res.jsonBody(), { ok: true, credits: { remaining: 42, display: '42' } })
  assert.equal(calls.credits, 1)
  assertNoSecret(res.state.raw, 'GET /agentmore/credits')
})

test('GET /credits：未登录 → ok:false AGENTMORE_NOT_LOGGED_IN', async () => {
  const { routes } = setup({ async credits() { return null } })
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.credits)
  assert.equal(res.state.status, 200)
  assert.deepEqual(res.jsonBody(), { ok: false, error: 'AGENTMORE_NOT_LOGGED_IN' })
})

test('GET /models：扁平契约，13 个模型字段齐全且不带令牌', async () => {
  const { routes, calls } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.models)
  const body = res.jsonBody()
  assert.equal(body.ok, true)
  assert.equal(body.enabled, true)
  assert.equal(body.region, 'cn')
  assert.equal(body.serving, true)
  assert.deepEqual(body.enabledModelIds, ['glm-5.3'])
  assert.deepEqual(body.contextWindowOverrides, { 'glm-5.3': 64000 })
  assert.deepEqual(Object.keys(body.models[0]).sort(), [
    'contextWindow',
    'contextWindowOverride',
    'defaultReasoningEffort',
    'effectiveContextWindow',
    'effectiveReasoningEffort',
    'enabled',
    'id',
    'inputModalities',
    'maxContextWindow',
    'maxTokens',
    'name',
    'reasoningEfforts',
  ].sort())
  assert.equal(calls.models, 1)
  assertNoSecret(res.state.raw, 'GET /agentmore/models')
})

test('POST /models：透传 patch 体', async () => {
  const { routes } = setup()
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.models, { method: 'POST', body: { enabled: false } })).jsonBody()
  assert.equal(body.ok, true)
  assert.equal(body.enabled, false)
})

test('POST /models/refresh：强制刷新走 refreshModels', async () => {
  const { routes, calls } = setup()
  await call(routes, AGENTMORE_ROUTE_PATHS.modelsRefresh, { method: 'POST' })
  assert.equal(calls.refreshModels, 1)
  assert.equal(calls.models, 0)
})

test('models 投影：非法字段被清洗（负数/超长/非数组/越界 modality）', async () => {
  const { routes } = setup({
    async models() {
      return {
        ok: true,
        enabled: true,
        enabledModelIds: ['ok', 42, 'x'.repeat(200)],
        defaultReasoningEffort: 'y'.repeat(100),
        contextWindowOverrides: { good: 1000, zero: 0, neg: -1, float: 1.5, ['k'.repeat(200)]: 1 },
        catalogSource: 'live',
        catalogError: '',
        serving: true,
        conflict: '',
        models: [{
          id: 'glm-5.3',
          name: 'x'.repeat(500),
          contextWindow: -1,
          maxContextWindow: 1.5,
          maxTokens: 128000,
          inputModalities: ['text', 'image', 'audio', 'video'],
          reasoningEfforts: ['max', 42],
          enabled: true,
        }],
      }
    },
  })
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.models)).jsonBody()
  assert.deepEqual(body.enabledModelIds, ['ok', 'x'.repeat(160)])
  assert.equal(body.defaultReasoningEffort, 'y'.repeat(32))
  assert.deepEqual(body.contextWindowOverrides, { good: 1000 })
  assert.equal(body.models[0].contextWindow, 0, '负整数不是 safe integer 之外的合法值 → 归零')
  assert.equal(body.models[0].maxContextWindow, 0)
  assert.deepEqual(body.models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(body.models[0].reasoningEfforts, ['max'])
})

test('models 投影：service 返回 null 时给空默认值', async () => {
  const { routes } = setup({ async models() { return null } })
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.models)).jsonBody()
  assert.equal(body.ok, false)
  assert.equal(body.enabled, false)
  assert.equal(body.region, 'cn')
  assert.deepEqual(body.models, [])
  assert.deepEqual(body.contextWindowOverrides, {})
})

test('Host 不是 loopback → 403（全部路由）', async () => {
  const { routes } = setup()
  for (const path of ALL) {
    const res = await call(routes, path, { method: path.endsWith('/login') || path.endsWith('/cancel') || path.includes('/accounts/') || path === AGENTMORE_ROUTE_PATHS.models || path === AGENTMORE_ROUTE_PATHS.modelsRefresh ? 'POST' : 'GET', headers: { origin: 'http://localhost:3080', host: 'evil.example' } })
    assert.equal(res.state.status, 403, path)
    assert.equal(res.jsonBody().error, 'untrusted host rejected')
  }
})

test('跨源请求 → 403（全部路由）', async () => {
  const { routes } = setup()
  for (const path of ALL) {
    const method = path === AGENTMORE_ROUTE_PATHS.status || path === AGENTMORE_ROUTE_PATHS.loginStatus || path === AGENTMORE_ROUTE_PATHS.accounts || path === AGENTMORE_ROUTE_PATHS.credits || path === AGENTMORE_ROUTE_PATHS.models ? 'GET' : 'POST'
    const res = await call(routes, path, { method, headers: CROSS_ORIGIN })
    assert.equal(res.state.status, 403, path)
    assert.equal(res.jsonBody().error, 'cross-origin request rejected')
  }
})

test('方法不匹配 → 405 且带 allow', async () => {
  const { routes } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.status, { method: 'POST' })
  assert.equal(res.state.status, 405)
  assert.equal(res.state.headers.allow, 'GET')
  assert.equal(res.jsonBody().ok, false)
})

test('GET /login → 405（登录必须 POST）', async () => {
  const { routes } = setup()
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.login, { method: 'GET' })
  assert.equal(res.state.status, 405)
  assert.equal(res.state.headers.allow, 'POST')
})

test('GET /models 与 POST /models 都允许', async () => {
  const { routes } = setup()
  assert.equal((await call(routes, AGENTMORE_ROUTE_PATHS.models, { method: 'GET' })).state.status, 200)
  assert.equal((await call(routes, AGENTMORE_ROUTE_PATHS.models, { method: 'POST', body: {} })).state.status, 200)
})

test('401 错误带可行动 hint（凭据被拒），但回显状态码仍是 500', async () => {
  const { routes } = setup({
    async status() {
      throw Object.assign(new Error('upstream said 401'), { status: 401 })
    },
  })
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.status)
  assert.equal(res.state.status, 500, 'agentmore 的错误不带 exposeStatus，故不外泄为 401')
  const body = res.jsonBody()
  assert.match(body.error, /HTTP 401/)
  assert.equal(typeof body.hint, 'string')
  assert.equal(body.hint.length > 0, true)
  assert.equal(res.state.raw.includes('upstream said'), false, '上游原始文案不得回显')
})

test('无 code 无状态码的错误 → request failed', async () => {
  const { routes } = setup({ async status() { throw new Error('opaque internal detail') } })
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.status)).jsonBody()
  assert.equal(body.error, 'request failed')
})

test('错误码含非法字符时不被回显', async () => {
  const { routes } = setup({
    async status() {
      throw Object.assign(new Error('x'), { code: 'BAD CODE WITH SPACES' })
    },
  })
  const body = (await call(routes, AGENTMORE_ROUTE_PATHS.status)).jsonBody()
  assert.equal(body.error, 'request failed')
})

test('POST /accounts/active：service 抛 AGENTMORE_ACCOUNT_NOT_FOUND → 500 且回码', async () => {
  const { routes } = setup({
    async activateAccount() {
      throw Object.assign(new Error('missing'), { code: 'AGENTMORE_ACCOUNT_NOT_FOUND' })
    },
  })
  const res = await call(routes, AGENTMORE_ROUTE_PATHS.accountActive, { method: 'POST', body: { id: 'nope' } })
  assert.equal(res.state.status, 500)
  assert.equal(res.jsonBody().error, 'AGENTMORE_ACCOUNT_NOT_FOUND')
})
