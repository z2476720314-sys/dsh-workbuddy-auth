/**
 * chatglm agent SSE 帧 → 归一化事件。
 *
 * 逐条对应 APK 里 `Ld/w;` 这个类的行为：
 *   * `Ld/w;->c(String acc, String incoming, boolean increase)` —— 增量差分
 *   * `Ld/w;->a(JSONObject frame) → ArrayList` —— 帧解析
 *
 * 上游帧形状（来自反汇编）：
 * ```json
 * {
 *   "meta_data": { "conversation_id": "...", "logic_id": "...", "id": "...",
 *                  "show_type": "mc_tool_result2", "full": true },
 *   "status": "finish",
 *   "parts": [ { "type": "text|add_input|error|intervene|finish",
 *                "meta_data": {...},
 *                "content": [ { "type": "text|think", "text": "..." } ] } ],
 *   "last_error": { "error_code": 0, "err_msg": "..." }
 * }
 * ```
 *
 * 关键点：`content[].text` 是**该 part 到目前为止的全文**，不是增量。
 * 因此每次都要和自己上一份快照做差分 —— 这就是 `Ld/w;->c` 存在的理由。
 */
import { parseUpstreamError } from './agentmore-protocol.mjs'

/** part 无可用 key 时的兜底（`Ld/w;->a` 里的常量 `"part"`）。 */
const DEFAULT_PART_KEY = 'part'

/** `show_type` 为该值的 text 块是工具结果回显，不进正文（否则会自我复读）。 */
const TOOL_RESULT_SHOW_TYPE = 'mc_tool_result2'

/** 帧级别的 part.type 里不需要任何处理的那一类。 */
const IGNORED_PART_TYPES = new Set(['add_input'])

/** `parts[].type` 里表示"回合结束/出错/被打断"的字面量。 */
const CONTROL_PART_TYPES = new Set(['finish', 'error', 'intervene'])

/**
 * `Ld/w;->c` 的等价实现：
 *   * `replace === true` → 直接返回 incoming（整段替换语义）
 *   * 相等 → null（无变化，不产事件）
 *   * incoming 以 acc 开头 → 返回后缀增量
 *   * 其余（上游重写了前缀，例如工具结果注入后重排）→ 返回整段
 *
 * 注意最后一条：不是返回 null 也不是返回空串。上游确实会出现"新文本不以旧文本开头"
 * 的情况（`mc_tool_result2` 回显被剔除后位置漂移），此时唯一安全的选择是把新内容
 * 整段当作增量吐出去，让下游看到完整的新状态。
 */
export function diffText(acc, incoming, replace = false) {
  if (replace) return incoming
  if (acc === incoming) return null
  if (incoming.startsWith(acc)) return incoming.slice(acc.length)
  return incoming
}

/** 文本块拼装：把 `content[]` 里同类块连起来（APK 用 StringBuilder append）。 */
function joinBlocks(blocks, wanted) {
  let out = ''
  for (const block of blocks) {
    if (!block || block.type !== wanted) continue
    const value = typeof block.text === 'string' ? block.text : ''
    if (value === '') continue
    out += value
  }
  return out
}

/**
 * 判断某个 text 块是否属于"工具结果回显"（必须跳过）。
 * APK 里这个标记可能落在块自身或块的 `meta_data` 上，两处都看。
 */
const isToolResultEcho = (block) =>
  block?.meta_data?.show_type === TOOL_RESULT_SHOW_TYPE || block?.show_type === TOOL_RESULT_SHOW_TYPE

