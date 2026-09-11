// 4 条同源 Host 路由的测试 —— 全部用假 ctx + 假 deps，**零真实网络请求、零真实文件读写**。
//
// 契约（设计文档 §10.2 / §10.3）：
//   * 只注册 4 条 `kind:'exact'` 路由，前缀 `/api/dsh-workbuddy-auth`；
//   * 所有 4 条路由先要求 Host 为 127.0.0.1 / localhost / [::1]，再做 Origin/Host 同源校验；
//     GET /status 虽不改状态，但同样返回账号脱敏信息，因此使用完全相同的请求来源围栏；
//   * 所有响应 `content-type: application/json; charset=utf-8`；
//   * **任何响应体都不得含 accessToken / refreshToken 的值**（含错误路径）；
//   * 错误统一 `{ ok:false, error }`，只回显状态码/错误码，绝不整段回显上游响应体，
//     也绝不回显本地文件路径（`ENOENT: … open 'C:\\Users\\…'` 会把用户目录带出去）。
// 所有令牌均为运行时合成的假串，不含任何真实机密。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { registerRoutes, isCrossOrigin, isTrustedLoopbackHost, ROUTE_PREFIX, ROUTE_PATHS } from '../lib/routes.mjs'
import { withCredits } from '../lib/status.mjs'

const STATUS = '/api/dsh-workbuddy-auth/status'
const CONNECTION_TEST = '/api/dsh-workbuddy-auth/connection/test'
const CREDENTIAL_REFRESH = '/api/dsh-workbuddy-auth/credential/refresh'
const CREDENTIAL_RELOAD = '/api/dsh-workbuddy-auth/credential/reload'
const ALL_PATHS = [STATUS, CONNECTION_TEST, CREDENTIAL_REFRESH, CREDENTIAL_RELOAD]

/** 同源请求头：Origin 的 host 与 Host 头一致（端口也必须一致）。 */
const SAME_ORIGIN = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }

const SECRET_A = 'SECRET-A'.repeat(20)
const SECRET_R = 'SECRET-R'.repeat(20)
/** 生产 seam 用例用的合成令牌（同样不含任何真实机密）。 */
const FAKE_TOKEN = 'SYNTHETIC-ACCESS'.repeat(8)
const FAKE_REFRESH = 'SYNTHETIC-REFRESH'.repeat(8)
const RAW = JSON.stringify({
  account: { uid: '00000000-1111-4222-8333-444444444444', nickname: '测试用户', phoneNumber: '13800001234' },
  auth: { accessToken: SECRET_A, refreshToken: SECRET_R, expiresAt: 1702592000000, refreshExpiresAt: 1705184000000, lastRefreshTime: 1700000000000 },
})

/** 反向断言：响应文本里不得出现任何令牌值。 */
function assertNoSecret(text, label) {
  const s = String(text)
  for (const needle of ['SECRET-A', 'SECRET-R', SECRET_A, SECRET_R, FAKE_TOKEN, FAKE_REFRESH]) {
    assert.equal(s.includes(needle), false, `${label} 不得含令牌值（命中 ${needle.slice(0, 10)}…）`)
  }
}

/** 假 webServer：register 收集路由并返回真正会摘除它的 disposer。 */
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

/**
 * 假 ctx。`expose` 决定 webServer 的读法，用来钉住两种真实存在的形态：
 *   'property' —— 最小假 ctx（brief 里给的形状，本仓库既有测试同型）；
 *   'get'      —— 真 Cordis ctx（服务用 ctx.get(name) 读取，未声明 inject 也不抛错）。
 */
function makeCtx({ expose = 'property' } = {}) {
  const webServer = makeWebServer()
  const infos = []
  const ctx = { logger: { info: (m) => infos.push(String(m)), warn: (m) => infos.push(String(m)) } }
  if (expose === 'property' || expose === 'both') ctx.webServer = webServer
  if (expose === 'get' || expose === 'both') ctx.get = (name) => (name === 'webServer' ? webServer : undefined)
  return { ctx, webServer, routes: webServer.routes, infos }
}

function makeReq({ method = 'GET', headers = SAME_ORIGIN } = {}) {
  return { method, headers }
}

/** 最小响应替身：记录状态码、响应头与响应体文本。 */
function makeRes() {
  const state = { status: 0, headers: {}, raw: undefined }
  return {
    state,
    jsonBody() {
      return JSON.parse(state.raw)
    },
    writeHead(status, headers = {}) {
      state.status = status
      state.headers = { ...headers }
    },
    end(body) {
      state.raw = body ?? ''
    },
  }
}

/** 找到路由并调用它，返回响应替身。 */
async function call(routes, path, { method = 'GET', headers = SAME_ORIGIN } = {}) {
  const route = routes.find((r) => r.path === path)
  assert.ok(route !== undefined, `路由 ${path} 必须已注册`)
  const res = makeRes()
  await route.handler(makeReq({ method, headers }), res)
  return res
}

/** 假 deps：记录每个 seam 的调用次数，永不触网、永不碰盘。 */
function makeDeps(over = {}) {
  const calls = { readCredentialRaw: 0, fetchCredits: 0, testConnection: 0, refreshNow: 0, reloadSeam: 0 }
  const deps = {
    readCredentialRaw: async () => {
      calls.readCredentialRaw += 1
      calls.fetchCredits += 1
      return withCredits(RAW, { ok: true, remaining: 950.25, total: 1234, used: 283.75, fetchedAt: 1700000000000, stale: false })
    },
    testConnection: async () => { calls.testConnection += 1; return { status: 200, sseChunks: true, model: 'hy3' } },
    refreshNow: async () => { calls.refreshNow += 1; return { refreshed: true, throttled: false, expiresAt: 1702592000000 } },
    reloadSeam: async () => { calls.reloadSeam += 1; return { refreshed: false, throttled: false, expiresAt: 1702592000000 } },
    now: () => 1700000000000,
    upstreamHost: 'copilot.tencent.com',
    userAgentFix: true,
    ...over,
  }
  return { deps, calls }
}

