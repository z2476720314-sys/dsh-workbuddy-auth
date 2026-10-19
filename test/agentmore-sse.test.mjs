import assert from 'node:assert/strict'
import test from 'node:test'

import { createFrameNormalizer, diffText, streamFrames } from '../lib/agentmore-sse.mjs'

/** 用固定字符串分块造一个 SSE Response；chunks 里每项是一段原始文本。 */
function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
}

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const textPart = (text, extra = {}) => ({ type: 'text', content: [{ type: 'text', text }], ...extra })

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

test('diffText 四种语义', () => {
  assert.equal(diffText('', 'abc'), 'abc')
  assert.equal(diffText('abc', 'abc'), null)
  assert.equal(diffText('ab', 'abcd'), 'cd')
  assert.equal(diffText('abc', 'xyz'), 'xyz', '前缀被重写时整段当作增量')
  assert.equal(diffText('abc', 'xyz', true), 'xyz')
  assert.equal(diffText('abc', 'abc', true), 'abc', 'replace 优先于相等判断')
  assert.equal(diffText('', ''), null)
})

test('normalizer：首个帧锁定 conversation_id，后续帧不再产', () => {
  const normalizer = createFrameNormalizer()
  assert.equal(normalizer.conversationId, null)
  assert.deepEqual(normalizer.parse({ conversation_id: 'c-1', parts: [] }), [{ type: 'conversation', id: 'c-1' }])
  assert.equal(normalizer.conversationId, 'c-1')
  assert.deepEqual(normalizer.parse({ conversation_id: 'c-2', parts: [] }), [], '已锁定后不再产 conversation 事件')
  assert.equal(normalizer.conversationId, 'c-1')
})

test('normalizer：conversation_id 也可以来自 meta_data', () => {
  const normalizer = createFrameNormalizer()
  assert.deepEqual(normalizer.parse({ meta_data: { conversation_id: 'meta-c' } }), [{ type: 'conversation', id: 'meta-c' }])
})

test('normalizer：非对象帧与空帧产空事件', () => {
  const normalizer = createFrameNormalizer()
  assert.deepEqual(normalizer.parse(null), [])
  assert.deepEqual(normalizer.parse('x'), [])
  assert.deepEqual(normalizer.parse({}), [])
})

test('normalizer：帧级 status 与 parts 控制字面量都产 status 事件', () => {
  const normalizer = createFrameNormalizer()
  assert.deepEqual(normalizer.parse({ status: 'finish' }), [{ type: 'status', value: 'finish' }])
  assert.deepEqual(
    normalizer.parse({ parts: [{ type: 'finish' }, { type: 'error' }, { type: 'intervene' }] }),
    [{ type: 'status', value: 'finish' }, { type: 'status', value: 'error' }, { type: 'status', value: 'intervene' }],
  )
  assert.deepEqual(normalizer.parse({ status: '' }), [], '空 status 不算事件')
})

test('normalizer：add_input 与空 part 被跳过', () => {
  const normalizer = createFrameNormalizer()
  assert.deepEqual(normalizer.parse({ parts: [{ type: 'add_input', content: [{ type: 'text', text: 'x' }] }] }), [])
  assert.deepEqual(normalizer.parse({ parts: [null, 'x', 0] }), [])
  assert.deepEqual(normalizer.parse({ parts: 'not-an-array' }), [])
})

test('normalizer：同一 part 累积差分，只吐新增部分', () => {
  const normalizer = createFrameNormalizer()
  const part = (text) => ({ parts: [textPart(text, { meta_data: { logic_id: 'L1' } })] })
  assert.deepEqual(normalizer.parse(part('你')), [{ type: 'delta', text: '你', think: '' }])
  assert.deepEqual(normalizer.parse(part('你好')), [{ type: 'delta', text: '好', think: '' }])
  assert.deepEqual(normalizer.parse(part('你好')), [], '无变化不产事件')
  assert.deepEqual(normalizer.parse(part('你好世界')), [{ type: 'delta', text: '世界', think: '' }])
})

test('normalizer：不同 part key 各自独立累积', () => {
  const normalizer = createFrameNormalizer()
  const keyed = (logicId, text) => ({ parts: [textPart(text, { meta_data: { logic_id: logicId } })] })
  assert.deepEqual(normalizer.parse(keyed('A', 'aa')), [{ type: 'delta', text: 'aa', think: '' }])
  assert.deepEqual(normalizer.parse(keyed('B', 'bb')), [{ type: 'delta', text: 'bb', think: '' }])
  assert.deepEqual(normalizer.parse(keyed('A', 'aa+')), [{ type: 'delta', text: '+', think: '' }])
})

