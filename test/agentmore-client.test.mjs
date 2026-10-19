import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENTMORE_STREAM_IDLE_TIMEOUT_MS,
  GUEST_MESSAGE,
  buildStreamBody,
  createAgentmoreClient,
  parseConversationId,
  parseCreditBalance,
  parseModelList,
  parseRefreshResult,
  parseUserInfo,
} from '../lib/agentmore-client.mjs'
import { AGENTMORE_ORIGIN, AGENTMORE_PATHS } from '../lib/agentmore-protocol.mjs'

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
const credential = (overrides = {}) => ({ accessToken: 'at-1', deviceId: 'dev-1', ...overrides })

/** 造一个不依赖网络的 fetch：记录每个请求，按 path 决定响应。 */
function recordingFetch(routes = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    for (const [path, handler] of Object.entries(routes)) {
      if (url === AGENTMORE_ORIGIN + path) return typeof handler === 'function' ? handler(url, init) : handler
    }
    return json({ code: 0, result: {} })
  }
  impl.calls = calls
  return impl
}

/** 时钟校准总是先于业务请求发生，测试里统一给一个恒定响应。 */
const clockRoute = { [AGENTMORE_PATHS.clock]: () => json({ result: { timestamp_ms: 1 } }) }

const businessCalls = (fetchImpl) => fetchImpl.calls.filter((call) => call.url !== AGENTMORE_ORIGIN + AGENTMORE_PATHS.clock)

test('常量：游客提示与流空闲超时', () => {
  assert.equal(GUEST_MESSAGE, '该账号是游客身份，请先在 chatglm.cn 登录后重新授权')
  assert.equal(AGENTMORE_STREAM_IDLE_TIMEOUT_MS, 180_000)
})

test('parseModelList：选 selected_model 为 id，跳过关闭项与重复项', () => {
  const models = parseModelList({
    models: [
      // 真实目录项形态：档位 id 在 am_effort，effort 是上游内部值。
      {
        selected_model: 'glm-5.3',
        display_name: 'GLM-5.3',
        am_switch: true,
        chat_switch: true,
        reasoning_efforts: [
          { am_effort: 'max', effort: 'deep_thinking', display_name: '极致' },
          { am_effort: 'low', effort: '', display_name: '快速' },
          { am_effort: 'high', effort: 'thinking', display_name: '深度' },
        ],
      },
      { selected_model: 'glm-5.3', display_name: '重复' },
      { selected_model: 'gone', display_name: '关闭', am_switch: false },
      { selected_model: '', display_name: '无 id' },
      { selected_model: null },
      null,
      'x',
      { selected_model: 'glm-flash' },
    ],
  })
  assert.deepEqual(models.map((model) => model.id), ['glm-5.3', 'glm-flash'])
  assert.deepEqual(models[0], {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxContextWindow: 1_000_000,
    maxTokens: 128_000,
    inputModalities: ['text'],
    // 无论目录顺序如何，都按官方口径排 low → high → max。
    reasoningEfforts: ['low', 'high', 'max'],
    defaultReasoningEffort: 'max',
  })
  assert.equal(models[1].name, 'glm-flash', 'display_name 缺失时回落 id')
  assert.deepEqual(models[1].reasoningEfforts, [])
  assert.equal(models[1].defaultReasoningEffort, null)
})

test('parseModelList：档位只取 am_effort，effort 值（thinking/deep_thinking）绝不外泄', () => {
  const models = parseModelList({
    models: [{ selected_model: 'm', reasoning_efforts: [{ am_effort: 'high', effort: 'thinking' }] }],
  })
  assert.deepEqual(models[0].reasoningEfforts, ['high'])
  assert.equal(JSON.stringify(models).includes('thinking'), false)
})

test('parseModelList：am_switch 是能力位不是下架位（实测两项真实模型都是 true）', () => {
  // 2026-10-18 实测 /operation/detail?tag=available_models：glm-5.3 与 glm-5.3-flash
  // 都是 am_switch:true + chat_switch:true。旧代码把 true 当「已下架」跳过，
  // 结果活取恒为空数组、目录只能退回内置 fallback。
  const models = parseModelList({
    models: [
      { selected_model: 'glm-5.3', am_switch: true, chat_switch: true },
      { selected_model: 'glm-5.3-flash', am_switch: true, chat_switch: true },
    ],
  })
  assert.deepEqual(models.map((model) => model.id), ['glm-5.3', 'glm-5.3-flash'])
  // 只有显式关掉（false）才剔除。
  assert.deepEqual(parseModelList({ models: [{ selected_model: 'off', am_switch: false }] }), [])
})

