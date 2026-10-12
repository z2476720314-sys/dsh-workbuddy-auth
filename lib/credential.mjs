// WorkBuddy（CodeBuddy）凭据记录解析 —— 纯函数，不读盘、不联网。

/**
 * 默认凭据文件路径；与 CodeBuddy CLI 实际读取的位置一致（阶段 0 fs 追踪实证）。
 * 注意：仅描述位置，本模块自身不读取该文件。
 */
export const DEFAULT_CREDENTIAL_FILE = `${process.env.LOCALAPPDATA}\\CodeBuddyExtension\\Data\\Public\\auth\\Tencent-Cloud.coding-copilot.info`

/**
 * 凭据被 WorkBuddy 桌面端加密时的固定错误文案。
 *
 * 2026-10-10 起桌面端把 `auth.accessToken` / `auth.refreshToken` /
 * `account.nickname` 等写成一个 AES-GCM 信封对象
 * `{$wbEncrypted: 1, envelope: "<base64>"}`，解封所需的保护器只存在于桌面端进程内
 * （`~/.workbuddy/keyblob` 也只是把同一份密文再包一层），DSH 侧**无法**解密。
 *
 * 这必须与「缺少 accessToken」区分开：后者指向「去登录」，而前者去做登录/重新读取
 * 都没用 —— 文件就在那里，只是读不出明文。两种病因混为一谈正是线上误导的来源。
 */
export const ENCRYPTED_ENVELOPE_MESSAGE = 'credential record is encrypted by the WorkBuddy desktop client'

/** 单个字段是否是桌面端的加密信封（`{$wbEncrypted: 1, envelope: ...}`）。 */
export function isEncryptedValue(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.$wbEncrypted !== undefined
  )
}

/** 整份记录是否使用了加密信封（任一令牌字段是信封即算）。 */
export function isEncryptedRecord(raw) {
  return isEncryptedValue(raw?.auth?.accessToken) || isEncryptedValue(raw?.auth?.refreshToken)
}

/**
 * 解析 CodeBuddy 凭据记录（明文 JSON）。
 *
 * 抛错顺序有意如此：先「不是 JSON」，再「被加密」（这是**可在文件里看到**的事实），
 * 最后才是「缺少 accessToken」（才是真正的未登录）。顺序颠倒会把加密文件报成未登录。
 *
 * @param {string} text 文件原文
 * @returns {{accessToken:string,refreshToken:string,tokenType:string,expiresAt:number,refreshExpiresAt:number,lastRefreshTime:number,uid:string}}
 */
export function parseCredentialRecord(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('credential record is not valid JSON')
  }
  const auth = raw?.auth
  if (isEncryptedRecord(raw)) {
    throw new Error(ENCRYPTED_ENVELOPE_MESSAGE)
  }
  if (!auth || typeof auth.accessToken !== 'string' || auth.accessToken === '') {
    throw new Error('credential record is missing auth.accessToken')
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const tok = auth.accessToken
  return {
    accessToken: tok,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    tokenType: typeof auth.tokenType === 'string' && auth.tokenType ? auth.tokenType : 'Bearer',
    expiresAt: num(auth.expiresAt),
    refreshExpiresAt: num(auth.refreshExpiresAt),
    lastRefreshTime: num(auth.lastRefreshTime),
    uid: typeof raw?.account?.uid === 'string' ? raw.account.uid : '',
  }
}

/**
 * 是否需要刷新：剩余时间不高于阈值即为真；缺失到期时间按需刷新处理。
 * @param {{expiresAt:number}} record
 * @param {number} [now]
 * @param {number} [marginMs]
 * @returns {boolean}
 */
export function needsRefresh(record, now = Date.now(), marginMs = 24 * 60 * 60 * 1000) {
  if (!record || !record.expiresAt) return true
  return record.expiresAt - now <= marginMs
}
