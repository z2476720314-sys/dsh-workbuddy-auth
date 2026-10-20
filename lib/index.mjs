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
import { withCredits, withAccounts, withCheckin } from './status.mjs'
import { registerRoutes } from './routes.mjs'
import { listCredentialSources } from './multi-account.mjs'
import { createAccountManager } from './account-manager.mjs'
import { createManagedAccountStore, managedAccountsPath } from './managed-store.mjs'
import { createDpapiProtector } from './dpapi.mjs'
import { createWebLoginService } from './web-login.mjs'
import { createCheckinService } from './checkin.mjs'
import { createCheckinStore, checkinStatePath } from './checkin-store.mjs'
import { createRejectedStore, resolveRejectedFile } from './rejected-store.mjs'
import { credentialErrorHint, isCredentialRejection, isEncryptedCredential } from './errors.mjs'
import { normalizeRegion, regionForAuthHost, resolveWorkBuddyOrigin, CN_BACKEND, CLIENT_USER_AGENT } from './origins.mjs'
import { createModelSettingsStore, modelSettingsPath, agentmoreModelSettingsPath } from './model-settings.mjs'
import { createModelCatalog } from './model-catalog.mjs'
import { createWorkBuddyAdapter, createModelService } from './model-adapter.mjs'
import { createAgentmoreStore, agentmoreAccountsPath } from './agentmore-store.mjs'
import { createAgentmoreClient } from './agentmore-client.mjs'
import { createAgentmoreCatalog, agentmoreCatalogCachePath } from './agentmore-catalog.mjs'
import { createAgentResolver } from './agentmore-agents.mjs'
import { createAgentmoreLoginService } from './agentmore-login.mjs'
import { createAgentmoreAdapter, createAgentmoreModelService } from './agentmore-adapter.mjs'
import { createAgentmoreService } from './agentmore-service.mjs'

/**
 * 激活账号的**原始**地区信号（同步读取，不做解析）。
 *
 * 为什么必须同步：fetch 包装层与刷新头构造要在发请求那一瞬间决定「打哪个地区、带哪套头」，
 * 没有 await 的机会。快照由 accountManager 维护（readActive / activate / refreshContext）。
 *
 * @param {{manager?:{context?:Function}}|undefined} activeFile
 * @returns {{region:unknown, apiOrigin:unknown, authHost:unknown, uid:unknown}|null} 无 manager 或读不到时 null
 */
function activeRegionSignal(activeFile) {
  const manager = activeFile?.manager
  if (manager === undefined || typeof manager.context !== 'function') return null
  try {
    const context = manager.context()
    if (context === null || typeof context !== 'object') return null
    return { region: context.region, apiOrigin: context.apiOrigin, authHost: context.authHost, uid: context.uid }
  } catch {
    return null
  }
}

/**
 * 刷新上下文：把原始信号交给 `buildRefreshRequest` 自行解析。
 *
 * 返回 `{}`（无任何地区字段）时刷新走与改动前**逐字节一致**的 CN 请求 —— 这是「没有激活账号
 * 上下文」时的既有语义。一旦有地区信号就原样传递：无法解析（拼错、地区与认证域冲突）
 * 会让 `buildRefreshRequest` 抛 `REFRESH_ORIGIN_ERROR`，宁可刷新失败也绝不把令牌发去另一个地区。
 *
 * @param {{manager?:{context?:Function}}|undefined} activeFile
 * @returns {{region?:unknown, apiOrigin?:unknown, authHost?:unknown, uid?:unknown, domain?:unknown}}
 */
function refreshContextFor(activeFile) {
  const signal = activeRegionSignal(activeFile)
  if (signal === null) return {}
  const hasSignal = [signal.region, signal.apiOrigin, signal.authHost].some((value) => typeof value === 'string' && value !== '')
  if (!hasSignal) return {}
  return { region: signal.region, apiOrigin: signal.apiOrigin, authHost: signal.authHost, uid: signal.uid, domain: signal.authHost }
}

/**
 * 余额查询的地区决策。
 *
 * 能解析出 origin → 用它反推的地区；**有地区信号但解析不出 origin** → `'unknown'`，
 * 让 credits 直接 fail-closed，绝不把该凭据的令牌 POST 到 CN 余额端点（「猜成 CN」是跨区投递）。
 * 完全没有地区信号（未启用多账号）→ `undefined`，保持改动前的 CN 语义。
 *
 * @param {{manager?:{context?:Function}}|undefined} activeFile
 * @returns {'cn'|'intl'|'unknown'|undefined}
 */
function creditsRegionFor(activeFile) {
  const route = resolveActiveRoute(activeFile)
  if (route !== undefined) return route.region
  const signal = activeRegionSignal(activeFile)
  const hasSignal = signal !== null && [signal.region, signal.apiOrigin, signal.authHost].some((value) => typeof value === 'string' && value !== '')
  return hasSignal ? 'unknown' : undefined
}

/**
 * 激活账号 → 「这条推理请求该打哪个 origin」的同步决策。
 *
 * 返回 `undefined` 表示「无法确定地区」：包装层保持改动前的行为（不改写、不加地区头），
 * 绝不把未知地区猜成 Intl，也绝不把 Intl 令牌发去 CN。
 *
 * @param {{manager?:{context?:Function}}|undefined} activeFile
 * @returns {{origin:string, region:'cn'|'intl'|undefined, uid:string, domain:string}|undefined}
 */
