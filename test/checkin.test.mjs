// 签到状态机（Task 1）：CN-only 选择、status-first、失败与重试策略、调度与队列。
// 参考实现的语义（D:\.dsh\...\dsh-chatgpt-subscription\lib\index.js:43603-43701）：
//   * 非手动运行时先看开关；同一本地日内 done 跳过、自动失败 ≥3 跳过、未开放 1 小时内跳过。
//   * 先 POST status，再按 `data.today_checked_in` / `data.active` 决定是否 POST daily。
//   * 401（`code === 401`）→ 强制刷新一次并重试一次；再失败记一次 attempts。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHECKIN_DAILY_PATH,
  CHECKIN_INACTIVE_RETRY_MS,
  CHECKIN_MAX_ATTEMPTS,
  CHECKIN_STATUS_PATH,
  CHECKIN_TICK_MS,
  CHECKIN_TIMEOUT_MS,
  createCheckinService,
  localDateString,
} from '../lib/checkin.mjs'

const T0 = 1_790_000_000_000
const TOKEN_MARK = 'TOKEN-'
// 桌面端 envelope 凭据的压缩形态：整段抽成短名常量，夹具形状不变。
const ENV = { $wbEncrypted: 1, envelope: 'x' }
const CN_MANAGED = 'managed:cn-managed-1'
const CN_DESKTOP = 'desktop-cn-2'
const INTL_MANAGED = 'managed:intl-3'
const ENCRYPTED_DESKTOP = 'desktop-encrypted-4'
const NO_TOKEN = 'managed:cn-managed-5'

function makeClock(start = T0) {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

function makeStore(overrides = {}) {
  const state = { enabled: true, accounts: {}, lastRunAt: 0, ...overrides }
  const lastRunAtWrites = []
  return {
    state,
    lastRunAtWrites,
    async load() {
      return state
    },
    getEnabled() {
      return state.enabled === true
    },
    async setEnabled(enabled) {
      state.enabled = enabled === true
    },
    getState() {
      return state
    },
    async updateAccount(id, entry) {
      state.accounts[id] = { ...entry }
    },
    async setLastRunAt(ts) {
      state.lastRunAt = ts
      lastRunAtWrites.push(ts)
    },
  }
}

function jsonResponse(payload, status = 200) {
  const body = JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body
    },
    async json() {
      return payload
    },
  }
}

/** 记录调用的假 fetch；每个请求按 queued 队列依次作答，队列用尽后重复最后一项。 */
function makeFetch(queued) {
  const calls = []
  const queue = [...queued]
  const impl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body, headers: init.headers ?? {} })
    impl.inFlight += 1
    impl.maxInFlight = Math.max(impl.maxInFlight, impl.inFlight)
    try {
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (typeof next === 'function') return await next({ url, init, index: calls.length - 1 })
      return next ?? jsonResponse({ code: 0, data: { today_checked_in: false, active: true } })
    } finally {
      impl.inFlight -= 1
    }
  }
  impl.calls = calls
  impl.inFlight = 0
  impl.maxInFlight = 0
  return impl
}

function credentialText(id, { tok = `${TOKEN_MARK}${id}` } = {}) {
  return JSON.stringify({
    auth: { accessToken: tok, refreshToken: `REFRESH-${id}`, expiresAt: T0 + 3_600_000, refreshExpiresAt: T0 + 86_400_000 },
    account: { uid: `uid-${id}`, uin: '', nickname: id, phoneNumber: '13800000000' },
  })
}

