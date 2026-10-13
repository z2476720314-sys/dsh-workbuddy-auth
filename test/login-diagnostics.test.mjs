// 登录状态准确性与脱敏诊断的回归测试（2026-10-13）。
//
// 覆盖两条真实误报路径：
//   A. 轮询期间一次瞬时失败（网络抖动 / 408 / 429 / 5xx）就判死整条登录 —— 用户还在浏览器里
//      输验证码，插件已经报错；上游抖一下并不等于这次授权作废。
//   B. 失败与超时只给一个笼统错误码，看不出是哪个阶段、哪个 HTTP 状态、什么时候发生的
//      —— 「可复验」要求 DTO 带上阶段/时间/HTTP 状态/稳定错误码，且绝不带 state、URL query、
//      令牌、验证码、手机号原文。
//
// 零真实网络、零真实磁盘：假 fetch + 内存 store + 可手动推进的时钟。
// 所有令牌/手机号/state 均为运行时合成的假串。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagedAccountStore } from '../lib/managed-store.mjs'

const loginModule = await import('../lib/web-login.mjs')
const { CN_BACKEND, LOGIN_ERRORS, LOGIN_POLL_INTERVAL_MS, createWebLoginService } = loginModule
// 上限由实现导出；缺失时按 5 兜底（此文件在实现前必须 RED）。
const MAX_TRANSIENT = loginModule.LOGIN_MAX_TRANSIENT_FAILURES ?? 5

const TOKSYN = 'SYNTHETIC-ACCESS-TOKEN-VALUE-DIAG'
const REFRESH_SYN = 'SYNTHETIC-REFRESH-TOKEN-VALUE-DIAG'
const STATE_CANARY = 'CANARY-STATE-VALUE-9f3c'
const QUERY_CANARY = 'CANARY-QUERY-VALUE-7b1'
const PHONE_CANARY = '13912345678'
const START = 1_700_000_000_000

/** 内存 managed store：真实现 + 假 protector / 假原子写。 */
function makeStore() {
  let file = null
  const protector = {
    protect: async (text) => `enc:${Buffer.from(text, 'utf8').toString('base64')}`,
    unprotect: async (ciphertext) => Buffer.from(ciphertext.slice(4), 'base64').toString('utf8'),
  }
  const store = createManagedAccountStore({
    filePath: 'C:/synthetic/diag.dpapi',
    protector,
    readFile: async () => {
      if (file === null) {
        const error = new Error('ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      return file
    },
    writeAtomic: async (_path, text) => {
      file = text
    },
  })
  return { store }
}

/** 可手动推进的时钟：定时器只入队，测试用 step() 精确驱动轮询。 */
function makeClock(start = START) {
  let value = start
  let queue = []
  const waits = []
  return {
    now: () => value,
    waits,
    get pendingTimers() {
      return queue.length
    },
    setTimer(fn, ms) {
      const entry = { fn, ms }
      waits.push(ms)
      queue.push(entry)
      return entry
    },
    clearTimer(handle) {
      queue = queue.filter((entry) => entry !== handle)
    },
    advance(ms) {
      value += ms
    },
    async step() {
      const next = queue.shift()
      if (next === undefined) {
        await drain()
        return false
      }
      value += next.ms
      next.fn()
      await drain()
      return true
    },
  }
}

async function drain(turns = 4) {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** 假 fetch：按队列依次作答（最后一答复放），并记录每次请求。 */
function makeFetch(responses) {
  const calls = []
  const queue = [...responses]
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (typeof next === 'function') return next(url, init)
    const status = next?.status ?? 200
    const body = next?.raw ?? JSON.stringify(next?.json ?? {})
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return body
      },
    }
  }
  return { fetchImpl, calls }
}