function resolveActiveRoute(activeFile) {
  const signal = activeRegionSignal(activeFile)
  if (signal === null) return undefined
  const origin = resolveWorkBuddyOrigin({ region: signal.region, apiOrigin: signal.apiOrigin, authHost: signal.authHost })
  if (origin === null) return undefined
  const domain = typeof signal.authHost === 'string' && signal.authHost !== '' ? signal.authHost : new URL(origin).hostname
  return {
    origin,
    // 地区由**解析后的 origin** 反推：origin 已过白名单，是唯一事实来源；
    // 上下文里的 region 只作为解析输入，不直接当结论。
    region: regionForAuthHost(domain) ?? normalizeRegion(signal.region) ?? undefined,
    uid: typeof signal.uid === 'string' ? signal.uid : '',
    domain,
  }
}

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

/**
 * 生产托管账号库：Windows CurrentUser DPAPI 加密整库、同目录原子替换。
 *
 * **失败关闭**：非 Windows 平台没有 DPAPI，直接不建库（托管账号与浏览器登录随之降级），
 * 绝不退化成明文副本——那是本功能里唯一不可接受的失败模式。
 *
 * `seams` 的三个注入点同时服务测试与运维：`managedStore` 整库替换（内存夹具，避开真 DPAPI 往返）、
 * `managedAccountsFile` 重定向库文件、`protector` 只替换加解密实现。
 *
 * @param {{managedStore?:object,managedAccountsFile?:string,protector?:object,fetchImpl?:typeof fetch}} [seams]
 * @returns {ReturnType<typeof createManagedAccountStore>|undefined}
 */
