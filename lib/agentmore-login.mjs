/**
 * 智谱清言登录服务：起一个受控 Chromium，用户手动登录，插件从 CDP 抓 cookie。
 *
 * 这是 APK 登录链路（`AuthActivity` + `Lf/b` + `Lf/d` + `Lf/e`）在桌面插件里的等价物：
 *
 *   APK                                   本插件
 *   WebView.loadUrl(agentmore.chatglm.cn)  Chromium 导航到同一 origin
 *   用户手动登录                             用户手动登录（同一个窗口）
 *   onPageFinished → AuthActivity.a()       轮询 Storage.getCookies
 *   CookieManager.getCookie(name)           cookieCandidates(allCookies(), name)
 *   evaluateJavascript(chatglm-deid)        evaluate(targetId, ...)
 *   Ld/h;->e → 用户信息                      client.userInfo（逐枚候选验证）
 *   is_guest → 失败                          同样是**中间态**，继续等（见下）
 *   Lb/c;->e → 落盘                          store.upsert
 *
 * 与 APK 的关键差异（都是刻意的）：
 *   * APK 每次 onCreate 都 `removeAllCookies` —— 因为它用的是系统 WebView，怕串号。
 *     我们用的是**专属临时 profile**，天然隔离，不需要（也不应该）清 cookie：
 *     清了用户就没法"已经登录过所以直接复用"。
 *   * APK 只有 1500ms 固定轮询；这里用「短间隔起步 + 逐步放宽」的退避，
 *     避免用户在登录页停留十分钟时把 CPU 烧掉。
 *   * **游客态不终结流程**。实测（2026-10-18，真机 Chromium）：打开
 *     `agentmore.chatglm.cn` 后 3 秒内，页面就会在**自己的子域上**写入一对游客
 *     `chatglm_token` / `chatglm_refresh_token`；而用户正式登录后令牌写在 apex
 *     `chatglm.cn` 上。早期实现把「发现游客」当失败并关窗，结果是用户刚看到登录框、
 *     还没来得及输验证码，窗口就被关掉并报「该账号是游客身份」。
 *     现在：游客只记一笔 `guestPending`，流程继续 running 等用户真的登进去。
 */
import { launchBrowser, cookieCandidates, cookieValue } from './browser-cdp.mjs'
import { AGENTMORE_ORIGIN, AGENTMORE_WEB_ORIGIN } from './agentmore-protocol.mjs'

/** 登录页：`Lf/a` 分支 1 的 `webView.loadUrl(...)` 用的就是 API origin 上的门户页。 */
const LOGIN_URL = AGENTMORE_ORIGIN

/** cookie 名（逐字来自 `AuthActivity.a()` 的两次 `b(...)` 调用）。 */
const TOKEN_COOKIE = 'chatglm_token'
const REFRESH_COOKIE = 'chatglm_refresh_token'

/** 轮询节奏：前 30 秒 1.5s（与 APK 的 `AuthActivity.d` 同值），之后退到 3s。 */
const POLL_FAST_MS = 1_500
const POLL_SLOW_MS = 3_000
const POLL_FAST_WINDOW_MS = 30_000
/** 整体登录窗口 10 分钟：用户在等短信验证码时不该被提前掐断。 */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

const loginError = (code) => Object.assign(new Error(code), { code })

/**
 * 把 cookie 里的令牌**按域配对**成候选凭据列表，apex 域优先。
 *
 * 为什么必须按域配对而不是各取一个：`chatglm_token` 与 `chatglm_refresh_token`
 * 来自同一台设备的不同会话时对不上，上游会直接 401；而 `agentmore.chatglm.cn`
 * 打开即发游客令牌，用户正式登录后又会在 `chatglm.cn` 上写一套。混着配，
 * 结果是「拿 apex 的 access + 子域的 refresh」这种必然失败的组合。
 *
 * @param {Array<{name?:string,value?:string,domain?:string}>} cookies
 * @returns {Array<{domain:string,accessToken:string,refreshToken:string}>}
 */
export function credentialCandidates(cookies) {
  const tokens = cookieCandidates(cookies, TOKEN_COOKIE)
  const refreshes = cookieCandidates(cookies, REFRESH_COOKIE)
  const refreshByDomain = new Map(refreshes.map((entry) => [entry.domain, entry.value]))
  // 只有**整个 profile 只有一枚** refresh 时才允许跨域兜底（单域登录的退化情形：
  // 上游偶尔只把 refresh 写到另一个域）。两枚以上时绝不猜配对。
  const soleRefresh = refreshes.length === 1 ? refreshes[0].value : null
  const list = []
  const seen = new Set()
  for (const token of tokens) {
    if (seen.has(token.domain)) continue
    seen.add(token.domain)
    const refreshToken = refreshByDomain.get(token.domain) ?? soleRefresh
    if (refreshToken === null || refreshToken === undefined) continue
    list.push({ domain: token.domain, ['accessToken']: token.value, refreshToken })
  }
  return list
}