test('parseModelList：非数组 / 缺字段给出空列表', () => {
  assert.deepEqual(parseModelList(null), [])
  assert.deepEqual(parseModelList({}), [])
  assert.deepEqual(parseModelList({ models: 'x' }), [])
})

test('parseModelList：name 截断到 160 字符', () => {
  const models = parseModelList({ models: [{ selected_model: 'm', display_name: '一'.repeat(200) }] })
  assert.equal(models[0].name.length, 160)
})

test('parseUserInfo：_id 支持数字与字符串，is_guest 严格比较', () => {
  assert.deepEqual(parseUserInfo({ code: 0, result: { _id: 12345, is_guest: false } }), { userId: '12345', isGuest: false })
  assert.deepEqual(parseUserInfo({ code: 0, result: { _id: 'abc', is_guest: true } }), { userId: 'abc', isGuest: true })
  assert.deepEqual(parseUserInfo({ result: {} }), { userId: '', isGuest: false })
  assert.deepEqual(parseUserInfo({ result: { _id: 1, is_guest: 'true' } }), { userId: '1', isGuest: false }, '字符串 true 不算游客')
  assert.deepEqual(parseUserInfo({ result: { _id: { nested: 1 } } }), { userId: '', isGuest: false })
})

test('parseUserInfo：业务错误码照样抛', () => {
  assert.throws(() => parseUserInfo({ code: 401, message: 'token 失效' }), { code: 'AGENTMORE_BUSINESS', status: 502 })
})

test('parseCreditBalance：读 member_info.left_score', () => {
  assert.deepEqual(parseCreditBalance({ result: { member_info: { left_score: 42 } } }), { remaining: 42, display: '42' })
  assert.deepEqual(parseCreditBalance({ result: { member_info: { left_score: '3.5' } } }), { remaining: 3.5, display: '3.5' })
  assert.deepEqual(parseCreditBalance({ result: { member_info: { left_score: -7 } } }), { remaining: -7, display: '-7' })
  assert.equal(parseCreditBalance({ result: {} }), null)
  assert.equal(parseCreditBalance({ result: { member_info: { left_score: 'abc' } } }), null)
  assert.equal(parseCreditBalance({ result: { member_info: { left_score: null } } }), null)
  assert.equal(parseCreditBalance({ result: { member_info: { left_score: Infinity } } }), null)
})

test('parseRefreshResult：缺 access_token 报错，refresh_token 可缺', () => {
  assert.deepEqual(parseRefreshResult({ result: { access_token: 'a2', refresh_token: 'r2' } }), { accessToken: 'a2', refreshToken: 'r2' })
  assert.deepEqual(parseRefreshResult({ result: { access_token: 'a2' } }), { accessToken: 'a2', refreshToken: '' })
  assert.throws(() => parseRefreshResult({ result: {} }), { code: 'AGENTMORE_REFRESH', status: 502 })
  assert.throws(() => parseRefreshResult({ result: { access_token: '' } }), { code: 'AGENTMORE_REFRESH', status: 502 })
})

test('parseConversationId：result.data 与 result 两处都认', () => {
  assert.equal(parseConversationId({ result: { data: { conversation_id: 'c-1' } } }), 'c-1')
  assert.equal(parseConversationId({ result: { conversation_id: 'c-2' } }), 'c-2')
  assert.throws(() => parseConversationId({ result: {} }), { code: 'AGENTMORE_CONVERSATION', status: 502 })
  assert.throws(() => parseConversationId({ result: { conversation_id: '' } }), { code: 'AGENTMORE_CONVERSATION', status: 502 })
})