test('注册 4 条 exact 路由：前缀正确、路径逐字一致，并返回可回收的 disposer', () => {
  const { ctx, routes } = makeCtx()
  const { deps } = makeDeps()

  const dispose = registerRoutes(ctx, deps)

  assert.equal(routes.length, 4)
  assert.deepEqual(routes.map((r) => r.path).sort(), [...ALL_PATHS].sort())
  assert.ok(routes.every((r) => r.kind === 'exact'), '4 条都必须是 exact 路由')
  assert.ok(ALL_PATHS.every((p) => p.startsWith(`${ROUTE_PREFIX}/`)), '路径必须挂在约定的前缀下')
  assert.equal(ROUTE_PREFIX, '/api/dsh-workbuddy-auth')
  assert.deepEqual(ROUTE_PATHS, {
    status: STATUS,
    connectionTest: CONNECTION_TEST,
    credentialRefresh: CREDENTIAL_REFRESH,
    credentialReload: CREDENTIAL_RELOAD,
  })

  assert.equal(typeof dispose, 'function')
  dispose()
  assert.deepEqual(routes, [], 'disposer 必须摘掉自己注册的全部路由')
})

test('GET /status → 200，返回脱敏 DTO，响应体不含令牌值', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  const res = await call(routes, STATUS)

  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['content-type'], 'application/json; charset=utf-8')
  const body = res.jsonBody()
  assert.equal(body.ok, true)
  assert.equal(body.account.nickname, '测试用户')
  assert.equal(body.account.uidTail, '4444')
  assert.equal(body.account.phoneMasked, '138****1234')
  assert.equal(body.state.credentialReadable, true)
  assert.equal(body.state.userAgentFix, true)
  assert.equal(body.state.upstreamHost, 'copilot.tencent.com')
  assert.deepEqual(body.credits, {
    ok: true,
    remaining: 950.25,
    total: 1234,
    used: 283.75,
    fetchedAt: 1700000000000,
    stale: false,
  })
  assert.equal(calls.readCredentialRaw, 1)
  assert.equal(calls.fetchCredits, 1)
  assert.deepEqual(Object.keys(body).sort(), ['account', 'credits', 'ok', 'state', 'token'])
  for (const forbidden of ['PackageCode', 'ResourceId', 'enterpriseId', 'accessToken', 'refreshToken', '00000000-1111-4222-8333-444444444444']) {
    assert.equal(String(res.state.raw).includes(forbidden), false, `/status 不得含敏感字段或原值 ${forbidden}`)
  }
  assertNoSecret(res.state.raw, 'GET /status')
})

test('GET /status：余额 unavailable 时凭据状态仍成功，credits 不得以 0 冒充成功', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps({
    readCredentialRaw: async () => {
      calls.readCredentialRaw += 1
      calls.fetchCredits += 1
      return withCredits(RAW, { ok: false, error: 'unavailable' })
    },
  })
  registerRoutes(ctx, deps)

  const res = await call(routes, STATUS)
  const body = res.jsonBody()

  assert.equal(res.state.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.credits, { ok: false, error: 'unavailable' })
  assert.equal(calls.readCredentialRaw, 1)
  assert.equal(calls.fetchCredits, 1)
  assertNoSecret(res.state.raw, 'GET /status（余额 unavailable）')
})

test('GET /status：即使脏余额 seam 返回包、账号与 token，响应也只取余额白名单', async () => {
  const { ctx, routes } = makeCtx()
  const { deps } = makeDeps({
    readCredentialRaw: async () => withCredits(RAW, {
      ok: true,
      remaining: '7.5',
      total: 10,
      used: 2.5,
      fetchedAt: 1700000000000,
      stale: false,
      PackageCode: 'SECRET-PACKAGE',
      ResourceId: 'SECRET-RESOURCE',
      uid: 'SECRET-UID',
      enterpriseId: 'SECRET-ENTERPRISE',
      accessToken: SECRET_A,
      refreshToken: SECRET_R,
    }),
  })
  registerRoutes(ctx, deps)

  const res = await call(routes, STATUS)
  const credits = res.jsonBody().credits

  assert.deepEqual(credits, { ok: true, remaining: 7.5, total: 10, used: 2.5, fetchedAt: 1700000000000, stale: false })
  assert.deepEqual(Object.keys(credits).sort(), ['fetchedAt', 'ok', 'remaining', 'stale', 'total', 'used'])
  for (const forbidden of ['PackageCode', 'ResourceId', 'SECRET-UID', 'SECRET-ENTERPRISE']) {
    assert.equal(String(res.state.raw).includes(forbidden), false)
  }
  assertNoSecret(res.state.raw, 'GET /status（脏余额 seam）')
})

test('GET /status 在凭据不可读时仍返回 200 + ok:false（状态查询本身不是 HTTP 错误）', async () => {
  const { ctx, routes } = makeCtx()
  const boom = new Error('ENOENT: no such file or directory')
  boom.code = 'ENOENT'
  const { deps } = makeDeps({ readCredentialRaw: async () => { throw boom } })
  registerRoutes(ctx, deps)

  const res = await call(routes, STATUS)

  assert.equal(res.state.status, 200)
  const body = res.jsonBody()
  assert.equal(body.ok, false)
  assert.equal(body.state.credentialReadable, false)
  // M4：只回显错误码（ENOENT 属于受限字符集的 code），**不**回显 error.message。
  assert.equal(body.error, 'ENOENT', '只允许回显错误码，而不是带本地路径的原文')
  assertNoSecret(res.state.raw, 'GET /status（失败路径）')
})

test('M4：GET /status 的错误不得回显本地文件路径（只回错误码）', async () => {
  const { ctx, routes } = makeCtx()
  // 真实形态：Node 的 ENOENT 消息里带绝对路径，直接回显等于把用户目录（乃至用户名）交给浏览器。
  const localPath = 'C:\\Users\\somebody\\AppData\\Local\\CodeBuddyExtension\\Data\\Public\\auth\\Tencent-Cloud.coding-copilot.info'
  const boom = new Error(`ENOENT: no such file or directory, open '${localPath}'`)
  boom.code = 'ENOENT'
  const { deps } = makeDeps({ readCredentialRaw: async () => { throw boom } })
  registerRoutes(ctx, deps)

  const res = await call(routes, STATUS)
  const body = res.jsonBody()

  assert.equal(res.state.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.error, 'ENOENT')
  assert.equal(String(res.state.raw).includes(localPath), false, '响应体不得含本地凭据文件路径')
  assert.equal(String(res.state.raw).includes('somebody'), false, '响应体不得含用户名')
  assert.equal(String(res.state.raw).includes('AppData'), false, '响应体不得含用户目录结构')
})

