// WorkBuddy 设置卡的 4 条 Host 路由（设计文档 §10.2 / §10.3）。
//
// 与设置卡客户端半区（后续任务）的契约：
//   GET  /api/dsh-workbuddy-auth/status              脱敏状态 DTO（同 buildStatus 的返回）
//   POST /api/dsh-workbuddy-auth/connection/test     发一次极小请求探测上游
//   POST /api/dsh-workbuddy-auth/credential/refresh  强制刷新一次（会轮换 refresh token）
//   POST /api/dsh-workbuddy-auth/credential/reload   重新读取凭据文件并同步到凭据 seam
//
// 安全边界（本模块据此实现，改动时请一并维持）：
//   1. **任何响应体都不得含 accessToken / refreshToken 的值**——含错误路径。因此：
//      * /status 只经 `buildStatus` 产出（见 lib/status.mjs 的安全契约）；
//      * 动作类路由**只取白名单字段**（数字/布尔/短字符串），绝不 spread 依赖的返回值，
//        这样即使某个 deps 实现「脏」到把整条凭据记录返回上来，令牌也到不了浏览器。
//   2. **所有 4 条路由都做两层请求来源校验**，且在触碰任何依赖之前返回 403：
//      * `Host` 必须严格是 loopback（127.0.0.1 / localhost / [::1]，端口任意）；
//      * 带 `Origin` 时，它的 host 必须与 `Host` 完全一致（端口不同也算跨源）。
//      GET /status 虽然不改状态，但它会返回昵称、手机号与 uid 尾号，因此与 POST 同等对待。
//
//      已知限制（设计文档 §10.3，**不要**为此引入新的认证机制）：这 4 条 `kind:'exact'` 路由
//      匹配优先于平台 `/api` 前缀围栏，因此仍没有后者的浏览器会话 cookie。loopback Host
//      校验挡住 DNS rebinding，Origin/Host 校验挡住跨源浏览器请求；残余面仅为**同机进程**，
//      它们可以直接构造 loopback 请求读取 /status 或触发 /credential/refresh。
//   3. 错误统一 `{ ok:false, error }`，只回显**状态码与错误码**，绝不整段回显上游响应体
//      （响应体里可能夹带令牌或其它敏感信息），也绝不回显本地文件路径
//      （`ENOENT: … open 'C:\\Users\\…'` 会把用户目录带出去）。GET /status 同样走这道白名单。
//   4. webServer 是**可选**依赖：非 web 组合下不注册路由、打一行日志、绝不抛错。
import { buildStatus } from './status.mjs'

/** 路由前缀（客户端半区必须与此一致）。 */
export const ROUTE_PREFIX = '/api/dsh-workbuddy-auth'

/** 4 条路由的逐字路径。 */
export const ROUTE_PATHS = {
  status: `${ROUTE_PREFIX}/status`,
  connectionTest: `${ROUTE_PREFIX}/connection/test`,
  credentialRefresh: `${ROUTE_PREFIX}/credential/refresh`,
  credentialReload: `${ROUTE_PREFIX}/credential/reload`,
}

/** webServer 缺失时的降级日志（apply 与 registerRoutes 共用同一句，避免文案漂移）。 */
export const NO_WEB_SERVER_LOG =
  '[workbuddy-auth] webServer service is unavailable in this composition; the WorkBuddy settings routes are not registered (credential sync continues normally)'

/**
 * 本插件自身模块可能抛出的**固定、无令牌**的短消息白名单。
 * 只有它们允许被回显到响应体；其它任何 message（可能夹带上游原始响应体）一律替换成
 * 'request failed'。宁可少给信息，也不给出一条可能带令牌的错误行。
 */
const SAFE_ERROR_MESSAGES = new Set([
  'credential record is not valid JSON',
  'credential record is missing auth.accessToken',
  'credential record is missing refreshToken',
  'credential record is unreadable',
  'refresh response is not valid JSON',
  'refresh response is missing data.accessToken',
  'refreshed record is missing accessToken',
  'upstream response is not a usable stream',
  'network request failed',
])

/** 展示字段长度上限。 */
const FIELD_MAX_LEN = 64

/**
 * 跨源判定：同源（或浏览器未带 Origin 的本地请求）放行，其余一律拒绝。
 * 只看 Origin 的 host 与 Host 头是否一致——端口不同也算跨源。
 * 与 `dsh-quit-button` 的判定同型（本插件不能跨包 import，故此处独立实现）。
 *
 * @param {Record<string, unknown>} [headers]
 * @returns {boolean}
 */
export function isCrossOrigin(headers) {
  const origin = headers?.origin
  if (typeof origin !== 'string' || origin === '') return false
  const host = headers?.host
  if (typeof host !== 'string' || host === '') return true
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/**
 * Host 头是否严格指向受信任的 loopback 名称/地址。
 *
 * 只接受 127.0.0.1、localhost、[::1]，端口可省略或为任意有效十进制端口。
 * 不接受其它 127/8 地址、IPv4 数字别名或 localhost 子域，避免 DNS rebinding 页面把攻击者
 * 域名同时放进 Origin 与 Host 后绕过单纯的 Origin/Host 相等检查。
 *
 * @param {unknown} host
 * @returns {boolean}
 */
export function isTrustedLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  const matched = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(host)
  if (matched === null) return false
  return matched[1] === undefined || Number(matched[1]) <= 65_535
}

