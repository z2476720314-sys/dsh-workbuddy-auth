import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { createAgentmoreLoginService, AGENTMORE_WEB_ORIGIN, LOGIN_URL, TOKEN_COOKIE, REFRESH_COOKIE, LOGIN_TIMEOUT_MS } from '../lib/agentmore-login.mjs'

/**
 * 登录服务用 `setTimeout` 退避轮询（1.5s → 3s）。真实等待会让每个用例至少 1.5 秒，
 * 所以这里只 mock `setTimeout`，再用 tick 手动推进轮询；`setImmediate` 保持真实，
 * 用来排空异步链。
 */
const STEP_MS = 1_500

function useMockTimers(t) {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
}

/** 推进一轮轮询并把微任务/IO 队列排空。 */
async function step(ms = STEP_MS) {
  mock.timers.tick(ms)
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

async function pumpUntil(predicate, { rounds = 30, ms = STEP_MS } = {}) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await step(ms)
  }
  throw new Error('轮询未在预期轮数内达成条件')
}

function fakeBrowser({ cookies = [], pageDeviceId = '', failOpen = false, failNavigate = false } = {}) {
  const state = { cookieReads: 0, evaluates: [], closed: 0, current: cookies, opened: null, navigated: null }
  return {
    state,
    async allCookies() {
      state.cookieReads += 1
      return state.current
    },
    async evaluate(targetId, expression) {
      state.evaluates.push({ targetId, expression })
      return JSON.stringify(pageDeviceId)
    },
    async openPage(url) {
      if (failOpen) throw new Error('open failed')
      state.opened = url
      return 'target-1'
    },
    async navigate(targetId, url) {
      if (failNavigate) throw new Error('navigate failed')
      state.navigated = { targetId, url }
    },
    async close() {
      state.closed += 1
    },
  }
}

function fakeStore() {
  const upserts = []
  return {
    upserts,
    async upsert(account) {
      upserts.push(account)
      return { id: `acc-${upserts.length}`, ...account }
    },
  }
}

function makeService(overrides = {}) {
  const browser = overrides.browser ?? fakeBrowser()
  const store = overrides.store ?? fakeStore()
  const userInfoCalls = []
  const client = {
    async userInfo(credential) {
      userInfoCalls.push(credential)
      const result = overrides.userInfo?.(credential) ?? { userId: 'u-1', isGuest: false }
      if (result instanceof Error) throw result
      return result
    },
  }
  const logs = []
  const handled = []
  const service = createAgentmoreLoginService({
    store,
    client,
    logger: { debug: (line) => logs.push(line) },
    onAccount: overrides.onAccount ?? (async (account) => handled.push(account.id)),
    launcher: overrides.launcher ?? (async () => browser),
    now: overrides.now ?? (() => Date.now()),
  })
  return { service, browser, store, client, userInfoCalls, logs, handled }
}

const bothCookies = (accessToken = 'tok-1', refreshToken = 'ref-1') => [
  { name: TOKEN_COOKIE, value: accessToken },
  { name: REFRESH_COOKIE, value: refreshToken },
]

/**
 * 断言用的 deviceId 形状：cookie 与 localStorage 都没有时是随机 32 位十六进制
 * （内容不可预知，只能断言形状）。
 */
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/

test('常量：登录页与 cookie 名逐字来自 APK', () => {
  assert.equal(LOGIN_URL, 'https://agentmore.chatglm.cn')
  assert.equal(AGENTMORE_WEB_ORIGIN, 'https://chatglm.cn')
  assert.equal(TOKEN_COOKIE, 'chatglm_token')
  assert.equal(REFRESH_COOKIE, 'chatglm_refresh_token')
  assert.equal(LOGIN_TIMEOUT_MS, 600_000)
})

test('start：打开登录页并立刻返回 running，不等第一轮轮询', async (t) => {
  useMockTimers(t)
  const { service, browser } = makeService({ browser: fakeBrowser({ cookies: [] }) })
  const dto = await service.start()
  assert.equal(dto.status, 'running')
  assert.equal(typeof dto.startedAt, 'number')
  assert.equal(dto.completedAt, null)
  assert.equal(browser.state.opened, LOGIN_URL)
  assert.deepEqual(browser.state.navigated, { targetId: 'target-1', url: LOGIN_URL })
  await service.dispose()
})

