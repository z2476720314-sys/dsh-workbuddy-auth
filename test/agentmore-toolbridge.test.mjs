import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TOOL_BRIDGE_TEMPLATE,
  buildExample,
  buildToolBridgePrompt,
  createToolBridge,
  findBalancedEnd,
} from '../lib/agentmore-toolbridge.mjs'

const tools = [
  { name: 'read_file', description: '读取文件内容', parameters: { properties: { path: { type: 'string' } } } },
  { name: 'run_command', description: '执行命令', parameters: { properties: { command: { type: 'string' } } } },
]

/** 把若干 delta 依次 push，收集全部事件。 */
function feed(bridge, deltas) {
  const events = []
  for (const delta of deltas) events.push(...bridge.push(delta))
  return events
}

test('模板逐字保留协议原文（含占位符）', () => {
  assert.match(TOOL_BRIDGE_TEMPLATE, /^\[回复格式要求\]/)
  assert.match(TOOL_BRIDGE_TEMPLATE, /\{tool_definitions\}/)
  assert.match(TOOL_BRIDGE_TEMPLATE, /\{example\}/)
  assert.match(TOOL_BRIDGE_TEMPLATE, /\{"name": "操作名", "arguments": \{"参数名": "参数值"\}\}/)
  assert.match(TOOL_BRIDGE_TEMPLATE, /不要加 < > 之类的标签或标记/)
})

test('buildToolBridgePrompt：无可用工具返回空串', () => {
  assert.equal(buildToolBridgePrompt(), '')
  assert.equal(buildToolBridgePrompt([]), '')
  // null 由调用方 `tools ?? []` 兜住（adapter 恒这么传），实现本身只接受数组或省略。
  assert.equal(buildToolBridgePrompt(undefined), '')
  assert.equal(buildToolBridgePrompt([{ name: '' }, null, 'x', { description: '无名' }]), '')
})

test('buildToolBridgePrompt：填两条占位符并列出工具', () => {
  const prompt = buildToolBridgePrompt(tools)
  assert.equal(prompt.includes('{tool_definitions}'), false)
  assert.equal(prompt.includes('{example}'), false)
  assert.match(prompt, /- read_file\(path\)：读取文件内容/)
  assert.match(prompt, /- run_command\(command\)：执行命令/)
  assert.match(prompt, /示例：你回复的正文应当像这样（用实际内容替换参数值）：/)
  assert.match(prompt, /\{"name": "read_file", "arguments": \{"path": "\/tmp\/example\.txt"\}\}/)
})

test('buildToolBridgePrompt：描述截断到 40 字符并压掉换行', () => {
  const long = { name: 'x', description: `${'一'.repeat(60)}\n第二行`, parameters: { properties: {} } }
  const prompt = buildToolBridgePrompt([long])
  assert.match(prompt, /- x：一{40}\n/)
  assert.equal(prompt.includes('第二行'), false)
})

test('buildExample：无参数工具生成空 arguments', () => {
  assert.equal(buildExample([]), '')
  const example = buildExample([{ name: 'ping', parameters: { properties: {} } }])
  assert.equal(example, '示例：你回复的正文应当像这样：\n{"name": "ping", "arguments": {}}')
})

test('buildExample：参数名映射到示例值，未知参数用 value', () => {
  const cases = [
    ['path', '/tmp/example.txt'],
    ['file', '/tmp/example.txt'],
    ['command', 'echo hello'],
    ['cmd', 'echo hello'],
    ['content', '要写入的内容'],
    ['text', '要写入的内容'],
    ['url', 'https://example.com'],
    ['pattern', '*.kt'],
    ['whatever', 'value'],
  ]
  for (const [param, expected] of cases) {
    const example = buildExample([{ name: 'op', parameters: { properties: { [param]: { type: 'string' } } } }])
    assert.equal(example, `示例：你回复的正文应当像这样（用实际内容替换参数值）：\n{"name": "op", "arguments": {${JSON.stringify(param)}: ${JSON.stringify(expected)}}}`)
  }
})

test('findBalancedEnd：配平、字符串内括号、转义引号', () => {
  assert.equal(findBalancedEnd('{}', 0), 1)
  assert.equal(findBalancedEnd('{"a":{}}', 0), 7)
  assert.equal(findBalancedEnd('{"a":"}"}', 0), 8, '字符串里的 } 不计数')
  assert.equal(findBalancedEnd('{"a":"\\"}"}', 0), 10, '转义引号不结束字符串')
  assert.equal(findBalancedEnd('{"a":', 0), -1)
  assert.equal(findBalancedEnd('{"a":}', 0), 5)
})

test('findBalancedEnd：字符串外反斜杠不吞字符', () => {
  assert.equal(findBalancedEnd('{a\\}}', 0), 3, '字符串外的 \\ 不转义，紧跟的 } 正常配平')
})

test('bridge disabled：全部当正文，不扣留', () => {
  const bridge = createToolBridge({ enabled: false })
  const events = feed(bridge, ['{"name": "read_file", ', '"arguments": {"path": "/x"}}'])
  assert.deepEqual(events, [{ type: 'text', text: '{"name": "read_file", ' }, { type: 'text', text: '"arguments": {"path": "/x"}}' }])
  assert.equal(bridge.pending, 0)
})

test('bridge：无 { 的普通文本立即放行', () => {
  const bridge = createToolBridge()
  assert.deepEqual(bridge.push('你好世界'), [{ type: 'text', text: '你好世界' }])
  assert.equal(bridge.pending, 0)
})

