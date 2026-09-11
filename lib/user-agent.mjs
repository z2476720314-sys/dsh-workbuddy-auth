// 上游 User-Agent 修复层 —— 唯一能干预「网关按 UA 拦截」的位置。
//
// 为什么需要这一层（缺陷实证，改动前请先读）：
//   WorkBuddy（腾讯 CodeBuddy）的推理网关**按 User-Agent 做安全策略拦截**。用真实请求做的
//   隔离实验：同一个请求体，带 `codebuddy-code/2.137.1` / `CodeBuddy/2.137.1` /
//   `codebuddy/2.137.1` / `Mozilla/5.0` / `dsh-workbuddy/0.1` / 不显式带 UA → 全部 200；
//   只有 DSH 自己的 `deepseek-harness/0.1.5-rc.1 (+https://github.com/deepseek-ai/deepseek-harness)`
//   → 400 {"code":11128,"msg":"request illegal"}。
//   该 UA 由 `@deepseek-ai/dsh-llm` 的 `attributionHeaders()` 生成，而适配器
//   `@deepseek-ai/dsh-llm-pi-ai` 在发请求前用 `headers.set(...)` **无条件覆盖**成自己那一份
//   （`lib/index.js` 的 `for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)`），
//   因此在**路由配置里配 `User-Agent` 是无效的**（会被覆盖）；`attributionHeaders(identity)`
//   虽然支持自定义 identity，但适配器不带参调用，配置层够不着。宿主进程内运行的本插件
//   是唯一可干预点：包一层 `globalThis.fetch`，只对目标上游改写这一个请求头。
//
// 本模块是纯函数式工具，不读文件、不碰令牌、不主动发请求：
//   * 只对**解析后的 URL hostname 精确等于 `host`**的请求改写 `user-agent`；
//   * 其余请求**原样透传**（连 `init` 的对象引用都不换，见 test/user-agent.test.mjs 的反向断言）；
//   * 安装 / 卸载都必须可逆：disposer 只复原「自己装的那一层」。
/** 默认的上游域名（WorkBuddy 推理网关）。 */
export const DEFAULT_UPSTREAM_HOST = 'copilot.tencent.com'
/** 默认的替代 User-Agent：走已验证为 200 的自有标识，而不是会被拦的 deepseek-harness/*。 */
export const DEFAULT_UPSTREAM_USER_AGENT = 'dsh-workbuddy/0.1'

/**
 * 安装标记：挂在包装层函数上，用于幂等判断与 disposer 找回原实现。
 * 用 Symbol.for 以便同一进程内多份模块实例（例如联结安装与源码目录）也能互相识别。
 */
const MARKER = Symbol.for('dsh-workbuddy-auth.user-agent-fix')

/**
 * 从 fetch 的第一参数取出 URL 字符串。
 * 支持 string / URL（有 href）/ Request（有 url）；取不到时返回 undefined，
 * 此时调用方必须**原样透传**：判断不出目标域名就绝不改动请求。
 *
 * @param {unknown} input
 * @returns {string|undefined}
 */
export function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input === null || typeof input !== 'object') return undefined
  if (typeof input.url === 'string') return input.url
  if (typeof input.href === 'string') return input.href
  return undefined
}

