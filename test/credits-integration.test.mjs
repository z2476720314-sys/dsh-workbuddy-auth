// 余额原因码的端到端集成测试：credits.mjs → index.mjs（createRouteDeps）→ status.mjs → routes.mjs → 浏览器可见 DTO。
//
// 为什么单独有一个文件：单元的「分类正确」不等于「分类真的走到了浏览器」。
// 这条链上有四道各自的过滤（credits.mjs 的 CREDIT_ERROR_CODES、status.mjs 的
// CREDIT_ERROR_WHITELIST、routes.mjs 的 /status 投影、client.js 的 CREDIT_ERRORS），
// 任何一道漏字段或值域不一致，用户看到的就还是那句没有信息量的「上游未提供余额」。
// 因此这里全部用真实实现（真 createRouteDeps + 真 buildStatus + 真 registerRoutes），
// 只把 fetch 换成假实现；凭据写在临时目录，零真实网络、零仓库内文件读写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { registerRoutes, ROUTE_PATHS } from '../lib/routes.mjs'
import { withCredits } from '../lib/status.mjs'
import { CREDIT_ERROR_CODES, PERSONAL_CREDIT_URL, fetchCreditBalance } from '../lib/credits.mjs'

const STATUS = ROUTE_PATHS.status
const SAME_ORIGIN = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }

// 全部为运行时合成的假串，不含任何真实凭据。
const TOK = 'SYNTHETIC-ACCESS'.repeat(8)
const REFRESH = 'SYNTHETIC-REFRESH'.repeat(8)
const UID = '00000000-1111-4222-8333-444444444444'
const PHONE = '13800001234'
const PACKAGE_CODE = 'SECRET-PACKAGE-CODE'
const RESOURCE_ID = 'SECRET-RESOURCE-ID'
const CREDIT_KEYS = ['fetchedAt', 'ok', 'remaining', 'stale', 'total', 'used']

/** 假 webServer：收集路由并返回真正会摘除它的 disposer。 */
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
  return { ctx: { logger: { info() {}, warn() {} }, webServer }, routes: webServer.routes }
}

function makeReq({ method = 'GET', headers = SAME_ORIGIN } = {}) {
  return { method, headers }
}

function makeRes() {
  const state = { status: 0, headers: {}, raw: '' }
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

async function call(routes, path) {
  const route = routes.find((r) => r.path === path)
  assert.ok(route !== undefined, `路由 ${path} 必须已注册`)
  const res = makeRes()
  await route.handler(makeReq(), res)
  return res
}

/** 计数型假 fetch：记录调用，绝不发真实请求。 */
function spyFetch(respond) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  impl.calls = calls
  return impl
}

async function writeCredential({ token = TOK } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-credits-chain-'))
  const file = join(dir, 'Tencent-Cloud.coding-copilot.info')
  const auth = { refreshToken: REFRESH, expiresAt: Date.now() + 90 * 864e5, refreshExpiresAt: Date.now() + 120 * 864e5 }
  if (token !== undefined) auth.accessToken = token
  await writeFile(file, JSON.stringify({ account: { uid: UID, nickname: '测试用户', phoneNumber: PHONE }, auth }), 'utf8')
  return file
}

/** 走真实链路拿 status DTO：真 createRouteDeps（读凭据 + 取余额）→ 真 buildStatus。 */
async function statusThroughChain(fetchImpl) {
  const { createRouteDeps } = await import('../lib/index.mjs')
  const file = await writeCredential()
  const deps = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, fetchImpl)
  const rawText = await deps.readCredentialRaw()
  const { buildStatus } = await import('../lib/status.mjs')
  return buildStatus({ rawText, now: 1 })
}

/** 反向断言：任何响应体都不得含令牌、uid 原文、手机号原文或上游内部字段名。 */
function assertNoSecret(text, label) {
  const raw = String(text)
  for (const needle of [TOK, REFRESH, UID, PHONE, PACKAGE_CODE, RESOURCE_ID, 'PackageCode', 'ResourceId', 'accessToken', 'refreshToken']) {
    assert.equal(raw.includes(needle), false, `${label} 不得含 ${needle.slice(0, 12)}…`)
  }
}

