/**
 * agentmore2api（智谱清言 Agent）上游协议层。
 *
 * 全部常量与算法来自对 `dev.agentmore2api` APK 的反汇编确证，不是猜测：
 *   * `Ld/h;->h(String)`          MD5 → 小写 hex
 *   * `Ld/h;->n(String deviceId)` 9 个请求头的逐字节拼装（含 X-Timestamp 校验位）
 *   * `Ld/h;->m(...)`             HTTP 公共路径（超时、不跟随重定向、错误映射）
 *   * `Ld/w;->a(JSONObject)`      SSE 帧 → 事件归一化（见 agentmore-sse.mjs）
 *
 * 该上游**没有** OpenAI 兼容接口：请求体是 chatglm 自己的 agent 会话协议，
 * 响应是带 `parts[]`/`meta_data` 的自有 SSE 帧。因此插件在 adapter 层做双向翻译。
 */
import { createHash, randomUUID } from 'node:crypto'
import { modelError } from './model-settings.mjs'

/** 上游 API origin（APK 里所有请求都拼在这个常量后面）。 */
export const AGENTMORE_ORIGIN = 'https://agentmore.chatglm.cn'
/** 网页 origin：登录 cookie 写在这里，与 API origin 是两个域（APK 两个都尝试读）。 */
export const AGENTMORE_WEB_ORIGIN = 'https://chatglm.cn'

/** 浏览器 UA：与 APK 里逐字一致（X-Timestamp 校准请求也用它）。 */
export const AGENTMORE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'

/** 端点路径（相对 AGENTMORE_ORIGIN）。 */
export const AGENTMORE_PATHS = {
  stream: '/chatglm/agent-api/stream',
  conversation: '/chatglm/agent-api/conversation',
  models: '/chatglm/agent-api/operation/detail?tag=available_models',
  agents: '/chatglm/agent-api/project/list?page=1&page_size=30',
  userInfo: '/chatglm/user-api/user/info',
  refresh: '/chatglm/user-api/user/refresh',
  clock: '/chatglm/operation-api/config/cur_ts',
  dailyLogin: '/chatglm/member-api/member/daily_login_score',
  taskComplete: '/chatglm/agent-api/task/complete',
}

/** 签名盐：`Ld/h;->n` 里 `const-string v0, "-8a1317a7468aa3ad86e997d08f3f31cb"`。 */
const SIGN_SALT = '8a1317a7468aa3ad86e997d08f3f31cb'

/** 静态头（不含随时间变化的四项）。 */
const STATIC_APP_NAME = 'chatglm'
const APP_PLATFORM = 'pc'
const APP_VERSION = '0.0.1'
const CONTENT_TYPE = 'application/json;charset=utf-8'

/** 超时：普通请求 15s/20s，流式读 180s（`Ld/h;->m` 与 `Ld/i;->e`）。 */
export const AGENTMORE_CONNECT_TIMEOUT_MS = 15_000
export const AGENTMORE_READ_TIMEOUT_MS = 20_000
export const AGENTMORE_STREAM_IDLE_TIMEOUT_MS = 180_000
/** 时钟校准请求自己的超时是 3s/3s（`Ld/h;->n` 里的 `const/16 v0, 3000`）。 */
export const AGENTMORE_CLOCK_TIMEOUT_MS = 3_000

/** 结果页里的内置模型回退（`Ld/z;-><clinit>` 的两个 `Ld/y` 常量）。 */
export const AGENTMORE_FALLBACK_MODELS = Object.freeze([
  { id: 'glm-5.3', name: 'GLM-5.3', reasoning: true },
  { id: 'glm-5.3-flash', name: 'GLM-Flash', reasoning: true },
])

/** `Ld/h;->h`：`MessageDigest("MD5")` → 每字节 `%02x` → 小写 hex。 */
export function md5Hex(text) {
  return createHash('md5').update(String(text), 'utf8').digest('hex')
}

/**
 * `Ld/h;->n` 的时间戳校验位算法，逐指令复刻：
 *   1. 长度 < 3 时原样返回（`if-ge v5, v6(+3), +004h → goto +077h` 即跳过整段替换）
 *   2. 每个字符减 48 求数字和
 *   3. 减去**倒数第二位**（`size - 2` 处的元素）
 *   4. `% 10` 作为校验位，替换字符串的**倒数第二位**（保留首位到 `length-2`，再接末位）
 *
 * 这个位不是加密，纯粹是防重放/防手改；算错一个字上游直接 401。
 */
