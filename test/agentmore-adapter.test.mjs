import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentmoreAdapter, createAgentmoreModelService, flattenPrompt, normalizeReasoningEffort, GUEST_MESSAGE, AGENTMORE_REGION } from '../lib/agentmore-adapter.mjs'
import { agentmoreScope } from '../lib/agentmore-catalog.mjs'

const credential = (overrides = {}) => ({ id: 'acc-1', userId: 'u-1', deviceId: 'dev-1', accessToken: 'tok', ...overrides })

function memorySettings(initial = {}) {
  let current = { enabled: true, enabledModelIds: ['glm-5.3'], defaultReasoningEffort: null, contextWindowOverrides: {}, ...initial }
  return {
    read: async () => ({ ...current, enabledModelIds: [...current.enabledModelIds], contextWindowOverrides: { ...current.contextWindowOverrides } }),
    async patch(patch) {
      current = { ...current, ...patch }
      if (patch.contextWindowOverrides) {
        // 与真实存储一致：null 表示删除该模型的覆盖。
        const overrides = { ...current.contextWindowOverrides }
        for (const [id, size] of Object.entries(patch.contextWindowOverrides)) {
          if (size === null) delete overrides[id]
          else overrides[id] = size
        }
        current.contextWindowOverrides = overrides
      }
      return current
    },
    get current() { return current },
  }
}

const model = (overrides = {}) => ({
  id: 'glm-5.3',
  name: 'GLM-5.3',
  contextWindow: 1_000_000,
  maxContextWindow: 1_000_000,
  maxTokens: 128_000,
  inputModalities: ['text'],
  reasoningEfforts: ['low', 'high', 'max'],
  defaultReasoningEffort: 'max',
  ...overrides,
})

function fakeCatalog({ models = [model()], catalogSource = 'live', catalogError = null, scopeKey = agentmoreScope(credential()) } = {}) {
  const state = { loads: 0, invalidations: [], models, catalogSource, catalogError, scopeKey, force: false }
  return {
    state,
    async load({ force = false } = {}) {
      state.loads += 1
      state.force = force
      return { scopeKey: state.scopeKey, catalogSource: state.catalogSource, catalogError: state.catalogError, models: state.models }
    },
    invalidate(options = {}) { state.invalidations.push(options) },
  }
}

function fakeClient() {
  const calls = []
  const conversations = []
  return {
    calls,
    conversations,
    async createConversation(options) {
      conversations.push(options)
      return 'conv-created'
    },
    async streamResponse(options) {
      calls.push(options)
      return sseResponse([{ status: 'finish' }])
    },
  }
}

/** 真实的 fetch Response：`streamFrames` 只接受 Response，不接受裸事件流。 */
function sseResponse(frames, { status = 200 } = {}) {
  const encoder = new TextEncoder()
  const payload = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload))
        controller.close()
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** 永远不产出也不关闭的流，用于测空闲超时与 dispose 中断。 */
function neverEndingResponse() {
  return new Response(new ReadableStream({ start() {} }), { status: 200 })
}

/** 正文帧：同一 logic_id 的 content.text 是"到目前为止的全文"。 */
const textFrame = (text, { key = 'p1' } = {}) => ({ parts: [{ type: 'text', meta_data: { logic_id: key }, content: [{ type: 'text', text }] }] })
const thinkFrame = (text, { key = 'p2' } = {}) => ({ parts: [{ type: 'text', meta_data: { logic_id: key }, content: [{ type: 'think', text }] }] })
const FINISH = { status: 'finish' }

function clientReturning(frames, { status = 200 } = {}) {
  const calls = []
  return {
    calls,
    async streamResponse(options) {
      calls.push(options)
      return sseResponse(frames, { status })
    },
  }
}

/** 只有 streamResponse 行为的桩：仍提供 createConversation，空 conversationId 时会走到它。 */
function streamOnly(streamResponse) {
  return { calls: [], async createConversation() { return 'conv-created' }, streamResponse }
}

function clientFailing(error) {
  return {
    calls: [],
    async streamResponse() {
      throw Object.assign(new Error('fake'), error)
    },
  }
}

