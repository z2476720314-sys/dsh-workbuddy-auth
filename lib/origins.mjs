// 地区与 origin 的**单一事实来源**（CN / Intl）。
//
// 为什么必须收在一处：同一个「这笔请求/这个账号属于哪个地区、该打哪个后端」的判断被
// 登录、刷新、推理路由、余额与设置卡五条路径共用。任何一处各写一份映射，都会在
// Intl 域新增（或 CN 网关变动）时悄悄分叉——而错误方向的后果是把请求发到**另一个地区**的
// 后端（带着该地区的令牌），或者把 CN 当 Intl 回退。因此：
//
//   * 地区与 host 的关系只在这里描述：`regionForAuthHost` / `originForAuthHost`；
//   * 任何**无法确定地区**的输入一律 `null`（fail-closed），调用方负责拒绝请求；
//   * 绝不提供「Intl 失败退回 CN」的兜底——那会把用户凭据送到错误的地区。
//
// 协议事实（来自订阅插件的只读参考实现与两个部署的实测）：
//   * CN 网关固定 `https://copilot.tencent.com`；
//   * Intl 与其认证域同 apex：`https://www.workbuddy.ai` / `https://www.codebuddy.ai`；
//   * 刷新头 `x-auth-refresh-source`：`*.workbuddy.ai` → `workbuddy`，其余 → `plugin`
//     （参考实现按**域名**判定，不是按地区；`codebuddy.ai` 走 `plugin` 分支）；
//   * 上游网关按客户端身份放行：CLI 身份在 CN / Intl 两侧的 state / token / chat 面都被接受，
//     而 CodeBuddyIDE 的 UA 会被 CN `/v3/config`（400 code 12403）与 Intl chat（401）拒绝。

/** CN 网关（固定，不分部署）。 */
export const CN_BACKEND = 'https://copilot.tencent.com'

/** Intl 部署的 origin 白名单（`www.<apex>`）。 */
export const INTL_ORIGINS = new Set(['https://www.workbuddy.ai', 'https://www.codebuddy.ai'])

/** 地区 → 允许的后端 origin。 */
export const API_ORIGINS = new Map([
  ['cn', new Set([CN_BACKEND])],
  ['intl', INTL_ORIGINS],
])

/** 合法地区标识；其余一律拒绝（绝不猜测、绝不回退）。 */
export const REGIONS = new Set(['cn', 'intl'])

/** Intl 认证域 apex：apex 自身与任意子域都属于 Intl。 */
export const INTL_AUTH_APEXES = ['workbuddy.ai', 'codebuddy.ai']

/** CN 认证域：腾讯网关主域 + CodeBuddy 国内域（apex 自身与任意子域）。 */
export const CN_AUTH_HOST = 'copilot.tencent.com'
export const CN_AUTH_APEXES = ['tencent.com', 'codebuddy.cn']

/** 上游网关接受的客户端身份（CLI 身份在两个地区都通过）。 */
export const CLIENT_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2'

/**
 * 规范化地区标识：`' CN '` → `'cn'`；非法值返回 `null`。
 *
 * @param {unknown} value
 * @returns {'cn'|'intl'|null}
 */
export function normalizeRegion(value) {
  if (typeof value !== 'string') return null
  const region = value.trim().toLowerCase()
  return REGIONS.has(region) ? region : null
}

/** 小写 hostname，去掉根点；非字符串返回 ''。 */
export function normalizeHost(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * 从 origin / host / hostname 里取 hostname；无法解析返回 ''。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function hostnameOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const raw = value.trim()
  if (!raw.includes('/')) return normalizeHost(raw)
  try {
    return normalizeHost(new URL(raw).hostname)
  } catch {
    return ''
  }
}