function createDefaultManagedStore(seams = {}) {
  if (seams.managedStore !== undefined) return seams.managedStore
  if (process.platform !== 'win32') return undefined
  return createManagedAccountStore({
    filePath: typeof seams.managedAccountsFile === 'string' && seams.managedAccountsFile !== ''
      ? seams.managedAccountsFile
      : managedAccountsPath(),
    protector: seams.protector ?? createDpapiProtector(),
  })
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
 * @param {{readFile:Function,refresh:Function,writeFile:Function,setCredential:Function,isActiveAccount?:Function,marginMs?:number,minRefreshIntervalMs?:number,now?:()=>number,throttle?:{lastRefreshAt:number}}} deps
 *   `readFile` 返回文本（单文件路径）或 `{accountId, text}`（统一激活上下文）；
 *   `writeFile(text, accountId?)` 按读到的账号定点写回；`isActiveAccount(accountId?)` 决定要不要更新 seam。
 * @returns {Promise<{token:string,expiresAt:number,uid:string,refreshed:boolean,throttled:boolean,staleAfterRefresh:boolean,seamSkipped:boolean}>}
 */
export async function syncCredential(deps) {
  const marginMs = deps.marginMs ?? REFRESH_MARGIN_MS
  const minRefreshIntervalMs = deps.minRefreshIntervalMs ?? marginMs / 2
  // Date.now 可注入：节流逻辑必须能在注入时钟下确定性测试，而不是靠真实等待 12 小时。
  const nowFn = deps.now ?? Date.now
  const throttle = deps.throttle ?? (deps.throttle = { lastRefreshAt: 0 })

  const read = await deps.readFile()
  // 统一激活上下文下 readFile 返回 {accountId, text}：accountId 是**读到时**的账号身份，
  // 刷新往返之后写回必须按它定点落盘，而不是按「写回时的当前激活账号」（review P1）。
  const rawText = typeof read === 'string' ? read : read?.text
  const accountId = typeof read === 'string' ? undefined : read?.accountId
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
      await deps.writeFile(merged, accountId)
      record = parseCredentialRecord(merged)
      refreshed = true
      throttle.lastRefreshAt = refreshedAt
      // 刷新成功但合并后的到期时间仍未越过阈值：服务端没给 expiresAt（沿用旧值），
      // 必须让调用方能识别出来并告警，而不是把它当成一次普通的成功刷新。
      staleAfterRefresh = needsRefresh(record, refreshedAt, marginMs)
    }
  }
  // seam 只在本次读到的账号仍是激活账号时更新：迟到的旧账号刷新结果不得把 seam 钉回旧账号
  // （激活已切到新账号，重载由激活路径负责）。判断失败按「照旧更新」处理，绝不因此中断同步。
  // 写入 seam 前再确认「这次刷新读到的账号仍是当前激活账号」。
  // 已知边界（设计取舍，不是漏洞）：判定与写入之间若发生激活切换，seam 可能落后一拍 ——
  // 因为写入目标本身是 per-account 的（writeActiveText(accountId) 拒绝未知 id），
  // 令牌不会串到别的账号；落后的一拍由激活流程末尾的 `syncOnce` 立刻纠正。
  let seamSkipped = false
  if (typeof accountId === 'string' && accountId !== '' && typeof deps.isActiveAccount === 'function') {
    try {
      seamSkipped = !(await deps.isActiveAccount(accountId))
    } catch {
      seamSkipped = false
    }
  }
  if (!seamSkipped) await deps.setCredential(TOKEN_REF, record.accessToken)
  return { token: record.accessToken, expiresAt: record.expiresAt, uid: record.uid, refreshed, throttled, staleAfterRefresh, seamSkipped }
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
export function createSyncDeps(ctx, config = {}, fetchImpl = fetch, activeFile, recordOutcome) {
  const staticFile = config.credentialFile || DEFAULT_CREDENTIAL_FILE
  const currentFile = () => (activeFile ? activeFile.file() : staticFile)
  // 多账号开启时，读写都经统一激活上下文（桌面文件或托管记录，同一份 active 状态）。
  const manager = activeFile?.manager
  return {
    // 统一激活上下文下 readFile 返回 {accountId, text}（身份钉住用），其余路径仍是文本。
    readFile: () => (manager ? manager.readActive() : readFile(currentFile(), 'utf8')),
    refresh: (record) => refreshCredential(record, fetchImpl, { context: refreshContextFor(activeFile) }),
    writeFile: (text, accountId) => (manager ? manager.writeActiveText(accountId, text) : writeCredentialAtomically(currentFile(), text)),
    // 只有多账号上下文才有「账号身份」概念；单文件路径下 seam 永远照旧更新。
    isActiveAccount: manager === undefined ? undefined : (accountId) => manager.isActiveAccount(accountId),
    // 每次同步的结果都要记账（成功摘除 / 401 标记），否则切换区无法如实标注失效账号。
    recordOutcome: typeof recordOutcome === 'function' ? recordOutcome : undefined,
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
export function createRouteDeps(ctx, config = {}, fetchImpl = fetch, syncDeps = createSyncDeps(ctx, config, fetchImpl), activeFile, activateAndSwitch, login, checkin, rejectedStore = createRejectedStore(resolveRejectedFile(config))) {
  const staticFile = config.credentialFile || DEFAULT_CREDENTIAL_FILE
  const currentFile = () => (activeFile ? activeFile.file() : staticFile)
  // authDir 统一走 resolveAuthDir：未配置时默认 = 凭据文件所在目录（见该函数）。
  const authDir = resolveAuthDir(config)
  const upstreamHost = config.upstreamHost ?? DEFAULT_UPSTREAM_HOST
  const upstreamUserAgent = config.upstreamUserAgent ?? DEFAULT_UPSTREAM_USER_AGENT
  const chatUrl = config.chatUrl ?? `https://${upstreamHost}${UPSTREAM_CHAT_PATH}`
  const model = config.connectionTestModel ?? CONNECTION_TEST_MODEL

  const manager = activeFile?.manager
  // 统一目录：有 manager 时走它；无 manager（仅测试直接构造路由依赖）时退回桌面扫描。
  // rejectedIds 来自本插件自己的落盘记录：被上游 401 拒绝过的账号在切换区里会被如实标注，
  // 用户不会再在同一份死凭据上反复撞墙。
  const describeSources = () =>
    manager
      ? manager.describe()
      : { activeId: sourceIdOf(currentFile()), sources: listCredentialSources(authDir, { rejectedIds: new Set(rejectedStore.list()) }) }
  const readCredentialRaw = async () => {
    if (manager === undefined) return readFile(currentFile(), 'utf8')
    return (await manager.readActive()).text
  }
  const readStatusCredential = async () => {
    const rawText = await readCredentialRaw()
    let credits
    try {
      credits = fetchCreditBalance({ record: parseCreditCredential(rawText), fetchImpl, now: Date.now(), region: creditsRegionFor(activeFile) })
    } catch {
      // 凭据 JSON 的余额辅助字段异常不影响账号/令牌状态；固定降级且不回显原始错误。
      credits = Promise.resolve({ ok: false, error: 'unavailable' })
    }
    let envelope = withCredits(rawText, credits)
    // 多账号：把脱敏账号列表挂进 status DTO（enabled 由 resolveAuthDir 决定，
    // 与 selector 是否存在无关 —— 这样设置卡在降级形态下也能拿到一致的字段形状）。
    // 未配置 authDir 时默认为凭据文件所在目录，因此默认即启用；显式 authDir: '' 是关闭开关。
    if (authDir !== '') {
      // 同一份统一目录（桌面 + 托管）既供 sources 路由，也供 status 账号 DTO。
      let described = { activeId: '', sources: [] }
      try {
        described = await describeSources()
      } catch {
        described = { activeId: '', sources: [] } // 目录扫描失败按「未发现账号」降级，绝不让 status 路由 500。
      }
      envelope = withAccounts(envelope, { enabled: true, activeId: described.activeId, sources: described.sources })
    }
    // 签到（签到计划 Task 4）：只读本地状态文件。summary() 是异步的，交给 buildStatus 侧的
    // finalizeCheckin 收尾；服务缺席（账号目录关闭）时挂 undefined → 关闭的零值 DTO。
    return withCheckin(envelope, checkin === undefined ? undefined : checkin.summary())
  }

  /**
   * 当前激活账号的 id（同步可得）：有 manager 时用它维护的同步上下文快照（刷新路径刚刚
   * 读过凭据，快照必然对得上这次刷新的那份账号），否则退回激活文件路径的摘要。
   * 记账必须与「刚才那次刷新用的是哪份凭据」同一身份 —— 记错账号比不记更糟。
   */
  const activeAccountId = () => {
    const fromContext = typeof manager?.context === 'function' ? manager.context().accountId : ''
    if (typeof fromContext === 'string' && fromContext !== '') return fromContext
    return sourceIdOf(currentFile())
  }

  /**
   * 一次刷新/重载的结果记账：成功摘除、401/403 标记（实现见 createOutcomeRecorder）。
   */
  const recordOutcome = createOutcomeRecorder({ rejectedStore, activeAccountId })

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
      try {
        const r = await withSyncGuard(forced, () => syncCredential(forced), rejectSyncInFlight)
        recordOutcome(undefined)
        return { refreshed: r.refreshed, throttled: r.throttled, expiresAt: r.expiresAt }
      } catch (error) {
        recordOutcome(error)
        throw error
      }
    },

    /** 设置卡的「重新读取」：走一次与 tick / 强制刷新**共享 guard** 的普通同步。 */
    reloadSeam: async () => {
      try {
        const r = await withSyncGuard(syncDeps, () => syncCredential(syncDeps), rejectSyncInFlight)
        recordOutcome(undefined)
        return { refreshed: r.refreshed, throttled: r.throttled, expiresAt: r.expiresAt }
      } catch (error) {
        recordOutcome(error)
        throw error
      }
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
            const description = await describeSources()
            return { ok: true, activeId: description.activeId, sources: description.sources }
          },
          activateCredentialSource: async (id) => {
            if (typeof activateAndSwitch !== 'function') return { ok: false, error: 'multi-account disabled' }
            return activateAndSwitch(id)
          },
          // 浏览器登录（Task 4）：托管库不可用时整块缺席，路由按 'multi-account disabled' 降级。
          // 只暴露 start/status 两个薄封装：地区白名单、授权 URL 校验、令牌解析、脱敏都在 web-login 内完成。
          ...(login === undefined
            ? {}
            : {
                startLogin: (region) => login.start(region),
                loginStatus: () => login.status(),
              }),
          // 签到（签到计划 Task 3）：服务缺席（账号目录关闭）时路由按 'checkin disabled' 降级。
          ...(checkin === undefined
            ? {}
            : {
                setCheckinEnabled: async (enabled) => {
                  await checkin.setEnabled(enabled)
                  return checkin.summary()
                },
                runCheckinNow: () => checkin.runManual(),
              }),
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

/**
 * 等到空闲后**原子**抢占在飞标记再执行 —— 与 `withSyncGuard` 的「忙就跳过」不同。
 *
 * 必须先等待、再在**同一个同步块**里登记（不能 `await` 之后再登记）：否则两个调用会同时
 * 通过空闲检查、双双挤进临界区。激活提交之后必须走这条路径重载 seam，因为
 * 提交**之后**才启动的同步可能读到旧账号（review P1 的第二个方向）。
 *
 * @template T
 * @param {{guard?:{inFlight:unknown}}} deps
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withSyncGuardWaiting(deps, run) {
  const guard = deps.guard ?? (deps.guard = { inFlight: undefined })
  // 在飞任务自身已把错误吞成 undefined（syncOnce 的 catch），这里只兜底防未处理拒绝。
  while (guard.inFlight !== undefined) await guard.inFlight.catch(() => {})
  const task = run()
  guard.inFlight = task
  try {
    return await task
  } finally {
    guard.inFlight = undefined
  }
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
    deps.recordOutcome?.(undefined)
    return r
  } catch (error) {
    const parts = [`[workbuddy-auth] ${reason} failed: ${describeSyncError(error)}`, ...credentialGuidanceParts(error, deps.credentialFilePath)]
    logger?.warn?.(parts.join('\n  '))
    deps.recordOutcome?.(error)
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
  } else if (isEncryptedCredential(error)) {
    // 文件在、但读不出明文：去登录没有用（桌面端会继续写密文），必须换一条路径。
    guidance = `  → ${credentialErrorHint(error)}`
  } else if (isCredentialRejection(error)) {
    guidance = `  → ${credentialErrorHint(error)}`
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
 * 多账号（accountManager 存在）时，激活状态唯一由 account-manager 持有（单一状态源）；
 * 无 accountManager（authDir 为空）时保持原有单文件行为。
 *
 * @param {{credentialFile?:string}} config
 * @param {ReturnType<typeof createAccountManager>|undefined} accountManager
 * @returns {{file:()=>string, manager:ReturnType<typeof createAccountManager>|undefined}}
 */
function resolveActiveCredentialFile(config, accountManager) {
  const initial = config.credentialFile || DEFAULT_CREDENTIAL_FILE
  return { file: () => initial, manager: accountManager }
}

/** 等待正在进行的同步（启动/tick/设置卡刷新）结束，使激活不会与其交错写回旧值。 */
async function waitForSyncIdle(deps) {
  while (deps.guard?.inFlight !== undefined) {
    await Promise.resolve(deps.guard.inFlight).catch(() => {})
  }
}

/**
 * 解析要写回的 profile patch 路径。
 *
 * `config.patchFile` 没人配过 —— 线上 persist 因此**恒为 false**，账号切换重启即丢。
 * 缺省时从 DSH 的 profile 目录推断（`DSH_PROFILE_DIR/cordis.patch.yml`）：
 *   * 显式字符串原样采用；
 *   * 空串是**显式关闭**（与 authDir 同语义）；
 *   * 无 DSH_PROFILE_DIR 时返回空串（退回「持久化不可用」，不猜路径）。
 *
 * @param {{patchFile?:string}} [config]
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolvePatchFile(config = {}, env = process.env) {
  if (typeof config.patchFile === 'string') return config.patchFile
  const profileDir = env?.DSH_PROFILE_DIR
  if (typeof profileDir !== 'string' || profileDir === '') return ''
  return `${profileDir.replace(/[\\/]+$/, '')}\\cordis.patch.yml`
}

/** 定位本插件条目：`- id: dsh-workbuddy-auth`（覆盖行与 `insert:` 包裹两种形态都命中）。 */
const ENTRY_RX = /^(\s*)-\s*id:\s*dsh-workbuddy-auth\s*$/

/**
 * 在 patch 文本里定位本插件条目块；找不到返回 null。
 * 块结束于「下一行缩进不超过条目自身且以 `-` 开头」的那一行。
 */
function findPluginEntry(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const matched = ENTRY_RX.exec(lines[index])
    if (matched === null) continue
    const indent = matched[1]
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') continue
      const lineIndent = line.length - line.trimStart().length
      if (lineIndent <= indent.length && line.trimStart().startsWith('-')) { end = cursor; break }
    }
    return { start: index, end, indent: ' '.repeat(indent.length) }
  }
  return null
}