test('M4：GET /status 的未知错误压缩成固定消息，绝不回显原文', async () => {
  const { ctx, routes } = makeCtx()
  const boom = new Error(`unexpected failure reading C:\\Users\\somebody\\secret\\path.info (body: ${SECRET_A})`)
  const { deps } = makeDeps({ readCredentialRaw: async () => { throw boom } })
  registerRoutes(ctx, deps)

  const res = await call(routes, STATUS)
  const body = res.jsonBody()

  assert.equal(body.error, 'request failed', '白名单以外的消息一律替换成固定文案')
  assert.equal(String(res.state.raw).includes('somebody'), false)
  assertNoSecret(res.state.raw, 'GET /status（未知错误）')
})

test('GET /status：跨源 Origin → 403，且 deps 零调用（不泄漏账号信息给跨源页面）', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  for (const headers of [
    { origin: 'http://evil.example', host: '127.0.0.1:3080' },
    { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' }, // 端口不同也算跨源
    { origin: 'not-a-url', host: '127.0.0.1:3080' }, // 非法 Origin
    { origin: 'http://127.0.0.1:3080' }, // Host 缺失
  ]) {
    const res = await call(routes, STATUS, { headers })
    assert.equal(res.state.status, 403, `/status 跨源必须 403（Origin=${JSON.stringify(headers.origin)}）`)
    assert.equal(res.jsonBody().ok, false)
    assertNoSecret(res.state.raw, 'GET /status（跨源）')
  }
  assert.equal(calls.readCredentialRaw, 0, '跨源请求必须在触碰任何依赖之前就被拒掉')
  assert.equal(calls.fetchCredits, 0, '跨源请求必须在余额网络 seam 前就被拒掉')
})

test('GET /status：三种 loopback Host 在同源或无 Origin 时放行', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  for (const headers of [
    SAME_ORIGIN,
    { host: '127.0.0.1:3080' },
    { origin: 'http://localhost:3080', host: 'localhost:3080' },
    { origin: 'http://[::1]:3080', host: '[::1]:3080' },
  ]) {
    const res = await call(routes, STATUS, { headers })
    assert.equal(res.state.status, 200, `可信 loopback Host 必须放行（headers=${JSON.stringify(headers)}）`)
    assert.equal(res.jsonBody().ok, true)
  }
  assert.equal(calls.readCredentialRaw, 4)
})

test('所有 4 条路由拒绝非 loopback Host，即使 Origin 与 Host 相同，且 deps 零调用', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  for (const [path, method] of [
    [STATUS, 'GET'],
    [CONNECTION_TEST, 'POST'],
    [CREDENTIAL_REFRESH, 'POST'],
    [CREDENTIAL_RELOAD, 'POST'],
  ]) {
    const res = await call(routes, path, {
      method,
      headers: { origin: 'http://evil.test:3080', host: 'evil.test:3080' },
    })
    assert.equal(res.state.status, 403, `${path} 不得接受 DNS rebinding Host`)
    assert.equal(res.jsonBody().ok, false)
  }
  assert.deepEqual(calls, { readCredentialRaw: 0, fetchCredits: 0, testConnection: 0, refreshNow: 0, reloadSeam: 0 })
})

test('所有 4 条路由在 Host 缺失时一律 403（包括无 Origin），且 deps 零调用', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  for (const [path, method] of [
    [STATUS, 'GET'],
    [CONNECTION_TEST, 'POST'],
    [CREDENTIAL_REFRESH, 'POST'],
    [CREDENTIAL_RELOAD, 'POST'],
  ]) {
    for (const headers of [{}, { origin: 'http://127.0.0.1:3080' }]) {
      const res = await call(routes, path, { method, headers })
      assert.equal(res.state.status, 403, `${path} 缺 Host 不得放行`)
      assert.equal(res.jsonBody().ok, false)
    }
  }
  assert.deepEqual(calls, { readCredentialRaw: 0, fetchCredits: 0, testConnection: 0, refreshNow: 0, reloadSeam: 0 })
})

test('POST /connection/test 同源 → 200，deps.testConnection 恰好一次', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  const res = await call(routes, CONNECTION_TEST, { method: 'POST' })

  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['content-type'], 'application/json; charset=utf-8')
  const body = res.jsonBody()
  assert.equal(body.ok, true)
  assert.equal(body.status, 200)
  assert.equal(body.sseChunks, true)
  assert.equal(calls.testConnection, 1)
  assertNoSecret(res.state.raw, 'POST /connection/test')
})

test('POST /connection/test 跨源 Origin → 403，且 deps 零调用', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  const res = await call(routes, CONNECTION_TEST, {
    method: 'POST',
    headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' },
  })

  assert.equal(res.state.status, 403)
  assert.equal(res.jsonBody().ok, false)
  assert.equal(calls.testConnection, 0, '跨源请求必须在触碰任何依赖之前就被拒掉')
  assertNoSecret(res.state.raw, 'POST /connection/test（跨源）')
})

test('所有会改状态的路由都对跨源 Origin 返回 403（端口不同也算跨源）', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  for (const path of [CONNECTION_TEST, CREDENTIAL_REFRESH, CREDENTIAL_RELOAD]) {
    const res = await call(routes, path, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' },
    })
    assert.equal(res.state.status, 403, `${path} 跨源必须 403`)
    assertNoSecret(res.state.raw, `${path}（跨源）`)
  }
  assert.deepEqual(calls, { readCredentialRaw: 0, fetchCredits: 0, testConnection: 0, refreshNow: 0, reloadSeam: 0 })

  // missing / 非法 Origin 头同样算跨源，绝不能放行。
  const forged = await call(routes, CREDENTIAL_REFRESH, { method: 'POST', headers: { origin: 'not-a-url', host: '127.0.0.1:3080' } })
  assert.equal(forged.state.status, 403)
  assert.equal(calls.refreshNow, 0)
})

test('POST /credential/refresh 同源 → 200，deps.refreshNow 恰好一次', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  const res = await call(routes, CREDENTIAL_REFRESH, { method: 'POST' })

  assert.equal(res.state.status, 200)
  const body = res.jsonBody()
  assert.equal(body.ok, true)
  assert.equal(body.refreshed, true)
  assert.equal(body.expiresAt, 1702592000000)
  assert.equal(calls.refreshNow, 1)
  assert.equal(calls.reloadSeam, 0, '两条路由不得互相串味')
  assertNoSecret(res.state.raw, 'POST /credential/refresh')
})

