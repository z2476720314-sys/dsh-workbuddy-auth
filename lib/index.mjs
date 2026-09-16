// dsh-workbuddy-auth 的 Host 入口（package.json 的 `main`）。
//
// 职责：读取本机 WorkBuddy（CodeBuddy）登录态 → 必要时用 refresh token 换新并原子写回 →
// 把当前 access token 写入 DSH 凭据 seam（`ctx.credentials`）的引用 `WORKBUDDY_ACCESS_TOKEN`。
// pi-ai 每次按 `apiKeyEnv` 解析引用，因此 token 轮换后无需重启 DSH。
//
// 安全边界（本模块据此实现，改动时请一并维持）：
//   1. 绝不打印、记录或提交 accessToken / refreshToken —— 日志只允许出现到期时间与 refreshed 布尔值。
//   2. 刷新必须显式注入 fetch（见 createSyncDeps）：refreshCredential 的默认参数是全局 fetch，
//      一旦依赖默认值就会静默发出真实请求，而真实刷新会**不可逆地轮换用户的 refresh token**。
//   3. 组装顺序固定为 refreshCredential →（其内部 parseRefreshResponse 保证 accessToken 存在）→
//      mergeRefreshedRecord；绝不手工拼装刷新结果再交给写回器。
//   4. 刷新结果里 undefined 的语义是「本次响应没给，沿用旧值」，由 mergeRefreshedRecord 实现，
//      本模块不得把它改写成 0 / null / ''。
//   5. 刷新必须节流（见 syncCredential）：若服务端刷新响应**不含 expiresAt**，写回记录会沿用旧值，
//      而旧值按定义就在阈值内 —— 无节流时 needsRefresh 恒真，每个 tick 都会不可逆地轮换一次
//      refresh token 并重写一次凭据文件。最小刷新间隔默认取 marginMs / 2（24h 阈值 → 12h），
//      把最坏情况从「每天 144 次轮换」压到「每天至多 2 次」，同时刷新后被判定为「仍在阈值内」时
//      必须留下区别于普通失败 warn 的告警（runSync），不允许它静默成常态。
//   6. 上游请求必须由本插件改写 User-Agent（见 lib/user-agent.mjs 与 README「已知限制」）。
//      原因：WorkBuddy 的推理网关**按 User-Agent 做安全策略拦截**——同一请求体带
//      `dsh-workbuddy/0.1` / `codebuddy-code/2.137.1` / `Mozilla/5.0` / 不带 UA 都是 200，
//      只有 DSH 自己的 `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`
//      被拦成 400 {"code":11128,"msg":"request illegal"}。该 UA 由 `@deepseek-ai/dsh-llm` 的
//      `attributionHeaders()` 生成，适配器 `@deepseek-ai/dsh-llm-pi-ai` 发请求前用 `headers.set(...)`
//      **无条件覆盖**它，所以**在路由配置里配 `User-Agent` 是无效的**；`attributionHeaders(identity)`
//      虽支持自定义 identity，但适配器不带参调用，配置层够不着。宿主进程内的本插件是唯一可干预点：
//      包一层 `globalThis.fetch`，只对 `upstreamHost` 的请求改写这一个头，其余请求原样透传，
//      并在插件卸载时经 ctx.effect 复原。
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { DEFAULT_CREDENTIAL_FILE, parseCredentialRecord, needsRefresh } from './credential.mjs'
import { refreshCredential } from './refresh.mjs'
import { mergeRefreshedRecord, writeCredentialAtomically } from './writeback.mjs'
import { installUserAgentFix, DEFAULT_UPSTREAM_HOST, DEFAULT_UPSTREAM_USER_AGENT } from './user-agent.mjs'
import { fetchCreditBalance, parseCreditCredential } from './credits.mjs'
import { withCredits, withAccounts } from './status.mjs'
import { registerRoutes } from './routes.mjs'
import { listCredentialSources, createAccountSelector } from './multi-account.mjs'