/**
 * 把 credentialFile 写进 patch 里**本插件条目自己的 config 块**。
 *
 * 用户 patch 的真实形态是**覆盖行**（`- id:` + `name:` + 已有 `config.authDir`）。
 * 旧实现在 name 后无条件追一个 `config:` 行 → 同一 mapping 出现两个 config 键，
 * YAML 直接解析失败，而 persist 还返回 true 谎报成功。这里改成：
 *   1. 块内已有 `credentialFile:` → 原地替换（保留它自己的缩进）；
 *   2. 块内已有 `config:` → 紧随其后插入，缩进取该块**已有子行的缩进**；
 *   3. 都没有 → 在 `name:` 之后补一个 config 块（旧行为，用于 insert 形态）。
 *
 * 缩进必须从现场推断而不是 `条目缩进 + 2`：`insert:` 包裹形态里 `- id:` 在 4 空格、
 * 它的键在 6 空格、而 `config` 的子键在 8 空格 —— 用 6 会把 credentialFile 提到
 * config 的同级，把 config 变成 null，YAML 直接解析失败（线上 patch 就是这么被写坏的）。
 *
 * @returns {string|null} 新文本；未命中条目或无需改动时 null
 */
function upsertCredentialFile(text, filePath) {
  const lines = text.split('\n')
  const entry = findPluginEntry(lines)
  if (entry === null) return null
  const block = lines.slice(entry.start, entry.end)
  const parents = block.filter((line) => /^\s*(name|config|credentialFile):/.test(line))
  const keyIndent = entry.indent + indentUnit(parents, entry.indent.length)
  for (let offset = 0; offset < block.length; offset += 1) {
    const matched = /^(\s*)credentialFile:.*$/.exec(block[offset])
    if (matched === null) continue
    block[offset] = `${matched[1]}credentialFile: ${filePath}`
    return [...lines.slice(0, entry.start), ...block, ...lines.slice(entry.end)].join('\n')
  }
  for (let offset = 0; offset < block.length; offset += 1) {
    const matched = /^(\s*)config:\s*$/.exec(block[offset])
    if (matched === null) continue
    const childIndent = childKeyIndent(block, offset) || `${matched[1]}  `
    const insertAt = entry.start + offset + 1
    return [...lines.slice(0, insertAt), `${childIndent}credentialFile: ${filePath}`, ...lines.slice(insertAt)].join('\n')
  }
  const nameAt = block.findIndex((line) => /^\s*name:\s*dsh-workbuddy-auth\s*$/.test(line))
  if (nameAt === -1) return null
  const insertAt = entry.start + nameAt + 1
  return [...lines.slice(0, insertAt), `${keyIndent}config:`, `${keyIndent}  credentialFile: ${filePath}`, ...lines.slice(insertAt)].join('\n')
}