const STATE_CANARY_OK = {
  json: { code: 0, data: { state: STATE_CANARY, authUrl: `https://copilot.tencent.com/auth?x=${QUERY_CANARY}` } },
}
const STATE_PLAIN_OK = { json: { code: 0, data: { state: 'state-diag', authUrl: 'https://copilot.tencent.com/auth?x=1' } } }
const PENDING = { json: { code: 11217, msg: 'pending' } }
const TOKEN_OK = {
  json: {
    code: 0,
    data: {
      auth: { accessToken: TOKSYN, refreshToken: REFRESH_SYN, expiresIn: 3600, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-diag', uin: '10009', phoneNumber: PHONE_CANARY },
    },
  },
}
const ACCOUNT_OK = { json: { code: 0, data: { uid: 'uid-diag', nickname: '诊断账号', uin: '10009' } } }
const GATEWAY_DOWN = { status: 503, raw: '<html>gateway down</html>' }
const UNAUTHORIZED = { status: 401, raw: '{"code":12153,"msg":"invalid token"}' }
const UPSTREAM_500 = { json: { code: 500, msg: 'internal error' } }
const NETWORK_THROW = () => {
  throw new Error('socket hang up')
}

/** 反复推进定时器，直到流程不再是 pending（或达到上限）。 */
async function settle(service, clock, limit = 400) {
  for (let index = 0; index < limit; index += 1) {
    if (service.status().status !== 'pending') return service.status()
    await clock.step()
  }
  return service.status()
}

function makeService(store, fetchImpl, clock) {
  return createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
}

/**
 * 断言诊断面不含 state、URL query、令牌、手机号原文。
 *
 * authUrl 是唯一允许带 query 的字段（它本来就要交给用户浏览器），因此比较时排除；
 * 但它的 query 绝不允许被复制进 detail / trace。
 */
function assertNoSecrets(dto, label) {
  const { authUrl: _authUrl, ...rest } = dto
  const text = JSON.stringify(rest)
  assert.equal(text.includes(STATE_CANARY), false, `${label} 不得含 state`)
  assert.equal(text.includes(QUERY_CANARY), false, `${label} 不得含授权 URL 的 query`)
  assert.equal(text.includes(TOKSYN), false, `${label} 不得含访问令牌`)
  assert.equal(text.includes(REFRESH_SYN), false, `${label} 不得含刷新令牌`)
  assert.equal(text.includes(PHONE_CANARY), false, `${label} 不得含手机号原文`)
}

test('瞬时网络失败：轮询保持 pending 并最终完成（一次抖动不得判死登录）', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_PLAIN_OK, NETWORK_THROW, PENDING, TOKEN_OK, ACCOUNT_OK])
  const service = makeService(store, fetchImpl, clock)

  const started = await service.start('cn')
  assert.equal(started.status, 'pending')

  const done = await settle(service, clock)
  assert.equal(done.status, 'complete', `一次瞬时网络失败后必须仍能完成登录，实际：${JSON.stringify(done)}`)
  assert.equal(done.account?.phoneMasked, '139****5678')
  assertNoSecrets(done, '完成 DTO')
  assert.ok(calls.length >= 4, '瞬时失败后必须继续轮询（不是立刻收摊）')
})

test('连续瞬时失败达到上限才终态失败，且带阶段/时间/HTTP 状态', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_PLAIN_OK, GATEWAY_DOWN])
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  const failed = await settle(service, clock)

  assert.equal(failed.status, 'error')
  assert.equal(failed.error, LOGIN_ERRORS.poll)
  assert.equal(failed.detail?.step, 'token', '失败必须能定位到阶段')
  assert.equal(failed.detail?.httpStatus, 503, '失败必须能定位到 HTTP 状态')
  assert.equal(typeof failed.detail?.reason, 'string')
  assert.ok(Array.isArray(failed.trace), '失败必须带诊断轨迹')
  const tokenEvents = failed.trace.filter((event) => event.step === 'token')
  assert.equal(tokenEvents.length, MAX_TRANSIENT, `轨迹应逐次记下重试（上限 ${MAX_TRANSIENT}）`)
  assert.equal(failed.trace[0].step, 'state')
  for (const event of failed.trace) {
    assert.equal(Number.isSafeInteger(event.at), true, '轨迹事件必须带时间戳')
    assert.equal(typeof event.step, 'string')
  }
  // 1 次发起 + 上限次轮询（最后一次即终态）
  assert.equal(calls.length, 1 + MAX_TRANSIENT)
  assertNoSecrets(failed, '失败 DTO')
})

test('上游 4xx 立即终态失败：不做瞬时重试', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_PLAIN_OK, UNAUTHORIZED])
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  const failed = await settle(service, clock)

  assert.equal(failed.status, 'error')
  assert.equal(failed.error, LOGIN_ERRORS.poll)
  assert.equal(failed.detail?.httpStatus, 401)
  assert.equal(failed.detail?.step, 'token')
  assert.equal(calls.length, 2, '鉴权类 4xx 是确定性的，重试没有意义')
})

