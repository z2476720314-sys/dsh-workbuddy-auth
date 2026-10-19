/**
 * 智谱清言（agentmore）上游客户端。
 *
 * 覆盖 APK 里用到的全部业务端点：
 *   * `Ld/h;->e`  `/chatglm/user-api/user/info`        → 用户身份 / 游客判定
 *   * `Ld/h;->d`  同上                                  → `member_info.left_score` 积分
 *   * `Ld/h;->k`  `/chatglm/user-api/user/refresh`      → 令牌续期
 *   * `Ld/z;->b`  `/chatglm/agent-api/operation/detail?tag=available_models` → 模型目录
 *   * `Ld/i;->a`  `/chatglm/agent-api/conversation`     → 建会话拿 conversation_id
 *   * `Ld/i;->e`  `/chatglm/agent-api/stream`           → 流式对话（SSE）
 *
 * 所有请求都经过 `agentmore-protocol.mjs` 的签名头与错误映射，本文件不再自己拼头。
 */
import {
  AGENTMORE_CONNECT_TIMEOUT_MS,
  AGENTMORE_ORIGIN,
  AGENTMORE_PATHS,
  AGENTMORE_STREAM_IDLE_TIMEOUT_MS,
  AGENTMORE_USER_AGENT,
  createClockOffsetResolver,
  requestJson,
  signedHeaders,
  statusError,
  upstreamError,
  unwrapResult,
} from './agentmore-protocol.mjs'
import { modelError } from './model-settings.mjs'

/** 上游 `is_guest` 为真时的固定错误（游客拿不到模型配额）。 */
const GUEST_MESSAGE = '该账号是游客身份，请先在 chatglm.cn 登录后重新授权'

/**
 * 目录项 → 内部模型描述。
 *
 * 字段来源（`Ld/z;->b(JSONObject result)`）：
 *   * `selected_model` 必填，即模型 id
 *   * `display_name` 空则回落 id
 *   * `am_switch` / `chat_switch` 是**能力开关**（true = 该模式下可用），不是下架标记
 *   * `reasoning_efforts` 非空数组 → 支持 reasoning（档位 id 取 `am_effort`）
 *
 * 上游目录**不含**上下文与输出上限：2026-10-18 对该接口做全字段穷举，除
 * am_description / am_switch / chat_switch / description / display_name /
 * display_tag / reasoning_efforts / selected_model 外没有任何 context / token /
 * window / length / max / limit 键。数值一律取自官方模型文档（docs.bigmodel.cn）：
 * GLM-5.3 与 GLM-5.3-Flash 都是 **1M 上下文窗口**、**最大输出 128K** Tokens。
 *
 * 早先的 `128_000` 是把「最大输出」误当成「上下文窗口」，后果是 `client.js`
 * 的覆盖校验用 `maxContextWindow` 设上限，用户即便手填也进不去 1M。
 */
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 128_000

/**
 * 档位 id → 顺序。官方三档 fixed 为 low → high → max（默认 max）。
 * 上游已按此序返回，这里仍显式排序：目录顺序若变动，设置卡里的档位不该跟着跳。
 */
const EFFORT_ORDER = ['low', 'high', 'max']

/**
 * 从一条目录项读档位 id。
 *
 * 每项形如 `{am_effort:'high', effort:'thinking', display_name:'深度', ...}`。
 * 实测（2026-10-18，真机 `/stream`）：`meta_data.reasoning_effort` 认的是
 * **am_effort** 那一套 —— low / high / max 全部 200，且思考帧数随档位递增
 * （low=0、high=10、max=14）；把 `effort` 字段的 "thinking" / "deep_thinking"
 * 原样发上去会被上游以 `status=error` 帧拒绝，回复正文为空。
 */
