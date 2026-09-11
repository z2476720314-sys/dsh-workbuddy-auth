// WorkBuddy（CodeBuddy）凭据记录解析 —— 纯函数，不读盘、不联网。

/**
 * 默认凭据文件路径；与 CodeBuddy CLI 实际读取的位置一致（阶段 0 fs 追踪实证）。
 * 注意：仅描述位置，本模块自身不读取该文件。
 */
export const DEFAULT_CREDENTIAL_FILE = `${process.env.LOCALAPPDATA}\\CodeBuddyExtension\\Data\\Public\\auth\\Tencent-Cloud.coding-copilot.info`

/**
 * 解析 CodeBuddy 凭据记录（明文 JSON）。
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
  if (!auth || typeof auth.accessToken !== 'string' || auth.accessToken === '') {
    throw new Error('credential record is missing auth.accessToken')
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    accessToken: auth.accessToken,
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