test('上游业务错误码立即终态失败：不做瞬时重试', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_PLAIN_OK, UPSTREAM_500])
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  const failed = await settle(service, clock)

  assert.equal(failed.status, 'error')
  assert.equal(failed.error, LOGIN_ERRORS.poll)
  assert.equal(failed.reason, 'upstream')
  // 复审 2026-10-13：业务码只展示有代码/文档证据的协议码（0/401/11128/11217/12403）。
  // 500 只是 HTTP 状态，不是有证据的业务码——字段丢弃，判定仍然照 raw code 走。
  assert.equal(Object.keys(failed.detail).includes('code'), false, '无证据的业务码不得进 DTO')
  assert.ok(failed.progress.includes('未知'), `文案用占位词：${failed.progress}`)
  assert.equal(calls.length, 2, '上游业务错误码是确定性的，重试没有意义')
})

test('上游业务错误码在有代码证据的集合内时照常展示（12403：CN /v3/config 拒绝 IDE UA）', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([{ json: { code: 12403, msg: 'invalid user agent' } }])
  const service = makeService(store, fetchImpl, clock)

  await assert.rejects(() => service.start('cn'), (error) => error.code === LOGIN_ERRORS.init)

  const failed = service.status()
  assert.equal(failed.status, 'error')
  assert.equal(failed.detail?.code, 12403)
  assert.equal(failed.progress, '上游返回业务错误码 12403，未能取得授权链接。')
  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(failed).includes('invalid user agent'), false, '上游文案不得回显')
})

test('超时：终态为超时错误码，并留下最后一次上游交互的阶段与时间', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_PLAIN_OK, PENDING])
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  clock.advance(300_000)
  const failed = await settle(service, clock)

  assert.equal(failed.status, 'error')
  assert.equal(failed.error, LOGIN_ERRORS.timeout)
  assert.equal(failed.detail?.step, 'token')
  assert.equal(failed.detail?.reason, 'timeout')
  assert.ok(Array.isArray(failed.trace) && failed.trace.length >= 1, '超时也要留下轨迹（哪一步、什么时候）')
  assert.equal(Number.isSafeInteger(failed.trace.at(-1).at), true)
  assert.equal(calls.length, 2)
  assertNoSecrets(failed, '超时 DTO')
})

test('脱敏：state / URL query / 令牌 / 手机号原文都不得进入 DTO 与轨迹', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl } = makeFetch([STATE_CANARY_OK, PENDING, TOKEN_OK, ACCOUNT_OK])
  const service = makeService(store, fetchImpl, clock)

  const pending = await service.start('cn')
  // 授权 URL 本身要交给用户浏览器，允许出现；但它的 query 不得被复制进诊断轨迹。
  assert.equal(pending.authUrl.includes(QUERY_CANARY), true)

  const done = await settle(service, clock)
  assert.equal(done.status, 'complete')
  assert.equal(done.account?.phoneMasked, '139****5678', '手机号只以掩码形式出现')
  assertNoSecrets(done, '完成 DTO')
})

test('完成即终态：complete 后不再发请求，也不被后续失败改写', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_PLAIN_OK, TOKEN_OK, ACCOUNT_OK])
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  const done = await settle(service, clock)
  assert.equal(done.status, 'complete')

  const settledCalls = calls.length
  for (let index = 0; index < 5; index += 1) await clock.step()
  assert.equal(service.status().status, 'complete', '完成之后不得再被降级为 error')
  assert.equal(service.status().error, undefined)
  assert.equal(calls.length, settledCalls, '完成之后不得再发轮询请求')
})

test('等待中的 pending DTO 也带轨迹（可复验），且不泄露 state', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_CANARY_OK, PENDING])
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  await clock.step()
  const pending = service.status()

  assert.equal(pending.status, 'pending')
  assert.match(pending.progress, /等待浏览器授权…（\d+ 秒）/)
  assert.ok(Array.isArray(pending.trace) && pending.trace.length >= 1, 'pending 也应有可复验的轨迹')
  assertNoSecrets(pending, 'pending DTO')
  assert.deepEqual(clock.waits.slice(0, 2), [LOGIN_POLL_INTERVAL_MS, LOGIN_POLL_INTERVAL_MS])

  const poll = calls.at(-1)
  assert.equal(poll.url, `${CN_BACKEND}/v2/plugin/auth/token?platform=cli&state=${STATE_CANARY}`, '轮询仍按原协议打上游')
  assert.equal(JSON.stringify(pending.trace).includes(STATE_CANARY), false, '轨迹不得复制 state')
})