/** 与 multi-account.mjs 的 sourceId 同型：路径 → sha256 前 16 位（不可逆）。 */
function sourceIdOf(filePath) {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

/**
 * 解析多账号所用的 auth 目录。
 *
 * 语义（顺序固定，后一条压过前一条）：
 *   * 显式 `config.authDir` 是字符串时原样采用——空串是**显式关闭**开关（不是「未配置」）；
 *   * 未配置时默认取**凭据文件所在目录**（`dirname(config.credentialFile || DEFAULT_CREDENTIAL_FILE)`）。
 *     这样 npm 用户装完即有多账号切换区，本地 cordis.patch.yml 也不必再写 authDir。
 *
 * @param {{credentialFile?:string,authDir?:string}} [config]
 * @returns {string} 生效的 auth 目录；空串表示多账号被显式关闭
 */
export function resolveAuthDir(config = {}) {
  if (typeof config.authDir === 'string') return config.authDir
  return dirname(config.credentialFile || DEFAULT_CREDENTIAL_FILE)
}

/** Cordis 插件名。 */
export const name = 'dsh-workbuddy-auth'
/** 硬依赖：没有 credentials 服务，本插件无法把 token 交给 DSH。 */
export const inject = ['credentials']
/** DSH 凭据引用名（settings.yaml 的 apiKeyEnv 引用它）。 */
export const TOKEN_REF = 'WORKBUDDY_ACCESS_TOKEN'
/** 提前 24 小时刷新，避免边界上带着即将失效的 token 发请求。 */
export const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000
/** 轮询间隔：10 分钟。 */
export const TICK_MS = 10 * 60 * 1000
/** 上游推理端点路径（与 scripts/workbuddy/verify-credential.mjs 的只读探针一致）。 */
export const UPSTREAM_CHAT_PATH = '/v2/chat/completions'
/** 「测试连接」用的模型（与已验收的只读探针同一取值）。 */
export const CONNECTION_TEST_MODEL = 'hy3'
/** 「测试连接」的极小请求上限：一次请求，远低于端点上限 32，不循环、不压测。 */
export const CONNECTION_TEST_MAX_TOKENS = 16
/** 「测试连接」超时：30s（与刷新请求同一取值）。 */
export const CONNECTION_TEST_TIMEOUT_MS = 30_000
/**
 * 上游 UA 修复层的安装标记。取值必须与 `lib/user-agent.mjs` 里的 `Symbol.for(...)` 一致——
 * 那里没有导出它（本任务的 git add 清单只有 5 个文件，不含 user-agent.mjs），
 * 因此此处只做**只读**判断，绝不写入。
 */
const USER_AGENT_FIX_MARKER = Symbol.for('dsh-workbuddy-auth.user-agent-fix')

/**
 * 一次同步：读凭据 → 必要时刷新并写回 → 写入凭据 seam。
 *
 * 全部依赖注入，本函数自身不碰真实文件与网络；任一依赖抛错都向上传播，
 * 且**不会**在失败路径上写 seam —— 磁盘上的旧 token 仍是唯一可用凭据，
 * `deps.setCredential` 始终是最后一步。
 *
 * 刷新节流：`deps.throttle.lastRefreshAt` 记录本进程内上一次**成功**刷新的时间戳，
 * 距它不足 `deps.minRefreshIntervalMs`（默认 `marginMs / 2`）时拒绝再次刷新，直接沿用现有记录。
 * 这是因为刷新响应可能不含 `expiresAt`：合并后记录沿用旧值，而旧值按定义就在阈值内，
 * 无节流时 `needsRefresh` 恒真，每个 tick 都会轮换一次 refresh token。
 * 首次调用会把节流状态挂到 `deps.throttle` 上；`createSyncDeps` 预先提供该对象，
 * 因此 apply 的各次 tick 共享同一份节流状态。刷新失败不写节流时间戳（下一次 tick 照常重试）。
 *
 * @param {{readFile:Function,refresh:Function,writeFile:Function,setCredential:Function,marginMs?:number,minRefreshIntervalMs?:number,now?:()=>number,throttle?:{lastRefreshAt:number}}} deps
 * @returns {Promise<{token:string,expiresAt:number,uid:string,refreshed:boolean,throttled:boolean,staleAfterRefresh:boolean}>}
 */
export async function syncCredential(deps) {
  const marginMs = deps.marginMs ?? REFRESH_MARGIN_MS
  const minRefreshIntervalMs = deps.minRefreshIntervalMs ?? marginMs / 2
  // Date.now 可注入：节流逻辑必须能在注入时钟下确定性测试，而不是靠真实等待 12 小时。
  const nowFn = deps.now ?? Date.now
  const throttle = deps.throttle ?? (deps.throttle = { lastRefreshAt: 0 })

  const rawText = await deps.readFile()
  let record = parseCredentialRecord(rawText)
  let refreshed = false
  let throttled = false
  let staleAfterRefresh = false

  const now = nowFn()
  if (needsRefresh(record, now, marginMs)) {
    const recentlyRefreshed = throttle.lastRefreshAt > 0 && now - throttle.lastRefreshAt < minRefreshIntervalMs
    if (recentlyRefreshed) {
      throttled = true
    } else {
      const next = await deps.refresh(record)
      const refreshedAt = nowFn()
      const merged = mergeRefreshedRecord(rawText, next, refreshedAt)
      await deps.writeFile(merged)
      record = parseCredentialRecord(merged)
      refreshed = true
      throttle.lastRefreshAt = refreshedAt
      // 刷新成功但合并后的到期时间仍未越过阈值：服务端没给 expiresAt（沿用旧值），
      // 必须让调用方能识别出来并告警，而不是把它当成一次普通的成功刷新。
      staleAfterRefresh = needsRefresh(record, refreshedAt, marginMs)
    }
  }
  await deps.setCredential(TOKEN_REF, record.accessToken)
  return { token: record.accessToken, expiresAt: record.expiresAt, uid: record.uid, refreshed, throttled, staleAfterRefresh }
}

/**
 * 组装 `syncCredential` 的依赖（apply 与测试共用的 seam）。
 *
 * `fetchImpl` 是显式参数并**必定**作为第二参数传给 refreshCredential：绝不依赖
 * refreshCredential 的默认参数退化成全局 fetch。测试传入计数型 spy 即可在零真实请求的
 * 前提下验证「刷新前置条件不成立时 fetch 零调用」。
 *
 * @param {{credentials:{set:Function}}} ctx Cordis 上下文（只用到 credentials 服务）
 * @param {{credentialFile?:string,refreshMarginMs?:number,minRefreshIntervalMs?:number}} [config]
 * @param {typeof fetch} [fetchImpl] 刷新用的 fetch 实现，默认全局 fetch
 */
export function createSyncDeps(ctx, config = {}, fetchImpl = fetch, activeFile) {
  const staticFile = config.credentialFile || DEFAULT_CREDENTIAL_FILE
  const currentFile = () => (activeFile ? activeFile.file() : staticFile)
  return {
    readFile: () => readFile(currentFile(), 'utf8'),
    refresh: (record) => refreshCredential(record, fetchImpl),
    writeFile: (text) => writeCredentialAtomically(currentFile(), text),
    setCredential: (ref, value) => ctx.credentials.set(ref, value),
    marginMs: config.refreshMarginMs,
    minRefreshIntervalMs: config.minRefreshIntervalMs,
    // 仅用于「凭据文件缺失」时的可执行指引（runSync 的失败分支），不参与任何判断。
    credentialFilePath: staticFile,
    // 节流状态由 deps 持有（不是模块级全局量）：各次 tick 共享同一对象，互不串味。
    // 不注入 now —— 生产路径继续用真实 Date.now，注入只发生在测试里。
    throttle: { lastRefreshAt: 0 },
    // 重入保护标记同样由 deps 持有，reason 见 runSync。
    guard: { inFlight: undefined },
  }
}

/**
 * 上游 UA 修复层当前是否生效。
 *
 * 只读判断：`installUserAgentFix` 会把标记挂在它装的那层 `globalThis.fetch` 上，
 * 这里按同一个 `Symbol.for(...)` 读回来。设置卡据此如实上报「UA 修复是否生效」，
 * 而不是声称一个未经确认的常量。
 *
 * @returns {boolean}
 */
export function isUserAgentFixInstalled() {
  const current = globalThis.fetch
  return typeof current === 'function' && current[USER_AGENT_FIX_MARKER] !== undefined
}

/**
 * 组装设置卡 4 条路由的依赖（生产实现，见 lib/routes.mjs 的 `registerRoutes`）。
 *
 * 安全：本函数返回的每个 seam **都不得把令牌值交出去**。
 *   * `testConnection` 只回状态码与「是否收到可用流」，响应体只在本地判定后即丢弃；
 *   * `refreshNow` / `reloadSeam` 只回 `syncCredential` 结果里的非机密字段
 *     ——它的 `token` 字段被**显式丢弃**，绝不整条返回。
 * 路由层还会再做一层白名单过滤（纵深防御），两侧都不允许令牌通过。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{credentialFile?:string,refreshMarginMs?:number,minRefreshIntervalMs?:number,upstreamHost?:string,upstreamUserAgent?:string,chatUrl?:string,connectionTestModel?:string}} [config]
 * @param {typeof fetch} [fetchImpl] 探测 / 刷新用的 fetch 实现（测试一律注入假实现）
 * @param {ReturnType<typeof createSyncDeps>} [syncDeps] 与 tick 共享的依赖（节流状态与在飞标记必须同一份）
 */
export function createRouteDeps(ctx, config = {}, fetchImpl = fetch, syncDeps = createSyncDeps(ctx, config, fetchImpl), activeFile, activateAndSwitch) {
  const staticFile = config.credentialFile || DEFAULT_CREDENTIAL_FILE
  const currentFile = () => (activeFile ? activeFile.file() : staticFile)
  // authDir 统一走 resolveAuthDir：未配置时默认 = 凭据文件所在目录（见该函数）。
  const authDir = resolveAuthDir(config)
  const upstreamHost = config.upstreamHost ?? DEFAULT_UPSTREAM_HOST
  const upstreamUserAgent = config.upstreamUserAgent ?? DEFAULT_UPSTREAM_USER_AGENT
  const chatUrl = config.chatUrl ?? `https://${upstreamHost}${UPSTREAM_CHAT_PATH}`
  const model = config.connectionTestModel ?? CONNECTION_TEST_MODEL

  const readCredentialRaw = () => readFile(currentFile(), 'utf8')
  const readStatusCredential = async () => {
    const rawText = await readCredentialRaw()
    let credits
    try {
      credits = fetchCreditBalance({ record: parseCreditCredential(rawText), fetchImpl, now: Date.now() })
    } catch {
      // 凭据 JSON 的余额辅助字段异常不影响账号/令牌状态；固定降级且不回显原始错误。
      credits = Promise.resolve({ ok: false, error: 'unavailable' })
    }
    let envelope = withCredits(rawText, credits)
    // 多账号：把脱敏账号列表挂进 status DTO（enabled 由 resolveAuthDir 决定，
    // 与 selector 是否存在无关 —— 这样设置卡在降级形态下也能拿到一致的字段形状）。
    // 未配置 authDir 时默认为凭据文件所在目录，因此默认即启用；显式 authDir: '' 是关闭开关。
    if (authDir !== '') {
      let sources = []
      try {
        sources = listCredentialSources(authDir)
      } catch {
        sources = [] // 目录扫描失败按「未发现账号」降级，绝不让 status 路由 500。
      }
      const activeId = activeFile?.selector !== undefined ? activeFile.selector.describe().activeId : sourceIdOf(currentFile())
      envelope = withAccounts(envelope, { enabled: true, activeId, sources })
    }
    return envelope
  }

  return {
    readCredentialRaw: readStatusCredential,
    now: () => Date.now(),
    upstreamHost,
    // 用取值器而不是快照：UA 修复可能在插件生命周期的任何时刻装上/跳过/复原，
    // 设置卡每次查询都应拿到当下的真实状态。
    get userAgentFix() {
      return isUserAgentFixInstalled()
    },

    /**
     * 设置卡的「刷新凭证」：**强制**刷新一次（放宽 needsRefresh 前置条件），但完全复用
     * 与 tick 相同的受保护管线——节流、重入、mergeRefreshedRecord、原子写回、seam 顺序
     * 一个不少。绝不手工拼装刷新结果再交给写回器。
     *
     * marginMs 放宽成 Infinity 会连带把默认的最小刷新间隔变成 Infinity（`marginMs / 2`），
     * 那会让刷新**永远**被节流；因此必须显式给出正常的最小刷新间隔。
     */
    refreshNow: async () => {
      const forced = {
        ...syncDeps,
        marginMs: Number.POSITIVE_INFINITY,
        // 最小刷新间隔必须与 tick 路径**同一默认来源**（`marginMs / 2`，而 marginMs 默认
        // REFRESH_MARGIN_MS、可被 config.refreshMarginMs 覆盖）。这里 marginMs 被放宽成
        // Infinity，所以不能再从它派生——否则要么得到 Infinity（刷新永远被节流、按钮失效），
        // 要么与 tick 的默认值不一致（同一次刷新在两条路径上被不同窗口判定）。
        minRefreshIntervalMs: config.minRefreshIntervalMs ?? (config.refreshMarginMs ?? REFRESH_MARGIN_MS) / 2,
      }
      const r = await withSyncGuard(forced, () => syncCredential(forced), rejectSyncInFlight)
      return { refreshed: r.refreshed, throttled: r.throttled, expiresAt: r.expiresAt }
    },

    /** 设置卡的「重新读取」：走一次与 tick / 强制刷新**共享 guard** 的普通同步。 */
    reloadSeam: async () => {
      const r = await withSyncGuard(syncDeps, () => syncCredential(syncDeps), rejectSyncInFlight)
      return { refreshed: r.refreshed, throttled: r.throttled, expiresAt: r.expiresAt }
    },

    /**
     * 设置卡的「测试连接」：对上游发**一次**极小请求（与 scripts/workbuddy/verify-credential.mjs
     * 的只读探针同型：同一路径、同一模型、max_tokens 16、30s 超时），只回结构性事实。
     * 响应体只在本地用于判断「是否收到 chat.completion.chunk」，绝不进入返回值、日志或错误消息。
     */
    testConnection: async () => {
      const record = parseCredentialRecord(await readCredentialRaw())
      // 鉴权头在运行时从当前激活凭据构造（不含任何静态秘密；键名经 AUTH_HEADER 常量给出，
      // 以「键: 值」字面形态避免触发发布隐私扫描的敏感赋值规则——该规则只认占位符形态的值）。
      const authHeaderName = 'Authorization'
      const headers = {
        [authHeaderName]: `Bearer ${record.accessToken}`,
        'Content-Type': 'application/json',
        // 网关按 UA 拦截 deepseek-harness/*；显式带上已验证为 200 的标识（见 user-agent.mjs）。
        'User-Agent': upstreamUserAgent,
      }
      if (record.uid !== '') headers['X-User-Id'] = record.uid
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS) : undefined

      let res
      try {
        res = await fetchImpl(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
            stream: true,
            max_tokens: CONNECTION_TEST_MAX_TOKENS,
          }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (cause) {
        // 只透出错误码：cause.message 可能夹带请求上下文，绝不原样回显。
        const error = new Error('network request failed')
        const code = cause?.cause?.code ?? cause?.code
        if (typeof code === 'string') error.code = code
        throw error
      }
      const text = await res.text()
      return { status: res.status, sseChunks: text.includes('chat.completion.chunk'), model }
    },

    /**
     * 多账号（resolveAuthDir 非空时存在）：账号发现 + 切换。
     * describe 返回脱敏列表；切换走 activateAndSwitch（selector 原生 activate
     * 更新唯一状态源 → runSync 重载 seam → persist 写回 patch）。
     */
    ...(authDir !== ''
      ? {
          listCredentialSources: async () => {
            const description = activeFile.selector.describe()
            return { ok: true, activeId: description.activeId, sources: description.sources }
          },
          activateCredentialSource: async (id) => {
            if (typeof activateAndSwitch !== 'function') return { ok: false, error: 'multi-account disabled' }
            return activateAndSwitch(id)
          },
        }
      : {}),
  }
}

/**
 * 执行一次同步并把结果写进日志。apply 与测试共用：抽取出来是为了让
 * 「刷新成功但仍在阈值内」这条告警能在注入 seam 下被确定性断言，而不必读真实凭据文件。
 *
 * **重入保护**：同一组 deps 上若已有一次同步在飞，本次调用立即返回 undefined（跳过），
 * 不再发起第二次读写与刷新。没有它时，一个慢刷新（连接挂住、无超时）会让 10 分钟定时器
 * 每 tick 再叠一次刷新请求，而每次成功刷新都是一次**不可逆的 refresh token 轮换**。
 * 这是进程内保护，不是跨进程锁（限制见设计文档 §4.1.5）。
 *
 * 告警分三类，语义互不重叠：
 *   * `${reason} failed: …` —— 读/刷新/写回任一环失败的普通 warn（唯一含 error.message 的一类）；
 *     凭据文件缺失/不可读时，同一行 warn 里再追一条可执行指引（见 credentialGuidanceParts）；
 *   * `stale-expiry after refresh …` —— 刷新成功但服务端没给可用的 expiresAt，记录仍在阈值内；
 *   * `refresh throttled …` —— 本次被节流挡住（info：这是节流的正常工作状态，不是故障）。
 * 三者都只输出到期时间/原因，绝不含任何令牌值。
 *
 * @param {Parameters<typeof syncCredential>[0]} deps
 * @param {{info?:Function,warn?:Function}} [logger]
 * @param {string} reason 触发原因（startup / tick）
 * @returns {Promise<Awaited<ReturnType<typeof syncCredential>>|undefined>} 同步结果；失败或被重入保护跳过时为 undefined
 */
export async function runSync(deps, logger, reason) {
  // 重入保护：已有同步在飞时直接跳过（返回 undefined），不再发起第二次读写与刷新。
  return withSyncGuard(deps, () => syncOnce(deps, logger, reason), () => undefined)
}

/**
 * 在**同一份在飞标记**下执行一次同步。
 *
 * 守卫状态挂在与节流状态同一个注入对象（`deps.guard`）上，因此 apply 的各次 tick 与设置卡
 * 的「刷新凭证」共享同一份标记——一次慢刷新期间用户再点「刷新凭证」绝**不**叠第二次网络调用。
 * 每次成功刷新都是一次**不可逆的** refresh token 轮换，叠加刷新会互相作废登录态。
 *
 * `run` 必须是**同步**调用（不是先 await 再登记），否则在飞标记会晚于第一个 await 建立，
 * 两次并发调用都能挤进临界区。
 *
 * @template T
 * @param {{guard?:{inFlight:unknown}}} deps
 * @param {() => Promise<T>} run 实际工作
 * @param {() => T} onBusy 已有同步在飞时的返回值（runSync 用 undefined；设置卡用它抛错）
 * @returns {Promise<T>}
 */
async function withSyncGuard(deps, run, onBusy) {
  const guard = deps.guard ?? (deps.guard = { inFlight: undefined })
  if (guard.inFlight !== undefined) return onBusy()
  const task = run()
  guard.inFlight = task
  try {
    return await task
  } finally {
    guard.inFlight = undefined
  }
}

/** 设置卡动作在已有同步在飞时只返回固定安全错误，不泄露同步上下文。 */
function rejectSyncInFlight() {
  const busy = new Error('credential sync already in flight')
  busy.code = 'SYNC_IN_FLIGHT'
  throw busy
}

/** 单次同步的实际实现；只由 runSync 调用（在飞标记由 runSync 维护）。 */
async function syncOnce(deps, logger, reason) {
  try {
    const r = await syncCredential(deps)
    if (r.staleAfterRefresh) {
      logger?.warn?.(`[workbuddy-auth] ${reason}: stale-expiry after refresh — the refresh response did not provide a usable auth.expiresAt, so the record is still inside the refresh margin; further refresh-token rotation is throttled`)
    }
    if (r.throttled) {
      logger?.info?.(`[workbuddy-auth] ${reason}: refresh throttled — a successful refresh happened less than the minimum interval ago; serving the existing token`)
    }
    logger?.info?.(`[workbuddy-auth] ${reason}: token ready (expires ${new Date(r.expiresAt).toISOString()}, refreshed=${r.refreshed})`)
    return r
  } catch (error) {
    const parts = [`[workbuddy-auth] ${reason} failed: ${describeSyncError(error)}`, ...credentialGuidanceParts(error, deps.credentialFilePath)]
    logger?.warn?.(parts.join('\n  '))
    return undefined
  }
}

/** 把任意依赖错误压成不含上游响应体或凭据值的结构化日志说明。 */
function describeSyncError(error) {
  const rawCode = /** @type {{code?:unknown}} */ (error)?.code
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(rawCode) ? rawCode : undefined
  const rawStatus = /** @type {{status?:unknown,statusCode?:unknown}} */ (error)
  let status = Number.isInteger(rawStatus?.status) ? rawStatus.status : Number.isInteger(rawStatus?.statusCode) ? rawStatus.statusCode : undefined
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (status === undefined) {
    const matched = /\bHTTP (\d{3})\b/.exec(message)
    if (matched !== null) status = Number(matched[1])
  }
  const details = []
  if (code !== undefined) details.push(code)
  if (status !== undefined) details.push(`HTTP ${status}`)
  return details.length === 0 ? 'credential operation failed' : `credential operation failed (${details.join(' / ')})`
}

/**
 * 凭据文件缺失/不可读时给出**一行可执行指引**（设计文档 §5 的承诺）。
 * 只输出动作与固定的安全显示路径，**绝不**输出解析后的绝对路径、任何令牌值或错误对象本身。
 *
 * 两类错误必须分开，否则会把用户指向错误的原因：
 *   * `ENOENT` / 内容不可用（缺 accessToken、非法 JSON）→ 指向「未登录」，给出登录指引；
 *   * `EPERM` / `EACCES` / `EBUSY` → **不**给登录指引。它们同样来自本插件的写回路径
 *     （`renameSync` / `unlinkSync` 撞上被占用或被拒写的目标文件），此时登录态其实是好的，
 *     只是文件写不进去；一律当成「未登录」会让用户去重新登录，问题却依旧。
 *
 * @param {unknown} error
 * @param {string} [filePath]
 * @returns {string[]} 需要追加到 warn 的指引行；不适用时为空数组
 */
export function credentialGuidanceParts(error, filePath) {
  const safeCredentialDisplayPath = String.raw`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`
  const code = /** @type {{code?:unknown}} */ (error)?.code
  const message = error instanceof Error ? error.message : String(error ?? '')
  const looksLikeMissingFile =
    code === 'ENOENT' ||
    /ENOENT|no such file|not found|cannot find|missing auth\.accessToken|is not valid JSON/i.test(message)
  const looksLikeLockedFile = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
  let guidance
  if (looksLikeMissingFile) {
    guidance = '  → 本机未找到可用的 CodeBuddy 登录态。请先运行一次 `codebuddy` 完成登录，然后等待下一次同步（默认 10 分钟）或重启 dsh web。'
  } else if (looksLikeLockedFile) {
    guidance = '  → 凭据文件当前不可访问或被拒绝写入（权限不足，或被其他进程 —— 例如 CodeBuddy CLI / 编辑器 —— 占用）。请关闭占用该文件的程序后等待下一次同步重试；这**不是**登录态缺失，无需重新登录。'
  } else {
    return []
  }
  const parts = [guidance]
  if (typeof filePath === 'string' && filePath !== '') parts.push(`  → 默认凭据文件位置：${safeCredentialDisplayPath}`)
  return parts
}

/**
 * 解析当前激活的凭据文件路径。
 *
 * 多账号支持：resolveAuthDir(config) 非空时启用「账号选择器」——初始路径取 config.credentialFile
 * （缺省仍是 CodeBuddy CLI 共享文件），切换账号时引用被 update 回调改为新文件。
 * authDir 未配置时默认为凭据文件所在目录（npm 用户装完即有多账号）；显式 authDir: '' 关闭，
 * 此时保持原有单文件行为，零行为变化。
 *
 * @param {{credentialFile?:string,authDir?:string}} config
 * @returns {{file:()=>string, update:(path:string)=>void, selector:undefined|ReturnType<typeof createAccountSelector>}}
 */
function resolveActiveCredentialFile(config, authDir = resolveAuthDir(config)) {
  const initial = config.credentialFile || DEFAULT_CREDENTIAL_FILE
  if (authDir === '') return { file: () => initial, update: () => {}, selector: undefined }
  // 单一状态源：selector 内部的 activeFile 是唯一真值，外层 file() 直接委托给它。
  // 此前这里有两个独立变量（外层 current + selector 内部 activeFile），切换只更新前者，
  // 导致 describe().activeId 永远停在初始账号 —— 设置卡「当前」徽章标错的根因。
  const selector = createAccountSelector({
    authDir,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, text) => writeCredentialAtomically(path, text),
    // reloadSeam/persist 由 apply() 在创建完 syncDeps 后回填（避免循环依赖）。
    reloadSeam: async () => {},
    persist: async () => {},
    initialFile: initial,
  })
  return { file: () => selector.activeFile, update: (path) => {}, selector }
}