function makeDeps({ queued = [], store = makeStore(), clock = makeClock(), accounts, readAccount, refreshAccount, extra = {} } = {}) {
  const list = accounts ?? [
    { id: CN_MANAGED, region: 'cn', source: 'managed' },
    { id: CN_DESKTOP, region: 'cn', source: 'desktop' },
    { id: INTL_MANAGED, region: 'intl', source: 'managed' },
    { id: ENCRYPTED_DESKTOP, region: 'cn', source: 'desktop', encrypted: true },
    { id: NO_TOKEN, region: 'cn', source: 'managed' },
  ]
  const fetchImpl = makeFetch(queued)
  const refreshes = []
  const service = createCheckinService({
    listAccounts: async () => list,
    readAccount: async (id) => {
      if (readAccount !== undefined) return readAccount(id)
      if (id === NO_TOKEN) return { text: JSON.stringify({ auth: { accessToken: '' }, account: { uid: 'uid-x' } }) }
      if (id === ENCRYPTED_DESKTOP) {
        return {
          text: JSON.stringify({
            auth: { accessToken: ENV },
          }),
        }
      }
      return { text: credentialText(id) }
    },
    refreshAccount: async (id) => {
      refreshes.push(id)
      if (refreshAccount !== undefined) return refreshAccount(id)
      return undefined
    },
    fetchImpl,
    store,
    now: clock.now,
    timeZone: 'Asia/Shanghai',
    logger: { info() {}, warn() {} },
    ...extra,
  })
  return { service, store, clock, fetchImpl, refreshes }
}

function urlsOf(fetchImpl) {
  return fetchImpl.calls.map((call) => call.url)
}

test('CN 选择：Intl、加密桌面与无令牌账号一律 skipped 且零网络调用', async () => {
  const { service, store, fetchImpl } = makeDeps()
  const summary = await service.runAutomatic()

  assert.deepEqual(urlsOf(fetchImpl), [
    `https://copilot.tencent.com${CHECKIN_STATUS_PATH}`,
    `https://copilot.tencent.com${CHECKIN_DAILY_PATH}`,
    `https://copilot.tencent.com${CHECKIN_STATUS_PATH}`,
    `https://copilot.tencent.com${CHECKIN_DAILY_PATH}`,
  ])
  assert.equal(summary.totalAccounts, 5)
  assert.equal(summary.doneToday, 2)
  assert.equal(summary.skippedToday, 3)
  assert.equal(summary.failedToday, 0)
  assert.equal(store.state.accounts[INTL_MANAGED], undefined)
  assert.equal(store.state.accounts[ENCRYPTED_DESKTOP], undefined)
})

test('status-first：两个端点都是 POST，且已签到账号不再打 daily 端点', async () => {
  const { service, fetchImpl } = makeDeps({
    queued: [jsonResponse({ code: 0, data: { today_checked_in: true, active: true } })],
  })
  const summary = await service.runAutomatic()

  assert.ok(fetchImpl.calls.length >= 2)
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(call.body, '{}')
    assert.match(call.headers.Authorization ?? '', /^Bearer TOKEN-/)
  }
  assert.deepEqual(urlsOf(fetchImpl), [
    `https://copilot.tencent.com${CHECKIN_STATUS_PATH}`,
    `https://copilot.tencent.com${CHECKIN_STATUS_PATH}`,
  ])
  assert.equal(summary.doneToday, 2)
})

test('未开放的活动：不计失败、落 inactive 状态，且一小时内自动不再重试', async () => {
  const { service, store, clock, fetchImpl } = makeDeps({
    queued: [jsonResponse({ code: 0, data: { today_checked_in: false, active: false } })],
  })
  const first = await service.runAutomatic()
  assert.equal(first.failedToday, 0)
  assert.equal(first.skippedToday, 5)
  assert.equal(store.state.accounts[CN_MANAGED].inactive, true)
  assert.equal(store.state.accounts[CN_MANAGED].inactiveAt, clock.now())

  const callsAfterFirst = fetchImpl.calls.length
  clock.advance(CHECKIN_INACTIVE_RETRY_MS - 1000)
  await service.runAutomatic()
  assert.equal(fetchImpl.calls.length, callsAfterFirst, '一小时内不得重试未开放活动')

  clock.advance(2000)
  await service.runAutomatic()
  assert.ok(fetchImpl.calls.length > callsAfterFirst, '超过一小时后应重新检查')
})