// ---------------------------------------------------------------------------
// 路由最后一跳：lib/routes.mjs 的 /accounts/login/status 投影。
// 诊断在服务层攒好、在路由层被静默丢掉，是这个仓库真实发生过的失败模式
// （「实现里加了 reason/detail/trace，浏览器却只看到 error」）。这里钉死：
// 白名单键（含 at 时间）必须穿过，非白名单键、畸形形状、超长值一律不得穿过。
// ---------------------------------------------------------------------------
function makeRouteHarness(routeDeps) {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  return { routes, ctx: { logger: { info() {}, warn() {} }, webServer }, deps: routeDeps }
}

async function callRoute(routes, path) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route !== undefined, `路由 ${path} 必须已注册`)
  const state = { status: 0, raw: '' }
  const res = {
    writeHead(status) {
      state.status = status
    },
    end(body) {
      state.raw = body ?? ''
    },
  }
  await route.handler({ method: 'GET', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }, res)
  return { status: state.status, body: JSON.parse(state.raw) }
}

test('路由投影：detail 与 trace 的 at（时间）穿过最后一跳，脏键/畸形值/超长值一律丢弃', async () => {
  const { registerRoutes, ROUTE_PATHS } = await import('../lib/routes.mjs')
  const event = (over) => ({ step: 'token', reason: 'http', host: 'copilot.tencent.com', httpStatus: 503, at: START, ...over })
  const dirty = {
    status: 'error',
    region: 'cn',
    error: LOGIN_ERRORS.poll,
    detail: {
      step: 'token',
      reason: 'upstream',
      host: 'copilot.tencent.com',
      httpStatus: 401,
      code: 11217,
      at: START,
      token: TOKSYN,
      url: `https://copilot.tencent.com/login?state=${STATE_CANARY}`,
      message: `Bearer ${TOKSYN}`,
    },
    trace: [
      event({}),
      event({ at: -1 }),
      event({ at: 'not-a-number' }),
      event({ step: '../../etc/passwd' }),
      event({ reason: 'leaked-class' }),
      event({ token: TOKSYN, state: STATE_CANARY }),
      event({ error: 'E'.repeat(400) }),
    ],
    accessToken: TOKSYN,
  }
  const { routes, ctx, deps } = makeRouteHarness({ loginStatus: async () => dirty })
  registerRoutes(ctx, deps)

  const { status, body } = await callRoute(routes, ROUTE_PATHS.loginStatus)

  assert.equal(status, 200)
  assert.equal(body.status, 'error')
  assert.equal(body.detail.at, START, 'detail.at 是「什么时候失败」的唯一凭据，不许在最后一跳丢掉')
  assert.equal(body.detail.httpStatus, 401)
  assert.equal(body.detail.code, 11217)
  for (const key of ['token', 'url', 'message']) assert.equal(body.detail[key], undefined, `detail.${key} 必须被丢弃`)

  assert.equal(body.trace[0].at, START)
  assert.equal(body.trace[1].at, undefined, '负时间不是时间戳')
  assert.equal(body.trace[2].at, undefined, '非数字不是时间戳')
  assert.equal(body.trace[3].step, undefined, '路径样 step 必须整段丢弃')
  assert.equal(body.trace[4].reason, undefined, '未知分类必须丢弃')
  assert.equal(body.trace[5].at, START, '非白名单键被丢，但同一条事件的白名单键保留')
  assert.equal(body.trace[6].error, undefined, '超长错误名不过形状闸门')

  const text = JSON.stringify(body)
  assert.equal(text.includes(STATE_CANARY), false, '路由响应不得含 state')
  assert.equal(text.includes(TOKSYN), false, '路由响应不得含令牌')
  assert.equal(text.includes('platform=cli'), false, '路由响应不得含上游 URL 原文')
})