async function collect(iterator) {
  const out = []
  for await (const event of iterator) out.push(event)
  return out
}

function makeAdapter(overrides = {}) {
  const settings = overrides.settings ?? memorySettings()
  const catalog = overrides.catalog ?? fakeCatalog()
  // 空 conversationId 会触发建会话，所以任何 client 桩都必须带这个方法；
  // 只有这样各测试才能只关心自己要断言的那一个行为。
  const raw = overrides.client ?? fakeClient()
  const client = typeof raw.createConversation === 'function'
    ? raw
    : { ...raw, async createConversation() { return 'conv-created' } }
  const adapter = createAgentmoreAdapter({
    settings,
    catalog,
    readCredential: overrides.readCredential ?? (async () => credential()),
    client,
    resolveAgentId: overrides.resolveAgentId ?? (async () => 'ag-1'),
    beforeCall: overrides.beforeCall,
    idleTimeoutMs: overrides.idleTimeoutMs,
    onCredentialRejected: overrides.onCredentialRejected,
  })
  return { adapter, settings, catalog, client }
}

const streamOptions = (overrides = {}) => ({
  model: 'glm-5.3',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  tools: [],
  ...overrides,
})

// ---------------------------------------------------------------- 纯函数

test('normalizeReasoningEffort：映射到上游 low/high/max 三档', () => {
  // 上游没有"关思考"，最低档就是 low；medium 归 high；xhigh/max 归 max。
  for (const value of ['none', 'minimal', 'low']) assert.equal(normalizeReasoningEffort(value), 'low', value)
  for (const value of ['medium', 'high']) assert.equal(normalizeReasoningEffort(value), 'high', value)
  for (const value of ['xhigh', 'max']) assert.equal(normalizeReasoningEffort(value), 'max', value)
  // default 与未知值不发字段，交给上游自己的默认（max）。
  for (const value of ['default', 'weird']) assert.equal(normalizeReasoningEffort(value), null, value)
  for (const value of ['', null, undefined, 0, {}, []]) assert.equal(normalizeReasoningEffort(value), null, String(value))
})

test('flattenPrompt：system → 工具桥 → 历史 的空行分段', () => {
  const prompt = flattenPrompt(
    {
      system: '系统提示',
      messages: [
        { role: 'system', content: '消息里的系统提示' },
        { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
        { role: 'assistant', content: [{ type: 'text', text: '回答一' }] },
        { role: 'user', content: '第二轮' },
      ],
    },
    [],
  )
  assert.equal(prompt, '系统提示\n\n消息里的系统提示\n\n第一轮\n\n助手：回答一\n\n第二轮')
})

test('flattenPrompt：tool 结果写成「工具 X 的返回结果」，避免模型重复调用', () => {
  const prompt = flattenPrompt(
    {
      messages: [
        { role: 'user', content: '读文件' },
        { role: 'tool', content: '文件内容', source: { kind: 'tool', toolName: 'read' } },
        { role: 'tool', content: [{ type: 'text', text: 'B' }], source: { kind: 'tool', name: 'grep' } },
        { role: 'tool', content: '无名工具' },
      ],
    },
    [],
  )
  assert.equal(prompt.includes('工具 read 的返回结果：\n文件内容'), true)
  assert.equal(prompt.includes('工具 grep 的返回结果：\nB'), true)
  assert.equal(prompt.includes('工具 工具 的返回结果：\n无名工具'), true)
})

test('flattenPrompt：assistant 的 tool-call 块写回协议 JSON', () => {
  const prompt = flattenPrompt(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我看看' },
            { type: 'tool-call', name: 'read', arguments: '{"path":"/a"}' },
            { type: 'tool-call', name: 'list', arguments: { path: '/b' } },
          ],
        },
      ],
    },
    [],
  )
  assert.equal(prompt, '助手：我看看\n{"name":"read","arguments":{"path":"/a"}}\n{"name":"list","arguments":{"path":"/b"}}')
})

test('flattenPrompt：坏 JSON 的 tool-call arguments 退化为 {}', () => {
  const prompt = flattenPrompt({ messages: [{ role: 'assistant', content: [{ type: 'tool-call', name: 'x', arguments: '{oops' }] }] }, [])
  assert.equal(prompt, '助手：{"name":"x","arguments":{}}')
})