/**
 * 认证域属于哪个地区。
 *
 * Intl 只认 `workbuddy.ai` / `codebuddy.ai` 的 apex 或子域；CN 认
 * `copilot.tencent.com`、`*.tencent.com` 与 `codebuddy.cn` 的 apex 或子域。
 * 其余一律 `null`（fail-closed）。
 *
 * `codebuddy.cn` 必须留在 CN：CN 网关在浏览器登录成功后签发的令牌报文里
 * `data.domain = 'www.codebuddy.cn'`（2026-10-13 生产实测），它同时也是
 * `lib/checkin.mjs` 的 `CHECKIN_DEFAULT_DOMAIN`。若这里返回 `null`，
 * `web-login` 的 parseCredential 会 fail-closed 丢掉刚拿到的 CN 令牌 ——
 * 表现为「浏览器已显示登录成功，插件却报 WORKBUDDY_LOGIN_POLL_FAILED」。
 *
 * @param {unknown} value 认证域、hostname 或 origin
 * @returns {'cn'|'intl'|null}
 */
export function regionForAuthHost(value) {
  const host = hostnameOf(value)
  if (host === '') return null
  for (const apex of INTL_AUTH_APEXES) {
    if (host === apex || host.endsWith(`.${apex}`)) return 'intl'
  }
  if (host === CN_AUTH_HOST) return 'cn'
  for (const apex of CN_AUTH_APEXES) {
    if (host === apex || host.endsWith(`.${apex}`)) return 'cn'
  }
  return null
}

/**
 * 认证域 → 后端 origin。
 *
 * Intl 与其 apex 同源（`https://www.<apex>`），且必须落在白名单内；CN 固定网关。
 * 无法确定地区或 origin 不在白名单时返回 `null`。
 *
 * @param {unknown} value 认证域、hostname 或 origin
 * @returns {string|null}
 */
export function originForAuthHost(value) {
  const region = regionForAuthHost(value)
  if (region === 'cn') return CN_BACKEND
  if (region === 'intl') {
    const host = hostnameOf(value)
    const origin = `https://www.${host.split('.').slice(-2).join('.')}`
    return INTL_ORIGINS.has(origin) ? origin : null
  }
  return null
}

/**
 * 解析一次请求该打的后端 origin。**绝不**在地区之间回退。
 *
 * 优先级：认证域（账号记录的 domain 最可信，能区分 Intl 的两个 apex）
 * → 账号记录里已存的 apiOrigin（必须落在该地区白名单内）
 * → `null`（调用方必须失败关闭，且不得发出请求）。
 *
 * 认证域与显式地区**冲突**时同样返回 `null`：宁可不发，也不把令牌发到另一个地区。
 *
 * @param {{region?:unknown,authHost?:unknown,apiOrigin?:unknown}} [input]
 * @returns {string|null}
 */
export function resolveWorkBuddyOrigin({ region, authHost, apiOrigin } = {}) {
  const wanted = normalizeRegion(region)
  const host = hostnameOf(authHost)
  if (host !== '') {
    const hostRegion = regionForAuthHost(host)
    if (hostRegion === null) return null
    if (wanted !== null && wanted !== hostRegion) return null
    return originForAuthHost(host)
  }
  const candidate = typeof apiOrigin === 'string' ? apiOrigin.trim().replace(/\/$/, '') : ''
  if (candidate === '') return null
  if (wanted !== null) return API_ORIGINS.get(wanted).has(candidate) ? candidate : null
  for (const origins of API_ORIGINS.values()) {
    if (origins.has(candidate)) return candidate
  }
  return null
}

/**
 * 刷新头 `x-auth-refresh-source` 的取值（参考实现按**域名**判定）。
 *
 * `*.workbuddy.ai` → `workbuddy`；其余（含 CN 与 `codebuddy.ai`）→ `plugin`。
 *
 * `codebuddy.ai` 归到 `plugin` 是**与参考实现逐字对齐**的结论，不是遗漏：参考实现的
 * `refreshSourceForDomain(domain) = domain.endsWith('.workbuddy.ai') ? 'workbuddy' : 'plugin'`
 * 同样只认 `.workbuddy.ai` 后缀。服务端若真按 source 分派，两个实现会一起错 —— 在拿到
 * 反例之前不要单方面改这里。
 *
 * @param {unknown} value 认证域、hostname 或 origin
 * @returns {'plugin'|'workbuddy'}
 */
export function refreshSourceForHost(value) {
  const host = hostnameOf(value)
  if (host === 'workbuddy.ai' || host.endsWith('.workbuddy.ai')) return 'workbuddy'
  return 'plugin'
}