test('POST /credential/reload 同源 → 200，deps.reloadSeam 恰好一次', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  const res = await call(routes, CREDENTIAL_RELOAD, { method: 'POST' })

  assert.equal(res.state.status, 200)
  const body = res.jsonBody()
  assert.equal(body.ok, true)
  assert.equal(body.refreshed, false)
  assert.equal(body.expiresAt, 1702592000000)
  assert.equal(calls.reloadSeam, 1)
  assert.equal(calls.refreshNow, 0)
  assertNoSecret(res.state.raw, 'POST /credential/reload')
})

test('POST 路由拒绝非 POST：405 + allow 头，且零依赖调用', async () => {
  const { ctx, routes } = makeCtx()
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  for (const path of [CONNECTION_TEST, CREDENTIAL_REFRESH, CREDENTIAL_RELOAD]) {
    const res = await call(routes, path, { method: 'GET' })
    assert.equal(res.state.status, 405, `${path} 必须只接受 POST`)
    assert.equal(res.state.headers.allow, 'POST')
    assert.equal(res.state.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(res.jsonBody().ok, false)
  }
  assert.deepEqual(calls, { readCredentialRaw: 0, fetchCredits: 0, testConnection: 0, refreshNow: 0, reloadSeam: 0 })
})

test('依赖抛错 → 500 { ok:false, error }，只回显状态码，不回显上游原始响应体', async () => {
  const { ctx, routes } = makeCtx()
  const { deps } = makeDeps({
    refreshNow: async () => { throw new Error('refresh failed: HTTP 401') },
  })
  registerRoutes(ctx, deps)

  const res = await call(routes, CREDENTIAL_REFRESH, { method: 'POST' })

  assert.equal(res.state.status, 500)
  const body = res.jsonBody()
  assert.equal(body.ok, false)
  assert.match(body.error, /HTTP 401/, '必须让界面能显示状态码')
  assertNoSecret(res.state.raw, 'POST /credential/refresh（失败路径）')
})

test('错误路径绝不整段回显上游响应体（响应体里可能夹带令牌）', async () => {
  const { ctx, routes } = makeCtx()
  const upstreamBody = `{"code":12153,"msg":"request illegal","accessToken":"${SECRET_A}"}`
  const { deps } = makeDeps({
    testConnection: async () => { throw new Error(`upstream rejected the probe: ${upstreamBody}`) },
  })
  registerRoutes(ctx, deps)

  const res = await call(routes, CONNECTION_TEST, { method: 'POST' })

  assert.equal(res.state.status, 500)
  assert.equal(res.jsonBody().ok, false)
  assertNoSecret(res.state.raw, 'POST /connection/test（上游报错）')
  assert.equal(String(res.state.raw).includes('request illegal'), false, '不得整段回显上游响应体')
})

test('错误路径回显错误码（如 ENOENT）而不是吞掉原因', async () => {
  const { ctx, routes } = makeCtx()
  const boom = new Error('EPERM: operation not permitted, rename ...')
  boom.code = 'PERM-DENIED'
  const { deps } = makeDeps({ reloadSeam: async () => { throw boom } })
  registerRoutes(ctx, deps)

  const res = await call(routes, CREDENTIAL_RELOAD, { method: 'POST' })

  assert.equal(res.state.status, 500)
  assert.equal(res.jsonBody().error, 'PERM-DENIED')
  assertNoSecret(res.state.raw, 'POST /credential/reload（失败路径）')
})

test('动作类路由的响应体是固定白名单字段：多一个字段就多一处令牌泄漏面', async () => {
  const { ctx, routes } = makeCtx()
  // 故意让假 deps 返回带令牌的「脏」结果：路由层必须只取白名单字段，不得 spread。
  const { deps } = makeDeps({
    testConnection: async () => ({ status: 200, sseChunks: true, model: 'hy3', accessToken: SECRET_A }),
    refreshNow: async () => ({ refreshed: true, throttled: false, expiresAt: 42, accessToken: SECRET_A, record: { accessToken: SECRET_A } }),
    reloadSeam: async () => ({ refreshed: false, throttled: false, expiresAt: 42, token: SECRET_A }),
  })
  registerRoutes(ctx, deps)

  const testRes = await call(routes, CONNECTION_TEST, { method: 'POST' })
  assert.deepEqual(Object.keys(testRes.jsonBody()).sort(), ['model', 'ok', 'sseChunks', 'status'])
  assertNoSecret(testRes.state.raw, 'POST /connection/test（脏 deps）')

  for (const path of [CREDENTIAL_REFRESH, CREDENTIAL_RELOAD]) {
    const res = await call(routes, path, { method: 'POST' })
    assert.deepEqual(Object.keys(res.jsonBody()).sort(), ['expiresAt', 'ok', 'refreshed', 'throttled'])
    assertNoSecret(res.state.raw, `${path}（脏 deps）`)
  }
})

test('webServer 缺失（非 web 组合）时降级：不抛错、返回 no-op disposer、留一行日志', () => {
  const infos = []
  const ctx = { logger: { info: (m) => infos.push(String(m)), warn: (m) => infos.push(String(m)) } }
  const { deps } = makeDeps()

  const dispose = registerRoutes(ctx, deps)

  assert.equal(typeof dispose, 'function', '必须返回 disposer，调用方才不需要分支')
  assert.doesNotThrow(() => dispose())
  assert.equal(infos.length, 1, '降级必须可观测')
  assert.match(infos[0], /webServer/)
  assertNoSecret(infos.join(' '), '降级日志')
})

test('真 Cordis 形态：服务经 ctx.get("webServer") 读取（未声明 inject 也不抛错）', async () => {
  const { ctx, routes } = makeCtx({ expose: 'get' })
  const { deps, calls } = makeDeps()
  registerRoutes(ctx, deps)

  assert.equal(routes.length, 4)
  const res = await call(routes, CREDENTIAL_REFRESH, { method: 'POST' })
  assert.equal(res.state.status, 200)
  assert.equal(calls.refreshNow, 1)
})

test('isCrossOrigin：缺 Origin 放行；Origin 存在时 host 缺失、不同或非法一律视为跨源', () => {
  assert.equal(isCrossOrigin({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }), false)
  assert.equal(isCrossOrigin({ host: '127.0.0.1:3080' }), false)
  assert.equal(isCrossOrigin({}), false)
  assert.equal(isCrossOrigin({ origin: 'http://evil.example', host: '127.0.0.1:3080' }), true)
  assert.equal(isCrossOrigin({ origin: 'http://127.0.0.1:3080' }), true)
  assert.equal(isCrossOrigin({ origin: 'not-a-url', host: '127.0.0.1:3080' }), true)
})

test('isTrustedLoopbackHost：只接受 127.0.0.1 / localhost / [::1]，端口任意', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:3080', 'localhost', 'localhost:65535', '[::1]', '[::1]:3080']) {
    assert.equal(isTrustedLoopbackHost(host), true, `${host} 应是可信 loopback Host`)
  }
  for (const host of [undefined, '', 'evil.test:3080', '127.0.0.2:3080', 'localhost.evil.test:3080', '::1:3080']) {
    assert.equal(isTrustedLoopbackHost(host), false, `${String(host)} 不得被当成可信 loopback Host`)
  }
})

