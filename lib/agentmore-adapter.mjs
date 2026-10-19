/**
 * agentmore LLM adapter：把 DSH 的 OpenAI 形状翻译成 chatglm agent 协议，再翻回来。
 *
 * 三层职责，逐层对照 APK：
 *
 *   1. **prompt 拍平**（`Ld/o;->b`）
 *      上游 `/stream` 只接受 `messages: [ { role: 'user', content: [{type:'text'}] } ]`
 *      —— 一条消息。所有 system / 历史 / 工具结果必须由插件自己拼成一段文本。
 *
 *   2. **事件翻译**（`Ld/w;` + `Ld/i;->c`）
 *      SSE 帧 → `{ text, think, conversation_id, status }` → DSH 的
 *      `block-start / text-delta / reasoning-delta / block-end` 事件流。
 *
 *   3. **伪工具桥**（`agentmore-toolbridge.mjs`）
 *      正文里抠 `{"name": ...}` → `tool-call-delta` 事件。
 *
 * 和 WorkBuddy 那份 adapter 的结构刻意保持同形（同样的 `snapshot` / `selected` /
 * `waitFor` 骨架、同样的错误码词汇），这样 `index.mjs` 里两处注册代码几乎对称，
 * 也便于测试复用同一批 fixture。
 */
import { modelError, validateModelPatch } from './model-settings.mjs'
import { buildToolBridgePrompt, createToolBridge } from './agentmore-toolbridge.mjs'
import { GUEST_MESSAGE } from './agentmore-client.mjs'
import { streamFrames } from './agentmore-sse.mjs'
// scope 算法必须与目录侧**同一份实现**：两处各写一套会造成 snapshot 每次误判
// ACCOUNT_CHANGED（hash 不同 → 永远不相等）。
import { agentmoreScope as scopeOf } from './agentmore-catalog.mjs'

/** agentmore 侧不需要 WorkBuddy 的 `region` 概念，但 DSH 的 provider DTO 要求同形。 */
const AGENTMORE_REGION = 'cn'

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : [])
        .map((block) => (block.type === 'text' ? block.text : block.type === 'tool-result' ? textOf(block.content) : ''))
        .join('')

/** 工具调用进 prompt 时的字面形态：与伪工具桥约定的 JSON 完全一致。 */
const callLiteral = (call) =>
  JSON.stringify({ name: call.name, arguments: typeof call.arguments === 'string' ? safeParse(call.arguments) : (call.arguments ?? {}) })

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * 把 DSH 的多轮 messages 拍平成一段 prompt（`Ld/o;->b` 的等价物）。
 *
 * 顺序（与 APK 的拼接顺序一致）：system → 工具桥格式要求 → 历史 → 当前用户输入。
 *
 * 两类消息要特殊处理：
 *   * `role: 'tool'` 的结果 —— 上游不认识 tool 角色，必须写成"工具返回了什么"的文本，
 *     否则模型会以为自己上一次调用的工具没执行过，从而重复调用。
 *   * `assistant` 的 tool_calls —— 必须写回成协议约定的那行 JSON，
 *     这样下一轮模型看到的是"我上次确实调用了 X"，上下文才自洽。
 */
