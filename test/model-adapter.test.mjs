import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkBuddyAdapter } from '../lib/model-adapter.mjs'
import { credentialScope } from '../lib/model-catalog.mjs'

const credential = { backend: 'https://fixture.invalid', region: 'cn', accountId: 'account-a', headers: { ['Authorization']: 'Bearer synthetic', 'X-User-Id': 'fixture-uid' } }
const model = { id: 'fixture-model', name: 'Fixture', contextWindow: 32000, maxContextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }
const preference = () => ({ enabled: true, enabledModelIds: ['fixture-model'], defaultReasoningEffort: 'high', contextWindowOverrides: { 'fixture-model': 1000 } })
const response = (chunks) => new Response(chunks.map((chunk) => 'data: ' + (typeof chunk === 'string' ? chunk : JSON.stringify(chunk)) + '\r\n\r\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } })
const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events }
function fixture(overrides = {}) {
  let settings = preference(), current = credential, captured
  const adapter = createWorkBuddyAdapter({ settings: { read: async () => settings }, catalog: { load: async () => ({ models: [model], scopeKey: credentialScope(current) }) }, readCredential: async () => current, fetchImpl: async (url, options) => { captured = { url, ...options, body: JSON.parse(options.body) }; return response([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']) }, ...overrides })
  return { adapter, settings: (value) => { settings = value }, credential: (value) => { current = value }, captured: () => captured }
}
const options = { provider: 'workbuddy', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }

test('Host registration requires an explicit default retry policy contract', () => {
  const { adapter } = fixture()
  assert.equal(typeof adapter.providerRetryPolicy, 'function')
  assert.equal(adapter.providerRetryPolicy('workbuddy'), undefined)
})

for (const code of ['WORKBUDDY_CATALOG_FAILED', 'WORKBUDDY_CATALOG_TIMEOUT']) {
  test(`missing catalog reports ${code} instead of disabling a selected model`, async () => {
    const f = fixture({ catalog: { load: async () => ({ models: [], scopeKey: credentialScope(credential), catalogError: code }) } })
    await assert.rejects(f.adapter.resolveModel('workbuddy', model.id), { code, status: code.endsWith('TIMEOUT') ? 504 : 502 })
    await assert.rejects(collect(f.adapter.stream(options)), { code })
    assert.equal(f.captured(), undefined)
    f.settings({ ...preference(), enabled: false })
    await assert.rejects(f.adapter.resolveModel('workbuddy', model.id), { code: 'WORKBUDDY_MODEL_DISABLED' })
  })
}

test('real Host registration advertises and resolves selected WorkBuddy models', { skip: !process.env.DSH_LLM_TEST_MODULE }, async () => {
  const { LlmRuntime } = await import(process.env.DSH_LLM_TEST_MODULE)
  const f = fixture()
  const runtime = Object.create(LlmRuntime.prototype)
  runtime.adapters = new Map()
  runtime.ctx = {
    events: { dispatch: () => [] },
    effect(factory) {
      const effect = factory()
      const cleanup = effect.next().value
      return () => { cleanup?.(); effect.return() }
    },
  }
  const release = runtime.registerAdapter(['workbuddy'], f.adapter)
  try {
    assert.deepEqual(runtime.listProviders(), [{ id: 'workbuddy', name: 'WorkBuddy' }])
    assert.deepEqual((await runtime.listModels('workbuddy')).map(({ id }) => id), [model.id])
    const info = await runtime.resolveModelInfo('workbuddy', model.id)
    assert.equal(info.id, model.id)
    assert.equal(info.provider, 'workbuddy')
    assert.equal(f.captured(), undefined)
    f.settings({ ...preference(), enabledModelIds: [] })
    assert.deepEqual(await runtime.listModels('workbuddy'), [])
  } finally {
    release()
    f.adapter.dispose()
  }
  assert.deepEqual(runtime.listProviders(), [])
})

test('zero selection, disabled and missing account gate list, resolve and actual stream', async () => {
  const f = fixture()
  f.settings({ ...preference(), enabledModelIds: [] })
  assert.deepEqual(await f.adapter.listModels('workbuddy'), [])
  await assert.rejects(f.adapter.resolveModel('workbuddy', model.id), { code: 'WORKBUDDY_MODEL_DISABLED' })
  await assert.rejects(collect(f.adapter.stream(options)), { code: 'WORKBUDDY_MODEL_DISABLED' })
  f.settings({ ...preference(), enabled: false })
  assert.deepEqual(await f.adapter.listModels(), [])
  f.settings(preference()); f.credential(null)
  assert.deepEqual(await f.adapter.listModels(), [])
  await assert.rejects(f.adapter.resolveModel('workbuddy', model.id), { code: 'WORKBUDDY_ACCOUNT_REQUIRED' })
})

test('resolved capabilities and output reservation follow effective context and current effort', async () => {
  const f = fixture()
  assert.equal((await f.adapter.listModels())[0].provider, 'workbuddy')
  const resolved = await f.adapter.resolveModel('workbuddy', model.id)
  assert.equal(resolved.context.contextWindow, 1000)
  assert.equal(resolved.defaultMaxTokens, undefined)
  assert.equal(resolved.reasoning.defaultEffort, 'high')
  await collect((await f.adapter.prepareCall('workbuddy', model.id)).stream(options))
  assert.equal(f.captured().body.reasoning_effort, 'high')
  assert.ok(f.captured().body.max_tokens <= 1000)
  f.settings({ ...preference(), defaultReasoningEffort: 'medium' })
  await collect(f.adapter.stream(options))
  assert.equal(f.captured().body.reasoning_effort, 'low')
  await assert.rejects(collect(f.adapter.stream({ ...options, reasoningEffort: 'off' })), { code: 'WORKBUDDY_REASONING_INVALID' })
})

test('stream maps thinking, text, fragmented calls, usage and finish to real host events', async () => {
  const f = fixture({ fetchImpl: async () => response([
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { content: 'answer' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_fixture', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } }, '[DONE]',
  ]) })
  const events = await collect(f.adapter.stream(options))
  assert.equal(events.find((e) => e.type === 'reasoning-delta').text, 'think')
  assert.equal(events.find((e) => e.type === 'text-delta').text, 'answer')
  const call = events.find((e) => e.type === 'block-end' && e.block.type === 'tool-call').block
  assert.deepEqual(call, { type: 'tool-call', id: 'call_fixture', name: 'lookup', arguments: '{"q":1}' })
  assert.deepEqual(events.find((e) => e.type === 'usage').usage, { inputTokens: 16, outputTokens: 5, cacheReadTokens: 4, reasoningTokens: 2 })
  assert.deepEqual(events.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('Host text tool results retain source call IDs across a parallel tool round', async () => {
  const f = fixture()
  await collect(f.adapter.stream({ ...options, messages: [
    ...options.messages,
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'synthetic reasoning' },
      { type: 'tool-call', id: 'call_first', name: 'lookup', arguments: { index: 1 } },
      { type: 'tool-call', id: 'call_second', name: 'lookup', arguments: { index: 2 } },
    ] },
    { role: 'tool', source: { kind: 'tool', callId: 'call_first' }, content: [{ type: 'text', text: 'first result' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call_second' }, content: [{ type: 'text', text: 'second result' }] },
  ] }))
  const messages = f.captured().body.messages
  assert.deepEqual(messages.find((message) => message.role === 'assistant').tool_calls.map((call) => call.id), ['call_first', 'call_second'])
  assert.deepEqual(messages.filter((message) => message.role === 'tool'), [
    { role: 'tool', tool_call_id: 'call_first', content: 'first result' },
    { role: 'tool', tool_call_id: 'call_second', content: 'second result' },
  ])
})

test('Host source call ID takes precedence over a legacy result block ID', async () => {
  const f = fixture()
  await collect(f.adapter.stream({ ...options, messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_source', name: 'lookup', arguments: {} }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call_source' }, content: [{ type: 'tool-result', toolCallId: 'call_legacy', content: [{ type: 'text', text: 'result' }] }] },
  ] }))
  assert.equal(f.captured().body.messages.find((message) => message.role === 'tool').tool_call_id, 'call_source')
})

test('images, assistant calls, tool results and schema become upstream input without new network', async () => {
  const f = fixture({ attachments: { readImage: async () => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) }) } })
  await collect(f.adapter.stream({ ...options, system: 'system', tools: [{ name: 'lookup', description: 'lookup', parameters: { $schema: 'fixture', type: 'object' } }], messages: [
    { role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png' } }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_fixture', name: 'lookup', arguments: { q: 1 } }] },
    { role: 'user', source: { kind: 'tool' }, content: [{ type: 'tool-result', toolCallId: 'call_fixture', content: [{ type: 'text', text: 'result' }] }] },
  ] }))
  const body = f.captured().body
  assert.equal(f.captured().url, 'https://fixture.invalid/v2/chat/completions')
  assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,AQID')
  assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"q":1}')
  assert.equal(body.messages[3].tool_call_id, 'call_fixture')
  assert.equal(body.tools[0].function.parameters.$schema, undefined)
})

test('errors and truncation are sanitized; abort cancels a hanging read', async () => {
  for (const reply of [new Response('sensitive upstream', { status: 401 }), response([{ error: { message: 'sensitive upstream' } }]), response([{ choices: [{ delta: { content: 'partial' } }] }])]) {
    const f = fixture({ fetchImpl: async () => reply })
    await assert.rejects(collect(f.adapter.stream(options)), (error) => !error.message.includes('sensitive'))
  }
  let cancelled = false
  const controller = new AbortController()
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ pull() { controller.abort() }, cancel() { cancelled = true } })) })
  await assert.rejects(collect(f.adapter.stream({ ...options, signal: controller.signal })), { code: 'ABORTED' })
  assert.equal(cancelled, true)
})