// —— apply 接线：路由必须经声明式依赖 + ctx.effect 注册、随卸载回收 ——
//
// 关键机制（评审 Important #2）：`apply` 里**不能**一次性 `ctx.get('webServer')` 判空。
// bundle patch 与用户 patch 被拍平为同一批，由 EntryTree.update 用 Promise.allSettled 并发创建；
// webServer 的服务实例在构造函数里 provide，但其 fiber 要等 `await listen()` 才 ACTIVE，
// 而 ctx.get 默认 strict → 返回 undefined → 降级分支吃掉 4 条路由，客户端半区全 404 且无报错。
// 因此实现改成 `ctx.inject(['webServer'], cb)`：服务 ACTIVE 时 Cordis 才拉起 cb。

/**
 * apply 用例的假 ctx。`inject` 被实现成**延迟投递**语义：
 *   * `pending` 模式下，`ctx.inject(deps, cb)` 只登记回调，测试稍后显式 `deliverWebServer()`
 *     （模拟「提供方晚于 apply 才 ACTIVE」）——这正是真实 Cordis 的竞态形状；
 *   * `ready` 模式下立即投递（模拟提供方先就绪）。
 * 两种模式都断言「路由最终被注册」，从而不再依赖「同步恒返回」这个测不出竞态的假实现。
 */
function makeApplyCtx({ withWebServer = true, defer = false } = {}) {
  const disposers = []
  const infos = []
  const warnings = []
  const webServer = makeWebServer()
  const pendingCallbacks = []
  const ctx = {
    credentials: { set: async () => {} },
    logger: {
      info: (m) => infos.push(String(m)),
      warn: (m) => warnings.push(String(m)),
    },
    effect: (fn) => { disposers.push(fn()) },
    // 真 Cordis 里 `ctx.get('webServer')` 读的是当前作用域的服务；registerRoutes 据此取名。
    // 假 ctx 保持同一形状，这样「依赖晚到」用例与真实现的读取路径一致。
    get: (name) => (withWebServer && name === 'webServer' ? webServer : undefined),
    // 声明式依赖：真实 Cordis 返回 fiber，这里只需要「回调在依赖就绪时被调用一次」。
    inject: (deps, cb) => {
      assert.deepEqual(deps, ['webServer'], 'apply 必须按名声明对 webServer 的依赖')
      if (defer) pendingCallbacks.push(cb)
      else if (withWebServer) cb(ctx)
      return { deps, cb }
    },
  }
  return {
    ctx,
    disposers,
    infos,
    warnings,
    webServer,
    routes: webServer.routes,
    pendingCallbacks,
    /** 模拟 webServer 的 fiber 转为 ACTIVE：投递所有已登记的回调。 */
    deliverWebServer() {
      for (const cb of pendingCallbacks.splice(0)) cb(ctx)
    },
  }
}

test('apply：webServer 提供方晚于 apply 就绪时，路由最终仍被注册（Important #2 竞态）', async () => {
  const { apply } = await import('../lib/index.mjs')
  const realFetch = globalThis.fetch
  const fake = async () => ({ ok: true, status: 200, text: async () => '{}' })
  // defer: true —— apply 执行时 webServer 的 fiber 还没 ACTIVE（真实 Cordis 的并发创建形状）。
  const { ctx, disposers, routes, pendingCallbacks, deliverWebServer } = makeApplyCtx({ withWebServer: true, defer: true })

  globalThis.fetch = fake
  try {
    apply(ctx, { credentialFile: join(tmpdir(), `wb-auth-late-${process.pid}-missing`, 'Tencent-Cloud.coding-copilot.info'), tickMs: 60_000 })

    assert.deepEqual(routes, [], '依赖未就绪时不得注册任何路由（这正是旧实现的失败点）')
    assert.equal(pendingCallbacks.length, 1, 'apply 必须把路由注册登记为对 webServer 的声明式依赖')

    deliverWebServer() // webServer 的 fiber 转为 ACTIVE

    assert.deepEqual(routes.map((r) => r.path).sort(), [...ALL_PATHS].sort(), '依赖晚到时路由必须最终被注册')
    assert.ok(disposers.length >= 3, '路由 effect 必须与 UA 修复、凭据同步一样可回收')

    for (const d of disposers) d()
    assert.deepEqual(routes, [], '插件卸载必须摘掉全部路由')
  } finally {
    for (const d of disposers) d?.()
    globalThis.fetch = realFetch
  }
})

test('apply：webServer 就绪时立即注册 4 条路由，卸载时全部回收', async () => {
  const { apply } = await import('../lib/index.mjs')
  const realFetch = globalThis.fetch
  const fake = async () => ({ ok: true, status: 200, text: async () => '{}' })
  const { ctx, disposers, routes } = makeApplyCtx({ withWebServer: true })

  globalThis.fetch = fake
  try {
    apply(ctx, { credentialFile: join(tmpdir(), `wb-auth-routes-${process.pid}-missing`, 'Tencent-Cloud.coding-copilot.info'), tickMs: 60_000 })

    assert.equal(disposers.length, 3, 'UA 修复 + 凭据同步 + 设置路由，三者都必须可回收')
    assert.deepEqual(routes.map((r) => r.path).sort(), [...ALL_PATHS].sort())

    for (const d of disposers) d()
    assert.deepEqual(routes, [], '插件卸载必须摘掉全部路由')
  } finally {
    for (const d of disposers) d?.()
    globalThis.fetch = realFetch
  }
})