/** 把 host 配置规范化为仅 hostname；非法值永不匹配请求。 */
function normalizeHostname(host) {
  if (typeof host !== 'string' || host === '') return undefined
  try {
    return new URL(`https://${host}`).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** 解析请求 URL 的 hostname；非法 URL 永不匹配目标。 */
function requestHostname(input) {
  const value = requestUrl(input)
  if (value === undefined) return undefined
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** 鸭子类型判定 Request（不依赖 instanceof，避免跨 realm 误判）。 */
function isRequestLike(input) {
  return (
    input !== null &&
    typeof input === 'object' &&
    typeof input.url === 'string' &&
    typeof input.clone === 'function' &&
    typeof input.headers === 'object'
  )
}

/** 构造 no-op disposer，并如实标注「本次没有安装/没有改动任何东西」及其原因。 */
function noop(reason) {
  const dispose = () => {}
  dispose.installed = false
  dispose.reason = reason
  return dispose
}

/**
 * 给 `globalThis.fetch` 装一层「只改目标上游 user-agent」的包装。
 *
 * 语义要点：
 *   * **只改写，不重建**：目标上游的 `init` 会以浅拷贝 + `Headers` 副本转发（调用方对象保持原样）；
 *     Request 输入则构造一个新的 Request（原对象不被就地改写）。
 *   * **非目标上游零改动**：直接以原始实参转发，实参个数也保持不变
 *     （`fetch(url)` 仍以单参调用被包装实现），`init` / `Request` 都是同一个对象引用。
 *   * **幂等**：当前 `globalThis.fetch` 已是本模块装的层时直接返回，不再叠加；此时返回的是
 *     no-op disposer（`installed === false`, `reason === 'already-installed'`），
 *     这样卸载「第二个挂载点」不会掀掉「第一个挂载点」仍在用的那层。
 *   * **可逆且不越权**：disposer 只在 `globalThis.fetch` 仍指向我们那层时才复原，
 *     别人后装的 fetch 绝不会被覆盖。
 *   * **安全跳过**：没有可用的 fetch 时返回 no-op disposer（`reason === 'fetch-unavailable'`），
 *     绝不改动 `globalThis.fetch`。
 *
 * @param {{host?:string,userAgent?:string,fetchImpl?:Function}} [options]
 * @returns {(() => void) & {installed:boolean, reason:'installed'|'already-installed'|'fetch-unavailable'}} disposer
 */
export function installUserAgentFix(options = {}) {
  const host = options.host ?? DEFAULT_UPSTREAM_HOST
  const normalizedHost = normalizeHostname(host)
  const userAgent = options.userAgent ?? DEFAULT_UPSTREAM_USER_AGENT
  const target = globalThis
  // previous：安装前 globalThis.fetch 的值 —— disposer 复原的是**它**（原样放回被我们替换掉的那份），
  // 而不是 fetchImpl；fetchImpl 只是被包装层转发的实现，两者可能不同（测试就是这么注入假 fetch 的）。
  const previous = target.fetch

  // 幂等：已经是我们装的层 → 复用，不叠加。返回 no-op disposer（见上）。
  if (typeof previous === 'function' && previous[MARKER] !== undefined) return noop('already-installed')

  const original = options.fetchImpl ?? previous
  if (typeof original !== 'function') return noop('fetch-unavailable')
  // fetchImpl 自己就是我们的包装层（例如把包装层当原实现传回来）时不叠加。
  if (original[MARKER] !== undefined) return noop('already-installed')
  const wrapper = async function fetchWithUserAgent(input, init) {
    const hostname = requestHostname(input)
    if (normalizedHost === undefined || hostname !== normalizedHost) {
      // 反向断言所在：非目标上游**原样透传**，实参个数与对象引用都不变。
      return init === undefined ? original(input) : original(input, init)
    }
    // Headers 构造器同时接受 Headers / 普通对象 / 键值对数组；Request 输入时缺省取请求自身的头。
    const headers = new Headers(init?.headers ?? (isRequestLike(input) ? input.headers : undefined))
    headers.set('user-agent', userAgent)
    if (isRequestLike(input)) return original(new Request(input, { ...(init ?? {}), headers }))
    return original(input, { ...(init ?? {}), headers })
  }

  const dispose = () => {
    // 只在当前装的仍是自己那层时复原：别人后装的 fetch 不能被我们覆盖掉。
    if (target.fetch === wrapper) target.fetch = previous
  }
  dispose.installed = true
  dispose.reason = 'installed'
  wrapper[MARKER] = { previous, original, host: normalizedHost, userAgent, dispose }
  target.fetch = wrapper
  return dispose
}