test('flattenPrompt：空输入返回空串；工具桥只在有工具时出现', () => {
  assert.equal(flattenPrompt({ messages: [] }, []), '')
  assert.equal(flattenPrompt({}, []), '')
  const bridged = flattenPrompt({ messages: [{ role: 'user', content: 'x' }] }, [{ name: 'read', description: '读', parameters: {} }])
  assert.equal(bridged.includes('{"name"'), true)
  assert.equal(bridged.split('\n\n').length >= 2, true)
})

// ---------------------------------------------------------------- provider DTO

test('providerInfo / providerRetryPolicy / 常量', () => {
  const { adapter } = makeAdapter()
  assert.deepEqual(adapter.providerInfo(), { id: 'agentmore', name: '智谱清言 Agent' })
  assert.deepEqual(adapter.providerInfo('custom'), { id: 'custom', name: '智谱清言 Agent' })
  assert.equal(adapter.providerRetryPolicy(), undefined)
  assert.equal(GUEST_MESSAGE, '该账号是游客身份，请先在 chatglm.cn 登录后重新授权')
  assert.equal(AGENTMORE_REGION, 'cn')
})

test('listModels：按偏好过滤，未登录返回空数组不抛', async () => {
  const { adapter } = makeAdapter({
    settings: memorySettings({ enabledModelIds: ['glm-5.3'] }),
    catalog: fakeCatalog({ models: [model(), model({ id: 'glm-5.3-flash', name: 'GLM-Flash', reasoningEfforts: [] })] }),
  })
  assert.deepEqual(await adapter.listModels(), [{ provider: 'agentmore', id: 'glm-5.3', name: 'GLM-5.3', inputModalities: ['text'] }])

  const { adapter: unlogged } = makeAdapter({ readCredential: async () => null })
  assert.deepEqual(await unlogged.listModels(), [])

  const changed = makeAdapter({ catalog: fakeCatalog({ scopeKey: 'OTHER' }) })
  assert.deepEqual(await changed.adapter.listModels(), [])

  const disabled = makeAdapter({ settings: memorySettings({ enabled: false }) })
  assert.deepEqual(await disabled.adapter.listModels(), [])
})

test('listModels：目录超时等非账号错误照样抛', async () => {
  const { adapter } = makeAdapter({
    catalog: {
      load: async () => { throw Object.assign(new Error('TIMEOUT'), { code: 'AGENTMORE_CATALOG_TIMEOUT' }) },
      invalidate() {},
    },
  })
  await assert.rejects(adapter.listModels(), { code: 'AGENTMORE_CATALOG_TIMEOUT' })
})

test('resolveModel：context 取覆盖值，三档 reasoning 原样透出', async () => {
  const { adapter } = makeAdapter({ settings: memorySettings({ contextWindowOverrides: { 'glm-5.3': 8_000 } }) })
  const resolved = await adapter.resolveModel('agentmore', 'glm-5.3')
  assert.equal(resolved.provider, 'agentmore')
  assert.equal(resolved.id, 'glm-5.3')
  assert.equal(resolved.name, 'GLM-5.3')
  assert.deepEqual(resolved.inputModalities, ['text'])
  assert.deepEqual(resolved.context, { contextWindow: 8_000 })
  assert.deepEqual(resolved.reasoning, { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }] })
})

test('resolveModel：无效覆盖值报 CONTEXT_INVALID；不支持推理的模型不带 reasoning', async () => {
  // 0/负数/半精度/字符串都会算出一个非法 contextWindow；null 表示"没有覆盖"，走模型默认值。
  for (const size of [0, -1, 1.5, '8000']) {
    const { adapter } = makeAdapter({ settings: memorySettings({ contextWindowOverrides: { 'glm-5.3': size } }) })
    await assert.rejects(adapter.resolveModel('agentmore', 'glm-5.3'), { code: 'AGENTMORE_CONTEXT_INVALID' }, String(size))
  }

  const { adapter: withNull } = makeAdapter({ settings: memorySettings({ contextWindowOverrides: { 'glm-5.3': null } }) })
  assert.equal((await withNull.resolveModel('agentmore', 'glm-5.3')).context.contextWindow, 1_000_000)

  const { adapter } = makeAdapter({ catalog: fakeCatalog({ models: [model({ reasoningEfforts: [] })] }) })
  assert.equal('reasoning' in await adapter.resolveModel('agentmore', 'glm-5.3'), false)
})