export function timestampWithCheck(raw) {
  const text = String(raw)
  if (text.length < 3) return text
  const digits = Array.from(text, (char) => char.charCodeAt(0) - 48)
  let sum = digits.reduce((total, digit) => total + digit, 0)
  sum -= digits[digits.length - 2]
  const check = ((sum % 10) + 10) % 10
  return text.slice(0, text.length - 2) + String(check) + text.slice(-1)
}

/** `UUID.randomUUID().toString().replace("-", "")` —— Kotlin 的 `Lt/l;->r` 全局替换。 */
const bareUuid = () => randomUUID().replaceAll('-', '')

/**
 * 生成一次请求所需的 9 个头（`LinkedHashMap` 容量 9 的那个 `filled-new-array`）。
 *
 * @param {object} options
 * @param {string} options.deviceId 设备指纹（APK 取自 `localStorage['chatglm-deid']`）
 * @param {number} [options.clockOffsetMs] 时钟偏移（见 createClockOffsetResolver）
 * @param {number} [options.at] 当前毫秒时间戳（测试注入；默认 Date.now）
 * @returns {Record<string,string>} 小写键名之外的逐字头名
 */
export function signedHeaders({ deviceId, clockOffsetMs = 0, at = Date.now() }) {
  const requestId = bareUuid()
  const nonce = bareUuid()
  const timestamp = timestampWithCheck(String(Math.trunc(at + clockOffsetMs)))
  return {
    'Content-Type': CONTENT_TYPE,
    'App-Name': STATIC_APP_NAME,
    'X-Device-Id': String(deviceId),
    'X-Request-Id': requestId,
    'X-App-Platform': APP_PLATFORM,
    'X-App-Version': APP_VERSION,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Sign': md5Hex(`${timestamp}-${nonce}-${SIGN_SALT}`),
  }
}

/**
 * 时钟偏移解析器：`Ld/h;->b` 那个静态字段的等价物。
 *
 * APK 的算法（含单飞锁）：
 *   t0 = now(); GET cur_ts; ts = result.timestamp_ms
 *   if (ts > 0) offset = ts + (now() - t0) / 2 - now()
 * 其中 `(now - t0) / 2` 是半 RTT 补偿，抵消请求自身的网络延迟。
 *
 * 校准失败**不抛错**：offset 保持 0，请求照发。APK 里 `JSONException` 会往上冒，
 * 但那条路径只会让整个请求失败；这里选择降级 —— 上游对本机时钟漂移的容忍度足以
 * 让一次失败的校准不致命，而让用户因为"校时接口抖动"完全用不了模型才是更糟的失败。
 */
export function createClockOffsetResolver({ fetchImpl = fetch, now = Date.now, timeoutMs = AGENTMORE_CLOCK_TIMEOUT_MS } = {}) {
  let offset = 0
  let calibrated = false
  let inFlight = null

  async function calibrate() {
    const started = now()
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const response = await fetchImpl(AGENTMORE_ORIGIN + AGENTMORE_PATHS.clock, {
        method: 'GET',
        headers: { 'User-Agent': AGENTMORE_USER_AGENT },
        ...(controller ? { signal: controller.signal } : {}),
      })
      if (!response?.ok) return
      const payload = await response.json()
      const remote = Number(payload?.result?.timestamp_ms)
      if (!Number.isFinite(remote) || remote <= 0) return
      const halfRtt = Math.floor((now() - started) / 2)
      offset = Math.trunc(remote + halfRtt - now())
      calibrated = true
    } catch {
      // 校准是可选的加速项，失败保持 0 偏移。
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    /** 当前偏移（未校准时为 0）。 */
    get value() {
      return offset
    },
    get calibrated() {
      return calibrated
    },
    /**
     * 确保已校准一次。并发调用共享同一次在飞请求（`Ld/h;->c` 单飞标记的等价物）：
     * 每个 tick 都给上游打一发校时请求既浪费又容易被限流。
     */
    ensure() {
      if (calibrated) return Promise.resolve(offset)
      if (inFlight === null) inFlight = calibrate().finally(() => { inFlight = null })
      return inFlight.then(() => offset)
    },
    /** 强制重新校准（账号切换、长时间空闲后可用）。 */
    refresh() {
      calibrated = false
      return this.ensure()
    },
  }
}