test('路由投影：pending 也带 at，且轨迹被裁剪到与实现一致的上限', async () => {
  const { registerRoutes, ROUTE_PATHS } = await import('../lib/routes.mjs')
  const many = Array.from({ length: 40 }, (_, index) => ({ step: 'token', at: START + index }))
  const { routes, ctx, deps } = makeRouteHarness({
    loginStatus: async () => ({ status: 'pending', region: 'cn', progress: '等待浏览器授权…（1 秒）', trace: many }),
  })
  registerRoutes(ctx, deps)

  const { body } = await callRoute(routes, ROUTE_PATHS.loginStatus)

  assert.equal(body.status, 'pending')
  assert.equal(body.trace.length, 24, '轨迹上限与 services 层 TRACE_LIMIT 一致')
  assert.equal(body.trace.at(-1).at, START + 39, '裁剪必须保留最近的事件（否则诊断只剩开头）')
})

// ---------------------------------------------------------------------------
// 终态码覆盖：每个「用户看得见」的失败都必须说清是哪一步失败、为什么失败，
// 而不是回落成那句笼统的「登录初始化或轮询失败」。这些用例是「笼统提示」缺陷的回归护栏。
// ---------------------------------------------------------------------------

const GENERIC_PROGRESS = '登录初始化或轮询失败。'

test('瞬时失败计数成功后清零：跨越多轮抖动仍能完成（不得累计成假失败）', async () => {
  assert.ok(MAX_TRANSIENT >= 3, '本用例要求上限至少 3，否则分不出「清零」与「累计」')
  // 三轮各 2 次抖动（累计 6 次 > 上限）；只有「成功/等待即清零」才能走完。
  const { fetchImpl } = makeFetch([
    STATE_PLAIN_OK,
    NETWORK_THROW,
    NETWORK_THROW,
    PENDING,
    NETWORK_THROW,
    NETWORK_THROW,
    PENDING,
    NETWORK_THROW,
    NETWORK_THROW,
    PENDING,
    TOKEN_OK,
    ACCOUNT_OK,
  ])
  const { store } = makeStore()
  const clock = makeClock()
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  // 抖动发生在 pending 期间：这时 DTO 就应该能复验（成功态按设计不带诊断字段）。
  for (let index = 0; index < 4; index += 1) await clock.step()
  const midway = service.status()
  assert.equal(midway.status, 'pending')
  assert.ok(Array.isArray(midway.trace) && midway.trace.length >= 2, '每次抖动都必须留痕，否则无法复验')
  assert.ok(
    midway.trace.every((event) => Number.isSafeInteger(event.at)),
    '轨迹每条都要有时间',
  )
  assert.ok(
    midway.trace.some((event) => event.step === 'token' && event.reason === 'network'),
    '抖动要记成 token 阶段的 network 原因',
  )
  assertNoSecrets(midway, '抖动中的 pending DTO')

  const final = await settle(service, clock)

  assert.equal(final.status, 'complete', '抖动分散在多轮时不等于这次授权作废')
  assert.equal('trace' in final, false, '成功态保持 0.3.1 的 DTO 形状：不带诊断字段')
})

test('初始化失败立即终态：DTO 带 step=state / reason=http / httpStatus，文案具体', async () => {
  const { fetchImpl, calls } = makeFetch([{ status: 500, raw: 'boom' }])
  const { store } = makeStore()
  const clock = makeClock()
  const service = makeService(store, fetchImpl, clock)

  await assert.rejects(
    () => service.start('cn'),
    (error) => error.code === LOGIN_ERRORS.init,
    '初始化失败必须以 LOGIN_ERRORS.init 抛出（调用方能区分阶段）',
  )

  const dto = service.status()
  assert.equal(dto.status, 'error')
  assert.equal(dto.error, LOGIN_ERRORS.init)
  assert.equal(dto.detail.step, 'state')
  assert.equal(dto.detail.reason, 'http')
  assert.equal(dto.detail.httpStatus, 500)
  assert.notEqual(dto.progress, GENERIC_PROGRESS, '有 HTTP 状态就不能回落成笼统提示')
  assert.equal(dto.progress.includes('HTTP 500'), true)
  assert.ok(Array.isArray(dto.trace) && dto.trace.length >= 1)
  assert.ok(Number.isSafeInteger(dto.trace.at(-1).at))
  assertNoSecrets(dto, '初始化失败 DTO')

  const frozen = calls.length
  await drain(6)
  assert.equal(calls.length, frozen, '初始化失败后不得再发请求')
})