test('apply：非 web 组合里 webServer 永不到来时，不注册路由、不抛错，且凭据同步照常', async () => {
  const { apply } = await import('../lib/index.mjs')
  const realFetch = globalThis.fetch
  const fake = async () => ({ ok: true, status: 200, text: async () => '{}' })
  // withWebServer: false + defer: true —— 回调登记了，但依赖永远不会 ACTIVE。
  const { ctx, disposers, routes, pendingCallbacks } = makeApplyCtx({ withWebServer: false, defer: true })

  globalThis.fetch = fake
  try {
    assert.doesNotThrow(() => apply(ctx, { credentialFile: join(tmpdir(), `wb-auth-noweb-${process.pid}-missing`, 'Tencent-Cloud.coding-copilot.info'), tickMs: 60_000 }))

    assert.deepEqual(routes, [], '没有 webServer 就不该注册任何路由')
    assert.equal(disposers.length, 2, '降级路径不得新增 effect：UA 修复 + 凭据同步仍必须照常挂上')
    assert.equal(pendingCallbacks.length, 1, '依赖声明本身仍然登记（Cordis 里表现为 fiber 保持 PENDING，apply 其余部分不受影响）')
  } finally {
    for (const d of disposers) d?.()
    globalThis.fetch = realFetch
  }
})

// —— 真实 Cordis 集成：把 Important #2 的竞态钉在真实 Loader 的语义上 ——
//
// 上面的假 ctx 是注入式的（能表达「依赖晚到」），但它毕竟是我自己写的替身。
// 本组用例改用**真实 @deepseek-ai/cordis**：真 Service、真 fiber 生命周期、真 ctx.inject，
// 并让假 webServer 的 `Service.init` 慢一拍（`await listen()` 的真实形状），
// 从而复现「apply 已 ACTIVE 而 webServer 仍 PENDING」这一竞态。

/** 解析真实的 @deepseek-ai/cordis。本仓库没有 node_modules；用它自己安装位置的解析根。 */
function resolveCordisEntry() {
  const roots = [
    process.env.npm_config_global_prefix,
    join(process.env.APPDATA ?? '', 'npm'),
    join(process.env.LOCALAPPDATA ?? '', 'npm'),
  ].filter((root) => root !== '')
  for (const root of roots) {
    try {
      // 以 dsh 自己的 package.json 为基准解析，得到它依赖的那份 cordis（才是运行时真正用的）。
      const base = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      return createRequire(base).resolve('@deepseek-ai/cordis')
    } catch {
      /* 试下一个根 */
    }
  }
  return undefined
}

const CORDIS_ENTRY = resolveCordisEntry()

test(
  '真实 Cordis 集成：webServer 的 Service.init 慢一拍时，路由仍在它 ACTIVE 后被注册（Important #2）',
  { skip: CORDIS_ENTRY === undefined ? '本机解析不到 @deepseek-ai/cordis，跳过真实 Cordis 集成用例（注入式用例已覆盖同一语义）' : false },
  async () => {
    const { Context, Service } = await import(pathToFileURL(CORDIS_ENTRY).href)
    const { apply, createSyncDeps, createRouteDeps } = await import('../lib/index.mjs')
    const { registerRoutes } = await import('../lib/routes.mjs')

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /** 假 credentials：apply 的硬依赖（真实现是 ctx.credentials.set）。 */
    class FakeCredentials extends Service {
      constructor(ctx) { super(ctx, 'credentials'); this.writes = [] }
      set(ref, value) { this.writes.push([ref, value]) }
    }

    /** 假 webServer：构造函数里就 provide（与服务实例一致），但 init 慢一拍才 ACTIVE。 */
    class SlowWebServer extends Service {
      constructor(ctx) { super(ctx, 'webServer'); this.routes = [] }
      register(route) {
        this.routes.push(route)
        return () => {
          const at = this.routes.indexOf(route)
          if (at !== -1) this.routes.splice(at, 1)
        }
      }
    }
    // 关键：这不是 lib 里的插件，而是真实 Cordis 的 Service —— 服务实例在构造函数里 provide，
    // fiber 要等 init 的 await 结束才 ACTIVE，与 dsh-host-webserver 的 `await listen()` 同型。
    SlowWebServer.prototype[Service.init] = async function () { await delay(30) }

    const root = new Context()
    const creds = root.plugin(FakeCredentials)
    const slowServer = root.plugin(SlowWebServer)

    const realFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' })
    // 用**生产 apply 本身**（lib/index.mjs 的导出），而不是测试里重写的等价物：
    // 这样被验证的就是真实接线，而不是我对它的复述。
    // lib/index.mjs 的 apply 只依赖 ctx.credentials / ctx.logger / ctx.effect / ctx.inject，
    // 真 Cordis 的 ctx 全部提供；唯一天然副作用是它会把 UA 修复装到 globalThis.fetch 上，
    // 由 app.dispose() 复原（finally 里再兜一次）。
    const app = root.plugin(apply, {
      credentialFile: join(tmpdir(), `wb-auth-cordis-${process.pid}-missing`, 'Tencent-Cloud.coding-copilot.info'),
      tickMs: 600_000,
    })

    try {
      await Promise.all([creds, app])
      // 此刻本插件的 fiber 已经是 ACTIVE（credentials 已就绪），而 webServer 仍在 PENDING。
      // 旧实现（apply 里一次性 ctx.get('webServer') 判空）正是在这里永久丢掉 4 条路由。
      assert.equal(app.state, 2, '本插件 fiber 必须已 ACTIVE（2）')
      assert.equal(root.get('webServer'), undefined, 'webServer 未 ACTIVE 时 strict 读取必须为 undefined（竞态的前提）')
      assert.deepEqual(root.get('webServer', false)?.routes ?? [], [], '依赖未 ACTIVE，路由尚未注册')

      await slowServer // 等慢 init 结束 → webServer 的 fiber 转为 ACTIVE

      assert.equal(root.get('webServer') === undefined, false, 'webServer 此时应已 ACTIVE')
      const server = root.get('webServer', false)
      assert.deepEqual(server.routes.map((r) => r.path).sort(), [...ALL_PATHS].sort(), '依赖晚到时 4 条路由必须最终被注册')

      // 卸载必须真回收（真 fiber 的 effect 语义）。
      await app.dispose()
      await delay(10)
      assert.deepEqual(server.routes, [], '插件卸载后路由必须全部摘除')
    } finally {
      for (const fiber of [app, slowServer, creds]) {
        try { await fiber.dispose() } catch { /* 已卸载 */ }
      }
      globalThis.fetch = realFetch
    }
  },
)