test('resolveModel：未启用 / 目录缺失 → MODEL_DISABLED；目录错误时透传错误码', async () => {
  const disabled = makeAdapter({ settings: memorySettings({ enabledModelIds: [] }) })
  await assert.rejects(disabled.adapter.resolveModel('agentmore', 'glm-5.3'), { code: 'AGENTMORE_MODEL_DISABLED', status: 409 })

  const missing = makeAdapter()
  await assert.rejects(missing.adapter.resolveModel('agentmore', 'nope'), { code: 'AGENTMORE_MODEL_DISABLED', status: 409 })

  const timedOut = makeAdapter({ catalog: fakeCatalog({ models: [], catalogError: 'AGENTMORE_CATALOG_TIMEOUT' }) })
  await assert.rejects(timedOut.adapter.resolveModel('agentmore', 'glm-5.3'), { code: 'AGENTMORE_CATALOG_TIMEOUT', status: 504 })

  const failed = makeAdapter({ catalog: fakeCatalog({ models: [], catalogError: 'AGENTMORE_CATALOG_FAILED' }) })
  await assert.rejects(failed.adapter.resolveModel('agentmore', 'glm-5.3'), { code: 'AGENTMORE_CATALOG_FAILED', status: 502 })
})

test('resolveModel：目录错误但模型存在时照常可用（回退列表照发）', async () => {
  const { adapter } = makeAdapter({ catalog: fakeCatalog({ catalogError: 'AGENTMORE_CATALOG_FAILED' }) })
  assert.equal((await adapter.resolveModel('agentmore', 'glm-5.3')).id, 'glm-5.3')
})

test('snapshot：未登录 → ACCOUNT_REQUIRED(401)；scope 不匹配 → ACCOUNT_CHANGED(409)', async () => {
  const noCredential = makeAdapter({ readCredential: async () => null })
  await assert.rejects(noCredential.adapter.resolveModel('agentmore', 'glm-5.3'), { code: 'AGENTMORE_ACCOUNT_REQUIRED', status: 401 })

  const changed = makeAdapter({ catalog: fakeCatalog({ scopeKey: 'OTHER' }) })
  await assert.rejects(changed.adapter.resolveModel('agentmore', 'glm-5.3'), { code: 'AGENTMORE_ACCOUNT_CHANGED', status: 409 })

  // scopeKey 为 null（目录回退）时不做身份比对
  const fallback = makeAdapter({ catalog: fakeCatalog({ scopeKey: null, catalogSource: 'fallback' }) })
  assert.equal((await fallback.adapter.resolveModel('agentmore', 'glm-5.3')).id, 'glm-5.3')
})

test('prepareCall：返回模型与 stream 绑定', async () => {
  const { adapter } = makeAdapter()
  const prepared = await adapter.prepareCall('agentmore', 'glm-5.3')
  assert.equal(prepared.model.id, 'glm-5.3')
  assert.equal(typeof prepared.stream, 'function')
})

test('signal：已 aborted 时立刻报 ABORTED(499)', async () => {
  const controller = new AbortController()
  controller.abort()
  const { adapter } = makeAdapter()
  await assert.rejects(adapter.resolveModel('agentmore', 'glm-5.3', controller.signal), { code: 'ABORTED', status: 499 })
  await assert.rejects(collect(adapter.stream(streamOptions({ signal: controller.signal }))), { code: 'ABORTED', status: 499 })
})

test('signal：准备阶段 abort 也会中断', async () => {
  const controller = new AbortController()
  const { adapter } = makeAdapter({
    resolveAgentId: () => new Promise(() => {}),
  })
  const pending = collect(adapter.stream(streamOptions({ signal: controller.signal })))
  controller.abort()
  await assert.rejects(pending, { code: 'ABORTED', status: 499 })
})