/**
 * 读取可选的 webServer 服务。
 *
 * 优先走 `ctx.get('webServer')`：这是 Cordis 官方读取**未在 inject 中声明**的服务的方式，
 * 服务不存在时返回 undefined 而不是抛错。只有在 `get` 完全不存在的语境（最小假 ctx、
 * 非 Cordis 调用方）才退回读 `ctx.webServer` 属性——在真 Cordis ctx 上直接取未声明的
 * 服务属性会抛「cannot get property ... without inject」，所以顺序不能反。
 *
 * @param {any} ctx
 * @returns {any} webServer 服务，或 undefined
 */
export function resolveWebServer(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') return ctx.get('webServer')
  return ctx.webServer
}

/** 统一响应：JSON + 显式 charset，且禁止缓存（响应体含账号脱敏信息）。 */
function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

/** 有限数字则原样返回，否则 0（绝不把任意类型塞进响应体）。 */
function numberOr0(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 读取并解析 JSON 请求体；空体/坏 JSON 一律空对象（active 路由自行校验 id）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let text = ''
    // 全可选链：测试/内部调用方可能传入没有流接口的最小 req 对象。
    req?.setEncoding?.('utf8')
    req?.on?.('data', (chunk) => {
      if (text.length < 4096) text += chunk
    })
    req?.on?.('end', () => {
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve({})
      }
    })
    req?.on?.('error', () => resolve({}))
    // 没有任何流事件的最小对象：立即以空体完成，绝不让请求挂死。
    if (typeof req?.on !== 'function') resolve({})
  })
}

/** 字符串则截断返回，否则空串。 */
function stringOrEmpty(value) {
  return typeof value === 'string' ? value.slice(0, FIELD_MAX_LEN) : ''
}

/**
 * 把任意错误压成一行**可安全回显**的错误信息。
 *
 * 只允许三种来源：错误码（受限字符集）、HTTP 状态码（属性或消息里的 `HTTP <3位>`）、
 * 以及上面的固定消息白名单。其它一律 'request failed'——这样即使某个依赖把上游响应体
 * （可能含令牌）塞进了 error.message，也不会被回显到浏览器。
 *
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const rawCode = error?.code
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(rawCode) ? rawCode : undefined
  let status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : undefined
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (status === undefined) {
    const matched = /\bHTTP (\d{3})\b/.exec(message)
    if (matched !== null) status = Number(matched[1])
  }

  const parts = []
  if (code !== undefined) parts.push(code)
  if (status !== undefined) parts.push(`HTTP ${status}`)
  if (parts.length === 0) parts.push(SAFE_ERROR_MESSAGES.has(message) ? message : 'request failed')
  return parts.join(' / ')
}

/**
 * 造一个路由处理器：loopback Host 校验 → 方法校验 → Origin/Host 校验 → 执行 → 统一错误封套。
 *
 * `ok` 的语义按路由而异，客户端半区据此渲染：
 *   * /status            → 凭据可读；
 *   * /connection/test   → 上游可用（2xx 且回的是可用流）；
 *   * /credential/*      → 本次动作已完成（细节看 refreshed / throttled）。
 *
 * @param {{method:string, crossOriginGuard:boolean, run:() => Promise<object>}} spec
 */
function makeHandler(spec) {
  return async (req, res) => {
    // exact 路由绕过平台 /api 的 cookie 围栏：先把 Host 限死在 loopback，防止攻击者域名
    // 同时充当 Origin 与 Host 的 DNS rebinding 请求越过后面的相等检查。
    if (!isTrustedLoopbackHost(req.headers?.host)) {
      json(res, 403, { ok: false, error: 'untrusted host rejected' })
      return
    }
    if (req.method !== spec.method) {
      json(res, 405, { ok: false, error: `method not allowed; use ${spec.method}` }, { allow: spec.method })
      return
    }
    if (spec.crossOriginGuard && isCrossOrigin(req.headers)) {
      json(res, 403, { ok: false, error: 'cross-origin request rejected' })
      return
    }
    // 本插件不读请求体；排空它以免半读的 POST 连接悬着（需要体的路由在 run 里自行读取）。
    if (spec.readsBody !== true) req.resume?.()
    try {
      json(res, 200, await spec.run(req))
    } catch (error) {
      // 错误可见性：默认只回错误码；DSH_WB_DEBUG=1 时在宿主 stdout 打出完整堆栈，
      // 便于排查（生产默认关闭；响应体仍走白名单，不回显堆栈）。
      if (process.env.DSH_WB_DEBUG === '1') console.error('[workbuddy-auth] route error:', error)
      json(res, 500, { ok: false, error: describeError(error) })
    }
  }
}