/** 从 cookie 里读 deviceId：Cookie 没有就退回页面 localStorage 的 `chatglm-deid`。 */
function deviceIdFromCookies(cookies) {
  for (const name of ['chatglm-deid', 'chatglm_deid', 'deid']) {
    const value = cookieValue(cookies, name)
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * 创建登录服务。
 *
 * @param {object} options
 * @param {ReturnType<typeof import('./agentmore-store.mjs').createAgentmoreStore>} options.store
 * @param {{userInfo:Function}} options.client 上游客户端（取用户身份）
 * @param {(entry:object)=>void} [options.logger]
 * @param {()=>Promise<object|null>} [options.onAccount] 成功回调（用于刷新目录、切适配器）
 */
export function createAgentmoreLoginService({ store, client, logger, onAccount = async () => {}, launcher = launchBrowser, now = Date.now } = {}) {
  /** 单飞：同时只允许一个登录流程在飞（浏览器窗口只有一个）。 */
  let flow = null
  let active = null

  const dto = () => {
    if (flow === null) return { status: 'idle' }
    return {
      status: flow.status,
      startedAt: flow.startedAt,
      completedAt: flow.completedAt ?? null,
      // 游客态是**等待中的事实**，不是错误：设置卡据此提示「先在窗口里登录」，
      // 而不是等用户瞎猜为什么一直停在「等待登录完成」。
      guestPending: flow.guestPending === true,
      ...(flow.error === null ? {} : { error: flow.error }),
      ...(flow.account === null ? {} : { account: flow.account }),
    }
  }

  async function teardown() {
    if (active === null) return
    const browser = active
    active = null
    try {
      await browser.close()
    } catch {
      // 浏览器已崩/已关都算正常收尾。
    }
  }

  /** 抓一次 cookie → 若找到一枚**真账号**令牌就走完认证。返回 true 表示已终结流程。 */
  async function tryComplete(runState) {
    const cookies = await runState.browser.allCookies()
    const candidates = credentialCandidates(cookies)
    if (candidates.length === 0) return false

    // 与 APK 一致：cookie 齐了之后才去取设备指纹。
    let deviceId = deviceIdFromCookies(cookies)
    if (deviceId === null) {
      const fromPage = await runState.browser.evaluate(runState.targetId, "localStorage.getItem('chatglm-deid') || ''").catch(() => '')
      const trimmed = typeof fromPage === 'string' ? fromPage.replace(/^"|"$/g, '').trim() : ''
      deviceId = trimmed === '' || trimmed === 'null' ? randomDeviceId() : trimmed
    }

    // 逐枚候选验证身份。游客令牌是正常中间态 —— 网页在用户点「登录」之前就会发放它，
    // 因此**绝不能**据此终结流程（曾经的 bug：用户还没机会登录，窗口就被关掉并报
    // 「该账号是游客身份」）。全部候选都是游客时，把流程留在 running 继续等。
    let sawGuest = false
    for (const candidate of candidates) {
      const credential = { ['accessToken']: candidate.accessToken, refreshToken: candidate.refreshToken, deviceId }
      let info
      try {
        info = await client.userInfo(credential)
      } catch (error) {
        // 令牌拿到了但上游不认 —— 可能是这一枚刚好过期，或用户还没走完二次确认。
        // 换下一枚；全都不可信时不终结流程，继续轮询让用户把剩下的步骤做完。
        if (error?.code === 'INVALID_CREDENTIAL') continue
        throw error
      }
      if (info?.isGuest === true) {
        sawGuest = true
        continue
      }

      // 身份写进**本流程**而不是模块级 `flow`：上游验证可能跨了 cancel/replace，
      // 此时 `flow` 已经指向新流程，写它等于用旧结果污染新流程（迟到结果不得改写状态）。
      if (flow !== runState) return true
      // 顺手取一次余额。`service.status()` 刻意不探测上游（冷启动不该打网络），
      // 只读账号里缓存的 credits；登录时落盘一次，设置卡首次打开就有数字。
      // 取余额失败不能拖垮登录本身，因此整体吞掉异常。
      const credits = await Promise.resolve()
        .then(() => client.credits(credential))
        .then((value) => value?.remaining ?? null)
        .catch(() => null)
      const account = await store.upsert({
        userId: info?.userId ?? '',
        displayName: info?.userId === '' ? '智谱清言账号' : `清言 ${String(info.userId).slice(-6)}`,
        ['accessToken']: credential.accessToken,
        refreshToken: credential.refreshToken,
        deviceId,
        credits,
        createdAt: now(),
        refreshedAt: now(),
      })
      runState.status = 'complete'
      runState.completedAt = now()
      runState.account = { id: account.id, displayName: account.displayName, userId: account.userId }
      runState.guestPending = false
      await onAccount(account).catch(() => {})
      return true
    }

    // 还没登录：记一笔「现在是游客态」，供设置卡给出可执行提示，但不改变流程状态。
    // 同样写本流程（run），不写模块级 `flow`：迟到的探测结果不得改写新流程。
    if (flow === runState) runState.guestPending = sawGuest
    logger?.debug?.('[agentmore] login pending: guest credential only')
    return false
  }

  async function run(runState) {
    const deadline = now() + LOGIN_TIMEOUT_MS
    while (now() < deadline) {
      if (flow !== runState) return // 被 cancel/replace
      if (runState.status === 'cancelled') return
      const elapsed = now() - runState.startedAt
      await new Promise((resolve) => setTimeout(resolve, elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS))
      if (flow !== runState) return
      let done
      try {
        done = await tryComplete(runState)
      } catch (error) {
        // 永久性协议错误（如 CDP 方法不存在）重试一万次也不会变好，必须立刻终止，
        // 否则界面会一直停在「等待登录」，用户看到的是卡死而没有任何线索。
        if (error?.permanent === true) {
          runState.status = 'error'
          runState.error = `登录链路故障（${error.code}）：${error.message}`
          runState.completedAt = now()
          logger?.warn?.(`[agentmore] login aborted on permanent CDP error: ${error.message}`)
          return
        }
        // 单次探测失败（浏览器正在导航、CDP 抖动）不算登录失败，继续轮询。
        logger?.debug?.(`[agentmore] login probe failed: ${error?.code ?? 'unknown'}`)
        done = false
      }
      if (done === true) return
    }
    if (flow === runState && runState.status === 'running') {
      runState.status = 'error'
      runState.error = '登录超时，请重试'
      runState.completedAt = now()
    }
  }

  return {
    /** 启动一次登录。已在飞时直接返回同一流程的 DTO（不重复开窗口）。 */
    async start() {
      if (flow !== null && flow.status === 'running') return dto()
      await teardown()
      flow = { status: 'running', startedAt: now(), completedAt: null, error: null, account: null, guestPending: false, browser: null, targetId: null }

      let browser
      try {
        browser = await launcher({})
      } catch (error) {
        flow.status = 'error'
        flow.error = error?.code === 'AGENTMORE_BROWSER_MISSING'
          ? '未找到可用的 Chromium 浏览器（Chrome / Edge）'
          : '无法启动浏览器'
        flow.completedAt = now()
        return dto()
      }

      active = browser
      flow.browser = browser
      try {
        const targetId = await browser.openPage(LOGIN_URL)
        flow.targetId = targetId
        await browser.navigate(targetId, LOGIN_URL)
      } catch {
        flow.status = 'error'
        flow.error = '无法打开登录页面'
        flow.completedAt = now()
        await teardown()
        return dto()
      }

      // 后台跑轮询；start 立即返回，让设置卡能开始展示"等待登录"。
      void run(flow).finally(async () => {
        await teardown()
      })
      return dto()
    },

    status() {
      return dto()
    },

    /** 用户主动取消：关窗口、置状态。 */
    async cancel() {
      if (flow === null) return { status: 'idle' }
      if (flow.status === 'running') {
        flow.status = 'cancelled'
        flow.completedAt = now()
      }
      await teardown()
      return dto()
    },

    /** 插件卸载时调用：必须保证不留孤儿浏览器进程。 */
    async dispose() {
      if (flow !== null) {
        flow.status = 'cancelled'
        flow.completedAt = now()
      }
      await teardown()
    },
  }
}

/** `UUID.randomUUID().toString().replace("-","")` 的等价物（`Lf/b` 的兜底分支）。 */
function randomDeviceId() {
  return globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? Math.random().toString(16).slice(2) + Date.now().toString(16)
}

export { AGENTMORE_WEB_ORIGIN, LOGIN_URL, TOKEN_COOKIE, REFRESH_COOKIE, LOGIN_TIMEOUT_MS }