test('normalizer：key 回退顺序 logic_id → id → "part"', () => {
  const normalizer = createFrameNormalizer()
  assert.deepEqual(normalizer.parse({ parts: [textPart('a', { meta_data: { id: 'I1' } })] }), [{ type: 'delta', text: 'a', think: '' }])
  // 同 id 视为同一 part：新文本不以旧文本开头 → 整段当作增量
  assert.deepEqual(normalizer.parse({ parts: [textPart('b', { meta_data: { id: 'I1' } })] }), [{ type: 'delta', text: 'b', think: '' }])
  // 全无 key → 落到常量 'part'，与其他无 key part 共享同一累积
  assert.deepEqual(normalizer.parse({ parts: [textPart('x')] }), [{ type: 'delta', text: 'x', think: '' }])
  assert.deepEqual(normalizer.parse({ parts: [textPart('xy')] }), [{ type: 'delta', text: 'y', think: '' }])
})

test('normalizer：think 块单独差分，和正文互不干扰', () => {
  const normalizer = createFrameNormalizer()
  assert.deepEqual(
    normalizer.parse({ parts: [{ type: 'text', content: [{ type: 'think', text: '想' }] }] }),
    [{ type: 'delta', text: '', think: '想' }],
  )
  assert.deepEqual(
    normalizer.parse({ parts: [{ type: 'text', content: [{ type: 'think', text: '想好了' }, { type: 'text', text: '答' }] }] }),
    [{ type: 'delta', text: '答', think: '好了' }],
  )
})

test('normalizer：mc_tool_result2 回显块不进正文', () => {
  const normalizer = createFrameNormalizer()
  const echoed = {
    parts: [{
      type: 'text',
      content: [
        { type: 'text', text: 'ECHO-SECRET', meta_data: { show_type: 'mc_tool_result2' } },
        { type: 'text', text: '正文' },
      ],
    }],
  }
  const events = normalizer.parse(echoed)
  assert.deepEqual(events, [{ type: 'delta', text: '正文', think: '' }])
  assert.equal(JSON.stringify(events).includes('ECHO-SECRET'), false)
})

test('normalizer：frame 级 full / part 级 full 触发整段替换', () => {
  const partLevel = createFrameNormalizer()
  partLevel.parse({ parts: [textPart('abcdef', { meta_data: { logic_id: 'L' } })] })
  assert.deepEqual(partLevel.parse({ parts: [textPart('xy', { meta_data: { logic_id: 'L', full: true } })] }), [{ type: 'delta', text: 'xy', think: '' }])

  const frameLevel = createFrameNormalizer()
  frameLevel.parse({ parts: [textPart('abcdef', { meta_data: { logic_id: 'L' } })] })
  assert.deepEqual(frameLevel.parse({ meta_data: { full: true }, parts: [textPart('z', { meta_data: { logic_id: 'L' } })] }), [{ type: 'delta', text: 'z', think: '' }])
})

test('normalizer：last_error 抛错且不再吐正文', () => {
  const normalizer = createFrameNormalizer()
  assert.throws(
    () => normalizer.parse({ parts: [textPart('不该出现')], last_error: { error_code: 10024 } }),
    { code: 'AGENTMORE_QUOTA', status: 402 },
  )
  assert.throws(
    () => normalizer.parse({ last_error: { error_code: -1001 } }),
    { code: 'AGENTMORE_OVERLOADED', status: 503 },
  )
})

test('normalizer：content 非数组或块非法时安全降级', () => {
  const normalizer = createFrameNormalizer()
  assert.deepEqual(normalizer.parse({ parts: [{ type: 'text', content: 'x' }] }), [])
  assert.deepEqual(normalizer.parse({ parts: [{ type: 'text', content: [null, { type: 'text' }, { type: 'text', text: 5 }] }] }), [])
})

test('streamFrames：多帧流按序产事件并以 done 收尾', async () => {
  const chunks = [
    frame({ conversation_id: 'c-1' }),
    frame({ parts: [textPart('你', { meta_data: { logic_id: 'L' } })] }),
    frame({ parts: [textPart('你好', { meta_data: { logic_id: 'L' } })] }),
    frame({ parts: [{ type: 'finish' }] }),
  ]
  const events = await collect(streamFrames(sseResponse(chunks), { idleTimeoutMs: 5_000 }))
  assert.deepEqual(events, [
    { type: 'conversation', id: 'c-1' },
    { type: 'delta', text: '你', think: '' },
    { type: 'delta', text: '好', think: '' },
    { type: 'status', value: 'finish' },
    { type: 'done' },
  ])
})