test('start：已在飞时返回同一流程，不重复开窗口', async (t) => {
  useMockTimers(t)
  let launches = 0
  const browser = fakeBrowser({ cookies: [] })
  const { service } = makeService({ browser, launcher: async () => { launches += 1; return browser } })
  const first = await service.start()
  const second = await service.start()
  assert.equal(launches, 1)
  assert.deepEqual(second, first)
  await service.dispose()
})

test('start：浏览器缺失 → 明确文案，不抛', async (t) => {
  useMockTimers(t)
  const { service } = makeService({
    launcher: async () => { throw Object.assign(new Error('missing'), { code: 'AGENTMORE_BROWSER_MISSING' }) },
  })
  const dto = await service.start()
  assert.equal(dto.status, 'error')
  assert.equal(dto.error, '未找到可用的 Chromium 浏览器（Chrome / Edge）')
})

test('start：其他启动失败 → 无法启动浏览器', async (t) => {
  useMockTimers(t)
  const { service } = makeService({ launcher: async () => { throw new Error('boom') } })
  const dto = await service.start()
  assert.equal(dto.status, 'error')
  assert.equal(dto.error, '无法启动浏览器')
})

test('start：打开页面失败 → 无法打开登录页面，并关掉浏览器', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ failOpen: true })
  const { service } = makeService({ browser })
  const dto = await service.start()
  assert.equal(dto.status, 'error')
  assert.equal(dto.error, '无法打开登录页面')
  assert.equal(browser.state.closed, 1)
})

test('start：navigate 失败同样报无法打开登录页面', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ failNavigate: true })
  const { service } = makeService({ browser })
  const dto = await service.start()
  assert.equal(dto.error, '无法打开登录页面')
  assert.equal(browser.state.closed, 1)
})

test('成功链路：两枚 cookie 齐了才取身份，落盘后 complete', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [] })
  const { service, store, userInfoCalls, handled } = makeService({
    browser,
    userInfo: () => ({ userId: 'user-abcdef123456', isGuest: false }),
  })
  await service.start()

  // 用户完成登录：下一轮探测就该终结流程
  browser.state.current = [...bothCookies(), { name: 'chatglm-deid', value: 'deid-from-cookie' }]
  await pumpUntil(() => service.status().status === 'complete')

  const dto = service.status()
  assert.equal(dto.error, undefined)
  assert.deepEqual(dto.account, { id: 'acc-1', displayName: '清言 123456', userId: 'user-abcdef123456' })

  const [credential] = userInfoCalls
  assert.deepEqual(credential, { accessToken: 'tok-1', refreshToken: 'ref-1', deviceId: 'deid-from-cookie' })

  const [account] = store.upserts
  assert.equal(account.userId, 'user-abcdef123456')
  assert.equal(account.accessToken, 'tok-1')
  assert.equal(account.refreshToken, 'ref-1')
  assert.equal(account.deviceId, 'deid-from-cookie')
  assert.equal(typeof account.createdAt, 'number')
  assert.equal(typeof account.refreshedAt, 'number')
  assert.deepEqual(handled, ['acc-1'])
  await service.dispose()
})

test('deviceId：cookie 缺 → 读 localStorage', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [], pageDeviceId: 'from-local-storage' })
  const { service, store } = makeService({ browser, userInfo: () => ({ userId: 'u-1', isGuest: false }) })
  await service.start()
  browser.state.current = bothCookies()
  await pumpUntil(() => service.status().status === 'complete')

  assert.equal(store.upserts[0].deviceId, 'from-local-storage')
  assert.equal(browser.state.evaluates.at(-1).expression, "localStorage.getItem('chatglm-deid') || ''")
  assert.equal(browser.state.evaluates.at(-1).targetId, 'target-1')
  await service.dispose()
})

test('deviceId：localStorage 为空或 "null" → 随机 32 位十六进制', async (t) => {
  useMockTimers(t)
  for (const pageDeviceId of ['', 'null']) {
    const browser = fakeBrowser({ cookies: bothCookies(), pageDeviceId })
    const { service, store } = makeService({ browser, userInfo: () => ({ userId: 'u-1', isGuest: false }) })
    await service.start()
    await pumpUntil(() => service.status().status === 'complete')
    assert.match(store.upserts[0].deviceId, /^[0-9a-f]{32}$/, pageDeviceId)
    await service.dispose()
  }
})

