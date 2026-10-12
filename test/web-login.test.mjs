// Host 侧登录服务的测试 —— 零真实网络、零真实磁盘（假 fetch + 内存 store）。
//
// 契约（设计文档 §「登录和账号库」/ §「安全与失败处理」）：
//   * token 只在 Host 内流动，DTO 只含白名单字段，任何响应文本都不得出现令牌值；
//   * 授权 URL 必须 HTTPS 且 host 属于该地区的受信任域，地区不符即 fail-closed；
//   * 登录流单例：新流程取代旧流程，旧流程迟到结果不得改写状态；
//   * 每约 1.5 秒轮询一次，最长 300 秒；
//   * 登录失败只更新错误状态，不覆盖已保存账号，也不改变 activeId。
// 所有令牌均为运行时合成的假串，不含任何真实机密。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagedAccountStore } from '../lib/managed-store.mjs'
import {
  CN_BACKEND,
  LOGIN_ERRORS,
  LOGIN_POLL_INTERVAL_MS,
  createWebLoginService,
  identityFromAccessToken,
  regionForAuthHost,
  validateAuthUrl,
} from '../lib/web-login.mjs'

const TOKSYN = 'SYNTHETIC-ACCESS-TOKEN-VALUE'
const REFRESH_TOKEN = 'SYNTHETIC-REFRESH-TOKEN-VALUE'
const START = 1_700_000_000_000