test('每个请求都带 20 秒超时信号，且响应头为 CN 身份头集', async () => {
  const { service, fetchImpl } = makeDeps()
  await service.runAutomatic()

  const call = fetchImpl.calls[0]
  assert.equal(CHECKIN_TIMEOUT_MS, 20_000)
  assert.ok(call.init.signal instanceof AbortSignal, '每个请求都必须带 AbortSignal')
  assert.equal(call.headers['Content-Type'], 'application/json')
  assert.equal(call.headers['X-Domain'], 'www.codebuddy.cn')
  assert.equal(call.headers['X-Product'], 'SaaS')
  assert.equal(call.headers['X-Ide-Name'], 'CodeBuddyIDE')
  assert.equal(call.headers['X-Requested-With'], 'XMLHttpRequest')
  assert.match(call.headers['User-Agent'], /^CLI\//)
  assert.match(call.headers['X-User-Id'], /^uid-/)
})

test('401 触发一次账号刷新并重试一次，成功记为 done', async () => {
  const { service, store, refreshes, fetchImpl } = makeDeps({
    queued: [
      jsonResponse({ code: 401, msg: 'HTTP 401' }),
      jsonResponse({ code: 0, data: { today_checked_in: true, active: true } }),
    ],
  })
  const summary = await service.runAutomatic()

  assert.deepEqual(refreshes, [CN_MANAGED])
  assert.equal(summary.doneToday, 2)
  assert.equal(store.state.accounts[CN_MANAGED].done, true)
  assert.equal(store.state.accounts[CN_MANAGED].attempts, 0)
  assert.ok(fetchImpl.calls.length >= 3)
})

test('重试后仍 401 记为一次失败，并保留固定的错误摘要（不含令牌）', async () => {
  const { service, store } = makeDeps({
    queued: [jsonResponse({ code: 401, msg: 'HTTP 401' })],
  })
  const summary = await service.runAutomatic()

  assert.equal(summary.failedToday, 2)
  const entry = store.state.accounts[CN_MANAGED]
  assert.equal(entry.attempts, 1)
  assert.equal(entry.done, false)
  const serialized = JSON.stringify(store.state)
  assert.ok(!serialized.includes(TOKEN_MARK), '签到状态文件不得出现令牌')
  assert.ok(!serialized.includes('C:\\'), '签到状态文件不得出现本机路径')
})

test('单个账号失败不影响后续账号', async () => {
  const { service, store } = makeDeps({
    queued: [
      jsonResponse({ code: 500, msg: 'boom' }), // 托管账号 status：非 401 失败
      jsonResponse({ code: 500, msg: 'boom' }), // 桌面账号 status
      jsonResponse({ code: 500, msg: 'boom' }), // 托管账号 daily
      jsonResponse({ code: 0, data: { today_checked_in: false, active: true } }), // 桌面账号 daily
    ],
  })
  const summary = await service.runAutomatic()

  assert.equal(store.state.accounts[CN_DESKTOP].done, true)
  assert.equal(summary.doneToday, 1)
  assert.equal(summary.failedToday, 1)
})

test('自动失败上限为 3：达到上限后当天自动运行跳过，手动运行仍然执行', async () => {
  const store = makeStore()
  const clock = makeClock()
  const { service, fetchImpl } = makeDeps({ store, clock, queued: [jsonResponse({ code: 500, msg: 'boom' })] })

  await service.runAutomatic()
  await service.runAutomatic()
  await service.runAutomatic()
  assert.equal(store.state.accounts[CN_MANAGED].attempts, CHECKIN_MAX_ATTEMPTS)

  const callsAfterCap = fetchImpl.calls.length
  const capped = await service.runAutomatic()
  assert.equal(fetchImpl.calls.length, callsAfterCap, '达到上限后自动运行不得再发请求')
  assert.equal(capped.failedToday, 2)

  await service.runManual()
  assert.ok(fetchImpl.calls.length > callsAfterCap, '手动运行必须绕过次数上限')
})

test('手动运行绕过 enabled=false，但仍跳过当天已签到的账号', async () => {
  const store = makeStore({ enabled: false })
  const { service, fetchImpl } = makeDeps({ store, queued: [jsonResponse({ code: 0, data: { today_checked_in: true, active: true } })] })

  const automatic = await service.runAutomatic()
  assert.equal(fetchImpl.calls.length, 0, '关闭开关后自动运行必须零请求')
  assert.equal(automatic.doneToday, 0)

  const manual = await service.runManual()
  assert.equal(manual.doneToday, 2)
  const callsAfterFirstManual = fetchImpl.calls.length

  const again = await service.runManual()
  assert.equal(fetchImpl.calls.length, callsAfterFirstManual, '已签到账号不得重复请求')
  assert.equal(again.doneToday, 2)
})

test('自动运行不可重入：进行中的调用复用同一轮，不产生第二轮请求', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { service, fetchImpl } = makeDeps({
    queued: [
      async () => {
        await gate
        return jsonResponse({ code: 0, data: { today_checked_in: true, active: true } })
      },
    ],
  })

  const first = service.runAutomatic()
  const second = service.runAutomatic()
  assert.equal(first, second, '进行中的自动运行必须复用同一 promise')
  release()
  await first

  const statusCalls = urlsOf(fetchImpl).filter((url) => url.endsWith(CHECKIN_STATUS_PATH)).length
  assert.equal(statusCalls, 2, '只应有一轮（两个 CN 账号各一次 status）')
})