export function flattenPrompt(options, tools) {
  const sections = []
  const system = [options.system, ...(options.messages ?? []).filter((m) => m.role === 'system').map((m) => textOf(m.content))]
    .filter((text) => typeof text === 'string' && text !== '')
  if (system.length > 0) sections.push(system.join('\n\n'))

  const bridge = buildToolBridgePrompt(tools ?? [])
  if (bridge !== '') sections.push(bridge)

  const history = []
  for (const message of options.messages ?? []) {
    if (message.role === 'system') continue
    if (message.source?.kind === 'tool' || message.role === 'tool') {
      const name = message.source?.toolName ?? message.source?.name ?? '工具'
      history.push(`工具 ${name} 的返回结果：\n${textOf(message.content)}`)
      continue
    }
    if (message.role === 'assistant') {
      const calls = (Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool-call')
      const parts = [textOf(message.content)]
      for (const call of calls) parts.push(callLiteral(call))
      const joined = parts.filter((part) => part !== '').join('\n')
      if (joined !== '') history.push(`助手：${joined}`)
      continue
    }
    const body = textOf(message.content)
    if (body !== '') history.push(body)
  }
  if (history.length > 0) sections.push(history.join('\n\n'))
  return sections.join('\n\n')
}

/**
 * reasoning effort 归一化。
 *
 * 上游 GLM-5.3 系列只有三档：`low` / `high` / `max`（默认 max，且不能禁用思考）。
 * 官方文档与真机 `/stream` 实测一致：发 low/high/max 都 200，思考帧数依次递增；
 * 发 thinking / deep_thinking（目录里的 `effort` 字段）会被上游回 error 帧。
 *
 * DSH 侧档位更宽（none/minimal/medium/xhigh…），映射规则：
 *   * none/minimal → `low`（上游没有"关思考"，能选的最低就是 low）
 *   * medium → `high`
 *   * high/xhigh/max → 原样落到 `max`（上游最高档）
 *   * 其余未知值 → null（不发该字段，让上游用自己的默认 max）
 *
 * 早先这里把 none/minimal 折成 'none'、其余一律 'high'，等于把三档压成两态，
 * 用户选「极致」也只会得到「深度」。
 */
export function normalizeReasoningEffort(value) {
  if (typeof value !== 'string' || value === '') return null
  if (value === 'default') return null
  if (value === 'none' || value === 'minimal' || value === 'low') return 'low'
  if (value === 'medium' || value === 'high') return 'high'
  if (value === 'xhigh' || value === 'max') return 'max'
  return null
}

/**
 * 事件翻译：把 `agentmore-sse.mjs` 的归一化事件流变成 DSH 的流式事件。
 *
 * 关键约束（与 workbuddy adapter 完全一致的对外契约）：
 *   * 每个 block 必须先 `block-start`，结束必须 `block-end`
 *   * `tool-call` 块的 `block-end` 才带完整 arguments
 *   * 最后必须产 `finish`，reason ∈ `stop | max-tokens | tool-calls`
 */
async function* translate(frames, { bridge, promptChars = 0 }) {
  let index = 0
  let current = null // { index, type }
  let sawTool = false
  let outputChars = 0
  const calls = []

  const openText = function* (type) {
    if (current !== null) {
      yield { type: 'block-end', index: current.index, block: { type: current.type, text: '' } }
    }
    current = { index: index++, type }
    yield { type: 'block-start', index: current.index, blockType: type }
  }
  const closeCurrent = function* () {
    if (current === null) return
    yield { type: 'block-end', index: current.index, block: { type: current.type, text: '' } }
    current = null
  }

  for await (const event of frames) {
    if (event.type === 'done') break
    if (event.type === 'status' && (event.value === 'error' || event.value === 'intervene')) {
      throw modelError(event.value === 'intervene' ? 'AGENTMORE_INTERVENED' : 'PROVIDER_ERROR', 502)
    }
    if (event.type !== 'delta') continue

    // 思考内容先出（上游把 think 与 text 分开给），保持"先想后说"的视觉顺序。
    if (event.think !== '') {
      if (current?.type !== 'reasoning') yield* openText('reasoning')
      outputChars += event.think.length
      yield { type: 'reasoning-delta', index: current.index, text: event.think }
    }

    for (const out of bridge.push(event.text)) {
      if (out.type === 'call') {
        yield* closeCurrent()
        const call = out.call
        const callIndex = index++
        calls.push(call)
        sawTool = true
        yield { type: 'block-start', index: callIndex, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: callIndex, id: call.id, name: call.name, argumentsDelta: JSON.stringify(call.arguments) }
        yield { type: 'block-end', index: callIndex, block: { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) } }
        continue
      }
      if (out.text === '') continue
      if (current?.type !== 'text') yield* openText('text')
      outputChars += out.text.length
      yield { type: 'text-delta', index: current.index, text: out.text }
    }
  }

  // 流尾部残余（未完成的候选调用一律当正文吐出）。
  for (const out of bridge.end()) {
    if (out.type !== 'text' || out.text === '') continue
    if (current?.type !== 'text') yield* openText('text')
    outputChars += out.text.length
    yield { type: 'text-delta', index: current.index, text: out.text }
  }
  yield* closeCurrent()

  // 上游完全不发 usage 帧。与其留空让 Host 的统计栏一无所有，不如给一个
  // **明确标注为估算**的近似值：中文约 1 字/0.6 token，英文约 4 字符/token，
  // 这里用 /2 这个折中的粗估，绝不用它做任何计费或配额判断。
  yield {
    type: 'usage',
    usage: {
      inputTokens: Math.max(0, Math.ceil(promptChars / 2)),
      outputTokens: Math.max(0, Math.ceil(outputChars / 2)),
      estimated: true,
    },
  }
  yield { type: 'finish', reason: sawTool ? 'tool-calls' : 'stop' }
}