function parseEffortIds(entry) {
  const list = Array.isArray(entry?.reasoning_efforts) ? entry.reasoning_efforts : []
  const ids = []
  for (const item of list) {
    const id = typeof item?.am_effort === 'string' ? item.am_effort.trim() : ''
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  const rank = (id) => {
    const index = EFFORT_ORDER.indexOf(id)
    return index === -1 ? EFFORT_ORDER.length : index
  }
  return ids.sort((left, right) => rank(left) - rank(right))
}

export function parseModelList(result) {
  const list = Array.isArray(result?.models) ? result.models : []
  const seen = new Set()
  const models = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.selected_model === 'string' ? entry.selected_model.trim() : ''
    if (id === '' || seen.has(id)) continue
    // `am_switch` / `chat_switch` 是「该模型在 Agent 模式 / 对话模式下可用」的能力位，
    // 实测两项真实模型都是 true。旧代码把 `am_switch === true` 当成「已下架」整条跳过，
    // 于是活取回来的两个模型被全部过滤掉（目录显示 0 个），只能退回内置列表。
    // 真下架时上游会把这整条从 models 里移除，不需要开关判断。
    if (entry.am_switch === false) continue
    const efforts = parseEffortIds(entry)
    const displayName = typeof entry.display_name === 'string' && entry.display_name.trim() !== ''
      ? entry.display_name.trim()
      : id
    seen.add(id)
    models.push({
      id,
      name: displayName.slice(0, 160),
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxContextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      // 上游目录不声明模态。官方文档：GLM-5.3 仅文本，GLM-5.3-Flash 支持
      // 视频/图像/文本/文件输入。但本适配器把全部历史拍平成**一段纯文本**
      // prompt（见 flattenPrompt），图片块会被 textOf 直接丢掉，因此这里
      // 一律标 text —— 标成 image 只会让 DSH 允许发图、再静默丢内容。
      inputModalities: ['text'],
      reasoningEfforts: efforts,
      // 官方默认 max。缺省不回落到 'default'（那套旧档位上游已不认）。
      defaultReasoningEffort: efforts.includes('max') ? 'max' : efforts[0] ?? null,
    })
  }
  return models
}

/** 从 `/user/info` 的 payload 里读身份。字段名见 `Ld/h;->e`。 */
export function parseUserInfo(payload) {
  const result = unwrapResult(payload)
  const rawId = result?._id
  const userId = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId : ''
  return { userId, isGuest: result?.is_guest === true }
}

/** 从 `/user/info` 的 payload 里读积分（`member_info.left_score`）。 */
export function parseCreditBalance(payload) {
  const result = unwrapResult(payload)
  const score = result?.member_info?.left_score
  const value = typeof score === 'number' ? score : typeof score === 'string' && /^-?\d+(\.\d+)?$/.test(score) ? Number(score) : null
  if (value === null || !Number.isFinite(value)) return null
  return { remaining: value, display: String(score) }
}

/** 从 `/user/refresh` 的 payload 里读新令牌（`Ld/h;->k`）。 */
export function parseRefreshResult(payload) {
  const result = unwrapResult(payload)
  const token = typeof result?.access_token === 'string' ? result.access_token : ''
  const refreshToken = typeof result?.refresh_token === 'string' ? result.refresh_token : ''
  if (token === '') throw upstreamError('refresh', '刷新成功但上游没有返回 access_token', 502)
  return { accessToken: token, refreshToken }
}

/** 从 `/conversation` 的 payload 里读 conversation_id（`Ld/i;->a`）。 */
export function parseConversationId(payload) {
  const result = unwrapResult(payload)
  const id = result?.data?.conversation_id ?? result?.conversation_id
  if (typeof id !== 'string' || id === '') {
    throw upstreamError('conversation', '创建会话成功但上游没有返回 conversation_id', 502)
  }
  return id
}

/**
 * 组装 `/stream` 请求体（`Ld/i;->e` 的 body 逐字段）。
 *
 * 注意 `messages` 只有**一条** user 消息，内容是一整段拼好的 prompt。
 * 上游没有多轮 messages 概念，历史必须由插件自己拍平进 prompt。
 */
export function buildStreamBody({ agentId, conversationId, prompt, reasoningEffort, selectedModel }) {
  const meta = { platform: 'pc' }
  if (typeof reasoningEffort === 'string' && reasoningEffort !== '') meta.reasoning_effort = reasoningEffort
  if (typeof selectedModel === 'string' && selectedModel !== '') meta.selected_model = selectedModel
  return {
    agent_id: agentId,
    conversation_id: conversationId,
    meta_data: meta,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  }
}

/**
 * 创建上游客户端。
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => Promise<{accessToken:string, refreshToken:string, deviceId:string}>} options.readCredential
 * @param {(credential:object) => Promise<void>} [options.writeCredential] 续期成功后回写
 */
