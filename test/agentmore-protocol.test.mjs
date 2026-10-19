import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  AGENTMORE_CLOCK_TIMEOUT_MS,
  AGENTMORE_CONNECT_TIMEOUT_MS,
  AGENTMORE_FALLBACK_MODELS,
  AGENTMORE_ORIGIN,
  AGENTMORE_PATHS,
  AGENTMORE_READ_TIMEOUT_MS,
  AGENTMORE_STREAM_IDLE_TIMEOUT_MS,
  AGENTMORE_USER_AGENT,
  AGENTMORE_WEB_ORIGIN,
  createClockOffsetResolver,
  md5Hex,
  parseUpstreamError,
  requestJson,
  signedHeaders,
  statusError,
  timestampWithCheck,
  unwrapResult,
  upstreamError,
} from '../lib/agentmore-protocol.mjs'

const SALT = '8a1317a7468aa3ad86e997d08f3f31cb'
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

test('常量逐字对齐 APK 反汇编', () => {
  assert.equal(AGENTMORE_ORIGIN, 'https://agentmore.chatglm.cn')
  assert.equal(AGENTMORE_WEB_ORIGIN, 'https://chatglm.cn')
  assert.match(AGENTMORE_USER_AGENT, /Chrome\/153\.0\.0\.0/)
  assert.equal(AGENTMORE_USER_AGENT.includes('; wv'), false, 'UA 不能带 WebView 标记')
  assert.equal(AGENTMORE_CONNECT_TIMEOUT_MS, 15_000)
  assert.equal(AGENTMORE_READ_TIMEOUT_MS, 20_000)
  assert.equal(AGENTMORE_STREAM_IDLE_TIMEOUT_MS, 180_000)
  assert.equal(AGENTMORE_CLOCK_TIMEOUT_MS, 3_000)
  assert.deepEqual(AGENTMORE_PATHS, {
    stream: '/chatglm/agent-api/stream',
    conversation: '/chatglm/agent-api/conversation',
    models: '/chatglm/agent-api/operation/detail?tag=available_models',
    agents: '/chatglm/agent-api/project/list?page=1&page_size=30',
    userInfo: '/chatglm/user-api/user/info',
    refresh: '/chatglm/user-api/user/refresh',
    clock: '/chatglm/operation-api/config/cur_ts',
    dailyLogin: '/chatglm/member-api/member/daily_login_score',
    taskComplete: '/chatglm/agent-api/task/complete',
  })
  assert.deepEqual(AGENTMORE_FALLBACK_MODELS.map((model) => model.id), ['glm-5.3', 'glm-5.3-flash'])
  assert.equal(Object.isFrozen(AGENTMORE_FALLBACK_MODELS), true)
})

test('md5Hex 与 node:crypto 一致且大小写为小写', () => {
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(md5Hex(123), createHash('md5').update('123', 'utf8').digest('hex'))
})

test('timestampWithCheck 逐例复刻校验位算法', () => {
  // 长度 < 3 原样返回（`if-ge v5, v6(+3)` 跳过整段替换）
  assert.equal(timestampWithCheck(''), '')
  assert.equal(timestampWithCheck('1'), '1')
  assert.equal(timestampWithCheck('10'), '10')

  // 三位数起才替换：sum(1+2+3)=6，减 digits[1]=2 → 4，校验位落到下标 1
  assert.equal(timestampWithCheck(123), '143')

  // sum(1+2+3+4+5+6+7+8+9)=45，减去 digits[7]=8 → 37，37%10=7 落到下标 7
  assert.equal(timestampWithCheck('123456789'), '123456779')

  // sum(1)=1，减去 digits[2]=0 → 1，校验位 1 落到下标 2
  assert.equal(timestampWithCheck('1000'), '1010')

  // 负和取正模：digits 全 -17，sum=-51，减 digits[1]=-17 → -34，((-34%10)+10)%10 = 6
  assert.equal(timestampWithCheck('\u001f\u001f\u001f'), '\u001f6\u001f')
})