test('changed scope between catalog and call never sends old capabilities with new identity', async () => {
  let sent = false
  const f = fixture({ catalog: { load: async () => ({ models: [model], scopeKey: 'old-scope' }) }, fetchImpl: async () => { sent = true } })
  await assert.rejects(collect(f.adapter.stream(options)), { code: 'WORKBUDDY_ACCOUNT_CHANGED' })
  assert.equal(sent, false)
})

test('caller abort and unload release a header wait even if transport ignores cancellation', async () => {
  for (const mode of ['caller', 'unload']) {
    let ready, requestSignal, timer
    const started = new Promise((resolve) => { ready = resolve })
    const controller = new AbortController()
    const f = fixture({ idleTimeoutMs: 300, fetchImpl: async (_, request) => { requestSignal = request.signal; ready(); return new Promise(() => {}) } })
    const request = collect(f.adapter.stream({ ...options, signal: controller.signal })).catch((error) => error)
    await started
    if (mode === 'caller') controller.abort()
    else f.adapter.dispose()
    let result
    try { result = await Promise.race([request, new Promise((resolve) => { timer = setTimeout(() => resolve({ code: 'WAIT_NOT_RELEASED' }), 80) })]) } finally { clearTimeout(timer) }
    assert.equal(requestSignal.aborted, true)
    assert.equal(result.code, 'ABORTED')
    assert.equal(result.status, 499)
  }
})

