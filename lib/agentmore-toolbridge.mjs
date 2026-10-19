/**
 * 伪工具桥：让 chatglm 的 agent 侧"能调用工具"。
 *
 * 上游没有 function calling（请求体里根本没有 `tools` 字段）。APK 的做法是在 prompt 里
 * 约定一个纯文本协议 —— 模型在正文里直接吐一行 `{"name": ..., "arguments": {...}}`，
 * 客户端扫描正文把这一行抠出来当 tool call 执行。
 *
 * 本文件复刻两件事：
 *   1. prompt 侧：`Ld/A;-><clinit>` 的格式要求模板 + `Ld/o;->b` 的 `{tool_definitions}`
 *      与 `{example}` 填充规则
 *   2. 解析侧：`Ld/w;->b(textSink, toolCallSink, end)` 的流式扫描状态机
 *
 * 解析器必须是**流式**的：模型可能在 delta 中间把 `{"name":` 吐一半就换气，
 * 缓冲区里必须能跨 delta 累积，直到括号配对成功或判定失败。
 */
import { randomUUID } from 'node:crypto'

/** 单个候选 JSON 的上限：超过就整体当正文冲出去（`Ld/w;->b` 的 262144）。 */
const MAX_CANDIDATE_CHARS = 262144

/** 需要识别的前缀令牌：`{"name"`（含引号，比对时跳过中间空白）。 */
const NAME_TOKEN = '"name"'

/** 参数名的示例值猜测表（`Ld/o;->b` 的 `{example}` 分支）。 */
const EXAMPLE_VALUES = new Map([
  ['path', '/tmp/example.txt'],
  ['file', '/tmp/example.txt'],
  ['command', 'echo hello'],
  ['cmd', 'echo hello'],
  ['content', '要写入的内容'],
  ['text', '要写入的内容'],
  ['url', 'https://example.com'],
  ['pattern', '*.kt'],
])

/** 工具描述进 prompt 时的长度上限（APK 的 `substring(0, 40)`）。 */
const DESCRIPTION_LIMIT = 40

/**
 * `Ld/A;-><clinit>` 的模板原文。`{tool_definitions}` 与 `{example}` 由 fillPrompt 替换。
 * 这段文本是协议本身 —— 改一个字上游的解析率就会掉，因此逐字保留。
 */
export const TOOL_BRIDGE_TEMPLATE = `[回复格式要求]
本对话接入的客户端程序会解析你的回复文本。当需要文件读写或命令操作时，请在回复正文中直接输出一行 JSON（纯文本，不要包裹任何标签<>、不要使用任何特殊标记）：

{"name": "操作名", "arguments": {"参数名": "参数值"}}

可用操作名：
{tool_definitions}

{example}

注意：
1. 直接把这行 JSON 写在正文里（就像写代码块内容一样），不需要做任何"操作"或"调用"动作
2. 不要加 < > 之类的标签或标记，直接写 JSON 本身
3. 需要多个操作时，每个操作用单独一行 JSON 表示
4. 不需要操作时正常用自然语言回答`

/** 取工具的 properties 键（`Ld/A;->c(JSONObject) → List<String>`）。 */
function parameterNamesOf(tool) {
  const properties = tool?.parameters?.properties
  if (properties === null || typeof properties !== 'object') return []
  return Object.keys(properties)
}

/** 单行工具说明：`- name(a, b)：描述`。 */
function describeTool(tool) {
  const params = parameterNamesOf(tool).join(', ')
  const raw = typeof tool.description === 'string' ? tool.description : ''
  const description = raw.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_LIMIT)
  const head = params === '' ? `- ${tool.name}` : `- ${tool.name}(${params})`
  return description === '' ? head : `${head}：${description}`
}

/** 按参数名猜一个示例值。 */
const exampleValueFor = (param) => EXAMPLE_VALUES.get(param) ?? 'value'

/**
 * 生成 `{example}` 段。逻辑对应 `Ld/o;->b`：
 *   * 没有工具 → 空串
 *   * 工具无参数 → `{"name": "x", "arguments": {}}`
 *   * 工具有参数 → 用第一个参数名猜值，并提示"用实际内容替换参数值"
 */
export function buildExample(tools) {
  const first = tools[0]
  if (first === undefined) return ''
  const params = parameterNamesOf(first)
  const payload = params.length === 0
    ? `{"name": ${JSON.stringify(first.name)}, "arguments": {}}`
    : `{"name": ${JSON.stringify(first.name)}, "arguments": {${JSON.stringify(params[0])}: ${JSON.stringify(exampleValueFor(params[0]))}}}`
  return params.length === 0
    ? `示例：你回复的正文应当像这样：\n${payload}`
    : `示例：你回复的正文应当像这样（用实际内容替换参数值）：\n${payload}`
}

/**
 * 把模板填成最终 system 段。无工具时返回空串（不注入任何格式要求）。
 *
 * @param {Array<{name:string,description?:string,parameters?:object}>} tools
 * @returns {string}
 */