test('signedHeaders 产出 9 个头，签名与时间戳自洽', () => {
  const at = 1_700_000_000_000
  const headers = signedHeaders({ deviceId: 'dev-abc', clockOffsetMs: 0, at })
  assert.deepEqual(Object.keys(headers), [
    'Content-Type',
    'App-Name',
    'X-Device-Id',
    'X-Request-Id',
    'X-App-Platform',
    'X-App-Version',
    'X-Timestamp',
    'X-Nonce',
    'X-Sign',
  ])
  assert.equal(headers['Content-Type'], 'application/json;charset=utf-8')
  assert.equal(headers['App-Name'], 'chatglm')
  assert.equal(headers['X-Device-Id'], 'dev-abc')
  assert.equal(headers['X-App-Platform'], 'pc')
  assert.equal(headers['X-App-Version'], '0.0.1')
  assert.equal(headers['X-Request-Id'].includes('-'), false, 'requestId 必须是裸 UUID')
  assert.equal(headers['X-Nonce'].includes('-'), false, 'nonce 必须是裸 UUID')
  assert.equal(headers['X-Request-Id'].length, 32)
  assert.equal(headers['X-Timestamp'], timestampWithCheck(String(at)))
  assert.equal(headers['X-Sign'], md5Hex(`${headers['X-Timestamp']}-${headers['X-Nonce']}-${SALT}`))
  assert.notEqual(headers['X-Sign'], md5Hex(`${headers['X-Timestamp']}-${headers['X-Request-Id']}-${SALT}`))
})

test('signedHeaders 把时钟偏移加进时间戳', () => {
  const at = 1_700_000_000_000
  const plain = signedHeaders({ deviceId: 'd', at })
  const shifted = signedHeaders({ deviceId: 'd', at, clockOffsetMs: 5_000 })
  assert.equal(shifted['X-Timestamp'], timestampWithCheck(String(at + 5_000)))
  assert.notEqual(shifted['X-Timestamp'], plain['X-Timestamp'])
})

test('每次调用都换新的 requestId / nonce / 签名', () => {
  const a = signedHeaders({ deviceId: 'd', at: 1_700_000_000_000 })
  const b = signedHeaders({ deviceId: 'd', at: 1_700_000_000_000 })
  assert.equal(a['X-Timestamp'], b['X-Timestamp'])
  assert.notEqual(a['X-Request-Id'], b['X-Request-Id'])
  assert.notEqual(a['X-Nonce'], b['X-Nonce'])
  assert.notEqual(a['X-Sign'], b['X-Sign'])
})

test('upstreamError 挂上游细节但只暴露插件错误码', () => {
  const error = upstreamError('overloaded', '服务器被挤爆了，请稍后重试', 503)
  assert.equal(error.code, 'AGENTMORE_OVERLOADED')
  assert.equal(error.status, 503)
  assert.equal(error.exposeStatus, true)
  assert.equal(error.upstreamType, 'overloaded')
  assert.equal(error.upstreamMessage, '服务器被挤爆了，请稍后重试')
  assert.equal(error.message, 'AGENTMORE_OVERLOADED')
})

test('parseUpstreamError 映射 -1001 与 10024，无法解析返回 null', () => {
  assert.equal(parseUpstreamError(null), null)
  assert.equal(parseUpstreamError({}), null)
  assert.equal(parseUpstreamError({ last_error: null }), null)
  assert.equal(parseUpstreamError({ last_error: 'boom' }), null)
  assert.equal(parseUpstreamError({ last_error: { error_code: 0 } }), null)
  assert.equal(parseUpstreamError({ last_error: { error_code: 'abc' } }), null)

  const overloaded = parseUpstreamError({ last_error: { error_code: -1001 } })
  assert.equal(overloaded.code, 'AGENTMORE_OVERLOADED')
  assert.equal(overloaded.status, 503)
  assert.equal(overloaded.upstreamMessage, '服务器被挤爆了，请稍后重试')

  const quota = parseUpstreamError({ meta_data: { last_error: { error_code: 10024 } } })
  assert.equal(quota.code, 'AGENTMORE_QUOTA')
  assert.equal(quota.status, 402)
  assert.equal(quota.upstreamMessage, '剩余积分不足，可购买积分充值包获得更多积分')

  const other = parseUpstreamError({ last_error: { error_code: 30001, err_msg: '模型不存在' } })
  assert.equal(other.code, 'AGENTMORE_UPSTREAM')
  assert.equal(other.status, 502)
  assert.equal(other.upstreamMessage, '上游错误 30001：模型不存在')

  const noMessage = parseUpstreamError({ last_error: { error_code: 7 } })
  assert.equal(noMessage.upstreamMessage, '上游错误 7')
})