/** 合成 JWT（第三段签名是假串；身份只取 payload 的 claims）。 */
function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.SIGNATURE-NOT-VERIFIED`
}

/** 内存 managed store：真正的 store 实现 + 假 protector / 假原子写。 */
function makeStore({ accounts = [], activeId = null } = {}) {
  let file = null
  const protector = {
    protect: async (text) => `enc:${Buffer.from(text, 'utf8').toString('base64')}`,
    unprotect: async (ciphertext) => {
      if (!ciphertext.startsWith('enc:')) throw new Error('bad envelope')
      return Buffer.from(ciphertext.slice(4), 'base64').toString('utf8')
    },
  }
  const store = createManagedAccountStore({
    filePath: 'C:/synthetic/accounts.dpapi',
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
  const seed = (async () => {
    for (const account of accounts) await store.upsert(account)
    if (activeId !== null) await store.setActiveId(activeId)
  })()
  return { store, seeded: seed, raw: () => file }
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
    /** 直接推进时间但不触发已排队的定时器（用于验证期限判断）。 */
    advance(ms) {
      value += ms
    },
    /** 触发最早的一个定时器并让步到微任务耗尽。 */
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

/** 假 fetch：按队列依次作答，并记录每次请求。 */
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
        if (next?.textThrow === true) throw new Error('body stream failed')
        return body
      },
    }
  }
  return { fetchImpl, calls }
}

const STATE_OK = { json: { code: 0, data: { state: 'state-1', authUrl: 'https://copilot.tencent.com/auth?x=1' } } }
const PENDING = { json: { code: 11217, msg: 'pending' } }
const TOKEN_OK = {
  json: {
    code: 0,
    data: {
      auth: { accessToken: TOKSYN, refreshToken: REFRESH_TOKEN, expiresIn: 3600, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-1', uin: '10001' },
    },
  },
}
const ACCOUNT_OK = { json: { code: 0, data: { uid: 'uid-1', nickname: '账号昵称', uin: '10001' } } }

/** 断言任意响应文本里都不含令牌值。 */
function assertNoToken(text, label) {
  const value = String(text)
  for (const needle of [TOKSYN, REFRESH_TOKEN]) {
    assert.equal(value.includes(needle), false, `${label} 不得含令牌值`)
  }
}

/** 反复推进定时器，直到流程不再是 pending（或达到上限）。 */
async function settle(service, clock, limit = 400) {
  for (let index = 0; index < limit; index += 1) {
    if (service.status().status !== 'pending') return service.status()
    await clock.step()
  }
  return service.status()
}

test('CN 初始化：请求体、身份头与 DTO 白名单', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_OK, PENDING, TOKEN_OK, ACCOUNT_OK])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  const dto = await service.start('cn')

  assert.equal(dto.status, 'pending')
  assert.equal(dto.region, 'cn')
  assert.equal(dto.authUrl, 'https://copilot.tencent.com/auth?x=1')
  assertNoToken(JSON.stringify(dto), '登录启动响应')

  const [first] = calls
  assert.equal(first.url, `${CN_BACKEND}/v2/plugin/auth/state?platform=cli`)
  assert.equal(first.init.method, 'POST')
  assert.equal(first.init.body, '{}')
  assert.equal(first.init.headers['x-domain'], 'copilot.tencent.com')
  assert.equal(first.init.headers['x-product'], 'SaaS')
  assert.equal(first.init.headers['x-ide-name'], 'CodeBuddyIDE')
  assert.equal(first.init.headers['x-requested-with'], 'XMLHttpRequest')
  assert.match(first.init.headers['user-agent'], /^CLI\//)
  assert.equal(first.init.headers.origin, undefined, 'CN 不带 Origin 头')
  assert.equal(first.init.headers.referer, undefined, 'CN 不带 Referer 头')
})

test('Intl 初始化：backend 与 Intl 头，并接受 codebuddy.ai 授权链接', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const stateCodebuddy = { json: { code: 0, data: { state: 'state-2', authUrl: 'https://auth.codebuddy.ai/login?y=2' } } }
  const tokenCodebuddy = {
    json: {
      code: 0,
      data: {
        auth: { accessToken: TOKSYN, refreshToken: REFRESH_TOKEN, expiresIn: 1800, domain: 'www.codebuddy.ai' },
        account: { uid: 'uid-2', nickname: 'Intl 用户', uin: '20002' },
      },
    },
  }
  const { fetchImpl, calls } = makeFetch([stateCodebuddy, PENDING, tokenCodebuddy, ACCOUNT_OK])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('intl')

  assert.equal(calls[0].url, 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=cli')
  assert.equal(calls[0].init.headers['x-domain'], 'www.workbuddy.ai')
  assert.equal(calls[0].init.headers.origin, 'https://www.workbuddy.ai')
  assert.equal(calls[0].init.headers.referer, 'https://www.workbuddy.ai/')

  const done = await settle(service, clock)
  assert.equal(done.status, 'complete')
  const account = await store.getById(done.account.id)
  assert.equal(account.apiOrigin, 'https://www.codebuddy.ai')
  assert.equal(done.account.uidTail, 'id-2'.slice(-4))
})

test('授权 URL 与认证域白名单：受信任域通过，其余 fail-closed', () => {
  assert.equal(regionForAuthHost('workbuddy.ai'), 'intl')
  assert.equal(regionForAuthHost('www.codebuddy.ai'), 'intl')
  assert.equal(regionForAuthHost('copilot.tencent.com'), 'cn')
  assert.equal(regionForAuthHost('evil-workbuddy.ai'), null)
  assert.equal(regionForAuthHost('workbuddy.ai.evil.com'), null)
  assert.equal(regionForAuthHost(''), null)

  assert.equal(validateAuthUrl('https://www.workbuddy.ai/auth', 'intl'), 'https://www.workbuddy.ai')
  assert.equal(validateAuthUrl('https://copilot.tencent.com/auth', 'cn'), CN_BACKEND)

  const rejected = [
    ['http://copilot.tencent.com/auth', 'cn'],
    ['https://workbuddy.ai.evil.com/auth', 'intl'],
    ['https://copilot.tencent.com/auth', 'intl'],
    ['https://www.workbuddy.ai/auth', 'cn'],
    ['not a url', 'cn'],
  ]
  for (const [authUrl, region] of rejected) {
    assert.throws(() => validateAuthUrl(authUrl, region), (error) => error.code === LOGIN_ERRORS.authUrl, `${authUrl} / ${region} 必须被拒`)
  }
})

test('轮询：等待码保持 pending，成功后入库并返回脱敏摘要', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_OK, PENDING, PENDING, TOKEN_OK, ACCOUNT_OK])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  assert.equal(clock.step !== undefined, true)
  await clock.step()
  const first = service.status()
  assert.equal(first.status, 'pending', '等待码必须保持 pending')
  assert.match(first.progress, /等待浏览器授权…（\d+ 秒）/)
  assert.equal(clock.waits[0], LOGIN_POLL_INTERVAL_MS, '轮询间隔必须是 1.5 秒')

  await clock.step()
  await clock.step()
  const done = service.status()
  assert.equal(done.status, 'complete')
  assert.equal(done.progress, '授权完成')
  assert.equal(done.account.nickname, '账号昵称', '账号资料补全昵称')
  assert.equal(done.account.region, 'cn')
  assert.equal(done.account.uidTail, 'id-1')
  assertNoToken(JSON.stringify(done), '登录完成响应')

  const token = calls.find((call) => call.url.includes('/v2/plugin/auth/token'))
  assert.match(token.url, /^https:\/\/copilot\.tencent\.com\/v2\/plugin\/auth\/token\?platform=cli&state=state-1$/)
  const account = calls.find((call) => call.url.endsWith('/v2/plugin/account'))
  assert.equal(account.init.headers.authorization, `Bearer ${TOKSYN}`)
  assert.equal(account.init.headers['x-domain'], 'copilot.tencent.com')

  const saved = (await store.list())[0]
  assert.equal(saved.uid, 'uid-1')
  assert.equal(saved.uin, '10001')
  assert.equal(saved.accessToken, TOKSYN)
  assert.equal(saved.refreshToken, REFRESH_TOKEN)
  assert.equal(saved.expiresAt, clock.now() + 3600 * 1000, 'expiresIn 从令牌签发时刻起算')
  assert.equal(saved.apiOrigin, CN_BACKEND)
})

test('身份解析：claims 优先，账号资料 best-effort 失败不影响登录', async () => {
  const CLAIMS = jwt({ sub: 'uid-from-claims', nickname: 'claims 昵称', uin: '30003' })
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl } = makeFetch([
    STATE_OK,
    { json: { code: 0, data: { auth: { accessToken: CLAIMS, refreshToken: '', expiresIn: 60, domain: 'copilot.tencent.com' } } } },
    { status: 500, raw: 'upstream boom' },
  ])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  const done = await settle(service, clock)

  assert.equal(done.status, 'complete')
  assert.equal(done.account.nickname, 'claims 昵称')
  assert.equal(done.account.uidTail, 'aims')
  const saved = (await store.list())[0]
  assert.equal(saved.uid, 'uid-from-claims')
  assert.equal(saved.uin, '30003')
  assert.equal(saved.refreshToken, '', '空 refreshToken 允许保存（仅 access token 可用）')
})

test('identityFromAccessToken 对非 JWT / 畸形令牌返回空对象', () => {
  assert.deepEqual(identityFromAccessToken('opaque-token'), {})
  assert.deepEqual(identityFromAccessToken('a.b'), {})
  assert.deepEqual(identityFromAccessToken('a.!!!not-base64!!!.c'), {})
  assert.deepEqual(identityFromAccessToken(undefined), {})
  assert.deepEqual(identityFromAccessToken(jwt({ sub: 'x', uin: 12345, enterprise_id: 'ent-1' })), { uid: 'x', uin: '12345', enterpriseId: 'ent-1' })
})

test('登录失败：只更新错误状态，不覆盖已保存账号、不改 activeId', async () => {
  const clock = makeClock()
  const { store, seeded } = makeStore({
    accounts: [
      {
        region: 'cn',
        uid: 'desktop-uid',
        uin: '',
        displayName: '已有账号',
        phoneMasked: '138****0000',
        accessToken: 'exist-t',
        refreshToken: 'EXISTING-REFRESH',
        expiresAt: START + 1000,
        refreshExpiresAt: 0,
        apiOrigin: CN_BACKEND,
      },
    ],
    activeId: undefined,
  })
  await seeded
  const existing = (await store.list())[0]
  await store.setActiveId(existing.id)

  const { fetchImpl } = makeFetch([STATE_OK, { json: { code: 500, msg: 'denied' } }])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  const failed = await settle(service, clock)

  assert.equal(failed.status, 'error')
  assert.equal(failed.error, LOGIN_ERRORS.poll)
  assert.match(failed.progress, /登录/)
  assertNoToken(JSON.stringify(failed), '失败响应')
  const accounts = await store.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].accessToken, 'exist-t')
  assert.equal(await store.getActiveId(), existing.id)
})

test('登录成功不激活账号：activeId 保持原值', async () => {
  const clock = makeClock()
  const { store, seeded } = makeStore({
    accounts: [
      {
        region: 'cn',
        uid: 'desktop-uid',
        uin: '',
        displayName: '桌面账号',
        phoneMasked: '',
        accessToken: 'exist-t',
        refreshToken: '',
        expiresAt: START,
        refreshExpiresAt: 0,
        apiOrigin: CN_BACKEND,
      },
    ],
  })
  await seeded
  const existing = (await store.list())[0]
  await store.setActiveId(existing.id)

  const { fetchImpl } = makeFetch([STATE_OK, TOKEN_OK, ACCOUNT_OK])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  const done = await settle(service, clock)

  assert.equal(done.status, 'complete')
  assert.equal((await store.list()).length, 2, '新账号入库')
  assert.equal(await store.getActiveId(), existing.id, '登录只添加，不切换')
})

const STATE_INTL = { json: { code: 0, data: { state: 'state-intl', authUrl: 'https://www.workbuddy.ai/auth?y=2' } } }

test('单例：新流程取代旧流程，旧流程迟到结果不改写新状态', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  let releaseOld = null
  const oldGate = new Promise((resolve) => {
    releaseOld = resolve
  })
  const { fetchImpl, calls } = makeFetch([
    STATE_OK,
    async () => {
      await oldGate
      return { ok: true, status: 200, async text() { return JSON.stringify(TOKEN_OK.json) } }
    },
    STATE_INTL,
    PENDING,
  ])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  await clock.step()
  assert.equal(calls.length, 2, '旧流程已发出一次轮询')

  await service.start('intl')
  assert.equal(calls[1].init.signal.aborted, true, '旧流程的在途轮询被 abort')

  releaseOld()
  await drain()

  assert.equal(service.status().status, 'pending')
  assert.equal(service.status().region, 'intl')
  assert.deepEqual(await store.list(), [], '被取代的流程不得入库')
})

test('超时：300 秒后停止轮询并给出超时错误码', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_OK, PENDING])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  clock.advance(300 * 1000)
  await clock.step()
  await drain()

  const done = service.status()
  assert.equal(done.status, 'error')
  assert.equal(done.error, LOGIN_ERRORS.timeout)
  assert.equal(clock.pendingTimers, 0, '超时后不得继续排队轮询')
  assert.equal(calls.length, 2, '超时后不再发请求')
  assert.equal(300 * 1000 / LOGIN_POLL_INTERVAL_MS, 200, '1.5 秒一次即 300 秒内最多 200 次轮询')
  assert.deepEqual(await store.list(), [], '超时不得入库')
})

test('cancel 停止轮询并回到 idle', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([STATE_OK, PENDING])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  await clock.step()
  const count = calls.length
  service.cancel()
  assert.equal(clock.pendingTimers, 0, '取消后不得留有在途定时器')

  await clock.step()
  await drain()

  assert.equal(service.status().status, 'idle')
  assert.equal(calls.length, count, '取消后不得再发请求')
})

test('非法地区与非法授权 URL：启动即拒绝且不进 pending', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const { fetchImpl, calls } = makeFetch([{ json: { code: 0, data: { state: 's', authUrl: 'https://www.workbuddy.ai/auth' } } }])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await assert.rejects(() => service.start('us'), (error) => error.code === LOGIN_ERRORS.region)
  assert.equal(calls.length, 0, '非法地区不发请求')

  await assert.rejects(() => service.start('cn'), (error) => error.code === LOGIN_ERRORS.authUrl)
  assert.equal(service.status().status, 'error')
  assert.equal(service.status().error, LOGIN_ERRORS.authUrl)
  assertNoToken(JSON.stringify(service.status()), '授权 URL 拒绝响应')
})

test('令牌自述地区与流程不符：fail-closed 不入库', async () => {
  const clock = makeClock()
  const { store } = makeStore()
  const mismatched = {
    json: {
      code: 0,
      data: { auth: { accessToken: TOKSYN, refreshToken: REFRESH_TOKEN, expiresIn: 60, domain: 'www.workbuddy.ai' } },
    },
  }
  const { fetchImpl } = makeFetch([STATE_OK, mismatched])
  const service = createWebLoginService({ store, fetchImpl, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

  await service.start('cn')
  const done = await settle(service, clock)

  assert.equal(done.status, 'error')
  assert.equal(done.error, LOGIN_ERRORS.poll)
  assert.deepEqual(await store.list(), [])
})

test('状态接口只读本地状态：idle 时也返回 DTO', () => {
  const { store } = makeStore()
  const service = createWebLoginService({ store, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) })
  assert.deepEqual(service.status(), { status: 'idle' })
})