test('cookie 名兜底：chatglm_deid / deid 也认', async (t) => {
  useMockTimers(t)
  for (const name of ['chatglm_deid', 'deid']) {
    const browser = fakeBrowser({ cookies: [...bothCookies(), { name, value: `id-${name}` }] })
    const { service, store } = makeService({ browser, userInfo: () => ({ userId: 'u-1', isGuest: false }) })
    await service.start()
    await pumpUntil(() => service.status().status === 'complete')
    assert.equal(store.upserts[0].deviceId, `id-${name}`)
    await service.dispose()
  }
})

test('credentialCandidates：严格按域配对，两域都有 refresh 时绝不跨域兜底', async (t) => {
  useMockTimers(t)
  const { credentialCandidates } = await import('../lib/agentmore-login.mjs')
  const candidates = credentialCandidates([
    { name: TOKEN_COOKIE, value: 'sub-token' },
    { name: TOKEN_COOKIE, value: 'apex-token', domain: 'chatglm.cn' },
    { name: REFRESH_COOKIE, value: 'sub-refresh' },
    { name: REFRESH_COOKIE, value: 'apex-refresh', domain: 'chatglm.cn' },
  ])
  // apex 优先，且每对内部同域。
  assert.deepEqual(candidates, [
    { domain: 'chatglm.cn', ['accessToken']: 'apex-token', refreshToken: 'apex-refresh' },
    { domain: '', ['accessToken']: 'sub-token', refreshToken: 'sub-refresh' },
  ])

  // 只有一个域给了 refresh：允许把那一枚补给同域之外的 token（单域退化）。
  assert.deepEqual(
    credentialCandidates([
      { name: TOKEN_COOKIE, value: 'only-token' },
      { name: REFRESH_COOKIE, value: 'only-refresh' },
    ]),
    [{ domain: '', ['accessToken']: 'only-token', refreshToken: 'only-refresh' }],
  )

  // 有 token 无 refresh：不成候选（上游会 401，验证纯属浪费）。
  assert.deepEqual(credentialCandidates([{ name: TOKEN_COOKIE, value: 'orphan' }]), [])
})

test('游客令牌不终结流程：保持 running、标记 guestPending、不落盘', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: bothCookies() })
  const { service, store } = makeService({ browser, userInfo: () => ({ userId: 'u-1', isGuest: true }) })
  await service.start()
  await pumpUntil(() => service.status().guestPending === true)

  // 真实故障（2026-10-18）：网页在用户点「登录」之前就下发游客令牌，
  // 早期实现据此关窗并报错，用户连登录框都没看清就被踢出来。
  assert.equal(service.status().status, 'running', '游客态是中间态，不是失败')
  assert.equal(service.status().error, undefined)
  assert.deepEqual(store.upserts, [])
  // 窗口必须还开着：用户还需要在里面登录。
  assert.equal(browser.state.closed, 0)
  await service.dispose()
})

test('游客 → 正式登录：同一流程内从 guestPending 转为 complete', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: bothCookies('guest-token', 'guest-refresh') })
  let attempts = 0
  const { service, store, handled } = makeService({
    browser,
    userInfo: (credential) => {
      // 游客令牌始终返回 is_guest；换到真账号令牌后立刻认。
      if (credential.accessToken.startsWith('guest-')) return { userId: 'guest-1', isGuest: true }
      attempts += 1
      return { userId: 'user-abcdef123456', isGuest: false }
    },
  })
  await service.start()
  await pumpUntil(() => service.status().guestPending === true)

  // 用户在窗口里登录完成：apex 域写入正式令牌，子域那枚游客令牌仍然在（真实情形）。
  browser.state.current = [
    ...bothCookies('guest-token', 'guest-refresh'),
    { name: TOKEN_COOKIE, value: 'real-token', domain: 'chatglm.cn' },
    { name: REFRESH_COOKIE, value: 'real-refresh', domain: 'chatglm.cn' },
  ]
  await pumpUntil(() => service.status().status === 'complete')

  assert.equal(attempts, 1)
  assert.equal(service.status().guestPending, false)
  assert.equal(store.upserts[0].accessToken, 'real-token')
  assert.equal(store.upserts[0].refreshToken, 'real-refresh')
  assert.deepEqual(handled, ['acc-1'])
  await service.dispose()
})

