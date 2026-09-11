// 刷新结果的原子写回 —— 合并语义 + 同目录临时文件 + fsync + rename + 失败清理。
// 本模块自身不读盘、不联网、不打印任何 token：调用方负责提供文件内容与路径。
import { writeFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * 把刷新结果合并回原始记录文本，保留未涉及的字段。
 *
 * 不变量 1（保留原值）：Task 2 的刷新结果中 refreshToken / expiresAt / refreshExpiresAt 为 undefined 时
 * 表示「本次响应没给」，必须沿用旧值；绝不能把 undefined 写进结果——否则下游 needsRefresh
 * 会把缺失的 expiresAt 当作「已过期」，每次调用都触发刷新，形成刷新风暴。
 * 因此这里用严格的 `!== undefined` 判断，而不是真值判断（后者会误丢合法的 0 值）。
 *
 * 不变量 2（令牌必填）：accessToken 是唯一无条件覆盖的字段。若传入 undefined，JSON.stringify 会
 * 静默删除该键，被原子写回的记录将不含 accessToken——旧 token 已被覆盖、登录态被销毁
 * （下次 parseCredentialRecord 直接抛 `credential record is missing auth.accessToken`）。
 * 因此这里显式拒绝缺失令牌，而不是产出「看起来合法」的残缺文本。本函数是导出的通用写回器，
 * 不能假定调用方一定先经过 Task 2 的 parseRefreshResponse。
 *
 * @param {string} rawText 凭据文件原文
 * @param {{accessToken:string, refreshToken?:string, expiresAt?:number, refreshExpiresAt?:number}} refreshed Task 2 的刷新结果
 * @param {number} [now] 本次刷新时间戳，写入 lastRefreshTime
 * @returns {string} 合并后的完整 JSON 文本
 * @throws {Error} refreshed.accessToken 不是非空字符串时
 */
export function mergeRefreshedRecord(rawText, refreshed, now = Date.now()) {
  if (typeof refreshed?.accessToken !== 'string' || refreshed.accessToken === '') {
    throw new Error('refreshed record is missing accessToken')
  }
  const raw = JSON.parse(rawText)
  const auth = { ...(raw.auth ?? {}) }
  auth.accessToken = refreshed.accessToken
  if (refreshed.refreshToken !== undefined) auth.refreshToken = refreshed.refreshToken
  if (refreshed.expiresAt !== undefined) auth.expiresAt = refreshed.expiresAt
  if (refreshed.refreshExpiresAt !== undefined) auth.refreshExpiresAt = refreshed.refreshExpiresAt
  auth.lastRefreshTime = now
  raw.auth = auth
  return JSON.stringify(raw)
}

/**
 * 原子替换：先写同目录临时文件 → fsync → rename 覆盖目标（与 CodeBuddy CLI 自身做法一致）。
 * 同目录可保证 rename 不跨卷，从而具备原子性；失败时目标文件保持原样。
 *
 * 失败语义（评审实测复现的缺陷：Windows 上 rename 覆盖被占用文件会抛 EPERM/EBUSY，
 * 旧实现直接抛出，把**含新轮换 refresh token** 的 `.tmp` 留在目录里，而目标文件仍是
 * 已失效的旧 refresh token —— 刷新已在服务端轮换，新凭据只存在于那个 `.tmp` 中，
 * 续期链路就此卡死）：
 *   * writeFileSync 失败 → 清理 tmp 后**原样重抛**（不替换成清理过程中产生的错误）；
 *   * renameSync 失败 → **先重试一次**（此时 tmp 仍在，重试才有意义）；仍失败才清理 tmp，
 *     并以**第一次 rename 的原始错误**重抛。顺序不能反：清理会删掉 tmp，之后的重试必然以
 *     ENOENT 失败，把真实的 EPERM/EBUSY（目标文件被占用）顶替成误导性的「文件不存在」。
 *   * 正常失败路径都不留 tmp；仅当清理动作**自身也失败**（unlink 与 rename 同为 EPERM）时
 *     tmp 才会残留 —— 这是已知限制，测试 test/writeback.test.mjs 如实钉住。
 *
 * fsync 的作用：没有它，rename 成功后若断电，目标文件可能被观测为 0 字节或部分内容——
 * 而对凭据文件而言「0 字节」等于把用户的登录态变成不可解析的垃圾。
 *
 * `fsImpl` 是测试 seam（默认真实 `node:fs`），生产调用方只传两个参数。
 *
 * @param {string} filePath 目标凭据文件
 * @param {string} content 完整文件内容
 * @param {typeof import('node:fs')} [fsImpl] 文件系统实现（测试注入用）
 */
export function writeCredentialAtomically(filePath, content, fsImpl = { writeFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync }) {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`

  // 清理 tmp；清理自身的失败不得掩盖/替换原始错误。
  const removeTmp = () => {
    try {
      fsImpl.unlinkSync(tmp)
    } catch {
      /* 清理失败时忽略：原始错误才是调用方需要看到的 */
    }
  }

  try {
    const fd = fsImpl.openSync(tmp, 'w')
    try {
      fsImpl.writeSync(fd, content, null, 'utf8')
      fsImpl.fsyncSync(fd)
    } finally {
      fsImpl.closeSync(fd)
    }
  } catch (error) {
    removeTmp()
    throw error // 原样重抛：不是「清理失败」也不是包装后的错误
  }

  try {
    fsImpl.renameSync(tmp, filePath)
  } catch (error) {
    // 重试一次：Windows 上覆盖被占用文件常是瞬时冲突，第二次常可成功。
    // 必须**先重试、再清理**：removeTmp() 会删掉 tmp，之后的重试必然以 ENOENT 失败，
    // 并把真实的 EPERM（目标文件被占用）顶替成误导性的「文件不存在」。
    try {
      fsImpl.renameSync(tmp, filePath)
    } catch {
      removeTmp()
      throw error // 原样重抛**第一次**的错误：重试与清理的错误都不得顶替它
    }
  }
}