test('账号库写入失败：code=store、step=store，文案明说原账号被保留', async () => {
  const store = {
    async upsert() {
      throw Object.assign(new Error('disk full'), { name: 'Error' })
    },
  }
  const { fetchImpl } = makeFetch([STATE_PLAIN_OK, TOKEN_OK, ACCOUNT_OK])
  const clock = makeClock()
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  const final = await settle(service, clock)

  assert.equal(final.status, 'error')
  assert.equal(final.error, LOGIN_ERRORS.store)
  assert.equal(final.detail.step, 'store')
  assert.equal(final.detail.reason, 'store')
  assert.notEqual(final.progress, GENERIC_PROGRESS)
  assert.equal(final.progress.includes('保留原账号'), true)
  assertNoSecrets(final, '写入失败 DTO')
})

test('身份冲突：以 MANAGED_ACCOUNT_IDENTITY_CONFLICT 终态，且给出可行动文案', async () => {
  const store = {
    async upsert() {
      throw Object.assign(new Error('conflict'), { code: 'MANAGED_ACCOUNT_IDENTITY_CONFLICT' })
    },
  }
  const { fetchImpl } = makeFetch([STATE_PLAIN_OK, TOKEN_OK, ACCOUNT_OK])
  const clock = makeClock()
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  const final = await settle(service, clock)

  assert.equal(final.status, 'error')
  assert.equal(final.error, 'MANAGED_ACCOUNT_IDENTITY_CONFLICT')
  assert.notEqual(final.progress, GENERIC_PROGRESS)
  assert.equal(final.progress.includes('冲突'), true)
})

test('成功响应缺 access token：code=token、reason=payload、step=credential', async () => {
  const noToken = {
    json: {
      code: 0,
      data: { auth: { refreshToken: REFRESH_SYN, expiresIn: 3600, domain: 'copilot.tencent.com' } },
    },
  }
  const { store } = makeStore()
  const { fetchImpl } = makeFetch([STATE_PLAIN_OK, noToken])
  const clock = makeClock()
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  const final = await settle(service, clock)

  assert.equal(final.status, 'error')
  assert.equal(final.error, LOGIN_ERRORS.token)
  assert.equal(final.detail.step, 'credential')
  assert.equal(final.detail.reason, 'payload')
  assert.equal(final.progress, '登录成功响应缺少 access token。')
  assert.equal((await store.list()).length, 0, '缺少令牌不得入库')
})

test('complete 竞态：被取代的旧流程的迟到响应不得改写状态与账号', async () => {
  const { store } = makeStore()
  const clock = makeClock()
  const calls = []
  let releaseLate = null
  const lateGate = new Promise((resolve) => {
    releaseLate = resolve
  })
  let tokenCall = 0
  const credential = (accessToken, uid) => ({
    code: 0,
    data: {
      auth: { accessToken, refreshToken: REFRESH_SYN, expiresIn: 3600, domain: 'copilot.tencent.com' },
      account: { uid, uin: '10009' },
    },
  })
  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload)
    },
  })
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.includes('/auth/state')) {
      return jsonResponse({ code: 0, data: { state: 'state-race', authUrl: 'https://copilot.tencent.com/auth?x=1' } })
    }
    if (url.includes('/auth/token')) {
      tokenCall += 1
      if (tokenCall === 1) {
        // 旧流程的第一次轮询被「网络挂住」，稍后才返回——这正是 complete 竞态的时间窗口。
        await lateGate
        return jsonResponse(credential(`${TOKSYN}-STALE`, 'uid-bbbb'))
      }
      return jsonResponse(credential(`${TOKSYN}-FRESH`, 'uid-aaaa'))
    }
    return jsonResponse({ code: 0, data: { uid: 'uid-aaaa', nickname: '新流程账号', uin: '10009' } })
  }
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  await clock.step() // 旧流程的轮询挂在 lateGate 上
  assert.equal(service.status().status, 'pending')

  await service.start('cn') // 新流程取代旧流程（旧流程被 abort）
  const final = await settle(service, clock)
  assert.equal(final.status, 'complete')
  assert.equal(final.account.uidTail, 'aaaa')

  const frozenCalls = calls.length
  const frozenAccount = JSON.stringify(final.account)
  releaseLate()
  await drain(8)

  const after = service.status()
  assert.equal(after.status, 'complete', '迟到响应不得把 complete 打回 pending 或 error')
  assert.equal(JSON.stringify(after.account), frozenAccount, '迟到响应不得改写已入库账号')
  assert.equal(calls.length, frozenCalls, '被取代的流程不得再发请求')

  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].uid, 'uid-aaaa', '库里只能是新流程的账号')
  assert.equal(JSON.stringify(accounts[0]).includes('uid-bbbb'), false)
  assertNoSecrets(after, '竞态后的 DTO')
})