test('apex 域令牌优先：绝不把子域游客令牌与 apex 真令牌混配', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({
    cookies: [
      { name: TOKEN_COOKIE, value: 'sub-token' },
      { name: REFRESH_COOKIE, value: 'sub-refresh' },
      { name: TOKEN_COOKIE, value: 'apex-token', domain: 'chatglm.cn' },
      { name: REFRESH_COOKIE, value: 'apex-refresh', domain: 'chatglm.cn' },
    ],
  })
  const { service, userInfoCalls } = makeService({ browser, userInfo: () => ({ userId: 'u-1', isGuest: false }) })
  await service.start()
  await pumpUntil(() => service.status().status === 'complete')

  // 第一枚被验证的就是 apex 那一对：混配（apex access + 子域 refresh）会被上游 401。
  assert.equal(userInfoCalls[0].accessToken, 'apex-token')
  assert.equal(userInfoCalls[0].refreshToken, 'apex-refresh')
  assert.match(userInfoCalls[0].deviceId, DEVICE_ID_PATTERN)
  await service.dispose()
})

test('第一枚候选 401 时继续试下一枚（过期令牌不阻断新登录）', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({
    cookies: [
      { name: TOKEN_COOKIE, value: 'stale-token', domain: 'chatglm.cn' },
      { name: REFRESH_COOKIE, value: 'stale-refresh', domain: 'chatglm.cn' },
      { name: TOKEN_COOKIE, value: 'fresh-token', domain: 'agentmore.chatglm.cn' },
      { name: REFRESH_COOKIE, value: 'fresh-refresh', domain: 'agentmore.chatglm.cn' },
    ],
  })
  const { service, store } = makeService({
    browser,
    userInfo: (credential) => {
      if (credential.accessToken === 'stale-token') return Object.assign(new Error('nope'), { code: 'INVALID_CREDENTIAL' })
      return { userId: 'u-1', isGuest: false }
    },
  })
  await service.start()
  await pumpUntil(() => service.status().status === 'complete')
  assert.equal(store.upserts[0].accessToken, 'fresh-token')
  await service.dispose()
})

test('只有一枚 cookie 时不探测身份（与 APK 一致）', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [{ name: TOKEN_COOKIE, value: 'tok-1' }] })
  const { service, userInfoCalls } = makeService({ browser })
  await service.start()
  await pumpUntil(() => browser.state.cookieReads >= 3)
  assert.deepEqual(userInfoCalls, [])
  await service.dispose()
})

test('refresh 缺失时同样不探测身份', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [{ name: REFRESH_COOKIE, value: 'ref-1' }] })
  const { service, userInfoCalls } = makeService({ browser })
  await service.start()
  await pumpUntil(() => browser.state.cookieReads >= 3)
  assert.deepEqual(userInfoCalls, [])
  await service.dispose()
})

test('INVALID_CREDENTIAL 不终结流程，继续轮询到成功', async (t) => {
  useMockTimers(t)
  let attempt = 0
  const browser = fakeBrowser({ cookies: bothCookies() })
  const { service } = makeService({
    browser,
    userInfo: () => {
      attempt += 1
      if (attempt === 1) return Object.assign(new Error('nope'), { code: 'INVALID_CREDENTIAL' })
      return { userId: 'u-1', isGuest: false }
    },
  })
  await service.start()
  await pumpUntil(() => service.status().status === 'complete')
  assert.equal(attempt, 2)
  await service.dispose()
})

test('探测期单次异常只记日志，不终结流程', async (t) => {
  useMockTimers(t)
  let reads = 0
  const browser = {
    async allCookies() {
      reads += 1
      if (reads === 1) throw new Error('cdp flake')
      return bothCookies()
    },
    async evaluate() { return '""' },
    async openPage() { return 'target-1' },
    async navigate() {},
    async close() {},
  }
  const { service, logs } = makeService({ browser, userInfo: () => ({ userId: 'u-1', isGuest: false }) })
  await service.start()
  await pumpUntil(() => service.status().status === 'complete')
  assert.equal(logs.some((line) => line.includes('login probe failed')), true)
  await service.dispose()
})

test('超时 → 「登录超时，请重试」并关浏览器', async (t) => {
  useMockTimers(t)
  // now 每次调用都推进很久：第一次判断就已越过 deadline。
  let clock = 0
  const browser = fakeBrowser({ cookies: [] })
  const { service } = makeService({ browser, now: () => { clock += 1_000_000; return clock } })
  await service.start()
  await pumpUntil(() => service.status().status === 'error', { rounds: 4 })
  assert.equal(service.status().error, '登录超时，请重试')
  assert.equal(browser.state.closed, 1)
})