test('上游 401 / 403：端到端收敛为 auth-rejected（行动＝重新登录该账号）', async () => {
  for (const status of [401, 403]) {
    const fetchImpl = spyFetch(async () => ({ ok: false, status, text: async () => 'unauthorized' }))
    const result = await statusThroughChain(fetchImpl)
    assert.equal(fetchImpl.calls.length, 1, `HTTP ${status} 只发一次余额请求`)
    assert.equal(fetchImpl.calls[0].url, PERSONAL_CREDIT_URL)
    assert.deepEqual(result.credits, { ok: false, error: 'auth-rejected' }, `HTTP ${status}`)
    assertNoSecret(JSON.stringify(result), `HTTP ${status} 的 status DTO`)
  }
})

test('其余非 2xx（500 / 503 / 418）：收敛为 request-failed（行动＝稍后重试）', async () => {
  for (const status of [500, 503, 418]) {
    const fetchImpl = spyFetch(async () => ({ ok: false, status, text: async () => 'gateway' }))
    const result = await statusThroughChain(fetchImpl)
    assert.deepEqual(result.credits, { ok: false, error: 'request-failed' }, `HTTP ${status}`)
  }
})

test('网络层失败（fetch 抛出 / 超时 abort）：收敛为 request-failed，且不回显错误原文', async () => {
  const fetchImpl = spyFetch(async () => {
    throw new Error(`connect ECONNREFUSED 127.0.0.1 open 'C:\\private\\auth\\token.info'`)
  })
  const result = await statusThroughChain(fetchImpl)
  assert.equal(fetchImpl.calls.length, 1)
  assert.deepEqual(result.credits, { ok: false, error: 'request-failed' })
  assert.equal(JSON.stringify(result).includes('ECONNREFUSED'), false, '错误原文不得进 DTO')
  assert.equal(JSON.stringify(result).includes('private'), false, '本地路径不得进 DTO')
})

test('2xx 但报文本身坏了：JSON 语法错 / data 非对象 / 无 Packages → upstream-invalid', async () => {
  const bodies = [
    // JSON.parse 对坏 JSON 抛的就是 SyntaxError，假实现必须同形，否则分类语义对不上。
    () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0')
    },
    async () => ({ data: null }),
    async () => ({ data: { SubscriptionPackageName: '体验版' } }),
  ]
  for (const json of bodies) {
    const fetchImpl = spyFetch(async () => ({ ok: true, status: 200, json }))
    const result = await statusThroughChain(fetchImpl)
    assert.deepEqual(result.credits, { ok: false, error: 'upstream-invalid' })
  }
})

test('2xx 但读体阶段断流：TypeError: terminated / AbortError 归 request-failed，只有语法错才是 upstream-invalid', async () => {
  // 读体时断流是传输层失败（用户该做的是稍后重试），报文坏掉才是上游的错（重试也不会好）。
  // 两类失败都发生在 response.json() 里，只有异常类型能把它们分开。
  const cases = [
    [new TypeError('terminated'), 'request-failed'],
    [Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), 'request-failed'],
    [new SyntaxError('Unexpected end of JSON input'), 'upstream-invalid'],
  ]
  for (const [error, expected] of cases) {
    const fetchImpl = spyFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw error
      },
    }))
    const result = await statusThroughChain(fetchImpl)
    assert.equal(fetchImpl.calls.length, 1, `${expected}：读体失败不重试，只发一次请求`)
    assert.deepEqual(result.credits, { ok: false, error: expected }, `${error.name} 应分类为 ${expected}`)
    assertNoSecret(JSON.stringify(result), `${expected} 的 status DTO`)
  }
})

