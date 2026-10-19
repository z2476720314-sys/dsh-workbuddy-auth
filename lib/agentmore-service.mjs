/**
 * agentmore 订阅点的应用服务层：把 store / client / catalog / 模型偏好 / 登录
 * 这些零件装配成 `routes.mjs` 期望的那 11 个方法。
 *
 * 为什么单独一层而不是内联进 `index.mjs`：
 *   * `index.mjs` 里 WorkBuddy 那半边已经 1100+ 行，再塞一份对称的装配代码会彻底不可读；
 *   * 这一层是**纯逻辑**（不碰 Cordis、不碰 ctx），可以直接被测试以假 store/client 驱动，
 *     不需要起 Host、也不需要真上游。
 *
 * 安全边界（与 routes 的白名单投影配合，这里是第一道）：
 *   * 本对象**永不**把 accessToken / refreshToken / deviceId 交出去；
 *   * 对外暴露的每个方法返回的都是可安全投影的普通对象；
 *   * 唯一持有明文令牌的地方是 `readCredential()`，它只给 adapter 与 client 用。
 */
import { accessTokenExpiry } from './agentmore-store.mjs'

/** 令牌剩余寿命低于此值时主动续期（与 APK `Ld/o;->f` 的 300s 同值）。 */
const REFRESH_AHEAD_MS = 300_000
/** JWT 解不出 exp 时的兜底：超过这个时长就续一次（APK 的同名常量是 1800000）。 */
const REFRESH_MAX_AGE_MS = 1_800_000
/** 积分余额缓存：设置卡一刷新就打一发上游会很吵，60s 内复用。 */
const CREDITS_TTL_MS = 60_000

/**
 * 数值投影。
 *
 * 必须先把 null / undefined / 空串挡掉：`Number(null) === 0` 且 `Number('') === 0`，
 * 否则上游没给余额时会被投影成「积分 0」，设置卡上就成了用户真的没积分。
 */
const numberOr = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}


/**
 * @param {object} options
 * @param {object} options.store `createAgentmoreStore`
 * @param {object} options.client `createAgentmoreClient`
 * @param {object} options.catalog `createAgentmoreCatalog`
 * @param {object} options.modelService `createAgentmoreModelService`
 * @param {object} options.login `createAgentmoreLoginService`
 * @param {() => Promise<string>} [options.resolveAgentId] 取/建 agent 绑定
 * @param {{info?:Function, warn?:Function, debug?:Function}} [options.logger]
 */