export function buildToolBridgePrompt(tools = []) {
  const usable = tools.filter((tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && tool.name !== '')
  if (usable.length === 0) return ''
  return TOOL_BRIDGE_TEMPLATE
    .replace('{tool_definitions}', usable.map(describeTool).join('\n'))
    .replace('{example}', buildExample(usable))
}

/**
 * 括号配对扫描：从 `start` 处的 `{` 开始找到与之匹配的 `}`。
 *
 * 三态机（`depth` / `inString` / `escape`）与 `Ld/w;->b` 完全一致：
 *   * 字符串内的 `{` `}` 不计数
 *   * 反斜杠转移下一个字符
 *   * 未配平返回 -1（说明缓冲还不够，等更多 delta）
 */
export function findBalancedEnd(source, start) {
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (escape) {
      escape = false
      continue
    }
    if (char === '\\') {
      if (inString) escape = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * 判断 `source[pos..]` 是否是 `{"name"` 前缀（允许 `{` 与 `"name"` 之间、以及 `"name"`
 * 与 `:` 之间有空白）。
 *
 * @returns {number} 命中时返回 `:` 之后的位置；未命中返回 -1。
 *   返回 -2 表示"看起来还是前缀，但缓冲不够"—— 调用方应停止扫描并等待更多输入，
 *   否则会把半截令牌当成正文冲出去。
 */
function matchNameCallPrefix(source, pos) {
  let index = pos
  const skipSpace = () => { while (index < source.length && /\s/.test(source[index])) index += 1 }
  if (source[index] !== '{') return -1
  index += 1
  skipSpace()
  for (let offset = 0; offset < NAME_TOKEN.length; offset += 1) {
    if (index + offset >= source.length) return -2
    if (source[index + offset] !== NAME_TOKEN[offset]) {
      // 稀疏写法（`{"arguments":...,"name":...`）不识别 —— 与 APK 一致，直接当正文。
      return -1
    }
  }
  index += NAME_TOKEN.length
  skipSpace()
  if (index >= source.length) return -2
  if (source[index] !== ':') return -1
  return index + 1
}

/** 从候选 JSON 文本里抽出 `{id, name, arguments}`；不合法返回 null。 */
function readCall(candidate) {
  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
  if (name === '') return null
  let args = parsed.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return null
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {}
  return { id: `call_${randomUUID().replaceAll('-', '')}`, name, arguments: args }
}

/**
 * 流式文本 → （正文增量 + 工具调用）的转换器。
 *
 * 用法：
 * ```js
 * const bridge = createToolBridge({ enabled: tools.length > 0 })
 * for (const event of bridge.push(deltaText)) { ... }
 * for (const event of bridge.end()) { ... }
 * ```
 *
 * `push` 返回的事件：
 *   * `{ type: 'text', text }`  —— 安全可下发的正文
 *   * `{ type: 'call', call }`  —— 解析出的工具调用
 *
 * 设计取舍：只有当缓冲里存在"可能长成工具调用"的前缀时才扣住文本（hold），
 * 其余情况一个字都不延迟 —— 否则普通对话会变成挤牙膏输出。
 */
export function createToolBridge({ enabled = true } = {}) {
  let buffer = ''

  const flushPlain = (upTo) => {
    const text = buffer.slice(0, upTo)
    buffer = buffer.slice(upTo)
    return text === '' ? [] : [{ type: 'text', text }]
  }

  return {
    /** 当前被扣住的字符数（诊断用）。 */
    get pending() {
      return buffer.length
    },

    push(delta) {
      if (typeof delta !== 'string' || delta === '') return []
      buffer += delta
      const events = []

      if (!enabled) {
        if (buffer !== '') events.push({ type: 'text', text: buffer })
        buffer = ''
        return events
      }

      // 逐个 `{` 尝试识别；识别不了就把它当普通字符放行。
      let index = 0
      while (index < buffer.length) {
        const brace = buffer.indexOf('{', index)
        if (brace === -1) {
          // 没有 `{`：全部安全，可以放行。
          events.push(...flushPlain(buffer.length))
          break
        }
        if (brace > 0) events.push(...flushPlain(brace))

        const afterColon = matchNameCallPrefix(buffer, 0)
        if (afterColon === -2) {
          // 缓冲还不足以判定，等更多输入。
          return events
        }
        if (afterColon === -1) {
          // 不是工具调用形状：这个 `{` 当普通字符放行，继续往后找。
          events.push(...flushPlain(1))
          index = 0
          continue
        }

        const end = findBalancedEnd(buffer, 0)
        if (end === -1) {
          // 括号还没配平，也可能只是超长文本块 —— 超限就整体放行。
          if (buffer.length > MAX_CANDIDATE_CHARS) {
            events.push(...flushPlain(buffer.length))
            index = 0
            break
          }
          return events
        }

        const candidate = buffer.slice(0, end + 1)
        const call = readCall(candidate)
        if (call === null) {
          // 配平了但不是合法调用：整段当正文（APK 同样退化成纯文本）。
          events.push(...flushPlain(end + 1))
          index = 0
          continue
        }
        events.push({ type: 'call', call })
        buffer = buffer.slice(end + 1)
        index = 0
      }
      return events
    },

    /** 流结束：把剩余缓冲原样吐出（未完成的候选也当正文）。 */
    end() {
      if (buffer === '') return []
      const text = buffer
      buffer = ''
      return [{ type: 'text', text }]
    },
  }
}