/**
 * 注册 4 条路由并返回 disposer（供 `ctx.effect` 使用，卸载时摘除全部路由）。
 *
 * webServer 缺失（非 web 组合）时**降级**：打一行 info、返回 no-op disposer，绝不抛错——
 * 凭据同步与上游 UA 修复完全不依赖本函数。
 *
 * @param {any} ctx Cordis 上下文（只用到 `ctx.get` / `ctx.logger`）
 * @param {{
 *   readCredentialRaw: () => Promise<string>,
 *   testConnection: () => Promise<{status?:number,sseChunks?:boolean,model?:string}>,
 *   refreshNow: () => Promise<{refreshed?:boolean,throttled?:boolean,expiresAt?:number}>,
 *   reloadSeam: () => Promise<{refreshed?:boolean,throttled?:boolean,expiresAt?:number}>,
 *   now?: () => number,
 *   userAgentFix?: boolean,
 *   upstreamHost?: string,
 * }} deps
 * @returns {() => void} disposer（webServer 缺失时是 no-op）
 */
export function registerRoutes(ctx, deps) {
  const server = resolveWebServer(ctx)
  if (server === undefined || typeof server.register !== 'function') {
    ctx?.logger?.info?.(NO_WEB_SERVER_LOG)
    return () => {}
  }

  const now = () => (typeof deps.now === 'function' ? deps.now() : Date.now())
  /** 动作类结果的共同形状：只取白名单字段，绝不 spread。 */
  const actionResult = (result) => ({
    ok: true,
    refreshed: result?.refreshed === true,
    throttled: result?.throttled === true,
    expiresAt: numberOr0(result?.expiresAt),
  })

  const handlers = [
    [
      ROUTE_PATHS.status,
      makeHandler({
        method: 'GET',
        // /status 也返回账号脱敏信息（昵称、手机号、uid 尾号），跨源页面一律拒绝。
        crossOriginGuard: true,
        run: async () => {
          let rawText
          let error
          try {
            rawText = await deps.readCredentialRaw()
          } catch (caught) {
            // M4：凭据读取失败时不能把原始 error 交给 buildStatus —— 它会取 error.message，
            // 而 Node 的 ENOENT/EPERM 消息里带**绝对本地路径**（`… open 'C:\Users\…'`），
            // 直接回显等于把用户目录交给浏览器。这里与 POST 路由走**同一道**白名单，
            // 先压成「错误码 / HTTP 状态码 / 固定消息」再往下传（describeError 只调用一次，
            // 它不幂等：二次处理会把 'ENOENT' 又降级成 'request failed'）。
            error = describeError(caught)
          }
          // buildStatus 自身产出的错误（凭据非 JSON、缺 accessToken 等）都在
          // SAFE_ERROR_MESSAGES 白名单里，因此这条路径不需要二次清洗。
          return buildStatus({
            rawText,
            now: now(),
            userAgentFix: deps.userAgentFix === true,
            upstreamHost: stringOrEmpty(deps.upstreamHost),
            error,
          })
        },
      }),
    ],
    [
      ROUTE_PATHS.connectionTest,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        run: async () => {
          const result = await deps.testConnection()
          const status = numberOr0(result?.status)
          return {
            ok: status >= 200 && status < 300 && result?.sseChunks === true,
            status,
            sseChunks: result?.sseChunks === true,
            model: stringOrEmpty(result?.model),
          }
        },
      }),
    ],
    [
      ROUTE_PATHS.credentialRefresh,
      makeHandler({ method: 'POST', crossOriginGuard: true, run: async () => actionResult(await deps.refreshNow()) }),
    ],
    [
      ROUTE_PATHS.credentialReload,
      makeHandler({ method: 'POST', crossOriginGuard: true, run: async () => actionResult(await deps.reloadSeam()) }),
    ],
    // 多账号路由：仅在 config.authDir 启用时由 index 注入依赖；未启用时返回明确降级。
    [
      `${ROUTE_PREFIX}/credentials/sources`,
      makeHandler({
        method: 'GET',
        crossOriginGuard: true,
        run: async () => {
          if (typeof deps.listCredentialSources !== 'function') return { ok: false, error: 'multi-account disabled' }
          return deps.listCredentialSources()
        },
      }),
    ],
    [
      `${ROUTE_PREFIX}/credentials/active`,
      makeHandler({
        method: 'POST',
        crossOriginGuard: true,
        // 请求体由 run 里的 readJsonBody 读取；预排空会让 data 事件丢失。
        readsBody: true,
        run: async (req) => {
          if (typeof deps.activateCredentialSource !== 'function') return { ok: false, error: 'multi-account disabled' }
          const body = await readJsonBody(req)
          const id = typeof body?.id === 'string' ? body.id.slice(0, 64) : ''
          return deps.activateCredentialSource(id)
        },
      }),
    ],
  ]

  const disposers = handlers.map(([path, handler]) => server.register({ kind: 'exact', path, handler }))
  return () => {
    for (const dispose of disposers) {
      // 卸载路径不得因为某个 disposer 抛错而半途而废。
      try {
        dispose?.()
      } catch {
        /* 忽略：路由摘除失败不应阻断插件卸载 */
      }
    }
  }
}