test('M6：强制刷新的最小间隔与 tick 路径同一默认来源（config.refreshMarginMs / 2，而不是写死 12h）', async () => {
  const { createRouteDeps, createSyncDeps } = await import('../lib/index.mjs')
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises')

  const T0 = 1_700_000_000_000
  let clock = T0
  const dir = await mkdtemp(join(tmpdir(), 'wb-auth-m6-'))
  const file = join(dir, 'Tencent-Cloud.coding-copilot.info')
  // 自定义 refreshMarginMs = 2h。tick 路径的最小间隔因此是 marginMs / 2 = 1h；
  // 「强制刷新」必须用**同一个** 1h，而不是写死的 REFRESH_MARGIN_MS / 2（12h）。
  const CUSTOM_MARGIN = 2 * 60 * 60 * 1000
  const MIN_INTERVAL = CUSTOM_MARGIN / 2
  await writeFile(file, JSON.stringify({
    account: { uid: 'u1' },
    auth: { accessToken: FAKE_TOKEN, refreshToken: FAKE_REFRESH, expiresAt: T0 + 1000 },
  }), 'utf8')

  const ctx = { credentials: { set: async () => {} } }
  const fetchImpl = makeSpyFetch(async () => ({
    ok: true,
    status: 200,
    // 响应不带 expiresAt：合并后沿用旧值（仍在阈值内），节流因此是唯一边界。
    text: async () => JSON.stringify({ data: { accessToken: `NEXT-${FAKE_TOKEN}`, refreshToken: `NEXT-${FAKE_REFRESH}` } }),
  }))
  const config = { credentialFile: file, refreshMarginMs: CUSTOM_MARGIN }
  const syncDeps = createSyncDeps(ctx, config, fetchImpl)
  syncDeps.now = () => clock
  const deps = createRouteDeps(ctx, config, fetchImpl, syncDeps)

  // 第一次 tick：记录临近过期 → 刷新成功，节流时间戳 = T0。
  const first = await deps.reloadSeam()
  assert.equal(first.refreshed, true, '首次 tick 必须真的刷新')
  assert.equal(fetchImpl.calls.length, 1)

  // 前进 MIN_INTERVAL - 1ms：**两条路径**都应被同一个窗口节流。
  clock = T0 + MIN_INTERVAL - 1

  const tickThrottled = await deps.reloadSeam()
  assert.equal(tickThrottled.throttled, true, 'tick 路径必须按自定义 marginMs / 2 节流')

  const forcedThrottled = await deps.refreshNow()
  assert.equal(forcedThrottled.throttled, true, '强制刷新必须用与 tick 相同的窗口，而不是写死的 REFRESH_MARGIN_MS / 2（12h）')
  assert.equal(fetchImpl.calls.length, 1, '被节流的两条路径都不得新增网络调用')

  // 越过自定义窗口后恢复刷新：证明窗口确实随 config.refreshMarginMs 缩放。
  clock = T0 + MIN_INTERVAL + 1
  const forced = await deps.refreshNow()
  assert.equal(forced.refreshed, true, '越过自定义最小间隔后强制刷新必须恢复')
  assert.equal(fetchImpl.calls.length, 2)

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.auth.accessToken, `NEXT-${FAKE_TOKEN}`, '刷新结果必须写回原凭据文件')
})

//
// 这里钉的是「本插件的生产实现自己有没有把令牌交出去」：路由层的白名单过滤是第二道防线，
// 但 seam 本身若不交令牌，第一道就已经守住了。

/** 一份含合成令牌的凭据记录。 */

/** 在临时目录里落一份凭据文件（绝不触碰真实凭据文件与 $DSH_HOME）。 */
async function writeTempCredential({ expiresAt = Date.now() + 90 * 864e5 } = {}) {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'wb-auth-routes-'))
  const file = join(dir, 'Tencent-Cloud.coding-copilot.info')
  await writeFile(file, JSON.stringify({
    account: { uid: '00000000-1111-4222-8333-444444444444', nickname: '测试用户', phoneNumber: '13800001234' },
    auth: { accessToken: FAKE_TOKEN, refreshToken: FAKE_REFRESH, expiresAt, refreshExpiresAt: expiresAt + 30 * 864e5, lastRefreshTime: 1 },
  }), 'utf8')
  return file
}

/** 计数型假 fetch：记录调用，绝不发真实请求。 */
function makeSpyFetch(respond) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  impl.calls = calls
  return impl
}

test('createRouteDeps：GET /status 只走固定余额 endpoint，并输出安全 credits DTO', async () => {
  const { createRouteDeps } = await import('../lib/index.mjs')
  const file = await writeTempCredential()
  const fetchImpl = makeSpyFetch(async (url) => {
    assert.equal(url, 'https://copilot.tencent.com/billing/meter/get-user-resource-summary')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          Packages: [{
            PackageCode: 'SECRET-PACKAGE',
            ResourceId: 'SECRET-RESOURCE',
            CycleTotalCapacity: '20',
            CycleRemainCapacity: '12.5',
            CycleUsedCapacity: '7.25',
          }],
        },
      }),
    }
  })
  const deps = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, fetchImpl)

  const statusRaw = await deps.readCredentialRaw()
  const status = await import('../lib/status.mjs').then(({ buildStatus }) => buildStatus({ rawText: statusRaw, now: 1 }))

  assert.equal(fetchImpl.calls.length, 1)
  assert.deepEqual(status.credits, { ok: true, remaining: 12.5, total: 20, used: 7.25, fetchedAt: status.credits.fetchedAt, stale: false })
  const text = JSON.stringify(status)
  for (const forbidden of ['SECRET-PACKAGE', 'SECRET-RESOURCE', FAKE_TOKEN, FAKE_REFRESH, '00000000-1111-4222-8333-444444444444']) {
    assert.equal(text.includes(forbidden), false)
  }
})