/**
 * 创建 adapter。接口形状与 `createWorkBuddyAdapter` 逐字段对齐。
 *
 * @param {object} options
 * @param {object} options.settings 模型偏好存储
 * @param {object} options.catalog 目录（`createAgentmoreCatalog`）
 * @param {() => Promise<object|null>} options.readCredential 当前激活凭据
 * @param {object} options.client 上游客户端
 * @param {(credential:object, signal?:AbortSignal) => Promise<string>} [options.resolveAgentId] 取/建 agent 绑定
 * @param {(account:object)=>void} [options.onCredentialRejected] 401 时的清理回调
 */
export function createAgentmoreAdapter({
  settings,
  catalog,
  readCredential,
  client,
  resolveAgentId,
  beforeCall = async () => {},
  idleTimeoutMs = 180_000,
  onCredentialRejected = async () => {},
} = {}) {
  const activeStreams = new Set()

  async function waitFor(operation, signal) {
    if (!signal) return operation()
    if (signal.aborted) throw modelError('ABORTED', 499)
    let onAbort
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(modelError('ABORTED', 499))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (signal.aborted) throw modelError('ABORTED', 499)
          return operation()
        }),
        cancelled,
      ])
      if (signal.aborted) throw modelError('ABORTED', 499)
      return result
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function snapshot(signal) {
    const preferences = await waitFor(() => settings.read(), signal)
    const listing = await waitFor(() => catalog.load({ signal }), signal)
    const credential = await waitFor(readCredential, signal)
    if (!credential) throw modelError('AGENTMORE_ACCOUNT_REQUIRED', 401)
    // listing.scopeKey 为 null 表示"目录侧没拿到凭据"（回退列表），此时不做身份比对。
    if (listing.scopeKey !== null && listing.scopeKey !== scopeOf(credential)) {
      throw modelError('AGENTMORE_ACCOUNT_CHANGED', 409)
    }
    return { preferences, listing, credential }
  }

  async function selected(id, signal) {
    const value = await snapshot(signal)
    const model = value.listing.models.find((entry) => entry.id === id)
    const enabled = value.preferences.enabled && value.preferences.enabledModelIds.includes(id)
    if (enabled && !model && value.listing.catalogError) {
      throw modelError(value.listing.catalogError, value.listing.catalogError === 'AGENTMORE_CATALOG_TIMEOUT' ? 504 : 502)
    }
    if (!enabled || !model) throw modelError('AGENTMORE_MODEL_DISABLED', 409)
    return { ...value, model }
  }

  const adapter = {
    dispose() {
      for (const controller of activeStreams) controller.abort()
    },
    providerInfo: (provider = 'agentmore') => ({ id: provider, name: '智谱清言 Agent' }),
    providerRetryPolicy: () => undefined,

    async listModels(provider = 'agentmore') {
      let value
      try {
        value = await snapshot()
      } catch (error) {
        if (['AGENTMORE_ACCOUNT_REQUIRED', 'AGENTMORE_ACCOUNT_CHANGED'].includes(error.code)) return []
        throw error
      }
      if (!value.preferences.enabled) return []
      return value.listing.models
        .filter((model) => value.preferences.enabledModelIds.includes(model.id))
        .map((model) => ({ provider, id: model.id, name: model.name, inputModalities: model.inputModalities }))
    },

    async resolveModel(provider, id, signal) {
      const { model, preferences } = await selected(id, signal)
      const size = preferences.contextWindowOverrides[model.id] ?? model.contextWindow
      if (!Number.isSafeInteger(size) || size <= 0) throw modelError('AGENTMORE_CONTEXT_INVALID')
      return {
        provider,
        id,
        name: model.name,
        inputModalities: model.inputModalities,
        context: { contextWindow: size },
        ...(model.reasoningEfforts.length > 0 ? { reasoning: { efforts: model.reasoningEfforts.map((effort) => ({ id: effort, name: effort })) } } : {}),
      }
    },

    async prepareCall(provider, id, signal) {
      return { model: await adapter.resolveModel(provider, id, signal), stream: (options) => adapter.stream(options) }
    },

    async *stream(options) {
      if (options.signal?.aborted) throw modelError('ABORTED', 499)
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      activeStreams.add(controller)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await waitFor(() => beforeCall(controller.signal), controller.signal)
        const { model, preferences, credential } = await waitFor(() => selected(options.model, controller.signal), controller.signal)
        const agentId = await waitFor(() => resolveAgentId(credential, controller.signal), controller.signal)
        const prompt = flattenPrompt(options, options.tools)
        const effort = normalizeReasoningEffort(options.reasoningEffort ?? preferences.defaultReasoningEffort)

        // 换账号检测：凭据在准备阶段被切走时必须中止，否则会把 A 的对话发到 B 的额度上。
        if (scopeOf(await waitFor(readCredential, controller.signal)) !== scopeOf(credential)) {
          throw modelError('AGENTMORE_ACCOUNT_CHANGED', 409)
        }

        // 会话 id 必须由上游真实分配，空串/缺字段/`null` 三种写法上游一律回
        // HTTP 200 + application/json `{"status":500}` —— 不是 SSE。流消费层读到 EOF
        // 却见不到 finish 帧，最终报 AGENTMORE_STREAM_TRUNCATED，用户只看到
        // 「本轮运行失败 / UNKNOWN」。实测（逐字段构造请求体）：三种写法都是 200+JSON 500。
        // 因此空 id 时先建会话，用上游给的 id 再发对话；历史已由 flattenPrompt 拍平进
        // prompt，换新会话不会丢上下文（实测新会话仍能引用上一轮内容）。
        const conversationId = typeof credential.conversationId === 'string' && credential.conversationId !== ''
          ? credential.conversationId
          : await waitFor(() => client.createConversation({ credential, agentId, signal: controller.signal }), controller.signal)

        let response
        try {
          response = await waitFor(
            () =>
              client.streamResponse({
                credential,
                agentId,
                conversationId,
                prompt,
                reasoningEffort: effort,
                selectedModel: model.id,
                signal: controller.signal,
              }),
            controller.signal,
          )
        } catch (error) {
          if (error?.code === 'INVALID_CREDENTIAL') await onCredentialRejected(credential).catch(() => {})
          if (error?.code === 'AGENTMORE_QUOTA') throw modelError('AGENTMORE_QUOTA', 402)
          if (error?.code === 'AGENTMORE_OVERLOADED') throw modelError('AGENTMORE_OVERLOADED', 503)
          throw error
        }

        const bridge = createToolBridge({ enabled: (options.tools ?? []).length > 0 })
        yield* translate(streamFrames(response, { signal: controller.signal, idleTimeoutMs }), {
          bridge,
          promptChars: prompt.length,
        })
      } finally {
        controller.abort()
        activeStreams.delete(controller)
        options.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
  return adapter
}

/**
 * 模型服务（与 `createModelService` 同形）：设置卡的读/改/刷新入口。
 *
 * `serving` 同时要求「已注册」+「无冲突」+「至少一个模型开启且在目录里」——
 * 三个条件缺一，用户看到的就是"以为开了但请求全 409"。
 */
export function createAgentmoreModelService({ settings, catalog, notify = () => {} } = {}) {
  let registered = false
  let conflict = null
  const status = async ({ force = false } = {}) => {
    const preferences = await settings.read()
    const listing = await catalog.load({ force })
    return {
      ok: true,
      ...preferences,
      region: AGENTMORE_REGION,
      catalogSource: listing.catalogSource,
      catalogError: listing.catalogError,
      serving: registered && conflict === null && preferences.enabled && listing.models.some((model) => preferences.enabledModelIds.includes(model.id)),
      conflict,
      models: listing.models.map((model) => ({
        ...model,
        enabled: preferences.enabledModelIds.includes(model.id),
        contextWindowOverride: preferences.contextWindowOverrides[model.id] ?? null,
        effectiveContextWindow: preferences.contextWindowOverrides[model.id] ?? model.contextWindow,
        // 三档语义（low/high/max，见 normalizeReasoningEffort）；偏好里那个值就是
        // 实际生效档位，不支持推理的模型给 null，别让界面假装它可调。
        effectiveReasoningEffort: Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
          ? preferences.defaultReasoningEffort ?? model.defaultReasoningEffort ?? null
          : null,
      })),
    }
  }
  return {
    status,
    async patch(patch) {
      // 校验规则与 WorkBuddy 共用一份实现，但错误码前缀不同 —— 客户端能据此区分
      // 「是哪边拒绝了这次保存」。
      validateModelPatch(patch, 'AGENTMORE')
      await settings.patch(patch)
      notify()
      return status()
    },
    async refresh() {
      const state = await status({ force: true })
      notify()
      return state
    },
    accountChanged() {
      catalog.invalidate({ keepCache: true })
      notify()
    },
    registration(nextActive, error = null) {
      registered = nextActive
      conflict = error
      notify()
    },
  }
}

export { GUEST_MESSAGE, AGENTMORE_REGION }