test('buildStreamBody：只有一条 user 消息，meta_data 可选字段按需出现', () => {
  const body = buildStreamBody({ agentId: 'ag', conversationId: 'c', prompt: '你好' })
  assert.deepEqual(body, {
    agent_id: 'ag',
    conversation_id: 'c',
    meta_data: { platform: 'pc' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })

  const full = buildStreamBody({ agentId: 'ag', conversationId: 'c', prompt: 'p', reasoningEffort: 'high', selectedModel: 'glm-5.3' })
  assert.deepEqual(full.meta_data, { platform: 'pc', reasoning_effort: 'high', selected_model: 'glm-5.3' })

  const empty = buildStreamBody({ agentId: 'ag', conversationId: 'c', prompt: 'p', reasoningEffort: '', selectedModel: '' })
  assert.deepEqual(empty.meta_data, { platform: 'pc' }, '空串不写进 meta_data')
})

test('client.userInfo：带签名头与 Bearer，解析身份', async () => {
  const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.userInfo]: () => json({ result: { _id: 9, is_guest: false } }) })
  const client = createAgentmoreClient({ fetchImpl })
  assert.deepEqual(await client.userInfo(credential()), { userId: '9', isGuest: false })
  const [call] = businessCalls(fetchImpl)
  assert.equal(call.init.headers.Authorization, 'Bearer at-1')
  assert.equal(call.init.headers['X-Device-Id'], 'dev-1')
  assert.equal(call.init.redirect, 'error')
})

test('client.credits：解析积分', async () => {
  const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.userInfo]: () => json({ result: { member_info: { left_score: 100 } } }) })
  const client = createAgentmoreClient({ fetchImpl })
  assert.deepEqual(await client.credits(credential()), { remaining: 100, display: '100' })
})

test('client.refresh：成功后回写新令牌，refresh_token 缺失时保留旧值', async () => {
  const written = []
  const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.refresh]: () => json({ result: { access_token: 'a2' } }) })
  const client = createAgentmoreClient({ fetchImpl, writeCredential: async (next) => written.push(next), now: () => 777 })
  const result = await client.refresh(credential({ refreshToken: 'r1' }))
  assert.deepEqual(result, { accessToken: 'a2', refreshToken: '' })
  assert.equal(written.length, 1)
  assert.deepEqual(written[0], { accessToken: 'a2', deviceId: 'dev-1', refreshToken: 'r1', refreshedAt: 777 })

  const [call] = businessCalls(fetchImpl)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.body, '{}')
})

test('client.refresh：并发共享一次在飞请求（避免轮换互相作废）', async () => {
  let calls = 0
  const fetchImpl = recordingFetch({
    ...clockRoute,
    [AGENTMORE_PATHS.refresh]: async () => {
      calls += 1
      await new Promise((resolve) => setImmediate(resolve))
      return json({ result: { ['access_token']: `a${calls}` } })
    },
  })
  const client = createAgentmoreClient({ fetchImpl })
  const [a, b] = await Promise.all([client.refresh(credential()), client.refresh(credential())])
  assert.equal(calls, 1)
  assert.deepEqual(a, b)
})

test('client.refresh：失败后允许重试（在飞标记被清掉）', async () => {
  let attempt = 0
  const fetchImpl = recordingFetch({
    ...clockRoute,
    [AGENTMORE_PATHS.refresh]: () => {
      attempt += 1
      return attempt === 1 ? json({ result: {} }) : json({ result: { access_token: 'ok' } })
    },
  })
  const client = createAgentmoreClient({ fetchImpl })
  await assert.rejects(client.refresh(credential()), { code: 'AGENTMORE_REFRESH' })
  assert.deepEqual(await client.refresh(credential()), { accessToken: 'ok', refreshToken: '' })
})

test('client.models：走目录端点并解析', async () => {
  const fetchImpl = recordingFetch({
    ...clockRoute,
    [AGENTMORE_PATHS.models]: () => json({ result: { models: [{ selected_model: 'glm-5.3', display_name: 'GLM-5.3' }] } }),
  })
  const client = createAgentmoreClient({ fetchImpl })
  assert.deepEqual((await client.models(credential())).map((model) => model.id), ['glm-5.3'])
})

test('client.agents：解包 result 原样返回', async () => {
  const payload = { list: [{ meta_data: { type: 'agent' } }] }
  const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.agents]: () => json({ result: payload }) })
  const client = createAgentmoreClient({ fetchImpl })
  assert.deepEqual(await client.agents(credential()), payload)
})

test('client.createConversation：POST agent_id 并取出 conversation_id', async () => {
  const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.conversation]: () => json({ result: { data: { conversation_id: 'c-9' } } }) })
  // createConversation 走统一的 call()，其中的 deviceId 取自 readCredential（装配层恒定提供）。
  const client = createAgentmoreClient({ fetchImpl, readCredential: async () => credential() })
  assert.equal(await client.createConversation({ credential: credential(), agentId: 'ag-1' }), 'c-9')
  const [call] = businessCalls(fetchImpl)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['X-Device-Id'], 'dev-1')
  assert.deepEqual(JSON.parse(call.init.body), { agent_id: 'ag-1' })
})

