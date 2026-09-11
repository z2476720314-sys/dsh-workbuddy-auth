// WorkBuddy 权威积分余额测试 —— 只注入假 fetch，绝不发真实网络请求。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CREDIT_TIMEOUT_MS,
  ENTERPRISE_CREDIT_URL,
  PERSONAL_CREDIT_URL,
  fetchCreditBalance,
  parseCreditCredential,
} from '../lib/credits.mjs'

const ACCESS_TOKEN = 'SYNTHETIC-CREDIT-ACCESS'.repeat(8)
const REFRESH_TOKEN = 'SYNTHETIC-CREDIT-REFRESH'.repeat(8)
const UID = 'credit-user-00000000-1111-4222-8333-444444444444'
const ENTERPRISE_ID = 'credit-enterprise-1234'
const T0 = 1_789_050_100_513

function record(overrides = {}) {
  return { accessToken: ACCESS_TOKEN, uid: UID, enterpriseId: '', ...overrides }
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function spyFetch(respond) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  impl.calls = calls
  return impl
}

function assertSafeSuccess(result) {
  assert.deepEqual(Object.keys(result).sort(), ['fetchedAt', 'ok', 'remaining', 'stale', 'total', 'used'])
  const text = JSON.stringify(result)
  for (const forbidden of [
    'PackageCode',
    'ResourceId',
    UID,
    ENTERPRISE_ID,
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    ACCESS_TOKEN.slice(17, 41),
  ]) {
    assert.equal(text.includes(forbidden), false, `安全 DTO 不得包含 ${forbidden.slice(0, 20)}`)
  }
}

test('个人余额：固定 endpoint 与请求头，并分别累计 Packages 的服务端三项字段', async () => {
  const fetchImpl = spyFetch(async () => jsonResponse({
    data: {
      Packages: [
        {
          PackageCode: 'SECRET-PACKAGE-A',
          ResourceId: 'SECRET-RESOURCE-A',
          CycleTotalCapacity: '1000',
          CycleRemainCapacity: '750.25',
          CycleUsedCapacity: '249.75',
          CycleFrozenCapacity: '999999',
        },
        {
          PackageCode: 'SECRET-PACKAGE-B',
          ResourceId: 'SECRET-RESOURCE-B',
          CycleTotalCapacity: '234',
          CycleRemainCapacity: '200',
          CycleUsedCapacity: '34',
          CycleFrozenCapacity: '888888',
        },
      ],
    },
  }))

  const result = await fetchCreditBalance({ record: record(), fetchImpl, now: T0 })

  assert.deepEqual(result, {
    ok: true,
    remaining: 950.25,
    total: 1234,
    used: 283.75,
    fetchedAt: T0,
    stale: false,
  })
  assert.equal(result.used, 283.75, 'used 必须独立累计 CycleUsedCapacity，不得以 total - remaining 重算')
  assertSafeSuccess(result)

  assert.equal(fetchImpl.calls.length, 1)
  const { url, init } = fetchImpl.calls[0]
  assert.equal(url, PERSONAL_CREDIT_URL)
  assert.equal(url, 'https://copilot.tencent.com/billing/meter/get-user-resource-summary')
  assert.equal(init.method, 'POST')
  assert.equal(init.body, '{}')
  assert.equal(init.headers.Authorization, `Bearer ${ACCESS_TOKEN}`)
  assert.equal(init.headers['X-User-Id'], UID)
  assert.equal(init.headers['Accept-Language'], 'zh')
  assert.equal(init.headers['User-Agent'], 'dsh-workbuddy/0.1')
  assert.equal('X-Enterprise-Id' in init.headers, false)
  assert.ok(init.signal, '30s 超时必须通过 AbortSignal 传给 fetch')
  assert.equal(CREDIT_TIMEOUT_MS, 30_000)
})

test('个人余额：累计结果溢出为非有限数时安全归零', async () => {
  const fetchImpl = spyFetch(async () => jsonResponse({
    data: {
      Packages: [
        { CycleTotalCapacity: '1e308', CycleRemainCapacity: '1e308', CycleUsedCapacity: '1e308' },
        { CycleTotalCapacity: '1e308', CycleRemainCapacity: '1e308', CycleUsedCapacity: '1e308' },
      ],
    },
  }))

  const result = await fetchCreditBalance({ record: record({ uid: `${UID}-overflow` }), fetchImpl, now: T0 + 0.5 })

  assert.deepEqual(result, { ok: true, remaining: 0, total: 0, used: 0, fetchedAt: T0 + 0.5, stale: false })
})