/**
 * 上游错误归一化。字段命名沿用 APK 的 `Ld/x{code, type, message}` 三元组，
 * 但对外只暴露插件自己的错误码，避免上游原始文案里的内部信息泄漏。
 */
export function upstreamError(type, message, status = 502) {
  const error = modelError(`AGENTMORE_${type.toUpperCase()}`, status)
  error.upstreamType = type
  error.upstreamMessage = message
  return error
}

/** `Ld/w;->a` 里的 last_error 映射表。 */
export function parseUpstreamError(frame) {
  const lastError = frame?.last_error ?? frame?.meta_data?.last_error
  if (lastError === null || typeof lastError !== 'object') return null
  const code = Number(lastError.error_code ?? 0)
  if (!Number.isFinite(code) || code === 0) return null
  if (code === -1001) return upstreamError('overloaded', '服务器被挤爆了，请稍后重试', 503)
  if (code === 10024) return upstreamError('quota', '剩余积分不足，可购买积分充值包获得更多积分', 402)
  const detail = String(lastError.err_msg ?? '') || String(lastError.message ?? '')
  return upstreamError('upstream', detail === '' ? `上游错误 ${code}` : `上游错误 ${code}：${detail}`, 502)
}

/** `Ld/h;->m` 的 HTTP 状态映射。 */
export function statusError(status, label = '请求') {
  if (status === 401 || status === 403) return modelError('INVALID_CREDENTIAL', 401)
  return upstreamError('http', `${label}失败（HTTP ${status}）`, 502)
}

/**
 * GET/POST 的公共执行器，对应 `Ld/h;->m`。
 *
 * 与 APK 的差异（有意的）：
 *   * APK 用 `HttpURLConnection` + `setInstanceFollowRedirects(false)`；这里靠 fetch 的
 *     `redirect: 'error'` 达到同样的"不跟随"，因为跟随重定向会把 Authorization 头带到
 *     另一个 origin。
 *   * APK 空 body 返回 `{}`；这里同样返回 `{}`，避免下游空值判断分叉。
 */
export async function requestJson({
  fetchImpl = fetch,
  method = 'GET',
  path,
  deviceId,
  token,
  body,
  label = '请求',
  clockOffset = 0,
  timeoutMs = AGENTMORE_READ_TIMEOUT_MS,
  signal,
}) {
  const headers = signedHeaders({ deviceId, clockOffsetMs: clockOffset })
  headers['User-Agent'] = AGENTMORE_USER_AGENT
  if (token) headers['Authorization'] = `Bearer ${token}`
  const payload = body === undefined ? null : JSON.stringify(body)
  if (payload !== null) headers['Content-Length'] = String(Buffer.byteLength(payload, 'utf8'))

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  const forward = () => controller?.abort()
  if (controller && signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', forward, { once: true })
  }

  let response
  try {
    response = await fetchImpl(AGENTMORE_ORIGIN + path, {
      method,
      headers,
      redirect: 'error',
      ...(payload === null ? {} : { body: payload }),
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch (cause) {
    if (signal?.aborted) throw modelError('ABORTED', 499)
    if (controller?.signal.aborted) throw modelError('TIMEOUT', 504)
    const error = modelError('TRANSPORT', 502)
    const code = cause?.cause?.code ?? cause?.code
    if (typeof code === 'string') error.transportCode = code
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) throw statusError(response.status, label)
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw upstreamError('invalid_json', `${label}响应不是合法 JSON`, 502)
  }
}

/**
 * 上游很多接口把真正的业务结果埋一层：`{ code, status, result: {...} }`。
 * `Ld/h;->c(JSONObject, String label)` 就是这个解包器。
 */
export function unwrapResult(payload) {
  if (payload === null || typeof payload !== 'object') return {}
  const code = payload.code ?? payload.status
  if (code !== undefined && code !== null && ![0, '0', 200, '200'].includes(code)) {
    const message = String(payload.message ?? payload.msg ?? '') || `上游返回 ${code}`
    throw upstreamError('business', message, 502)
  }
  return payload.result ?? payload.data ?? payload
}