test('慢速窗口：超过 30 秒后退避到 3 秒', async (t) => {
  useMockTimers(t)
  let clock = Date.now()
  const browser = fakeBrowser({ cookies: [] })
  const { service } = makeService({ browser, now: () => clock })
  await service.start()

  // 先跑到至少一轮，确认快速窗口在 1.5s 节奏下工作
  await pumpUntil(() => browser.state.cookieReads >= 1)
  clock += 31_000

  // 不假设定时器相位：不论起步时剩余多少，3 秒内只应推进一轮探测
  const before = browser.state.cookieReads
  await step(1_500)
  await step(1_500)
  assert.equal(browser.state.cookieReads - before, 1, '慢速窗口里 3 秒只触发一次')
  await service.dispose()
})

test('cancel：running → cancelled 并关窗口；重复 cancel 幂等', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [] })
  const { service } = makeService({ browser })
  await service.start()
  const dto = await service.cancel()
  assert.equal(dto.status, 'cancelled')
  assert.equal(typeof dto.completedAt, 'number')
  assert.equal(browser.state.closed, 1)

  const again = await service.cancel()
  assert.equal(again.status, 'cancelled')
  assert.equal(browser.state.closed, 1)
})

test('cancel：未启动时返回 idle', async (t) => {
  useMockTimers(t)
  const { service } = makeService()
  assert.deepEqual(await service.cancel(), { status: 'idle' })
})

test('cancel 后再 start 会开新窗口', async (t) => {
  useMockTimers(t)
  let launches = 0
  const { service } = makeService({
    launcher: async () => { launches += 1; return fakeBrowser({ cookies: [] }) },
  })
  await service.start()
  await service.cancel()
  const restarted = await service.start()
  assert.equal(launches, 2)
  assert.equal(restarted.status, 'running')
  await service.dispose()
})

test('cancel 之后轮询立即停止，不再读 cookie', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [] })
  const { service } = makeService({ browser })
  await service.start()
  await pumpUntil(() => browser.state.cookieReads >= 2)
  await service.cancel()
  // 取消时可能正有一次探测在飞，先让它彻底跑完，再取基准值
  await step(STEP_MS)
  const frozen = browser.state.cookieReads
  await step(STEP_MS)
  await step(STEP_MS)
  assert.equal(browser.state.cookieReads, frozen)
})

test('dispose：置 cancelled 且不留浏览器；幂等', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [] })
  const { service } = makeService({ browser })
  await service.start()
  await service.dispose()
  assert.equal(service.status().status, 'cancelled')
  assert.equal(browser.state.closed, 1)
  await service.dispose()
  assert.equal(browser.state.closed, 1)
})

test('status()：未启动时是 idle', () => {
  const { service } = makeService()
  assert.deepEqual(service.status(), { status: 'idle' })
})

test('onAccount 抛错不影响 complete', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: bothCookies() })
  const { service } = makeService({
    browser,
    userInfo: () => ({ userId: 'u-1', isGuest: false }),
    onAccount: async () => { throw new Error('handler failed') },
  })
  await service.start()
  await pumpUntil(() => service.status().status === 'complete')
  await service.dispose()
})

test('displayName：userId 为空时用「智谱清言账号」', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: bothCookies() })
  const { service, store } = makeService({ browser, userInfo: () => ({ userId: '', isGuest: false }) })
  await service.start()
  await pumpUntil(() => service.status().status === 'complete')
  assert.equal(store.upserts[0].displayName, '智谱清言账号')
  await service.dispose()
})

test('cookie 值含百分号时解码后再用', async (t) => {
  useMockTimers(t)
  const browser = fakeBrowser({ cookies: [{ name: TOKEN_COOKIE, value: 'tok%2D1' }, { name: REFRESH_COOKIE, value: 'ref%2D1' }] })
  const { service, userInfoCalls } = makeService({ browser, userInfo: () => ({ userId: 'u-1', isGuest: false }) })
  await service.start()
  await pumpUntil(() => service.status().status === 'complete')
  assert.equal(userInfoCalls[0].accessToken, 'tok-1')
  assert.equal(userInfoCalls[0].refreshToken, 'ref-1')
  await service.dispose()
})