test('statusError 只把 401/403 当凭据问题', () => {
  for (const status of [401, 403]) {
    const error = statusError(status)
    assert.equal(error.code, 'INVALID_CREDENTIAL')
    assert.equal(error.status, 401)
  }
  const other = statusError(500, '取模型列表')
  assert.equal(other.code, 'AGENTMORE_HTTP')
  assert.equal(other.status, 502)
  assert.equal(other.upstreamMessage, '取模型列表失败（HTTP 500）')
})

test('requestJson 组头、加 Bearer、并把 body 长度写进 Content-Length', async () => {
  let seen = null
  const payload = await requestJson({
    path: AGENTMORE_PATHS.userInfo,
    deviceId: 'dev-1',
    token: 'tok-1',
    body: { hello: '世界' },
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return json({ code: 0, result: { _id: 7 } })
    },
  })
  assert.equal(seen.url, AGENTMORE_ORIGIN + AGENTMORE_PATHS.userInfo)
  assert.equal(seen.init.method, 'GET')
  assert.equal(seen.init.redirect, 'error')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok-1')
  assert.equal(seen.init.headers['User-Agent'], AGENTMORE_USER_AGENT)
  assert.equal(seen.init.headers['X-Device-Id'], 'dev-1')
  assert.equal(seen.init.body, JSON.stringify({ hello: '世界' }))
  assert.equal(seen.init.headers['Content-Length'], String(Buffer.byteLength(seen.init.body, 'utf8')))
  assert.deepEqual(payload, { code: 0, result: { _id: 7 } })
})

test('requestJson 无 token 不加 Authorization，无 body 不加 Content-Length', async () => {
  let seen = null
  await requestJson({
    path: AGENTMORE_PATHS.clock,
    deviceId: 'dev-1',
    fetchImpl: async (_url, init) => {
      seen = init
      return json({ result: { timestamp_ms: 1 } })
    },
  })
  assert.equal('Authorization' in seen.headers, false)
  assert.equal('Content-Length' in seen.headers, false)
  assert.equal('body' in seen, false)
})

test('requestJson 空 body 返回 {}，坏 JSON 报 invalid_json', async () => {
  const empty = await requestJson({ path: '/x', deviceId: 'd', fetchImpl: async () => new Response('', { status: 200 }) })
  assert.deepEqual(empty, {})

  await assert.rejects(
    requestJson({ path: '/x', deviceId: 'd', fetchImpl: async () => new Response('not json', { status: 200 }) }),
    { code: 'AGENTMORE_INVALID_JSON', status: 502 },
  )
})

test('requestJson 非 2xx 走 statusError', async () => {
  await assert.rejects(
    requestJson({ path: '/x', deviceId: 'd', fetchImpl: async () => new Response('{}', { status: 401 }) }),
    { code: 'INVALID_CREDENTIAL', status: 401 },
  )
  await assert.rejects(
    requestJson({ path: '/x', deviceId: 'd', label: '取积分', fetchImpl: async () => new Response('{}', { status: 503 }) }),
    { code: 'AGENTMORE_HTTP', status: 502 },
  )
})

test('requestJson 传输失败保留 transportCode，且不泄漏上游文案', async () => {
  const failure = Object.assign(new Error('connect ECONNREFUSED secret-canary'), { code: 'ECONNREFUSED' })
  await assert.rejects(
    requestJson({ path: '/x', deviceId: 'd', fetchImpl: async () => { throw failure } }),
    (error) => {
      assert.equal(error.code, 'TRANSPORT')
      assert.equal(error.status, 502)
      assert.equal(error.transportCode, 'ECONNREFUSED')
      assert.equal(String(error.message).includes('secret-canary'), false)
      return true
    },
  )
})