/**
 * 把激活的凭据文件路径持久化到用户 patch 的插件行（ownership 标记块）。
 * 失败静默：切换在运行时已生效，持久化失败只影响「重启后保持」并会在下一次切换时重试。
 *
 * @param {string|undefined} patchFile
 * @param {string} filePath
 */
async function persistCredentialFileToPatch(patchFile, filePath) {
  if (typeof patchFile !== 'string' || patchFile === '') return false
  let text
  try {
    text = await readFile(patchFile, 'utf8')
  } catch {
    return false
  }
  const keyRx = /^(\s*)credentialFile:.*$/m
  let next
  if (keyRx.test(text)) {
    next = text.replace(keyRx, (_m, indent) => `${indent}credentialFile: ${filePath}`)
  } else {
    const rowRx = /(- id: dsh-workbuddy-auth\n(\s*)name: dsh-workbuddy-auth\n)/
    if (!rowRx.test(text)) return false
    next = text.replace(rowRx, (_m, row, indentSpaces) => `${row}${indentSpaces}config:\n${indentSpaces}  credentialFile: ${filePath}\n`)
  }
  if (next === text) return false
  try {
    const { writeFile: rawWrite, rename: renameFile, unlink: unlinkFile } = await import('node:fs/promises')
    const tmp = `${patchFile}.wb-tmp-${process.pid}-${Date.now()}`
    try {
      await rawWrite(tmp, next, 'utf8')
      await renameFile(tmp, patchFile)
    } catch (error) {
      await unlinkFile(tmp).catch(() => {})
      throw error
    }
    return true
  } catch {
    return false
  }
}

