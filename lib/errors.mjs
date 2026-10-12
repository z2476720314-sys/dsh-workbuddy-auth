// 错误分类与「可行动指引」的唯一来源。
//
// 为什么需要它：截图里的 `HTTP 500: HTTP 401；已尝试重新读取状态。` 是用户实际看到的东西 ——
// 一个状态码，没有任何可执行信息。而 401 与「凭据被加密」是**两种完全不同的病因**：
//   * 401/403：refresh token 已被服务端作废（例如切到了历史备份、或别的客户端轮换过），
//     正确动作是换一个账号或重新登录；
//   * envelope：WorkBuddy 桌面端把令牌加密后写盘，DSH 侧没有解封器，
//     此时让用户去「运行 codebuddy 登录」是把他指向错误的方向。
// 本模块把这两类压成固定、**不含任何令牌**的短文案，路由层与客户端共用同一份措辞。

import { ENCRYPTED_ENVELOPE_MESSAGE } from './credential.mjs'

/** refresh 端点拒绝当前 refresh token 时挂的错误码（401/403 统一归到这里）。 */
export const UPSTREAM_REJECTED_CODE = 'UPSTREAM_CREDENTIAL_REJECTED'

/** 凭据被 WorkBuddy 桌面端加密（AES-GCM envelope）时的固定文案；唯一来源在 credential.mjs。 */
export const ENCRYPTED_CREDENTIAL_MESSAGE = ENCRYPTED_ENVELOPE_MESSAGE

/** 凭据被上游拒绝时的指引：先给最短路径（切换账号），再给兜底（重新登录）。 */
const REJECTED_HINT =
  '当前账号的登录态已失效（refresh token 已被服务端作废，常见于切到了历史备份文件，或别的客户端刷新过）。' +
  '请点上方「切换账号」换用其它账号；若都失效，请运行 `codebuddy` 重新登录后再点「重新读取」。'

/** 凭据被桌面端加密时的指引：明确说清「DSH 侧解不开」，别让用户白折腾登录。 */
const ENCRYPTED_HINT =
  '这份凭据已被 WorkBuddy 桌面端加密（{$wbEncrypted} 信封），DSH 无法解密其中令牌，因此不能直接使用。' +
  '请点「切换账号」选用明文凭据的账号，或在 CodeBuddy 编辑器/CLI 中重新登录以生成一份 DSH 可读的明文凭据。'

/** HTTP 状态码 → 数字；取自 error.status / error.statusCode / 消息里的 `HTTP <3位>`。 */
export function errorStatus(error) {
  const raw = /** @type {{status?:unknown,statusCode?:unknown}} */ (error)
  if (Number.isInteger(raw?.status)) return raw.status
  if (Number.isInteger(raw?.statusCode)) return raw.statusCode
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const matched = /\bHTTP (\d{3})\b/.exec(message)
  return matched === null ? undefined : Number(matched[1])
}

/**
 * 这次失败是否属于「上游拒绝当前凭据」。
 * 只认 401/403 与显式错误码：429（限流）、5xx（服务端故障）都不是凭据问题，
 * 把它们归到「登录态失效」会把用户指向错误的动作。
 */
export function isCredentialRejection(error) {
  if (error === undefined || error === null) return false
  if (/** @type {{code?:unknown}} */ (error)?.code === UPSTREAM_REJECTED_CODE) return true
  const status = errorStatus(error)
  return status === 401 || status === 403
}

/** 错误消息是否表示「凭据被加密」。 */
export function isEncryptedCredential(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message === ENCRYPTED_CREDENTIAL_MESSAGE
}

/**
 * 该错误对应的一行可行动指引；不适用时返回空串（调用方可据此省略 hint 字段）。
 * 输出永不含令牌值与本地路径。
 */
export function credentialErrorHint(error) {
  if (isEncryptedCredential(error)) return ENCRYPTED_HINT
  if (isCredentialRejection(error)) return REJECTED_HINT
  return ''
}