test('bridge：完整调用被识别为 call，arguments 保留原类型', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['{"name": "read_file", "arguments": {"path": "/tmp/a", "n": 3, "ok": true}}'])
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'call')
  assert.equal(events[0].call.name, 'read_file')
  assert.deepEqual(events[0].call.arguments, { path: '/tmp/a', n: 3, ok: true })
  assert.match(events[0].call.id, /^call_[0-9a-f]{32}$/)
  assert.equal(bridge.pending, 0)
})

test('bridge：调用前后夹带的正文被切出来', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['我这就读：{"name": "read_file", "arguments": {"path": "/x"}}好了'])
  assert.deepEqual(events.map((event) => event.type), ['text', 'call', 'text'])
  assert.equal(events[0].text, '我这就读：')
  assert.equal(events[1].call.name, 'read_file')
  assert.equal(events[2].text, '好了')
})

test('bridge：跨 delta 断开的令牌被扣住，凑齐后识别', () => {
  const bridge = createToolBridge()
  assert.deepEqual(bridge.push('前缀{"na'), [{ type: 'text', text: '前缀' }])
  assert.equal(bridge.pending, 4, '半截 { "name" 前缀被扣住')
  assert.deepEqual(bridge.push('me": "read_file"'), [], '仍缺 arguments 收尾')
  const final = bridge.push(', "arguments": {}}')
  assert.deepEqual(final.map((event) => event.type), ['call'], '凑齐后一次性产 call')
  assert.equal(final[0].call.name, 'read_file')
  assert.equal(bridge.pending, 0)
})

test('bridge：多个调用各产一个 call 事件', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['{"name": "a", "arguments": {}}{"name": "b", "arguments": {}}'])
  assert.deepEqual(events.map((event) => event.type), ['call', 'call'])
  assert.deepEqual(events.map((event) => event.call.name), ['a', 'b'])
})

test('bridge：稀疏写法（name 不在首位）当正文放行', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['{"arguments": {}, "name": "a"}'])
  assert.equal(events.some((event) => event.type === 'call'), false)
  assert.equal(events.map((event) => event.text).join(''), '{"arguments": {}, "name": "a"}')
})

test('bridge：配平但非合法调用整段当正文', () => {
  // flush 的分块粒度是实现细节，只断言"文本总量等于原文、且不产 call"。
  for (const source of ['{"name": 123}', '{"name": ""}', '{"name": "a", "arguments": "not json"}', '{not json}']) {
    const copy = createToolBridge()
    const events = feed(copy, [source])
    assert.equal(events.some((event) => event.type === 'call'), false, `不应识别为调用：${source}`)
    assert.equal(events.map((event) => event.text).join(''), source, `应整段当正文：${source}`)
    assert.equal(copy.pending, 0, source)
  }
  const bridge = createToolBridge()
  const events = feed(bridge, ['{"name": "a", "arguments": [1]}'])
  assert.equal(events[0].type, 'call')
  assert.deepEqual(events[0].call.arguments, {}, 'arguments 是数组时按空对象处理')
})

test('bridge：arguments 为合法 JSON 字符串时被二次解析', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['{"name": "op", "arguments": "{\\"path\\": \\"/y\\"}"}'])
  assert.equal(events[0].type, 'call')
  assert.deepEqual(events[0].call.arguments, { path: '/y' })
})

test('bridge：括号未配平时扣住，end() 把残余当正文', () => {
  const bridge = createToolBridge()
  assert.deepEqual(bridge.push('{"name": "a", "arguments": {'), [])
  assert.ok(bridge.pending > 0)
  assert.deepEqual(bridge.end(), [{ type: 'text', text: '{"name": "a", "arguments": {' }])
  assert.equal(bridge.pending, 0)
  assert.deepEqual(bridge.end(), [])
})

test('bridge：end() 在缓冲为空时返回空数组', () => {
  const bridge = createToolBridge()
  bridge.push('纯文本')
  assert.deepEqual(bridge.end(), [])
})

test('bridge：非字符串 / 空 delta 被忽略', () => {
  const bridge = createToolBridge()
  assert.deepEqual(bridge.push(''), [])
  assert.deepEqual(bridge.push(null), [])
  assert.deepEqual(bridge.push(undefined), [])
  assert.deepEqual(bridge.push(42), [])
  assert.equal(bridge.pending, 0)
})

test('bridge：超长未配平缓冲整体放行（不无限扣留）', () => {
  const bridge = createToolBridge()
  const huge = `{"name": "a", "arguments": {"x": "${'y'.repeat(262144)}`
  const events = bridge.push(huge)
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'text')
  assert.equal(events[0].text.length, huge.length)
  assert.equal(bridge.pending, 0)
})

test('bridge：候选 JSON 里字符串含 unicode 花括号也能配平', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['{"name": "op", "arguments": {"text": "花括号 { } 在字符串里"}}'])
  assert.equal(events[0].type, 'call')
  assert.equal(events[0].call.arguments.text, '花括号 { } 在字符串里')
})

test('bridge：`{` 与 `"name"` 之间允许空白', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['{  \n "name"  :  "op", "arguments": {}}'])
  assert.equal(events[0].type, 'call')
  assert.equal(events[0].call.name, 'op')
})

test('bridge：连续裸 { 字节流不卡死，最终得到正文或调用', () => {
  const bridge = createToolBridge()
  const events = feed(bridge, ['{', '{', '{'])
  const all = [...events, ...bridge.end()]
  assert.equal(all.some((event) => event.type === 'call'), false)
  assert.equal(all.map((event) => event.text).join(''), '{{{')
})