// ── 四项独立审查 finding 的回归用例（全部合成输入；零真实凭据、零真实网络） ──────────
//
// 四项 finding 的修复代码先于这些用例落盘（同一批工作），因此这里记录的是
// 「用旧候选逆实验验明用例确实能捕获该缺陷」，而不是先红后绿 —— 逆向证据见
// D:\.dsh\dsh-config-backups\...-freeze\ 下的 repro 日志。

/** 看着「像个域」但绝不是注册域：旧字符集闸门 `[a-z0-9.-]{1,64}` 会整串放行。 */
const RAW_DOMAIN_CANARY = `C:\\private\\secret-token.json?state=${STATE_CANARY}&token=${TOKSYN}`

/** 上游在令牌报文里声明域（真实现读 data.auth.domain）：域由上游控制，所以它是泄漏面。 */
function credentialClaimingDomain(domain) {
  return {
    json: {
      code: 0,
      data: { auth: { accessToken: TOKSYN, refreshToken: REFRESH_SYN, expiresIn: 60, domain } },
    },
  }
}

/** Intl 流程的授权报文：authUrl 必须落在 Intl origin 白名单内。 */
const INTL_STATE_OK = {
  json: { code: 0, data: { state: 'state-intl', authUrl: 'https://www.workbuddy.ai/auth?x=1' } },
}

/** 跑一条「地区不符」流程，返回终态 DTO 与库。 */
async function settleRegionFailure(region, domain, stateOk = STATE_PLAIN_OK) {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl } = makeFetch([stateOk, credentialClaimingDomain(domain)])
  const service = makeService(store, fetchImpl, clock)
  await service.start(region)
  return { done: await settle(service, clock), store }
}

test('P1 回归：带路径/query/state/token 的原始域不得经 progress 回显（闸门只做一半等于没做）', async () => {
  const { done } = await settleRegionFailure('cn', RAW_DOMAIN_CANARY)

  assert.equal(done.status, 'error')
  assert.equal(done.error, LOGIN_ERRORS.poll)
  assert.equal(done.reason, 'region')
  assert.equal(
    done.progress,
    '登录报文里的域 未知域 不在本次地区的白名单内，已按安全策略丢弃凭据（令牌未入库）。',
  )
  assert.equal(Object.keys(done.detail).includes('domain'), false, '未成形的域不得进 detail')
  assert.ok(Array.isArray(done.trace) && done.trace.length >= 1, '轨迹本身仍要保留（可复验）')
  for (const event of done.trace) {
    assert.equal(Object.keys(event).includes('domain'), false, '未成形的域不得进轨迹')
  }
  const text = JSON.stringify(done)
  for (const needle of [STATE_CANARY, TOKSYN, 'secret-token.json', 'Users']) {
    assert.equal(text.includes(needle), false, `诊断面不得出现 ${needle.slice(0, 12)}…`)
  }
  assertNoSecrets(done, 'region 失败 DTO')
})

test('P2 回归：域闸门只认注册域形状——纯手机号/无点标识符进不了 detail/trace/文案，合法域保留', async () => {
  // 反面：这两类值都能整串过旧字符集闸门，却都不是域。
  for (const bogus of [PHONE_CANARY, 'TOKENCANARY']) {
    const { done } = await settleRegionFailure('cn', bogus)
    assert.equal(done.reason, 'region', `${bogus} 应按地区不符终态`)
    assert.equal(Object.keys(done.detail).includes('domain'), false, `${bogus} 不得进 detail.domain`)
    assert.equal(JSON.stringify(done).includes(bogus), false, `${bogus} 不得出现在任何诊断字段`)
    assert.ok(done.progress.includes('未知域'), `文案必须退化为占位词：${done.progress}`)
  }

  // 正面：真的注册域必须原样保留——否则「哪个域被拒」就不可诊断了（codebuddy.cn 那类失败）。
  for (const [region, domain] of [
    ['cn', 'www.codebuddy.ai'],
    ['intl', 'www.codebuddy.cn'],
  ]) {
    const { done, store } = await settleRegionFailure(
      region,
      domain,
      region === 'intl' ? INTL_STATE_OK : STATE_PLAIN_OK,
    )
    assert.equal(done.reason, 'region', `${domain} 在 ${region} 流程里应被拒`)
    assert.equal(done.detail.domain, domain, `${domain} 必须保留在 detail.domain`)
    assert.ok(done.progress.includes(domain), `文案必须点名被拒的域：${done.progress}`)
    assert.deepEqual(await store.list(), [], '地区不符绝不入库')
  }
})