// ---------------------------------------------------------------- 事件翻译

test('stream：fake client 回帧，逐事件校验', async () => {
  const client = clientReturning([textFrame('你'), textFrame('你好'), FINISH])
  const { adapter } = makeAdapter({ client })
  const events = await collect(adapter.stream(streamOptions()))
  assert.deepEqual(events.map((event) => event.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(events[0], { type: 'block-start', index: 0, blockType: 'text' })
  assert.deepEqual(events[1], { type: 'text-delta', index: 0, text: '你' })
  assert.deepEqual(events[3], { type: 'block-end', index: 0, block: { type: 'text', text: '' } })
  assert.deepEqual(events[5], { type: 'finish', reason: 'stop' })
  assert.equal(events[4].usage.estimated, true)
  assert.equal(events[4].usage.inputTokens, Math.ceil('你好'.length / 2))
  assert.equal(events[4].usage.outputTokens, Math.ceil('你好'.length / 2))
})

test('stream：think 先出 reasoning 块，再切 text 块', async () => {
  const client = clientReturning([thinkFrame('想一想'), textFrame('答'), FINISH])
  const { adapter } = makeAdapter({ client })
  const events = await collect(adapter.stream(streamOptions()))
  assert.deepEqual(events.slice(0, 5), [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想一想' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '答' },
  ])
})

test('stream：status error / intervene 分别报 PROVIDER_ERROR 与 AGENTMORE_INTERVENED', async () => {
  for (const [value, code] of [['error', 'PROVIDER_ERROR'], ['intervene', 'AGENTMORE_INTERVENED']]) {
    const client = clientReturning([{ parts: [{ type: value }] }, FINISH])
    const { adapter } = makeAdapter({ client })
    await assert.rejects(collect(adapter.stream(streamOptions())), { code, status: 502 }, value)
  }
})

test('stream：有工具且正文里出现协议 JSON → tool-call 块 + finish reason tool-calls', async () => {
  const literal = '{"name":"read","arguments":{"path":"/a"}}'
  const client = clientReturning([textFrame('我来读：'), textFrame(`我来读：${literal}`), FINISH])
  const { adapter } = makeAdapter({ client })
  const events = await collect(adapter.stream(streamOptions({ tools: [{ name: 'read', description: '读文件', parameters: { path: '' } }] })))

  const call = events.find((event) => event.type === 'tool-call-delta')
  assert.equal(call.name, 'read')
  assert.match(call.id, /^call_[0-9a-f]{32}$/)
  assert.deepEqual(JSON.parse(call.argumentsDelta), { path: '/a' })

  const ended = events.find((event) => event.type === 'block-end' && event.block.type === 'tool-call')
  assert.deepEqual(JSON.parse(ended.block.arguments), { path: '/a' })
  assert.equal(ended.block.name, 'read')
  assert.equal(events.at(-1).reason, 'tool-calls')
})

test('stream：无工具时不解析协议 JSON，整段当正文', async () => {
  const literal = '{"name":"read","arguments":{"path":"/a"}}'
  const client = clientReturning([textFrame(literal), FINISH])
  const { adapter } = makeAdapter({ client })
  const events = await collect(adapter.stream(streamOptions({ tools: [] })))
  assert.equal(events.some((event) => event.type === 'tool-call-delta'), false)
  assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''), literal)
  assert.equal(events.at(-1).reason, 'stop')
})

test('stream：未配平的候选在流尾按正文吐出', async () => {
  const client = clientReturning([textFrame('看这个 {"name":"read"'), FINISH])
  const { adapter } = makeAdapter({ client })
  const events = await collect(adapter.stream(streamOptions({ tools: [{ name: 'read', description: '读', parameters: {} }] })))
  assert.equal(events.some((event) => event.type === 'tool-call-delta'), false)
  assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''), '看这个 {"name":"read"')
})