test('余额成功：六键精确（不多不少），上游内部字段与凭据原文都不出现', async () => {
  const fetchImpl = spyFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        Packages: [
          { PackageCode: PACKAGE_CODE, ResourceId: RESOURCE_ID, CycleTotalCapacity: '20', CycleRemainCapacity: '12.5', CycleUsedCapacity: '7.25' },
        ],
      },
    }),
  }))
  const result = await statusThroughChain(fetchImpl)
  assert.equal(result.credits.ok, true)
  assert.equal(result.credits.remaining, 12.5)
  assert.equal(result.credits.total, 20)
  assert.equal(result.credits.used, 7.25)
  assert.equal(result.credits.stale, false)
  assert.deepEqual(Object.keys(result.credits).sort(), CREDIT_KEYS)
  assertNoSecret(JSON.stringify(result), '成功态 status DTO')
})

test('枚举往返：四种原因码原样穿过 status → 路由投影，一个都不许丢', async () => {
  const { buildStatus } = await import('../lib/status.mjs')
  const { createRouteDeps } = await import('../lib/index.mjs')
  const file = await writeCredential()
  for (const error of CREDIT_ERROR_CODES) {
    const dirty = spyFetch(async () => ({ ok: false, status: 401 }))
    const deps = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, dirty)
    // 用真实 seam 起头，再把余额信封换成指定的原因码，专测投影这一段。
    deps.readCredentialRaw = async () => withCredits(JSON.stringify({ account: { uid: UID }, auth: { ['access' + 'Token']: TOK } }), { ok: false, error })
    const { ctx, routes } = makeCtx()
    registerRoutes(ctx, { ...deps, readCredentialRaw: deps.readCredentialRaw, buildStatus })
    const body = (await call(routes, STATUS)).jsonBody()
    assert.deepEqual(body.credits, { ok: false, error }, `原因码 ${error} 必须原样到浏览器`)
    assertNoSecret(JSON.stringify(body), `原因码 ${error} 的 /status 响应`)
  }
})

test('脏余额枚举与多余键：未知原因码收敛为 unavailable，非白名单键一律丢弃', async () => {
  const { buildStatus } = await import('../lib/status.mjs')
  const { createRouteDeps } = await import('../lib/index.mjs')
  const file = await writeCredential()
  const dirtyPayload = { ok: false, error: 'upstream-said-no', httpStatus: 401, token: TOK, message: 'Bearer abc被拒' }
  const deps = createRouteDeps({ credentials: { set: async () => {} } }, { credentialFile: file }, spyFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { Packages: [] } }) })))
  deps.readCredentialRaw = async () => withCredits(JSON.stringify({ account: { uid: UID }, auth: { ['access' + 'Token']: TOK } }), dirtyPayload)
  const { ctx, routes } = makeCtx()
  registerRoutes(ctx, { ...deps, readCredentialRaw: deps.readCredentialRaw, buildStatus })

  const body = (await call(routes, STATUS)).jsonBody()
  assert.deepEqual(body.credits, { ok: false, error: 'unavailable' }, '未知枚举不得原样透出')
  assert.deepEqual(Object.keys(body.credits).sort(), ['error', 'ok'])
  assertNoSecret(JSON.stringify(body), '脏余额信封的 /status 响应')
})

test('枚举值域固定为四种：CREDIT_ERROR_CODES 是唯一的真源，加减值必须同步客户端文案', () => {
  assert.deepEqual([...CREDIT_ERROR_CODES].sort(), ['auth-rejected', 'request-failed', 'unavailable', 'upstream-invalid'])
})

test('没有 accessToken：不发请求，直接 unavailable（跨区「猜成 CN」同样不许发）', async () => {
  const fetchImpl = spyFetch(async () => {
    throw new Error('不该发生：无令牌时不得触网')
  })
  assert.deepEqual(await fetchCreditBalance({ record: { uid: UID, accessToken: '' }, fetchImpl }), { ok: false, error: 'unavailable' })
  assert.deepEqual(await fetchCreditBalance({ record: { uid: UID }, fetchImpl }), { ok: false, error: 'unavailable' })
  assert.deepEqual(await fetchCreditBalance({ record: { uid: UID, accessToken: TOK }, region: 'intl', fetchImpl }), { ok: false, error: 'unavailable' })
  assert.equal(fetchImpl.calls.length, 0, '一个请求都不许发')
})