test('P2 回归：被取代的旧流程的迟到事件不得混进新流程的 trace', async () => {
  const { store } = makeStore()
  const clock = makeClock()
  let releaseLate = null
  const lateGate = new Promise((resolve) => {
    releaseLate = resolve
  })
  let tokenCall = 0
  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload)
    },
  })
  const fetchImpl = async (url) => {
    if (url.includes('/auth/state')) {
      return jsonResponse({ code: 0, data: { state: 'state-trace', authUrl: 'https://copilot.tencent.com/auth?x=1' } })
    }
    if (url.includes('/auth/token')) {
      tokenCall += 1
      if (tokenCall === 1) {
        // 旧流程的第一次轮询被「网络挂住」，等新流程起来之后才回 503（503 是瞬时失败，会记轨迹）。
        await lateGate
        return { ok: false, status: 503, async text() { return '<html>gateway down</html>' } }
      }
      return jsonResponse(PENDING.json)
    }
    return jsonResponse({})
  }
  const service = makeService(store, fetchImpl, clock)

  await service.start('cn')
  await clock.step() // 旧流程的轮询此刻挂在 lateGate 上
  assert.equal(service.status().status, 'pending')

  await service.start('cn') // 新流程取代旧流程（旧流程被 abort）
  await clock.step() // 新流程轮询一次：上游回「等待授权」，仍是 pending
  const before = service.status()
  assert.equal(before.status, 'pending')
  assert.ok(Array.isArray(before.trace) && before.trace.length >= 1, '新流程 pending 也要带轨迹')
  const frozen = JSON.stringify(before)

  releaseLate() // 旧流程的迟到 503 在此刻到达
  await drain(8)

  assert.equal(
    JSON.stringify(service.status()),
    frozen,
    '旧流程的迟到事件不得改写或追加新流程的任何诊断字段',
  )
  assert.equal(tokenCall, 2, '被取代的流程不得再发轮询请求')
  assert.equal(
    service.status().trace.some((event) => event.httpStatus !== undefined),
    false,
    '新流程轨迹里不得出现旧流程的 HTTP 状态',
  )
  assertNoSecrets(service.status(), '隔离后的 DTO')
})

test('P2 回归：轮询读体阶段断流（TypeError: terminated）按瞬时网络失败处理，一次抖动不判死登录', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  let tokenCall = 0
  const jsonResponse = (payload) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload)
    },
  })
  const fetchImpl = async (url) => {
    if (url.includes('/auth/state')) {
      return jsonResponse({ code: 0, data: { state: 'state-body', authUrl: 'https://copilot.tencent.com/auth?x=1' } })
    }
    if (url.includes('/auth/token')) {
      tokenCall += 1
      // 读体才断的流：旧实现 catch 成空串，直接当「报文无法解析」终态收摊。
      if (tokenCall === 1) {
        return {
          ok: true,
          status: 200,
          async text() {
            throw new TypeError('terminated')
          },
        }
      }
      if (tokenCall === 2) return jsonResponse(PENDING.json)
      return jsonResponse(TOKEN_OK.json)
    }
    return jsonResponse(ACCOUNT_OK.json)
  }
  const service = makeService(store, fetchImpl, clock)

  const started = await service.start('cn')
  assert.equal(started.status, 'pending')
  const done = await settle(service, clock)

  assert.equal(done.status, 'complete', `读体断流应走瞬时重试，而不是判死：${JSON.stringify(done)}`)
  assert.equal(tokenCall, 3, '断流一次后必须继续轮询到成功')
  assert.equal(done.account?.phoneMasked, '139****5678')
  assertNoSecrets(done, '读体断流后的完成 DTO')
})