export function createAgentmoreClient({ fetchImpl = fetch, readCredential, writeCredential, now = Date.now } = {}) {
  const clock = createClockOffsetResolver({ fetchImpl, now })
  let refreshing = null

  /** 统一入口：先确保时钟校准，再发请求。 */
  async function call({ method = 'GET', path, token, body, label, signal, timeoutMs }) {
    const offset = await clock.ensure()
    return requestJson({
      fetchImpl,
      method,
      path,
      deviceId: (await readCredential()).deviceId,
      token,
      body,
      label,
      clockOffset: offset,
      signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  }

  const client = {
    clock,

    /** 用户身份（`Ld/h;->e`）。 */
    async userInfo(credential, signal) {
      const payload = await requestJson({
        fetchImpl,
        path: AGENTMORE_PATHS.userInfo,
        deviceId: credential.deviceId,
        token: credential.accessToken,
        label: '用户信息',
        clockOffset: await clock.ensure(),
        signal,
      })
      return parseUserInfo(payload)
    },

    /** 积分（`Ld/h;->d`）。 */
    async credits(credential, signal) {
      const payload = await requestJson({
        fetchImpl,
        path: AGENTMORE_PATHS.userInfo,
        deviceId: credential.deviceId,
        token: credential.accessToken,
        label: '积分查询',
        clockOffset: await clock.ensure(),
        signal,
      })
      return parseCreditBalance(payload)
    },

    /**
     * 令牌续期（`Ld/h;->k`）。并发调用共享一次在飞请求 —— 每次刷新都会轮换
     * refresh_token，重复发等于把上一个新令牌作废。
     */
    refresh(credential, signal) {
      if (refreshing !== null) return refreshing
      const work = (async () => {
        const payload = await requestJson({
          fetchImpl,
          method: 'POST',
          path: AGENTMORE_PATHS.refresh,
          deviceId: credential.deviceId,
          token: credential.accessToken,
          body: {},
          label: '令牌续期',
          clockOffset: await clock.ensure(),
          signal,
        })
        const next = parseRefreshResult(payload)
        if (typeof writeCredential === 'function') {
          await writeCredential({
            ...credential,
            ['accessToken']: next.accessToken,
            refreshToken: next.refreshToken === '' ? credential.refreshToken : next.refreshToken,
            refreshedAt: now(),
          })
        }
        return next
      })().finally(() => { refreshing = null })
      refreshing = work
      return work
    },

    /** 模型目录（`Ld/z;->b`）。 */
    async models(credential, signal) {
      const payload = await requestJson({
        fetchImpl,
        path: AGENTMORE_PATHS.models,
        deviceId: credential.deviceId,
        token: credential.accessToken,
        label: '模型目录',
        clockOffset: await clock.ensure(),
        signal,
        timeoutMs: 10_000,
      })
      return parseModelList(unwrapResult(payload))
    },

    /** 智能体列表（`Ld/b` 的输入，取自 `project/list`）。 */
    async agents(credential, signal) {
      const payload = await requestJson({
        fetchImpl,
        path: AGENTMORE_PATHS.agents,
        deviceId: credential.deviceId,
        token: credential.accessToken,
        label: '智能体列表',
        clockOffset: await clock.ensure(),
        signal,
      })
      return unwrapResult(payload)
    },

    /** 建会话（`Ld/i;->a`）。 */
    async createConversation({ credential, agentId, signal }) {
      const payload = await call({
        method: 'POST',
        path: AGENTMORE_PATHS.conversation,
        token: credential.accessToken,
        body: { agent_id: agentId },
        label: '创建会话',
        signal,
      })
      return parseConversationId(payload)
    },

    /**
     * 发起流式对话，返回原始 `Response`（由 `agentmore-sse.mjs` 消费）。
     *
     * 头组装与 `Ld/i;->e` 逐项对齐，包括那个刻意重复的 `Accept`：上游网关按原样透传，
     * 我们保持同样形态以免触发任何基于头指纹的拒绝。
     */
    async streamResponse({ credential, agentId, conversationId, prompt, reasoningEffort, selectedModel, signal }) {
      const offset = await clock.ensure()
      const headers = signedHeaders({ deviceId: credential.deviceId, clockOffsetMs: offset })
      headers['User-Agent'] = AGENTMORE_USER_AGENT
      headers['Authorization'] = `Bearer ${credential.accessToken}`
      headers.Accept = 'text/event-stream, text/event-stream'
      const body = JSON.stringify(buildStreamBody({ agentId, conversationId, prompt, reasoningEffort, selectedModel }))
      headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'))

      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), AGENTMORE_CONNECT_TIMEOUT_MS) : null
      const forward = () => controller?.abort()
      if (controller && signal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', forward, { once: true })
      }
      try {
        const response = await fetchImpl(AGENTMORE_ORIGIN + AGENTMORE_PATHS.stream, {
          method: 'POST',
          headers,
          body,
          redirect: 'error',
          ...(controller ? { signal: controller.signal } : {}),
        })
        if (!response.ok) throw statusError(response.status, '对话请求')
        return response
      } catch (error) {
        if (signal?.aborted) throw modelError('ABORTED', 499)
        if (error?.code !== undefined) throw error
        if (controller?.signal.aborted) throw modelError('TIMEOUT', 504)
        throw modelError('TRANSPORT', 502)
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', forward)
      }
    },
  }

  return client
}

export { AGENTMORE_STREAM_IDLE_TIMEOUT_MS, GUEST_MESSAGE }