test('stream：请求体逐项对齐（prompt 拍平、effort、selectedModel、conversationId）', async () => {
  const client = fakeClient()
  const { adapter } = makeAdapter({ client })
  await collect(adapter.stream(streamOptions({
    system: '系统',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: 'hi' }],
  })))
  const [call] = client.calls
  assert.equal(call.agentId, 'ag-1')
  // 凭据里没有 conversationId 时必须先建会话，不能再把空串发给上游。
  assert.equal(call.conversationId, 'conv-created')
  assert.equal(client.conversations.length, 1)
  assert.equal(call.reasoningEffort, 'high')
  assert.equal(call.selectedModel, 'glm-5.3')
  assert.equal(call.prompt, '系统\n\nhi')
  assert.ok(call.signal instanceof AbortSignal)
})

test('stream：reasoningEffort 用偏好默认值；default 折成 null', async () => {
  const client = fakeClient()
  const { adapter } = makeAdapter({ client, settings: memorySettings({ defaultReasoningEffort: 'none' }) })
  await collect(adapter.stream(streamOptions()))
  assert.equal(client.calls[0].reasoningEffort, 'low')

  const nulled = fakeClient()
  const { adapter: adapter2 } = makeAdapter({ client: nulled, settings: memorySettings({ defaultReasoningEffort: 'default' }) })
  await collect(adapter2.stream(streamOptions()))
  assert.equal(nulled.calls[0].reasoningEffort, null)
})

test('stream：credential.conversationId 透传', async () => {
  const client = fakeClient()
  const { adapter } = makeAdapter({ client, readCredential: async () => credential({ conversationId: 'conv-1' }) })
  await collect(adapter.stream(streamOptions()))
  assert.equal(client.calls[0].conversationId, 'conv-1')
})

test('stream：准备阶段账号被切走 → ACCOUNT_CHANGED(409)', async () => {
  let reads = 0
  const { adapter } = makeAdapter({
    readCredential: async () => {
      reads += 1
      return reads === 1 ? credential() : credential({ userId: 'u-2' })
    },
    catalog: { load: async () => ({ scopeKey: null, catalogSource: 'fallback', catalogError: null, models: [model()] }), invalidate() {} },
  })
  await assert.rejects(collect(adapter.stream(streamOptions())), { code: 'AGENTMORE_ACCOUNT_CHANGED', status: 409 })
})

test('stream：beforeCall 收到内部 signal，且先于上游请求', async () => {
  const order = []
  const client = { calls: [], async streamResponse() { order.push('stream'); return sseResponse([FINISH]) } }
  const { adapter } = makeAdapter({ client, beforeCall: async (signal) => { order.push('before'); assert.ok(signal instanceof AbortSignal) } })
  await collect(adapter.stream(streamOptions()))
  assert.deepEqual(order, ['before', 'stream'])
})

test('stream：401 → 触发 onCredentialRejected；配额与过载各自翻译', async () => {
  const rejected = []
  const { adapter } = makeAdapter({
    client: { async streamResponse() { throw Object.assign(new Error('x'), { code: 'INVALID_CREDENTIAL' }) } },
    onCredentialRejected: async (cred) => rejected.push(cred.id),
  })
  await assert.rejects(collect(adapter.stream(streamOptions())), { code: 'INVALID_CREDENTIAL' })
  assert.deepEqual(rejected, ['acc-1'])

  for (const [code, mapped, status] of [['AGENTMORE_QUOTA', 'AGENTMORE_QUOTA', 402], ['AGENTMORE_OVERLOADED', 'AGENTMORE_OVERLOADED', 503]]) {
    const { adapter: failing } = makeAdapter({ client: { async streamResponse() { throw Object.assign(new Error('x'), { code }) } } })
    await assert.rejects(collect(failing.stream(streamOptions())), { code: mapped, status })
  }
})

test('stream：onCredentialRejected 自己抛错不影响原错误', async () => {
  const { adapter } = makeAdapter({
    client: { async streamResponse() { throw Object.assign(new Error('x'), { code: 'INVALID_CREDENTIAL' }) } },
    onCredentialRejected: async () => { throw new Error('cleanup failed') },
  })
  await assert.rejects(collect(adapter.stream(streamOptions())), { code: 'INVALID_CREDENTIAL' })
})