/** 取 part 的累积键：`meta_data.logic_id` → `meta_data.id` → 常量。 */
function partKeyOf(part) {
  const meta = part?.meta_data
  for (const candidate of [meta?.logic_id, meta?.id]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return DEFAULT_PART_KEY
}

/**
 * 创建帧归一化器。一个对话流一个实例（状态：conversationId 是否已锁定、各 part 累积值）。
 *
 * 产出事件：
 *   * `{ type: 'conversation', id }` —— 首个带 conversation_id 的帧
 *   * `{ type: 'status', value }`    —— `finish` / `error` / `intervene` 或帧级 `status`
 *   * `{ type: 'delta', text, think }` —— 正文/思考增量（两者都空则不产）
 *
 * 抛错：帧里带非零 `last_error` 时抛 `AGENTMORE_*` 错误（见 parseUpstreamError）。
 */
export function createFrameNormalizer() {
  const parts = new Map()
  let conversationId = null

  return {
    /** 已锁定的 conversation_id（未锁定时为 null）。 */
    get conversationId() {
      return conversationId
    },

    /**
     * 解析一帧。
     * @param {unknown} frame
     * @returns {Array<{type:string}>}
     */
    parse(frame) {
      if (frame === null || typeof frame !== 'object') return []
      const events = []
      const meta = frame.meta_data ?? {}

      // 1) conversation_id 只取第一次（`if (!a)` 分支），后续帧忽略。
      if (conversationId === null) {
        const id = frame.conversation_id ?? meta.conversation_id
        if (typeof id === 'string' && id !== '') {
          conversationId = id
          events.push({ type: 'conversation', id })
        }
      }

      // 2) last_error 优先于一切 —— 出错时不应再往外吐正文。
      const error = parseUpstreamError(frame)
      if (error) throw error

      // 3) 帧级 status（与 parts 级控制字面量并列，二者都可能独立出现）。
      if (typeof frame.status === 'string' && frame.status !== '') {
        events.push({ type: 'status', value: frame.status })
      }

      const partList = Array.isArray(frame.parts) ? frame.parts : []
      for (const part of partList) {
        if (part === null || typeof part !== 'object') continue
        const partType = typeof part.type === 'string' ? part.type : ''
        if (IGNORED_PART_TYPES.has(partType)) continue
        if (CONTROL_PART_TYPES.has(partType)) {
          events.push({ type: 'status', value: partType })
          continue
        }

        const key = partKeyOf(part)
        const previous = parts.get(key) ?? { text: '', think: '' }
        const blocks = Array.isArray(part.content) ? part.content : []
        const textBlocks = blocks.filter((block) => block && block.type === 'text')
        // 纯工具结果回显的块不参与累积（否则正文会自我复读）。
        const visibleText = textBlocks.some(isToolResultEcho)
          ? joinBlocks(textBlocks.filter((block) => !isToolResultEcho(block)), 'text')
          : joinBlocks(textBlocks, 'text')
        const nextThink = joinBlocks(blocks, 'think')
        const replace = part.meta_data?.full === true || meta.full === true

        // 上游给的是"该 part 的全文"；和上一份快照做差分才是真正要吐的增量。
        const textDelta = diffText(previous.text, visibleText, replace)
        const thinkDelta = diffText(previous.think, nextThink, replace)
        parts.set(key, { text: visibleText, think: nextThink })

        const text = textDelta ?? ''
        const think = thinkDelta ?? ''
        if (text !== '' || think !== '') events.push({ type: 'delta', text, think })
      }

      return events
    },
  }
}

/**
 * 把上游流（`fetch` 的 Response）变成归一化事件序列。
 *
 * 与 `lib/model-adapter.mjs` 里 workbuddy 版本的关键差异：
 *   * 上游没有 `[DONE]`（APK 的 `Ld/o;->g` 只是"遇到就跳过"），结束靠流关闭 +
 *     `parts[].type === 'finish'` 的 status 事件；
 *   * 因此"是否正常结束"的判据是**收到了 finish status**，而不是哨兵行。
 */
export async function* streamFrames(response, { signal, idleTimeoutMs, normalizer = createFrameNormalizer() } = {}) {
  if (!response?.ok || !response.body) {
    const status = response?.status ?? 0
    throw Object.assign(new Error('upstream response is not a usable stream'), {
      code: status === 401 || status === 403 ? 'INVALID_CREDENTIAL' : 'AGENTMORE_STREAM_INVALID',
      status: status === 401 || status === 403 ? 401 : 502,
      exposeStatus: true,
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let finished = false
  const aborted = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', aborted, { once: true })

  try {
    while (!finished) {
      if (signal?.aborted) throw Object.assign(new Error('ABORTED'), { code: 'ABORTED', status: 499, exposeStatus: true })
      let timer
      let timeoutError
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timeoutError = Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT', status: 504, exposeStatus: true })
          reject(timeoutError)
          void reader.cancel().catch(() => {})
        }, idleTimeoutMs)
      })
      let chunk
      try {
        chunk = await Promise.race([reader.read(), timeout])
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('ABORTED'), { code: 'ABORTED', status: 499, exposeStatus: true })
        if (timeoutError && error === timeoutError) throw timeoutError
        throw Object.assign(new Error('TRANSPORT'), { code: 'TRANSPORT', status: 502, exposeStatus: true })
      } finally {
        clearTimeout(timer)
      }
      if (signal?.aborted) throw Object.assign(new Error('ABORTED'), { code: 'ABORTED', status: 499, exposeStatus: true })

      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      // 与 workbuddy 版本同一上限：2MB 未换行的单行说明上游在流非 SSE 内容。
      if (pending.length > 2 * 1024 * 1024) {
        throw Object.assign(new Error('AGENTMORE_STREAM_INVALID'), { code: 'AGENTMORE_STREAM_INVALID', status: 502, exposeStatus: true })
      }

      let newline
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        const events = consumeLine(line, normalizer)
        for (const event of events) {
          if (event.type === 'status' && event.value === 'finish') finished = true
          yield event
        }
      }

      if (chunk.done) {
        if (pending !== '') for (const event of consumeLine(pending, normalizer)) {
          if (event.type === 'status' && event.value === 'finish') finished = true
          yield event
        }
        break
      }
    }
    if (!finished) {
      throw Object.assign(new Error('AGENTMORE_STREAM_TRUNCATED'), { code: 'AGENTMORE_STREAM_TRUNCATED', status: 502, exposeStatus: true })
    }
    yield { type: 'done' }
  } finally {
    signal?.removeEventListener('abort', aborted)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * 单行 SSE 消费。对应 `Ld/o;->g(String) → JSONObject`：
 *   * 只处理 `data:` 前缀行
 *   * `[DONE]` 与 `HEARTBEAT` 直接跳过（上游会发心跳占位）
 *   * 解析失败**静默忽略**（APK 记一条日志继续）—— 上游偶尔会在流里插入非 JSON 行，
 *     为此中断整条回答是错的
 */
function consumeLine(line, normalizer) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return []
  const raw = trimmed.slice(5).trim()
  if (raw === '' || raw === '[DONE]' || raw === 'HEARTBEAT') return []
  let frame
  try {
    frame = JSON.parse(raw)
  } catch {
    return []
  }
  return normalizer.parse(frame)
}