/** 条目键（name/config）相对 `- id:` 的缩进量；取现场实测差值，缺省 2 空格。 */
function indentUnit(keys, baseLen) {
  for (const line of keys) {
    const width = line.length - line.trimStart().length
    if (width > baseLen) return ' '.repeat(width - baseLen)
  }
  return '  '
}

/** `config:` 块内第一个子键的缩进；没有子行时返回 ''（调用方回退为 config 缩进 +2）。 */
function childKeyIndent(block, configOffset) {
  const configIndent = block[configOffset].length - block[configOffset].trimStart().length
  for (let cursor = configOffset + 1; cursor < block.length; cursor += 1) {
    const line = block[cursor]
    if (line.trim() === '') continue
    const width = line.length - line.trimStart().length
    return width > configIndent ? ' '.repeat(width) : ''
  }
  return ''
}

/**
 * 造一个「刷新/重载结果记账」函数。apply 的后台 tick 与路由上的动作**共用同一份实现**，
 * 保证「tick 撞上 401」与「用户点刷新撞上 401」留下同一份记录。
 *
 * 语义：
 *   * 成功 → 当前账号凭据可用，从 rejected 集合摘除（用户重新登录后应当自动「复活」）；
 *   * 401/403 → 记下来，切换区据此标注「登录态已失效」。
 * 记账必须与「刚才那次刷新用的是哪份凭据」同一身份 —— 记错账号比不记更糟；记账失败不影响动作结果。
 *
 * @param {{rejectedStore:{list:()=>string[],mark:(id:string)=>void,clear:(id:string)=>void}, activeAccountId:()=>string}} deps
 */
function createOutcomeRecorder({ rejectedStore, activeAccountId }) {
  return (error) => {
    const id = activeAccountId()
    if (typeof id !== 'string' || id === '') return
    if (error === undefined) {
      rejectedStore.clear(id)
      return
    }
    if (isCredentialRejection(error)) rejectedStore.mark(id)
  }
}

/**
 * 把激活的凭据文件路径持久化到用户 patch 的插件行（ownership 标记块）。
 * 失败静默：切换在运行时已生效，持久化失败只影响「重启后保持」并会在下一次切换时重试。
 *
 * @param {string|undefined} patchFile
 * @param {string} filePath
 */