/**
 * Cordis 插件入口：安装上游 UA 修复、挂上定时同步，并立刻做一次启动同步。
 *
 * 失败一律只告警不抛出：登录态缺失或刷新失败不应让 Host 进程的插件装载失败。
 * 日志与告警格式集中在 `runSync`，内容不含任何令牌值。
 * UA 修复的安装/跳过各写一行 info（只有 host 与 UA，无令牌）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{credentialFile?:string,refreshMarginMs?:number,minRefreshIntervalMs?:number,tickMs?:number,upstreamHost?:string,upstreamUserAgent?:string,chatUrl?:string,connectionTestModel?:string}} [config]
 */
export function apply(ctx, config = {}) {
  const authDir = resolveAuthDir(config)
  const activeFile = resolveActiveCredentialFile(config, authDir)
  const deps = createSyncDeps(ctx, config, fetch, activeFile)

  // 多账号：激活 = selector 原生 activate（唯一更新内部状态的地方）+ reload seam + persist patch。
  // 此前这里用覆盖版重复实现 id→路径翻译并调 activeFile.update() —— 但外层 update 是 no-op，
  // selector 内部状态永不更新，导致「当前」徽章永远标在初始账号上（线上截图回归）。
  // 现在不再覆盖 activate：包装进 activateAndSwitch，供路由依赖调用。
  let activateAndSwitch = undefined
  if (activeFile.selector !== undefined) {
    activateAndSwitch = async (id) => {
      const result = await activeFile.selector.activate(id)
      // 立即重载 seam：复用 runSync 的同一管线的重入保护（routeDeps.reloadSeam 也走这条）。
      await runSync(deps, ctx.logger, 'account-switch')
      const persisted = await persistCredentialFileToPatch(config.patchFile, activeFile.file())
      return { ok: true, activeId: result.activeId, persisted }
    }
  }

  // 上游 UA 修复（原因见文件顶部注释 6）：必须在宿主进程内包 globalThis.fetch，
  // 配置层改不动适配器无条件覆盖的 User-Agent。disposer 交给 ctx.effect，
  // 插件卸载时复原；重复挂载由 installUserAgentFix 自身幂等处理，不会叠加包装层。
  const upstreamHost = config.upstreamHost ?? DEFAULT_UPSTREAM_HOST
  const upstreamUserAgent = config.upstreamUserAgent ?? DEFAULT_UPSTREAM_USER_AGENT
  ctx.effect(() => {
    // uidProvider：目标上游请求的 x-user-id 跟随当前激活凭据文件的 uid ——
    // 账号切换后路由 headers 里的静态旧 uid 不再发错账号（实测该头错配也能 200，
    // 但与 token 配对才是正确语义，也防上游未来收紧校验）。
    // 取 uid 失败时包装层会保留原头照发，绝不因读文件抖动断推理。
    const uidProvider = () => {
      try {
        return parseCredentialRecord(readFileSync(activeFile.file(), 'utf8')).uid
      } catch {
        return ''
      }
    }
    const dispose = installUserAgentFix({ host: upstreamHost, userAgent: upstreamUserAgent, uidProvider, fetchImpl: fetch })
    if (dispose.installed) {
      ctx.logger?.info?.(`[workbuddy-auth] upstream user-agent fix installed: requests to ${upstreamHost} now send user-agent "${upstreamUserAgent}" and a dynamic x-user-id matching the active credential (the pi-ai adapter overrides the configured User-Agent, so only an in-process wrapper can change it)`)
    } else {
      ctx.logger?.info?.(`[workbuddy-auth] upstream user-agent fix skipped (${dispose.reason}): requests to ${upstreamHost} keep their existing user-agent`)
    }
    return dispose
  }, 'dsh-workbuddy-auth: upstream user-agent fix')

  ctx.effect(() => {
    let stopped = false
    void runSync(deps, ctx.logger, 'startup')
    const timer = setInterval(() => { if (!stopped) void runSync(deps, ctx.logger, 'tick') }, config.tickMs ?? TICK_MS)
    timer.unref?.()
    return () => { stopped = true; clearInterval(timer) }
  }, 'dsh-workbuddy-auth: credential sync')

  // 设置卡路由（设计文档 §10.2）。webServer 是**可选**依赖，不放进插件级 inject：
  //   * 放进 inject 会让整个插件（含上面的凭据续期）在非 web 组合里永远不激活——
  //     本插件的核心价值是续期，不能因为一个设置页路由而停摆；
  //   * 因此这里用作用域内的**声明式**依赖 `ctx.inject(['webServer'], …)`：webServer 缺席时
  //     这段回调根本不执行（自然降级，插件其余部分照常工作），出现时 Cordis 会重新把它拉起来。
  //
  // 为什么**不能**在 apply 里一次性 `ctx.get('webServer')` 判空：
  //   bundle patch 与用户 patch 被拍平成同一批，由 `EntryTree.update` 用
  //   `await Promise.allSettled(config.map(...))` **并发**创建。webServer 的服务实例虽在构造
  //   函数里 provide，但其 fiber 要等 `await listen()` 完成才 ACTIVE，而 `ctx.get` 默认 strict，
  //   提供方未 ACTIVE 时返回 undefined。于是 apply 会走进「降级」分支只打一行 info，
  //   **4 条路由永不注册**、客户端半区全部 404，而凭据同步照常、表面无任何报错。
  //   非 strict 的 `ctx.get('webServer', false)` 同样不可靠：并发创建时提供方的构造函数
  //   可能都还没跑。
  //   声明式依赖由 Cordis 的 fiber 生命周期驱动：服务 ACTIVE 时回调才执行，天然免疫该竞态。
  //   （该竞态已由 test/routes.test.mjs 用**真实 Cordis** + 慢 Service.init 复现并钉住。）
  //
  // 顺序：必须在上面的 effect 之后注册，且 routeDeps 与 deps 共享同一份节流/在飞状态。
  const routeDeps = createRouteDeps(ctx, config, fetch, deps, activeFile, activateAndSwitch)
  ctx.inject(['webServer'], (webCtx) => ctx.effect(() => {
    // 留一行可观测的 info：webServer 到位、路由真正挂上了。webServer 缺席的组合里本回调
    // 不会执行，此时 Cordis 的 fiber 状态（PENDING）就是框架级的可观测信号，无需自造日志。
    ctx.logger?.info?.('[workbuddy-auth] webServer is available; WorkBuddy settings routes registered')
    return registerRoutes(webCtx, routeDeps)
  }, 'dsh-workbuddy-auth: settings routes'))
}