test('streamFrames：跨 chunk 断行仍能正确拼帧', async () => {
  const payload = frame({ conversation_id: 'c-1', parts: [textPart('拼起来')] }) + frame({ status: 'finish' })
  const chunks = [payload.slice(0, 7), payload.slice(7, 20), payload.slice(20, 61), payload.slice(61)]
  const events = await collect(streamFrames(sseResponse(chunks), { idleTimeoutMs: 5_000 }))
  assert.deepEqual(events[0], { type: 'conversation', id: 'c-1' })
  assert.deepEqual(events[1], { type: 'delta', text: '拼起来', think: '' })
  assert.equal(events.at(-1).type, 'done')
})

test('streamFrames：CRLF 行尾兼容', async () => {
  const events = await collect(streamFrames(
    sseResponse([`data: ${JSON.stringify({ status: 'finish' })}\r\n\r\n`]),
    { idleTimeoutMs: 5_000 },
  ))
  assert.deepEqual(events, [{ type: 'status', value: 'finish' }, { type: 'done' }])
})

test('streamFrames：忽略 [DONE] / HEARTBEAT / 空 data / 非 data 行 / 坏 JSON', async () => {
  const events = await collect(streamFrames(
    sseResponse([
      'data: [DONE]\n\n',
      'data: HEARTBEAT\n\n',
      'data:   \n\n',
      ': comment line\n\n',
      'data: {not json\n\n',
      `data: ${JSON.stringify({ status: 'finish' })}\n\n`,
    ]),
    { idleTimeoutMs: 5_000 },
  ))
  assert.deepEqual(events, [{ type: 'status', value: 'finish' }, { type: 'done' }])
})

test('streamFrames：最后一帧缺换行也能被消费', async () => {
  const events = await collect(streamFrames(
    sseResponse([`data: ${JSON.stringify({ status: 'finish' })}`]),
    { idleTimeoutMs: 5_000 },
  ))
  assert.deepEqual(events, [{ type: 'status', value: 'finish' }, { type: 'done' }])
})

test('streamFrames：未收到 finish 就结束 → TRUNCATED', async () => {
  await assert.rejects(
    collect(streamFrames(sseResponse([frame({ conversation_id: 'c-1' })]), { idleTimeoutMs: 5_000 })),
    { code: 'AGENTMORE_STREAM_TRUNCATED', status: 502 },
  )
})

test('streamFrames：收到 finish 后立即停止读流', async () => {
  const events = await collect(streamFrames(
    sseResponse([frame({ status: 'finish' }), frame({ parts: [textPart('不该读到')] })]),
    { idleTimeoutMs: 5_000 },
  ))
  assert.deepEqual(events, [{ type: 'status', value: 'finish' }, { type: 'done' }])
})

test('streamFrames：非 2xx 分别映射 INVALID_CREDENTIAL / STREAM_INVALID', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(collect(streamFrames(sseResponse([], { status }), { idleTimeoutMs: 5_000 })), { code: 'INVALID_CREDENTIAL', status: 401 })
  }
  await assert.rejects(collect(streamFrames(sseResponse([], { status: 500 }), { idleTimeoutMs: 5_000 })), { code: 'AGENTMORE_STREAM_INVALID', status: 502 })
  await assert.rejects(collect(streamFrames(null, { idleTimeoutMs: 5_000 })), { code: 'AGENTMORE_STREAM_INVALID', status: 502 })
})

test('streamFrames：无 body 的 200 也算不可用流', async () => {
  await assert.rejects(
    collect(streamFrames(new Response(null, { status: 200 }), { idleTimeoutMs: 5_000 })),
    { code: 'AGENTMORE_STREAM_INVALID', status: 502 },
  )
})

test('streamFrames：空闲超时 → TIMEOUT 504', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {}\n\n')) } })
  await assert.rejects(
    collect(streamFrames(new Response(body, { status: 200 }), { idleTimeoutMs: 30 })),
    { code: 'TIMEOUT', status: 504 },
  )
})

test('streamFrames：外部 abort → ABORTED 499', async () => {
  const controller = new AbortController()
  const body = new ReadableStream({ start() { /* 永不产出 */ } })
  const pending = collect(streamFrames(new Response(body, { status: 200 }), { idleTimeoutMs: 5_000, signal: controller.signal }))
  controller.abort()
  await assert.rejects(pending, { code: 'ABORTED', status: 499 })
})

test('streamFrames：未换行缓冲超过 2MB → STREAM_INVALID', async () => {
  await assert.rejects(
    collect(streamFrames(sseResponse(['x'.repeat(2 * 1024 * 1024 + 10)]), { idleTimeoutMs: 5_000 })),
    { code: 'AGENTMORE_STREAM_INVALID', status: 502 },
  )
})

test('streamFrames：normalizer 可外部注入以共享对话状态', async () => {
  const normalizer = createFrameNormalizer()
  await collect(streamFrames(sseResponse([frame({ status: 'finish' })]), { idleTimeoutMs: 5_000, normalizer }))
  assert.equal(normalizer.conversationId, null)
})