test('dispose：中断在飞流', async () => {
  // 永不产出的真实 Response：dispose 必须靠内部 AbortController 把它掐断。
  const client = { calls: [], async streamResponse() { return neverEndingResponse() } }
  const { adapter } = makeAdapter({ client })
  const pending = collect(adapter.stream(streamOptions()))
  await new Promise((resolve) => setImmediate(resolve))
  adapter.dispose()
  await assert.rejects(pending, { code: 'ABORTED', status: 499 })
})

// ---------------------------------------------------------------- modelService

function makeModelService(overrides = {}) {
  const settings = overrides.settings ?? memorySettings()
  const catalog = overrides.catalog ?? fakeCatalog({ models: [model(), model({ id: 'glm-5.3-flash', name: 'GLM-Flash' })] })
  const notes = []
  const service = createAgentmoreModelService({ settings, catalog, notify: () => notes.push('notify') })
  return { service, settings, catalog, notes }
}

test('modelService.status：serving 三条件 + region + 模型视图', async () => {
  const { service } = makeModelService()
  const state = await service.status()
  assert.equal(state.ok, true)
  assert.equal(state.region, 'cn')
  assert.equal(state.serving, false, '未注册前不算在服务')
  assert.equal(state.conflict, null)
  const flash = state.models.find((entry) => entry.id === 'glm-5.3-flash')
  assert.equal(flash.enabled, false)
  assert.equal(flash.contextWindowOverride, null)
  assert.equal(flash.effectiveContextWindow, 1_000_000)
})

test('modelService.status：registration 后 serving 变 true，冲突或禁用则回落', async () => {
  const { service } = makeModelService()
  service.registration(true)
  assert.equal((await service.status()).serving, true)

  service.registration(true, 'PORT_CONFLICT')
  const conflicted = await service.status()
  assert.equal(conflicted.serving, false)
  assert.equal(conflicted.conflict, 'PORT_CONFLICT')

  service.registration(true)
  await service.patch({ enabled: false })
  assert.equal((await service.status()).serving, false)

  await service.patch({ enabled: true, enabledModelIds: ['unknown-model'] })
  assert.equal((await service.status()).serving, false, '开启的模型不在目录里 → 不算在服务')
})

test('modelService.status：force 穿透目录缓存', async () => {
  const { service, catalog } = makeModelService()
  await service.status()
  assert.equal(catalog.state.force, false)
  await service.status({ force: true })
  assert.equal(catalog.state.force, true)
})

test('modelService.status：effectiveReasoningEffort 只给支持推理的模型', async () => {
  const { service } = makeModelService({
    catalog: fakeCatalog({ models: [model(), model({ id: 'glm-5.3-flash', reasoningEfforts: [] })] }),
  })
  const state = await service.status()
  assert.equal(state.models.find((entry) => entry.id === 'glm-5.3').effectiveReasoningEffort, 'max')
  assert.equal(state.models.find((entry) => entry.id === 'glm-5.3-flash').effectiveReasoningEffort, null)
})

test('modelService.patch：走 AGENTMORE 前缀校验并通知', async () => {
  const { service, notes } = makeModelService()
  await service.patch({ enabledModelIds: ['glm-5.3', 'glm-5.3-flash'] })
  assert.equal(notes.length, 1)

  // 注意：字面量 { __proto__: 1 } 在对象字面量里会被引擎当作原型设置而消失，
  // 必须用计算键构造真实的 "__proto__" 自有属性，才测得到防护分支。
  const protoKey = { ['__proto__']: 1 }
  for (const patch of [{ nope: 1 }, { enabled: 'yes' }, { enabledModelIds: ['bad id'] }, { defaultReasoningEffort: 'ultra' }, { contextWindowOverrides: protoKey }]) {
    await assert.rejects(service.patch(patch), { code: 'AGENTMORE_MODELS_INVALID' }, JSON.stringify(patch))
  }
})