test('个人余额：无效、非有限与负数按 0，CycleFrozenCapacity 完全忽略', async () => {
  const fetchImpl = spyFetch(async () => jsonResponse({
    data: {
      Packages: [
        { CycleTotalCapacity: '-3', CycleRemainCapacity: 'not-a-number', CycleUsedCapacity: '-1', CycleFrozenCapacity: '500' },
        { CycleTotalCapacity: '12.5', CycleRemainCapacity: Infinity, CycleUsedCapacity: '4.25', CycleFrozenCapacity: '1000' },
      ],
    },
  }))

  const result = await fetchCreditBalance({ record: record({ uid: `${UID}-invalid` }), fetchImpl, now: T0 + 1 })

  assert.deepEqual(result, { ok: true, remaining: 0, total: 12.5, used: 4.25, fetchedAt: T0 + 1, stale: false })
  assertSafeSuccess(result)
})

test('企业余额：固定 enterprise usage endpoint，total=limitNum、used=credit、remaining=limitNum-credit', async () => {
  const fetchImpl = spyFetch(async () => jsonResponse({
    data: {
      limitNum: '1000.5',
      credit: '250.25',
      enterpriseId: ENTERPRISE_ID,
      uid: UID,
      accessToken: ACCESS_TOKEN,
    },
  }))

  const result = await fetchCreditBalance({
    record: record({ uid: `${UID}-enterprise`, enterpriseId: ENTERPRISE_ID }),
    fetchImpl,
    now: T0 + 2,
  })

  assert.deepEqual(result, { ok: true, remaining: 750.25, total: 1000.5, used: 250.25, fetchedAt: T0 + 2, stale: false })
  assertSafeSuccess(result)
  assert.equal(fetchImpl.calls.length, 1)
  const { url, init } = fetchImpl.calls[0]
  assert.equal(url, ENTERPRISE_CREDIT_URL)
  assert.equal(url, 'https://copilot.tencent.com/billing/meter/get-enterprise-user-usage')
  assert.equal(init.headers['X-Enterprise-Id'], ENTERPRISE_ID)
  assert.equal(init.headers['X-User-Id'], `${UID}-enterprise`)
})

test('企业余额：limitNum/credit 的无效或负值按 0，但权威 remaining 可为负', async () => {
  const negative = spyFetch(async () => jsonResponse({ data: { limitNum: '-10', credit: 'bad' } }))
  assert.deepEqual(
    await fetchCreditBalance({ record: record({ uid: `${UID}-enterprise-invalid`, enterpriseId: `${ENTERPRISE_ID}-invalid` }), fetchImpl: negative, now: T0 + 3 }),
    { ok: true, remaining: 0, total: 0, used: 0, fetchedAt: T0 + 3, stale: false },
  )

  const overdrawn = spyFetch(async () => jsonResponse({ data: { limitNum: '10', credit: '12' } }))
  assert.deepEqual(
    await fetchCreditBalance({ record: record({ uid: `${UID}-enterprise-over`, enterpriseId: `${ENTERPRISE_ID}-over` }), fetchImpl: overdrawn, now: T0 + 4 }),
    { ok: true, remaining: -2, total: 10, used: 12, fetchedAt: T0 + 4, stale: false },
  )
})

test('非 2xx、非 JSON、缺 data 或缺个人 Packages 都返回 unavailable，不以 0 冒充成功', async () => {
  const cases = [
    async () => jsonResponse({ data: { Packages: [] } }, 503),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json') } }),
    async () => jsonResponse({}),
    async () => jsonResponse({ data: {} }),
  ]

  for (const [index, respond] of cases.entries()) {
    const result = await fetchCreditBalance({
      record: record({ uid: `${UID}-failure-${index}` }),
      fetchImpl: spyFetch(respond),
      now: T0 + 10 + index,
    })
    assert.deepEqual(result, { ok: false, error: 'unavailable' })
  }
})

test('余额请求把精确 30s 超时信号交给 fetch，abort 后收敛为 unavailable', async () => {
  const originalTimeout = AbortSignal.timeout
  const seen = []
  AbortSignal.timeout = (milliseconds) => {
    seen.push(milliseconds)
    const controller = new AbortController()
    queueMicrotask(() => controller.abort(new Error(`synthetic timeout ${ACCESS_TOKEN}`)))
    return controller.signal
  }
  try {
    const fetchImpl = spyFetch(async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }))
    const result = await fetchCreditBalance({ record: record({ uid: `${UID}-timeout` }), fetchImpl, now: T0 + 19 })
    assert.deepEqual(seen, [30_000])
    assert.deepEqual(result, { ok: false, error: 'unavailable' })
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN.slice(10, 30)), false)
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