test('header timeout is bounded and classified even if transport ignores cancellation', async () => {
  const f = fixture({ idleTimeoutMs: 15, fetchImpl: async () => new Promise(() => {}) })
  await assert.rejects(collect(f.adapter.stream(options)), { code: 'TIMEOUT', status: 504 })
})

test('read timeout remains TIMEOUT when reader cancellation ends the pending read', async () => {
  let cancelled = false
  const f = fixture({ idleTimeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true } })) })
  await assert.rejects(collect(f.adapter.stream(options)), { code: 'TIMEOUT', status: 504 })
  assert.equal(cancelled, true)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function within50ms(pending) {
  let timer
  try { return await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve({ pending: true }), 50) })]) }
  finally { clearTimeout(timer) }
}

for (const stage of ['beforeCall', 'settings', 'catalog', 'credential', 'attachments', 'finalCredential']) {
  for (const action of ['abort', 'dispose']) {
    test(`preflight ${stage} ${action} settles without chat and permits a new invocation`, async () => {
      const entered = deferred(), gate = deferred()
      let paused = false, credentialReads = 0, requests = 0
      const pause = async (name) => {
        if (stage !== name || paused) return
        paused = true; entered.resolve(); await gate.promise
      }
      const f = fixture({
        beforeCall: () => pause('beforeCall'),
        settings: { read: async () => { await pause('settings'); return preference() } },
        catalog: { load: async () => { await pause('catalog'); return { models: [model], scopeKey: credentialScope(credential) } } },
        readCredential: async () => { await pause(++credentialReads === 1 ? 'credential' : 'finalCredential'); return credential },
        attachments: { readImage: async () => { await pause('attachments'); return { ref: { mediaType: 'image/png' }, data: new Uint8Array([1, 2, 3]) } } },
        fetchImpl: async () => { requests++; return response([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]']) },
      })
      const controller = new AbortController()
      const input = stage === 'attachments' ? { ...options, messages: [{ role: 'user', content: [{ type: 'image', attachment: 'synthetic-image' }] }] } : options
      const pending = collect(f.adapter.stream({ ...input, signal: controller.signal })).then((events) => ({ events }), (error) => ({ error }))
      try {
        await entered.promise
        if (action === 'abort') controller.abort(); else f.adapter.dispose()
        const result = await within50ms(pending)
        assert.equal(result.pending ?? false, false, 'cancelled preflight must settle within 50ms')
        assert.equal(result.error?.code, 'ABORTED')
        assert.equal(result.error?.status, 499)
        assert.equal(requests, 0)
        if (action === 'abort') gate.reject(new Error('synthetic-late-dependency-detail')); else gate.resolve()
        await new Promise(setImmediate)
        assert.equal(requests, 0, 'late preflight must not dispatch chat')
        const next = await collect(f.adapter.stream(input))
        assert.equal(next.at(-1)?.type, 'finish')
        assert.equal(requests, 1, 'a fresh invocation remains usable after cancellation')
      } finally {
        gate.resolve(); await pending; f.adapter.dispose()
      }
    })
  }
}

for (const code of [undefined, 'TIMEOUT']) {
  test(`reader failure with upstream code ${code ?? 'absent'} is sanitized as transport`, async () => {
    const error = new Error('synthetic-sensitive-reader-detail')
    if (code) Object.assign(error, { code, status: 504 })
    const reply = new Response(new ReadableStream({ start(controller) { controller.error(error) } }))
    const f = fixture({ fetchImpl: async () => reply })
    await assert.rejects(collect(f.adapter.stream(options)), { code: 'TRANSPORT', message: 'TRANSPORT', status: 502 })
    assert.equal(reply.body.locked, false)
  })
}

for (const action of ['abort', 'dispose']) {
  test(`immediate ${action} does not start a cancelled preflight callback`, async () => {
    let beforeCalls = 0, requests = 0
    const f = fixture({ beforeCall: async () => { beforeCalls++ }, fetchImpl: async () => { requests++; return response(['[DONE]']) } })
    const controller = new AbortController()
    const pending = collect(f.adapter.stream({ ...options, signal: controller.signal })).then((events) => ({ events }), (error) => ({ error }))
    if (action === 'abort') controller.abort(); else f.adapter.dispose()
    try {
      const result = await within50ms(pending)
      assert.equal(result.error?.code, 'ABORTED')
      assert.equal(result.error?.status, 499)
      assert.equal(beforeCalls, 0, 'cancelled callbacks must not begin after disposal')
      assert.equal(requests, 0)
    } finally { f.adapter.dispose(); await pending }
  })
}

test('reader transport carries an own sanitized failure payload for Host normalization', async () => {
  const f = fixture({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('synthetic-sensitive-host-detail')) } })) })
  await assert.rejects(collect(f.adapter.stream(options)), (error) => {
    assert.equal(Object.hasOwn(error, 'code'), true)
    assert.equal(error.code, 'TRANSPORT')
    assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'failure')?.value, { code: 'TRANSPORT', message: 'TRANSPORT', status: 502 })
    return true
  })
})