export function createAgentmoreService({
  store,
  client,
  catalog,
  modelService,
  login,
  resolveAgentId = async () => {
    throw Object.assign(new Error('AGENTMORE_AGENT_NOT_FOUND'), { code: 'AGENTMORE_AGENT_NOT_FOUND' })
  },
  logger,
  now = Date.now,
} = {}) {
  /** 续期的单飞：并发首字不应该把 refresh_token 轮换两次。 */
  let refreshing = null
  let creditsCache = null

  /**
   * 取当前激活凭据，必要时先续期。
   *
   * 与 WorkBuddy 侧的差别：那边凭据来自用户机器上的 CodeBuddy 桌面文件，续期是"写回同一个文件"；
   * 这里凭据由我们自己的 store 持有，续期也必须写回 store，否则下次重启就退回旧令牌。
   */
  async function readCredential({ refresh = true, signal } = {}) {
    const account = await store.getActive()
    if (account === null) return null

    if (refresh) {
      const expiry = accessTokenExpiry(account.accessToken)
      const due = expiry !== null
        ? expiry - now() <= REFRESH_AHEAD_MS
        : now() - numberOr(account.refreshedAt, 0) >= REFRESH_MAX_AGE_MS
      if (due) {
        // 续期失败不能让整条链路挂掉：令牌可能仍然可用（exp 解析失败、时钟偏差），
        // 真失效时下游第一次请求会拿到 401 并给出 INVALID_CREDENTIAL。
        try {
          await refreshAccount(account, signal)
          const next = await store.getActive()
          if (next !== null) return next
        } catch (error) {
          logger?.warn?.(`[agentmore] token refresh failed: ${error?.code ?? 'unknown'}`)
        }
      }
    }
    return account
  }

  /** 续期并落盘。`client.refresh` 内部已是单飞，这里只负责把结果并回账号。 */
  function refreshAccount(account, signal) {
    if (refreshing !== null) return refreshing
    const work = (async () => {
      const next = await client.refresh(account, signal)
      const merged = await store.upsert({ ...account, ['accessToken']: next.accessToken, refreshToken: next.refreshToken === '' ? account.refreshToken : next.refreshToken, refreshedAt: now() })
      creditsCache = null
      return merged
    })().finally(() => {
      refreshing = null
    })
    refreshing = work
    return work
  }

  async function activeAccount() {
    return store.getActive()
  }

  /**
   * `/status` 里的模型摘要。
   *
   * 为什么这里用 `list` 装数组、而 `/models` 路由用 `models`：
   * `/status` 的顶层已经有一个 `models` 键表示"模型这一块的状态"，数组只能换个名字；
   * `/models` 是**扁平**契约（与 WorkBuddy 同名路由逐字段一致），才能让客户端
   * 原样复用 `normalizeModels` 与 `ModelsPanel`，不必写第二套解析。
   * 这两处转换都收敛在本层，routes 与我都不必记第二套形状。
   */
  const modelsSummary = (state) => ({
    enabled: state?.enabled === true,
    serving: state?.serving === true,
    catalogSource: state?.catalogSource ?? '',
    catalogError: state?.catalogError ?? '',
    conflict: state?.conflict ?? '',
    enabledModelIds: Array.isArray(state?.enabledModelIds) ? state.enabledModelIds : [],
    defaultReasoningEffort: state?.defaultReasoningEffort ?? null,
    list: Array.isArray(state?.models) ? state.models : [],
  })

  return {
    /** 给 adapter 用：只在这一层交出明文令牌。 */
    readCredential,
    /** 给 adapter 用：401 后的清理（目前只记一笔，账号留给用户自己重新登录）。 */
    async onCredentialRejected(account) {
      creditsCache = null
      logger?.warn?.(`[agentmore] credential rejected for account ${String(account?.id ?? '').slice(0, 8)}`)
    },
    resolveAgentId,

    /**
     * 设置卡状态。
     *
     * 刻意**不在**这里探测上游：一次页面渲染打三发请求（user/info + 积分 + 目录）会让
     * 设置卡在弱网下卡住十秒。积分只读缓存，用户点「刷新」才真取。
     */
    async status() {
      const account = await activeAccount()
      const state = await modelService.status()
      return {
        ok: true,
        loggedIn: account !== null,
        ...(account === null ? {} : {
          account: { id: account.id, displayName: account.displayName, userId: account.userId },
        }),
        credits: creditsCache === null
          ? {
            remaining: numberOr(account?.credits, null),
            display: account?.credits === null || account?.credits === undefined ? '' : String(account.credits),
          }
          : creditsCache.value,
        models: modelsSummary(state),
      }
    },

    /** 启动浏览器登录。已在飞时返回同一流程，不会开第二个窗口。 */
    startLogin() {
      return login.start()
    },
    loginStatus() {
      return login.status()
    },
    cancelLogin() {
      return login.cancel()
    },

    async listAccounts() {
      const accounts = await store.list()
      const active = await store.getActive()
      const activeId = active === null ? null : active.id
      return accounts.map((account) => ({
        id: account.id,
        displayName: account.displayName,
        userId: account.userId,
        active: account.id === activeId,
      }))
    },

    async activateAccount(id) {
      await store.setActiveId(id)
      // 换账号 → 目录缓存必须失效，否则会把 A 的模型列表给 B 用（adapter 也会因此报 ACCOUNT_CHANGED）。
      catalog.invalidate({ keepCache: true })
      creditsCache = null
      modelService.accountChanged()
    },

    async removeAccount(id) {
      await store.remove(id)
      catalog.invalidate()
      creditsCache = null
      modelService.accountChanged()
    },

    /**
     * 真查积分（`Ld/h;->d` → `/user/info` 的 `member_info.left_score`）。
     * 未登录返回 null，由路由翻译成 `AGENTMORE_NOT_LOGGED_IN`。
     */
    async credits() {
      const account = await readCredential()
      if (account === null) return null
      if (creditsCache !== null && now() - creditsCache.at < CREDITS_TTL_MS) return creditsCache.value
      const result = await client.credits(account)
      // parseCreditBalance 的返回是 `{ remaining, display }`；早先误读 `result.value`，
      // 恒为 undefined，导致余额永远显示 0（`Number(null) === 0` 又把 null 折成 0）。
      const value = { remaining: numberOr(result?.remaining, null), display: typeof result?.display === 'string' ? result.display : '' }
      creditsCache = { at: now(), value }
      // 顺手把余额写回账号，让下次冷启动的设置卡不必请求就能显示。
      await store.upsert({ ...account, credits: value.remaining, refreshedAt: account.refreshedAt }).catch(() => {})
      return value
    },

    models() {
      // 扁平契约：与 WorkBuddy 的 `/models` 逐字段同形，客户端复用同一套解析。
      return modelService.status()
    },
    patchModels(patch) {
      return modelService.patch(patch)
    },
    async refreshModels() {
      creditsCache = null
      // 强制重拉上游目录（`force: true`），否则用户点「刷新」只会拿到 30 分钟缓存。
      return modelService.refresh()
    },

    /** 插件卸载：必须关掉可能还开着的登录浏览器窗口。 */
    dispose() {
      return login.dispose()
    },
  }
}