test('client.streamResponse：头与 body 逐项对齐 APK', async () => {
  const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.stream]: () => new Response('', { status: 200 }) })
  const client = createAgentmoreClient({ fetchImpl })
  await client.streamResponse({ credential: credential(), agentId: 'ag', conversationId: 'c', prompt: '问', reasoningEffort: 'high', selectedModel: 'glm-5.3' })

  const [call] = businessCalls(fetchImpl)
  const { headers, body, method, redirect } = call.init
  assert.equal(method, 'POST')
  assert.equal(redirect, 'error')
  assert.equal(headers.Accept, 'text/event-stream, text/event-stream', '刻意重复的 Accept 必须保留')
  assert.equal(headers.Authorization, 'Bearer at-1')
  assert.equal(headers['X-Device-Id'], 'dev-1')
  assert.equal(headers['Content-Length'], String(Buffer.byteLength(body, 'utf8')))
  assert.deepEqual(JSON.parse(body), {
    agent_id: 'ag',
    conversation_id: 'c',
    meta_data: { platform: 'pc', reasoning_effort: 'high', selected_model: 'glm-5.3' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '问' }] }],
  })
})

test('client.streamResponse：非 2xx 走 statusError', async () => {
  for (const [status, expected] of [[401, 'INVALID_CREDENTIAL'], [403, 'INVALID_CREDENTIAL'], [500, 'AGENTMORE_HTTP']]) {
    const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.stream]: () => new Response('', { status }) })
    const client = createAgentmoreClient({ fetchImpl })
    await assert.rejects(
      client.streamResponse({ credential: credential(), agentId: 'a', conversationId: 'c', prompt: 'p' }),
      { code: expected },
      String(status),
    )
  }
})

test('client.streamResponse：传输失败报 TRANSPORT，不泄漏原因', async () => {
  const fetchImpl = recordingFetch({
    ...clockRoute,
    [AGENTMORE_PATHS.stream]: () => { throw new Error('socket hang up secret-canary') },
  })
  const client = createAgentmoreClient({ fetchImpl })
  await assert.rejects(
    client.streamResponse({ credential: credential(), agentId: 'a', conversationId: 'c', prompt: 'p' }),
    (error) => {
      assert.equal(error.code, 'TRANSPORT')
      assert.equal(String(error.message).includes('secret-canary'), false)
      return true
    },
  )
})

test('client.streamResponse：外部 abort 报 ABORTED', async () => {
  const controller = new AbortController()
  const fetchImpl = recordingFetch({
    ...clockRoute,
    [AGENTMORE_PATHS.stream]: (_url, init) => new Promise((_resolve, reject) => {
      // 已 aborted 的 signal 不会再触发事件；必须先查一次，否则这里永久挂起。
      if (init.signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  const client = createAgentmoreClient({ fetchImpl })
  const pending = client.streamResponse({ credential: credential(), agentId: 'a', conversationId: 'c', prompt: 'p', signal: controller.signal })
  // 让 streamResponse 走到 fetch 之后再 abort，才是"外部中断在飞请求"的真实时序。
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, { code: 'ABORTED', status: 499 })
})

test('client 先校时再发业务请求，且只校一次', async () => {
  const fetchImpl = recordingFetch({ ...clockRoute, [AGENTMORE_PATHS.userInfo]: () => json({ result: { _id: 1 } }) })
  const client = createAgentmoreClient({ fetchImpl })
  await client.userInfo(credential())
  await client.userInfo(credential())
  const clockCalls = fetchImpl.calls.filter((call) => call.url === AGENTMORE_ORIGIN + AGENTMORE_PATHS.clock)
  assert.equal(clockCalls.length, 1)
  assert.equal(fetchImpl.calls[0].url, AGENTMORE_ORIGIN + AGENTMORE_PATHS.clock, '校时必须是第一个请求')
})

test('client 校时失败不影响业务请求（降级为 0 偏移）', async () => {
  const fetchImpl = recordingFetch({
    [AGENTMORE_PATHS.clock]: () => { throw new Error('clock down') },
    [AGENTMORE_PATHS.userInfo]: () => json({ result: { _id: 3 } }),
  })
  const client = createAgentmoreClient({ fetchImpl })
  assert.deepEqual(await client.userInfo(credential()), { userId: '3', isGuest: false })
  assert.equal(client.clock.calibrated, false)
})