test('凭据或 fetch seam 不可用时零网络调用并返回 unavailable', async () => {
  const fetchImpl = spyFetch(async () => { throw new Error('must not run') })

  for (const badRecord of [undefined, {}, { accessToken: '', uid: UID }, { accessToken: ACCESS_TOKEN, uid: '' }]) {
    assert.deepEqual(await fetchCreditBalance({ record: badRecord, fetchImpl, now: T0 + 20 }), { ok: false, error: 'unavailable' })
  }
  assert.equal(fetchImpl.calls.length, 0)
  assert.deepEqual(await fetchCreditBalance({ record: record({ uid: `${UID}-no-fetch` }), fetchImpl: undefined, now: T0 + 21 }), { ok: false, error: 'unavailable' })
})

test('同 scope 的并发请求合并为一次 in-flight fetch', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = spyFetch(async () => {
    await gate
    return jsonResponse({ data: { Packages: [{ CycleTotalCapacity: '9', CycleRemainCapacity: '7', CycleUsedCapacity: '2' }] } })
  })
  const sameRecord = record({ uid: `${UID}-inflight` })

  const first = fetchCreditBalance({ record: sameRecord, fetchImpl, now: T0 + 30 })
  const second = fetchCreditBalance({ record: { ...sameRecord }, fetchImpl, now: T0 + 30 })
  await Promise.resolve()
  assert.equal(fetchImpl.calls.length, 1, '相同账号 scope 在飞时只能有一个网络请求')

  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.deepEqual(a, { ok: true, remaining: 7, total: 9, used: 2, fetchedAt: T0 + 30, stale: false })
})

test('60s TTL 内复用成功快照；过期刷新失败时返回最后成功值并标 stale:true', async () => {
  let attempts = 0
  const fetchImpl = spyFetch(async () => {
    attempts += 1
    if (attempts === 1) {
      return jsonResponse({ data: { Packages: [{ CycleTotalCapacity: '100', CycleRemainCapacity: '80', CycleUsedCapacity: '19' }] } })
    }
    throw new Error(`synthetic network failure containing ${ACCESS_TOKEN}`)
  })
  const sameRecord = record({ uid: `${UID}-ttl` })

  const fresh = await fetchCreditBalance({ record: sameRecord, fetchImpl, now: T0 + 40 })
  const cached = await fetchCreditBalance({ record: sameRecord, fetchImpl, now: T0 + 40 + 59_999 })
  assert.deepEqual(cached, fresh)
  assert.equal(fetchImpl.calls.length, 1, 'TTL 内不得重复联网')

  const rollback = await fetchCreditBalance({ record: sameRecord, fetchImpl, now: T0 })
  assert.deepEqual(rollback, { ...fresh, stale: true }, '时钟回拨不得无限延长 TTL；刷新失败应回退 stale 快照')
  assert.equal(fetchImpl.calls.length, 2)

  const stale = await fetchCreditBalance({ record: sameRecord, fetchImpl, now: T0 + 40 + 60_000 })
  assert.deepEqual(stale, { ...fresh, stale: true })
  assert.equal(fetchImpl.calls.length, 3, 'TTL 到期后应再次尝试刷新')
  assertSafeSuccess(stale)
})

test('首次请求失败时没有旧快照，只返回固定 unavailable 且不泄漏错误或 token', async () => {
  const fetchImpl = spyFetch(async () => { throw new Error(`ECONNRESET ${ACCESS_TOKEN} ${UID}`) })
  const result = await fetchCreditBalance({ record: record({ uid: `${UID}-cold-failure` }), fetchImpl, now: T0 + 50 })
  assert.deepEqual(result, { ok: false, error: 'unavailable' })
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN.slice(8, 28)), false)
})

test('parseCreditCredential 只从 raw JSON 提取余额请求最小字段，不携带整条对象', () => {
  const rawText = JSON.stringify({
    account: {
      uid: UID,
      enterpriseId: ENTERPRISE_ID,
      nickname: '不应进入余额 record',
      phoneNumber: '13800001234',
      type: 'enterprise',
    },
    auth: {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      expiresAt: 123,
    },
    Packages: [{ PackageCode: 'SHOULD-NOT-BE-COPIED' }],
  })

  const minimal = parseCreditCredential(rawText)

  assert.deepEqual(minimal, { accessToken: ACCESS_TOKEN, uid: UID, enterpriseId: ENTERPRISE_ID })
  assert.deepEqual(Object.keys(minimal).sort(), ['accessToken', 'enterpriseId', 'uid'])
  assert.equal('refreshToken' in minimal, false)
  assert.equal('account' in minimal, false)
  assert.equal('Packages' in minimal, false)
})