test('手动请求排队而不是被丢弃：与自动轮次串行执行', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let automaticSettled = false
  const store = makeStore()
  const { service, fetchImpl } = makeDeps({
    store,
    queued: [
      async () => {
        await gate
        return jsonResponse({ code: 0, data: { today_checked_in: true, active: true } })
      },
      jsonResponse({ code: 0, data: { today_checked_in: true, active: true } }),
    ],
  })

  const automatic = service.runAutomatic().then((value) => {
    automaticSettled = true
    return value
  })
  let manualSettled = false
  const manual = service.runManual().then((value) => {
    manualSettled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(automaticSettled, false, '自动轮次仍在进行中')
  assert.equal(manualSettled, false, '手动轮次必须排队等待，不得与自动轮次并行')
  assert.equal(fetchImpl.maxInFlight, 1, '任何时刻只允许一个在飞请求')

  release()
  await automatic
  await manual
  assert.equal(manualSettled, true, '手动轮次在自动轮次之后仍然执行')
  assert.equal(fetchImpl.maxInFlight, 1)
  assert.equal(store.lastRunAtWrites.length, 2, '自动与手动各跑完一轮（手动没有被丢弃）')
})

test('summary 只暴露聚合计数与时间戳，绝不包含令牌或路径', async () => {
  const { service } = makeDeps()
  const summary = await service.runAutomatic()

  assert.deepEqual(Object.keys(summary).sort(), [
    'doneToday',
    'enabled',
    'failedToday',
    'lastRunAt',
    'skippedToday',
    'totalAccounts',
  ])
  const serialized = JSON.stringify(summary)
  assert.ok(!serialized.includes(TOKEN_MARK))
  assert.ok(!serialized.includes('uid-'))
  assert.ok(!serialized.includes('C:\\'))
})

test('本地日期翻转后重新统计：昨天的 done 不阻止今天的签到', async () => {
  const store = makeStore()
  const clock = makeClock()
  const { service, fetchImpl } = makeDeps({ store, clock, queued: [jsonResponse({ code: 0, data: { today_checked_in: true, active: true } })] })

  await service.runAutomatic()
  const yesterday = localDateString(clock.now(), 'Asia/Shanghai')
  assert.equal(store.state.accounts[CN_MANAGED].date, yesterday)
  const callsAfterFirst = fetchImpl.calls.length

  clock.advance(24 * 60 * 60 * 1000)
  await service.runAutomatic()
  assert.ok(fetchImpl.calls.length > callsAfterFirst, '新的一天必须重新检查')
  assert.notEqual(localDateString(clock.now(), 'Asia/Shanghai'), yesterday)
})

test('start() 立即跑一轮并按 600000ms 定时，stop() 清掉定时器', async () => {
  const timers = []
  const cleared = []
  const { service } = makeDeps({
    extra: {
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
      clearTimer: (id) => cleared.push(id),
    },
  })

  service.start()
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, CHECKIN_TICK_MS)
  assert.equal(CHECKIN_TICK_MS, 600_000)

  service.stop()
  assert.deepEqual(cleared, [1])
})

test('账号列表读取失败时不抛错，只记零结果', async () => {
  const store = makeStore()
  const { service, fetchImpl } = makeDeps({
    store,
    extra: {
      listAccounts: async () => {
        throw new Error('scan failed')
      },
    },
  })
  const summary = await service.runAutomatic()

  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(summary.totalAccounts, 0)
  assert.equal(summary.doneToday, 0)
})