test('reader rejection does not override concurrent caller cancellation', async () => {
  const entered = deferred(), controller = new AbortController()
  let source
  const reply = new Response(new ReadableStream({ start(value) { source = value }, pull() { entered.resolve() } }, { highWaterMark: 0 }))
  const f = fixture({ fetchImpl: async () => reply })
  const pending = collect(f.adapter.stream({ ...options, signal: controller.signal })).then((events) => ({ events }), (error) => ({ error }))
  try {
    await entered.promise
    source.error(new Error('synthetic-sensitive-cancel-race-detail')); controller.abort()
    const result = await within50ms(pending)
    assert.equal(result.error?.code, 'ABORTED')
    assert.equal(result.error?.message, 'ABORTED')
    assert.equal(result.error?.status, 499)
    assert.equal(reply.body.locked, false)
  } finally { f.adapter.dispose(); await pending }
})

for (const [body, code] of [
  ['data: {invalid\n\n', 'WORKBUDDY_STREAM_INVALID'],
  ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'WORKBUDDY_STREAM_TRUNCATED'],
]) {
  test(`protocol failure ${code} is not misclassified as transport`, async () => {
    const reply = new Response(body)
    const f = fixture({ fetchImpl: async () => reply })
    await assert.rejects(collect(f.adapter.stream(options)), { code, status: 502 })
    assert.equal(reply.body.locked, false)
  })
}