test('createRouteDeps：测试连接只回结构性事实，绝不回响应体或令牌（注入假 fetch）', async () => {
  const { createRouteDeps } = await import('../lib/index.mjs')
  const file = await writeTempCredential()
  const streamBody = 'data: {"choices":[{"delta":{"content":"ok"}}],"chat.completion.chunk":true}\n\n'
  const fetchImpl = makeSpyFetch(async () => ({ ok: true, status: 200, text: async () => streamBody }))
  const deps = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, fetchImpl)

  const result = await deps.testConnection()

  assert.equal(fetchImpl.calls.length, 1, '一次极小请求，不循环、不压测')
  assert.equal(fetchImpl.calls[0].url, 'https://copilot.tencent.com/v2/chat/completions')
  const sent = fetchImpl.calls[0].init
  assert.equal(sent.headers.Authorization, `Bearer ${FAKE_TOKEN}`, '出站请求必须带上凭据（这是它存在的意义）')
  assert.equal(sent.headers['User-Agent'], 'dsh-workbuddy/0.1', '必须带已验证为 200 的 UA，绕开网关按 UA 的拦截')
  assert.equal(sent.headers['X-User-Id'], '00000000-1111-4222-8333-444444444444')
  assert.equal(JSON.parse(sent.body).max_tokens, 16)

  assert.deepEqual(Object.keys(result).sort(), ['model', 'sseChunks', 'status'])
  assert.equal(result.status, 200)
  assert.equal(result.sseChunks, true)
  assertNoSecret(JSON.stringify(result), 'testConnection 的返回值')
})

test('createRouteDeps：非可用流 / 网络失败都只回结构性事实（含错误码）', async () => {
  const { createRouteDeps } = await import('../lib/index.mjs')
  const file = await writeTempCredential()

  const plain = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, makeSpyFetch(async () => ({ ok: true, status: 200, text: async () => '{"error":"nope"}' })))
  assert.deepEqual(await plain.testConnection(), { status: 200, sseChunks: false, model: 'hy3' })

  const breaking = makeSpyFetch(async () => {
    const cause = new Error(`connect ECONNREFUSED (raw body would go here: ${FAKE_TOKEN})`)
    cause.code = 'ECONNREFUSED'
    throw cause
  })
  const offline = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, breaking)
  await assert.rejects(() => offline.testConnection(), (error) => {
    assert.equal(error.message, 'network request failed', '不得把底层 error.message（可能夹带上游内容）透出去')
    assert.equal(error.code, 'ECONNREFUSED', '错误码要保留，界面才显示得出原因')
    assertNoSecret(error.message, '网络失败的错误消息')
    return true
  })
})

test('createRouteDeps：强制刷新走完整受保护管线，返回值不含令牌且确实写回文件', async () => {
  const { createRouteDeps } = await import('../lib/index.mjs')
  const { readFile } = await import('node:fs/promises')
  // 到期时间很远：needsRefresh 本会返回 false，「强制」刷新必须仍然刷新。
  const file = await writeTempCredential({ expiresAt: Date.now() + 300 * 864e5 })
  const fetchImpl = makeSpyFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: { accessToken: `NEXT-${FAKE_TOKEN}`, refreshToken: `NEXT-${FAKE_REFRESH}`, expiresIn: 3600 } }),
  }))
  const deps = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, fetchImpl)

  const result = await deps.refreshNow()

  assert.equal(fetchImpl.calls.length, 1)
  assert.match(fetchImpl.calls[0].url, /token\/refresh/)
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'refreshed', 'throttled'])
  assert.equal(result.refreshed, true, '「刷新凭证」必须真的刷新，而不是因未临近过期而空转')
  assert.equal(result.throttled, false)
  assertNoSecret(JSON.stringify(result), 'refreshNow 的返回值')

  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.auth.accessToken, `NEXT-${FAKE_TOKEN}`, '刷新结果必须原子写回原凭据文件')
  assert.equal(onDisk.account.nickname, '测试用户', '写回不得丢掉未涉及的字段')
})

test('createRouteDeps：刷新与 tick 共用同一份在飞标记，慢刷新期间不得叠第二次请求', async () => {
  const { createRouteDeps, createSyncDeps } = await import('../lib/index.mjs')
  const file = await writeTempCredential()
  const fetchImpl = makeSpyFetch(async () => {
    throw new Error('refresh must not be reached while a sync is in flight')
  })
  const syncDeps = createSyncDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, fetchImpl)
  const deps = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, fetchImpl, syncDeps)

  // 模拟「已有同步在飞」：守卫对象与 tick 是同一份。
  syncDeps.guard.inFlight = Promise.resolve()

  await assert.rejects(() => deps.refreshNow(), (error) => {
    assert.equal(error.code, 'SYNC_IN_FLIGHT')
    assertNoSecret(error.message, '在飞拒绝的错误消息')
    return true
  })
  assert.equal(fetchImpl.calls.length, 0, '在飞期间必须零新增网络调用（每次刷新都是一次不可逆轮换）')
})

test('createRouteDeps：重新读取会同步到凭据 seam，返回值不含令牌', async () => {
  const { createRouteDeps, createSyncDeps } = await import('../lib/index.mjs')
  const file = await writeTempCredential()
  const sets = []
  const ctx = { credentials: { set: async (ref, value) => sets.push([ref, value]) } }
  const fetchImpl = makeSpyFetch(async () => { throw new Error('不应刷新：记录远未到期') })
  const deps = createRouteDeps(ctx, { credentialFile: file }, fetchImpl, createSyncDeps(ctx, { credentialFile: file }, fetchImpl))

  const result = await deps.reloadSeam()

  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'refreshed', 'throttled'])
  assert.equal(result.refreshed, false)
  assert.equal(fetchImpl.calls.length, 0)
  assert.deepEqual(sets, [['WORKBUDDY_ACCESS_TOKEN', FAKE_TOKEN]], '重新读取必须把当前令牌写进 seam')
  assertNoSecret(JSON.stringify(result), 'reloadSeam 的返回值')
})

test('isUserAgentFixInstalled 如实反映当下状态，而不是无条件声称已生效', async () => {
  const { isUserAgentFixInstalled } = await import('../lib/index.mjs')
  const { installUserAgentFix } = await import('../lib/user-agent.mjs')
  const realFetch = globalThis.fetch
  const fake = async () => ({ ok: true, status: 200, text: async () => '' })

  globalThis.fetch = fake
  try {
    assert.equal(isUserAgentFixInstalled(), false)
    const dispose = installUserAgentFix({ fetchImpl: fake })
    assert.equal(isUserAgentFixInstalled(), true)
    dispose()
    assert.equal(isUserAgentFixInstalled(), false, '复原后必须如实回到 false')
  } finally {
    globalThis.fetch = realFetch
  }
})