test('modelService.patch：contextWindowOverrides 的 null 表示删除覆盖', async () => {
  const { service, settings } = makeModelService()
  await service.patch({ contextWindowOverrides: { 'glm-5.3': 4_000 } })
  assert.equal(settings.current.contextWindowOverrides['glm-5.3'], 4_000)
  await service.patch({ contextWindowOverrides: { 'glm-5.3': null } })
  assert.equal('glm-5.3' in settings.current.contextWindowOverrides, false)
})

test('modelService.refresh：强制刷新并通知', async () => {
  const { service, catalog, notes } = makeModelService()
  await service.refresh()
  assert.equal(catalog.state.force, true)
  assert.equal(notes.length, 1)
})

test('modelService.accountChanged：invalidate 保留磁盘缓存并通知', async () => {
  const { service, catalog, notes } = makeModelService()
  service.accountChanged()
  assert.deepEqual(catalog.state.invalidations, [{ keepCache: true }])
  assert.equal(notes.length, 1)
})

test('agentmoreScope 与 adapter 用的是同一份实现（换账号检测不会永远不等）', async () => {
  const cred = credential()
  const { adapter } = makeAdapter({ catalog: fakeCatalog({ scopeKey: agentmoreScope(cred) }) })
  assert.equal((await adapter.resolveModel('agentmore', 'glm-5.3')).id, 'glm-5.3')
})

// ── 空白 conversation_id 的自动建会话 ────────────────────────────────────────
//
// 现场（2026-10-15 用户报 AGENTMORE_STREAM_TRUNCATED）：凭据里的 conversationId 是空串，
// 插件把 `conversation_id: ""` 直接发给上游，上游回的是 **HTTP 200 + application/json**
// `{"status":500,"message":"internal server error"}` —— 不是 SSE。流消费层读到 EOF 却没见到
// finish 帧，于是抛 STREAM_TRUNCATED，用户只看到「本轮运行失败 / UNKNOWN」。
//
// 上游对空串、缺字段、null 三种写法行为一致（都 200+JSON 500），所以必须由插件先建会话。

test('stream：conversationId 为空时先建会话，再用新 id 发起对话', async () => {
  const created = []
  const calls = []
  const client = {
    created,
    calls,
    async createConversation({ credential: cred, agentId }) {
      created.push({ credential: cred, agentId })
      return 'conv-new'
    },
    async streamResponse(options) {
      calls.push(options)
      return sseResponse([{ status: 'finish' }])
    },
  }
  const { adapter } = makeAdapter({ client, readCredential: async () => credential({ conversationId: '' }) })
  await collect(adapter.stream(streamOptions()))
  assert.equal(created.length, 1, '空 conversationId 必须先建会话')
  assert.equal(created[0].agentId, 'ag-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].conversationId, 'conv-new', '对话必须用新建的会话 id')
})

test('stream：conversationId 缺失（undefined）同样先建会话', async () => {
  const created = []
  const client = {
    async createConversation() { created.push(1); return 'conv-x' },
    async streamResponse(options) { return sseResponse([{ status: 'finish' }]) },
  }
  const { adapter } = makeAdapter({ client, readCredential: async () => credential() })
  await collect(adapter.stream(streamOptions()))
  assert.equal(created.length, 1)
})

test('stream：已有 conversationId 时不建会话（保持原行为）', async () => {
  const created = []
  const client = {
    async createConversation() { created.push(1); return 'conv-should-not-use' },
    async streamResponse() { return sseResponse([{ status: 'finish' }]) },
  }
  const { adapter } = makeAdapter({ client, readCredential: async () => credential({ conversationId: 'conv-1' }) })
  await collect(adapter.stream(streamOptions()))
  assert.equal(created.length, 0)
})

test('stream：建会话失败时透传上游错误，不吞成 STREAM_TRUNCATED', async () => {
  const client = {
    async createConversation() { throw Object.assign(new Error('AGENTMORE_CONVERSATION'), { code: 'AGENTMORE_CONVERSATION', status: 502 }) },
    async streamResponse() { return sseResponse([{ status: 'finish' }]) },
  }
  const { adapter } = makeAdapter({ client, readCredential: async () => credential({ conversationId: '' }) })
  await assert.rejects(collect(adapter.stream(streamOptions())), { code: 'AGENTMORE_CONVERSATION' })
})
