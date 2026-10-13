// 诊断字段的**展示白名单**：服务层（lib/web-login.mjs）、路由层（lib/routes.mjs）与前端
// （lib/client.js）三处投影共用同一套取值规则。
//
// 为什么是白名单而不是形状：`step` / `host` / `domain` / `error` / `code` 里有上游可控的值，
// 而「像不像域名 / 像不像标识符」对上游的字符串没有约束力——复审已实证
// `TOKENCANARY.example`、`p13800138000.example`、`{error:'13800138000'}`（数字串）与
// `{code:'13800138000'}` 四类都能过形状闸门，然后出现在 progress / detail / trace 三处文案里。
// 只认已知取值，展示面就收敛成固定有限集合。
//
// 不在白名单的值一律**丢字段**（不截断、不替换成别的字符串）；文案侧需要占位词时
// 由调用方显示「未知」/「未知域」。协议原始 code 仍可用于内部成功/失败判断。
//
// 前端由宿主经典脚本加载器装载（不能 import 本模块），只能保留一份同规则副本；
// 两份副本的一致性由 test/diagnostic-display.test.mjs（规则本体）与
// test/client-login-hint.test.mjs（跨层逐项对比）锁定。
import { DISPLAY_DOMAINS, UNKNOWN_DISPLAY_DOMAIN, displayDomain, isDisplayDomain } from './origins.mjs'

export { DISPLAY_DOMAINS, UNKNOWN_DISPLAY_DOMAIN, displayDomain, isDisplayDomain }

/** 允许出现的失败原因分类（与 LOGIN_ERRORS 的失败路径一一对应）。 */
export const DISPLAY_REASONS = new Set(['network', 'http', 'upstream', 'region', 'payload', 'store', 'timeout'])

/** 允许出现在诊断里的字段；其余键（令牌、state、任意键）一律不进浏览器。 */
export const DISPLAY_DIAGNOSTIC_FIELDS = ['at', 'step', 'reason', 'host', 'domain', 'httpStatus', 'code', 'error']

/** 单次失败的轨迹事件上限。 */
export const DISPLAY_TRACE_LIMIT = 24

/**
 * 阶段枚举：**只有本插件自己写下的字面量**（`note()` 的 step 参数）。
 * 阶段名会进 UI 文案（前端 `LOGIN_STAGE_LABELS`），让上游可控的串进来就等于送它一个回显位。
 */
export const DISPLAY_STEPS = new Set(['state', 'token', 'credential', 'store'])

/**
 * 错误类型枚举：运行时真正会出现的 `error.name`。
 *
 * 证据：本插件只在网络/读体异常处写 `error: error?.name`（undici 抛 `TypeError` 表示传输失败、
 * `AbortError` 表示取消/超时），以及模块自己构造的 `Error` / `SyntaxError`。不是「像类名就放行」。
 */
export const DISPLAY_ERROR_NAMES = new Set(['Error', 'TypeError', 'AbortError', 'SyntaxError'])

/**
 * 业务码集合：有代码或文档证据的协议码。
 *
 *   0     成功（lib/web-login.mjs 与 lib/checkin.mjs 的 `code === 0` 判定）
 *   401   鉴权失败（lib/checkin.mjs 的 `result.code === 401`）
 *   11128 请求非法 / UA 不被接受（lib/index.mjs、lib/user-agent.mjs 的注释与实测报文）
 *   11217 授权未完成（LOGIN_PENDING_CODE，轮询 pending 判定）
 *   12403 CN `/v3/config` 拒绝 IDE UA（lib/origins.mjs 的协议事实注释）
 *
 * 其余数字不得当业务码展示：500 只是 HTTP 状态、不是有证据的业务码，而长数字（手机号）
 * 更是复审实证过的泄漏形态——没有证据就没有展示位。
 */
export const DISPLAY_UPSTREAM_CODES = new Set([0, 401, 11128, 11217, 12403])

/** HTTP 状态码是三位数（RFC 9110）：只展示这个区间内的整数。 */
export const DISPLAY_HTTP_STATUS_MIN = 100
export const DISPLAY_HTTP_STATUS_MAX = 599

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDisplayStep(value) {
  return typeof value === 'string' && DISPLAY_STEPS.has(value)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDisplayErrorName(value) {
  return typeof value === 'string' && DISPLAY_ERROR_NAMES.has(value)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDisplayUpstreamCode(value) {
  return Number.isSafeInteger(value) && DISPLAY_UPSTREAM_CODES.has(value)
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function displayAt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function displayHttpStatus(value) {
  if (!Number.isSafeInteger(value)) return null
  return value >= DISPLAY_HTTP_STATUS_MIN && value <= DISPLAY_HTTP_STATUS_MAX ? value : null
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function displayUpstreamCode(value) {
  return isDisplayUpstreamCode(value) ? value : null
}

/**
 * 单个诊断字段的展示判定；不在白名单内返回 `undefined`（丢字段）。
 *
 * 按 key 判定：同一个值在不同字段下的结论不同，字符串与数字也不互相兜底
 * （`{code:'13800138000'}` 不能因为「能转成数字」而当业务码展示）。
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {string|number|undefined}
 */
export function displayField(key, value) {
  if (typeof value === 'string') {
    if (value === '') return undefined
    if (key === 'step') return isDisplayStep(value) ? value : undefined
    if (key === 'error') return isDisplayErrorName(value) ? value : undefined
    if (key === 'host' || key === 'domain') return isDisplayDomain(value) ? displayDomain(value) : undefined
    return undefined
  }
  if (key === 'at') return displayAt(value) ?? undefined
  if (key === 'httpStatus') return displayHttpStatus(value) ?? undefined
  if (key === 'code') return displayUpstreamCode(value) ?? undefined
  return undefined
}