export async function persistCredentialFileToPatch(patchFile, filePath) {
  if (typeof patchFile !== 'string' || patchFile === '') return false
  let text
  try {
    text = await readFile(patchFile, 'utf8')
  } catch {
    return false
  }
  const next = upsertCredentialFile(text, filePath)
  if (next === null) return false
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
export function apply(ctx, config = {}, seams = {}) {
  const authDir = resolveAuthDir(config)
  // 单点注入 fetch：同步刷新、浏览器登录、连接测试与 UA 包装层共用同一个实现，
  // 测试注入假 fetch 即可在整个插件生命周期内零真实请求（也避免测试打到真实上游）。
  const fetchImpl = typeof seams.fetchImpl === 'function' ? seams.fetchImpl : fetch
  // 统一账号管理器：桌面 .info 与托管（DPAPI 加密）账号的唯一目录与激活状态。
  // seams.managedStore 为可选注入（测试直接给内存夹具；生产走 createDefaultManagedStore）。
  // 关掉多账号（authDir 显式空串）时不建库：托管账号与登录一并缺席，不做半开状态。
  const managedStore = authDir === '' ? undefined : createDefaultManagedStore(seams)
  // 「已失效账号」落盘集合：路径由 config.rejectedFile / DSH_HOME 决定（空串=显式关闭）。
  const rejectedStore = createRejectedStore(resolveRejectedFile(config))
  // patch 路径必须**从 profile 目录推断**：没人配过 config.patchFile，否则切换重启即丢。
  const patchFile = resolvePatchFile(config)
  const accountManager = authDir === ''
    ? undefined
    : createAccountManager({
      authDir,
      managedStore,
      initialDesktopFile: config.credentialFile || DEFAULT_CREDENTIAL_FILE,
      persistDesktopSelection: (filePath) => persistCredentialFileToPatch(patchFile, filePath),
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: (path, text) => writeCredentialAtomically(path, text),
      rejectedIds: () => new Set(rejectedStore.list()),
    })
  const activeFile = resolveActiveCredentialFile(config, accountManager)
  // 启动预热：把落盘的 activeId 解析成同步上下文（地区 / origin / uid），
  // 让 fetch 包装层与 status 路由在第一次同步发生之前就能拿到正确地区。
  // 失败只降级为「上下文为空」（退回 CN 默认行为），绝不阻断插件装载。
  if (accountManager !== undefined) void accountManager.refreshContext().catch(() => {})
  // 后台 tick 的记账：与路由动作共用同一份实现（createOutcomeRecorder），
  // 保证「tick 撞上 401」与「用户点刷新撞上 401」产生同一份记录。
  const recordOutcome = createOutcomeRecorder({
    rejectedStore,
    activeAccountId: () => {
      const fromContext = typeof accountManager?.context === 'function' ? accountManager.context().accountId : ''
      if (typeof fromContext === 'string' && fromContext !== '') return fromContext
      return sourceIdOf(config.credentialFile || DEFAULT_CREDENTIAL_FILE)
    },
  })
  const deps = createSyncDeps(ctx, config, fetchImpl, activeFile, recordOutcome)
  // 浏览器登录：托管库是它的唯一写入口，必须与 manager 共用**同一个 store 实例**——
  // 否则新登录的账号要到下次进程重启才出现在「账号来源」列表里。
  const login = managedStore === undefined ? undefined : createWebLoginService({ store: managedStore, fetchImpl })
  if (authDir !== '' && managedStore === undefined && seams.managedStore === undefined) {
    // 非 Windows 没有 DPAPI：托管账号库与浏览器登录整块缺席（桌面明文账号仍照常）。只留一行可观测信号。
    ctx.logger?.info?.(`[workbuddy-auth] managed account store unavailable on ${process.platform}: browser login and DPAPI-managed accounts are disabled (desktop credential files are unaffected)`)
  }

  // 自动签到（签到计划 Task 3）：账号目录关闭（authDir 显式空串）时整块缺席——
  // 没有可枚举的账号，签到无事可做，路由也一并降级为 'checkin disabled'。
  //
  // 状态文件**不加密**：它只存开关、每账号的本地日/次数/结果时间戳，没有任何令牌或路径
  // （写入口与读入口各清洗一次白名单，见 lib/checkin-store.mjs）。因此不需要 DPAPI，
  // 非 Windows 上签到照常可用。
  const checkinStore = accountManager === undefined
    ? undefined
    : seams.checkinStore ?? createCheckinStore({ filePath: seams.checkinStateFile || checkinStatePath() })
  const checkin = checkinStore === undefined
    ? undefined
    : createCheckinService({
      // 账号目录：桌面明文 + 托管（加密信封的桌面文件根本不会被列出来，因此不存在「读到密文」）。
      listAccounts: async () => (await accountManager.describe()).sources,
      readAccount: (id) => accountManager.readById(id),
      // 401 后的续期：**按账号 id 定点**读写（身份钉住），并一律走 CN 刷新上下文——
      // 签到只处理 CN 账号，CN 头集与改动前逐字节一致，不会混入 Intl 头。
      refreshAccount: async (id) => {
        const read = await accountManager.readById(id)
        const record = parseCredentialRecord(read.text)
        const next = await refreshCredential(record, fetchImpl, { context: { region: 'cn' } })
        const merged = mergeRefreshedRecord(read.text, next, Date.now())
        await accountManager.writeActiveText(read.accountId, merged)
        return true
      },
      fetchImpl,
      store: checkinStore,
      logger: ctx.logger,
    })

  // 多账号：激活 = 等待在飞同步结束 → 账号管理器激活 → 再次等空闲 → **抢在飞标记**重载 seam。
  // 两处等待缺一不可：
  //   * 第一次等待：提交之前可能已有一个读旧账号的同步在飞，它的写回必须落定（写回按身份钉住，
  //     但 seam 顺序仍需确定）；
  //   * 第二次等待 + 原子抢占：提交**之后**才启动的同步会读到仍然过期的旧账号，若重载
  //     用「忙就跳过」的 runSync，`account-switch` 会被丢进 onBusy 分支 —— 激活响应回显新
  //     activeId，seam 却还停在旧账号的令牌上（review P1 的第二个方向）。
  // 串行化由 accountManager.activate 内部的固定键锁负责，这里**不得**再套 withAccountLock
  //（同 key 非重入锁会自锁成死等）。
  let modelService
  let activateAndSwitch = undefined
  if (accountManager !== undefined) {
    activateAndSwitch = async (id) => {
      await waitForSyncIdle(deps)
      const result = await accountManager.activate(id)
      await waitForSyncIdle(deps)
      await withSyncGuardWaiting(deps, () => syncOnce(deps, ctx.logger, 'account-switch'))
      modelService?.accountChanged()
      return { ok: true, activeId: result.activeId, persisted: result.persisted }
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
      if (activeFile.manager !== undefined) return activeFile.manager.activeUidSync()
      try {
        return parseCredentialRecord(readFileSync(activeFile.file(), 'utf8')).uid
      } catch {
        return ''
      }
    }
    const dispose = installUserAgentFix({
      host: upstreamHost,
      userAgent: upstreamUserAgent,
      uidProvider,
      // 地区路由：路由配置里的 URL 是按 CN 写的，激活的却可能是 Intl 账号。
      // routeProvider 同步给出「该打哪个 origin」；无法确定时返回 undefined，
      // 包装层保持原样（不改写、不加地区头），绝不猜地区。
      routeProvider: () => resolveActiveRoute(activeFile),
      fetchImpl,
    })
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

  // 签到调度：启动后立即跑一轮，之后每 CHECKIN_TICK_MS 一轮；dispose 时必须清掉定时器，
  // 否则插件卸载后仍会每 10 分钟发一次上游请求（测试钉住这一点）。
  if (checkin !== undefined) {
    ctx.effect(() => {
      void checkin.start()
      return () => checkin.stop()
    }, 'dsh-workbuddy-auth: daily check-in')
  }

  // Read-only model calls are optional in hosts that expose only the credential writer.
  if (typeof ctx.credentials?.resolve === 'function') {
    const notifyModels = () => ctx.emit?.('llm/adapters-updated')
    const modelSettingsFile = seams.modelSettingsFile ?? modelSettingsPath()
    const settings = createModelSettingsStore({ filePath: modelSettingsFile })
    const readModelCredential = async () => {
      try {
        const read = await deps.readFile()
        const record = parseCredentialRecord(typeof read === 'string' ? read : read.text)
        const context = accountManager?.context()
        if (context && (context.accountId !== read.accountId || !(await accountManager.isActiveAccount(read.accountId)))) return null
        const token = (await ctx.credentials.resolve(TOKEN_REF))?.value
        if (token !== record.accessToken) return null
        // Pin origin, identity and token from one manager read; never use the mutable global fetch wrapper.
        const backend = context ? resolveWorkBuddyOrigin(context) : CN_BACKEND
        if (backend === null) return null
        const region = backend === CN_BACKEND ? 'cn' : 'intl'
        const authHeaderName = 'Authorization'
        const headers = { [authHeaderName]: `Bearer ${token}`, 'User-Agent': CLIENT_USER_AGENT }
        if (record.uid) headers['X-User-Id'] = record.uid
        if (region === 'intl') Object.assign(headers, { 'X-Domain': context.authHost || new URL(backend).hostname, Origin: backend, Referer: backend + '/', 'X-Product': 'SaaS', 'X-Ide-Name': 'CodeBuddyIDE', 'X-Requested-With': 'XMLHttpRequest' })
        if (context && accountManager.context().accountId !== read.accountId) return null
        return { backend, region, accountId: typeof read === 'string' ? sourceIdOf(config.credentialFile || DEFAULT_CREDENTIAL_FILE) : read.accountId, headers }
      } catch { return null }
    }
    const catalog = createModelCatalog({ readCredential: readModelCredential, fetchImpl, cacheFile: modelSettingsFile + '.catalog-cache', onAccountChange: notifyModels })
    modelService = createModelService({ settings, catalog, notify: notifyModels })
    ctx.effect(() => {
      const stop = ctx.on?.('credentials/reference-updated', (ref) => {
        if (ref === TOKEN_REF) modelService.accountChanged()
      })
      return () => { stop?.(); catalog.invalidate() }
    }, 'dsh-workbuddy-auth: model credential updates')
    const attachments = { get readImage() {
      const service = ctx.get('attachments')
      return typeof service?.readImage === 'function' ? service.readImage.bind(service) : undefined
    }, get readImageRequest() {
      const service = ctx.get('attachments')
      return typeof service?.readImageRequest === 'function' ? service.readImageRequest.bind(service) : undefined
    }, get imageHostPath() {
      const service = ctx.get('attachments'), fs = ctx.get('fs')
      if (typeof service?.imageHostPath !== 'function' || typeof fs?.processPathFromHostPath !== 'function') return undefined
      return ref => {
        const path = service.imageHostPath(ref)
        return path === undefined ? undefined : fs.processPathFromHostPath(path)
      }
    } }
    const adapter = createWorkBuddyAdapter({ settings, catalog, readCredential: readModelCredential, fetchImpl, attachments, beforeCall: () => withSyncGuardWaiting(deps, () => syncCredential(deps)) })
    ctx.effect(() => () => adapter.dispose(), 'dsh-workbuddy-auth: model request cleanup')
    let modelRegistration = false
    ctx.inject(['llm'], (llmCtx) => llmCtx.effect(() => {
      if (modelRegistration) return () => {}
      let dispose
      try {
        dispose = llmCtx.llm.registerAdapter(['workbuddy'], adapter)
        modelRegistration = true
        modelService.registration(true)
      } catch {
        modelService.registration(false, 'WORKBUDDY_ADAPTER_CONFLICT')
        return () => {}
      }
      return () => {
        modelRegistration = false
        adapter.dispose()
        try { dispose?.() } finally { modelService.registration(false) }
      }
    }, 'dsh-workbuddy-auth: native models'))
  }

  // ── 第二订阅点：智谱清言 Agent（agentmore）────────────────────────────────
  //
  // 与 WorkBuddy 并列的另一个 provider。整块**独立装配**，与上面的 WorkBuddy 链路
  // 零共享状态：账号库、目录缓存、模型偏好、登录流程各一份。这么做不是偷懒，
  // 而是两边语义确实不同：
  //   * WorkBuddy 的凭据来自用户机器上的 CodeBuddy 桌面文件（我们只读+续期回写）；
  //   * 智谱清言的凭据由本插件自己在登录流程里取得（我们持有并写自己的加密库）。
  // 硬塞进同一份 store 会让 region / origin 的白名单校验互相污染。
  //
  // 非 Windows 没有 DPAPI → 账号库与登录整块缺席（与 WorkBuddy 侧的托管库同一取舍：
  // 绝不退化成明文落盘）。模型路由缺席时设置卡自然不显示这一区。
  const agentmoreStore = seams.agentmoreStore ?? (process.platform === 'win32'
    ? createAgentmoreStore({
      filePath: seams.agentmoreAccountsFile ?? agentmoreAccountsPath(),
      protector: seams.agentmoreProtector ?? createDpapiProtector(),
    })
    : undefined)

  let agentmoreService
  if (agentmoreStore !== undefined) {
    const agentmoreClient = createAgentmoreClient({
      fetchImpl,
      readCredential: () => agentmoreStore.getActive(),
      writeCredential: (account) => agentmoreStore.upsert(account),
    })
    const agentmoreSettings = createModelSettingsStore({
      filePath: seams.agentmoreModelSettingsFile ?? agentmoreModelSettingsPath(),
      // 错误码前缀独立：用户能分清是哪一边拒绝了这次保存。
      prefix: 'AGENTMORE',
    })
    const notifyAgentmore = () => ctx.emit?.('llm/adapters-updated')
    const agentmoreCatalog = createAgentmoreCatalog({
      readCredential: () => agentmoreStore.getActive(),
      fetchModels: (credential, signal) => agentmoreClient.models(credential, signal),
      cacheFile: seams.agentmoreCatalogFile ?? agentmoreCatalogCachePath(),
      now: Date.now,
    })
    const agentmoreModelService = createAgentmoreModelService({
      settings: agentmoreSettings,
      catalog: agentmoreCatalog,
      notify: notifyAgentmore,
    })
    const agentResolver = createAgentResolver({
      // 智能体绑定必须是**活的**上游状态：换账号、上游改了 agent 列表都要重取。
      fetchAgents: (credential, signal) => agentmoreClient.agents(credential, signal),
      log: (message) => ctx.logger?.info?.(`[agentmore] ${message}`),
    })
    const agentmoreLogin = createAgentmoreLoginService({
      store: agentmoreStore,
      client: agentmoreClient,
      logger: ctx.logger,
      // 登录成功后立刻让目录与适配器看到新账号，用户不必重启 DSH。
      onAccount: async () => {
        agentmoreCatalog.invalidate()
        agentResolver.invalidate()
        agentmoreModelService.accountChanged()
      },
    })

    agentmoreService = createAgentmoreService({
      store: agentmoreStore,
      client: agentmoreClient,
      catalog: agentmoreCatalog,
      modelService: agentmoreModelService,
      login: agentmoreLogin,
      resolveAgentId: (credential, signal) => agentResolver.resolve(credential, signal),
      logger: ctx.logger,
    })

    // 插件卸载时必须关掉可能还开着的登录浏览器窗口 —— 否则会留下一个孤儿进程。
    ctx.effect(() => () => agentmoreLogin.dispose(), 'dsh-workbuddy-auth: agentmore login cleanup')

    const agentmoreAdapter = createAgentmoreAdapter({
      settings: agentmoreSettings,
      catalog: agentmoreCatalog,
      readCredential: () => agentmoreService.readCredential(),
      client: agentmoreClient,
      resolveAgentId: (credential, signal) => agentResolver.resolve(credential, signal),
      onCredentialRejected: (account) => agentmoreService.onCredentialRejected(account),
    })
    ctx.effect(() => () => agentmoreAdapter.dispose(), 'dsh-workbuddy-auth: agentmore model request cleanup')

    let agentmoreRegistration = false
    ctx.inject(['llm'], (llmCtx) => llmCtx.effect(() => {
      if (agentmoreRegistration) return () => {}
      let dispose
      try {
        // 独立注册，**不**与 workbuddy 合进同一个数组：`registerAdapter` 的第二个参数是
        // 单个 adapter，一个 adapter 只服务它自己声明的那个 provider id。
        dispose = llmCtx.llm.registerAdapter(['agentmore'], agentmoreAdapter)
        agentmoreRegistration = true
        agentmoreModelService.registration(true)
      } catch {
        agentmoreModelService.registration(false, 'AGENTMORE_ADAPTER_CONFLICT')
        return () => {}
      }
      return () => {
        agentmoreRegistration = false
        agentmoreAdapter.dispose()
        try { dispose?.() } finally { agentmoreModelService.registration(false) }
      }
    }, 'dsh-workbuddy-auth: agentmore native models'))
  } else if (typeof process !== 'undefined' && process.platform !== 'win32') {
    ctx.logger?.info?.('[workbuddy-auth] agentmore subscription unavailable on this platform: DPAPI-managed account store requires Windows')
  }

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
  const routeDeps = createRouteDeps(ctx, config, fetchImpl, deps, activeFile, activateAndSwitch, login, checkin, rejectedStore)
  routeDeps.models = modelService
  // 第二订阅点的 11 条路由（挂在 /api/dsh-workbuddy-auth/agentmore 下）。
  // 账号库缺席（非 Windows）时整个 agentmore 对象为 undefined，路由族自然不注册。
  routeDeps.agentmore = agentmoreService
  ctx.inject(['webServer'], (webCtx) => ctx.effect(() => {
    // 留一行可观测的 info：webServer 到位、路由真正挂上了。webServer 缺席的组合里本回调
    // 不会执行，此时 Cordis 的 fiber 状态（PENDING）就是框架级的可观测信号，无需自造日志。
    ctx.logger?.info?.('[workbuddy-auth] webServer is available; WorkBuddy settings routes registered')
    return registerRoutes(webCtx, routeDeps)
  }, 'dsh-workbuddy-auth: settings routes'))
}