test('requestJson 外部 abort 报 ABORTED，自身超时报 TIMEOUT', async () => {
  const external = new AbortController()
  const pending = requestJson({
    path: '/x',
    deviceId: 'd',
    signal: external.signal,
    fetchImpl: () => new Promise((_resolve, reject) => {
      external.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  external.abort()
  await assert.rejects(pending, { code: 'ABORTED', status: 499 })

  // 超时：假 fetch 必须在收到 abort 时拒绝，否则 requestJson 会永远等下去。
  await assert.rejects(
    requestJson({
      path: '/x',
      deviceId: 'd',
      timeoutMs: 20,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }),
    { code: 'TIMEOUT', status: 504 },
  )
})

test('unwrapResult 解一层 result/data，非 0 码抛业务错误', () => {
  assert.deepEqual(unwrapResult({ code: 0, result: { a: 1 } }), { a: 1 })
  assert.deepEqual(unwrapResult({ status: 200, data: { b: 2 } }), { b: 2 })
  assert.deepEqual(unwrapResult({ code: '0', result: [1] }), [1])
  assert.deepEqual(unwrapResult({ plain: true }), { plain: true })
  assert.deepEqual(unwrapResult(null), {})

  for (const code of [1, '500', -1]) {
    assert.throws(() => unwrapResult({ code, message: '积分不足' }), { code: 'AGENTMORE_BUSINESS', status: 502 })
  }
  assert.throws(
    () => unwrapResult({ code: 42 }),
    (error) => {
      assert.equal(error.upstreamMessage, '上游返回 42')
      return true
    },
  )
})

test('createClockOffsetResolver 用半 RTT 补偿，失败静默保持 0', async () => {
  let clock = 1_000
  const resolver = createClockOffsetResolver({
    now: () => clock,
    fetchImpl: async () => {
      clock += 400 // 往返 400ms → 半 RTT 200ms
      return json({ result: { timestamp_ms: 9_000_000 } })
    },
  })
  assert.equal(resolver.value, 0)
  assert.equal(resolver.calibrated, false)
  const offset = await resolver.ensure()
  assert.equal(resolver.calibrated, true)
  // remote + halfRtt - now = 9_000_000 + 200 - 1_400
  assert.equal(offset, 9_000_000 + 200 - 1_400)
  assert.equal(resolver.value, offset)
})

test('createClockOffsetResolver 单飞：并发 ensure 只打一次校时', async () => {
  let calls = 0
  const resolver = createClockOffsetResolver({
    fetchImpl: async () => {
      calls += 1
      await new Promise((resolve) => setImmediate(resolve))
      return json({ result: { timestamp_ms: 5 } })
    },
  })
  const [a, b, c] = await Promise.all([resolver.ensure(), resolver.ensure(), resolver.ensure()])
  assert.equal(calls, 1)
  assert.equal(a, b)
  assert.equal(b, c)
  await resolver.ensure()
  assert.equal(calls, 1, '已校准后不再请求')
})

test('createClockOffsetResolver 校时失败不抛错，refresh 可重试', async () => {
  let calls = 0
  let fail = true
  const resolver = createClockOffsetResolver({
    fetchImpl: async () => {
      calls += 1
      if (fail) throw new Error('secret-canary')
      return json({ result: { timestamp_ms: 1_234 } })
    },
  })
  assert.equal(await resolver.ensure(), 0)
  assert.equal(resolver.calibrated, false)

  fail = false
  await resolver.refresh()
  assert.equal(calls, 2)
  assert.equal(resolver.calibrated, true)
})

test('createClockOffsetResolver 忽略坏响应（非 2xx / 非正数时间戳）', async () => {
  for (const response of [
    new Response('{}', { status: 500 }),
    json({ result: {} }),
    json({ result: { timestamp_ms: 0 } }),
    json({ result: { timestamp_ms: 'abc' } }),
    json({ result: { timestamp_ms: -5 } }),
  ]) {
    const resolver = createClockOffsetResolver({ fetchImpl: async () => response.clone() })
    assert.equal(await resolver.ensure(), 0)
    assert.equal(resolver.calibrated, false)
  }
})
