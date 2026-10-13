window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-auth',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React

    const ROUTE_PREFIX = '/api/dsh-workbuddy-auth'
    const STATUS_ROUTE = `${ROUTE_PREFIX}/status`
    const ACTION_ROUTES = Object.freeze({
      test: `${ROUTE_PREFIX}/connection/test`,
      refresh: `${ROUTE_PREFIX}/credential/refresh`,
      reload: `${ROUTE_PREFIX}/credential/reload`,
    })
    const SOURCES_ROUTE = `${ROUTE_PREFIX}/credentials/sources`
    const ACTIVE_ROUTE = `${ROUTE_PREFIX}/credentials/active`
    const LOGIN_ROUTE = `${ROUTE_PREFIX}/accounts/login`
    const LOGIN_STATUS_ROUTE = `${ROUTE_PREFIX}/accounts/login/status`
    const CHECKIN_SETTINGS_ROUTE = `${ROUTE_PREFIX}/checkin/settings`
    const CHECKIN_NOW_ROUTE = `${ROUTE_PREFIX}/checkin/now`
    const LOGIN_STATUSES = ['idle', 'pending', 'complete', 'error']
    const LOGIN_POLL_INTERVAL_MS = 1500
    // Host 侧登录流程最长 300s；上界留出余量，避免页面无限轮询。
    const LOGIN_MAX_POLLS = 220
    const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' })

    const styles = `
      .wb-settings { color: var(--dsw-alias-label-primary, inherit); max-width: 720px; overflow-wrap: anywhere; }
      .wb-settings * { box-sizing: border-box; }
      .wb-settings__head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-bottom: 16px; }
      .wb-settings__title { margin: 0; font: inherit; font-size: 1.08rem; font-weight: 650; letter-spacing: -0.01em; }
      .wb-settings__lede, .wb-settings__muted { margin: 0; color: var(--dsw-alias-label-tertiary, currentColor); font-size: .875rem; line-height: 1.55; }
      .wb-settings__section { border-top: .5px solid var(--dsw-alias-border-l3, currentColor); padding: 16px 0; }
      .wb-settings__section-title { margin: 0 0 10px; font: inherit; font-size: .78rem; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, currentColor); }
      .wb-settings__rows { display: grid; grid-template-columns: minmax(7.5rem, .7fr) minmax(0, 1.3fr); gap: 8px 18px; margin: 0; }
      .wb-settings__rows dt, .wb-settings__rows dd { margin: 0; min-width: 0; font-size: .9rem; line-height: 1.5; }
      .wb-settings__rows dt { color: var(--dsw-alias-label-tertiary, currentColor); }
      .wb-settings__rows dd { text-align: right; font-variant-numeric: tabular-nums; }
      .wb-settings__credits { display: flex; align-items: end; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
      .wb-settings__balance { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
      .wb-settings__diamond { color: var(--dsw-alias-state-business-primary, currentColor); opacity: .78; font-size: 1rem; line-height: 1; }
      .wb-settings__remaining { font-size: clamp(1.45rem, 4vw, 1.9rem); line-height: 1; font-weight: 680; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
      .wb-settings__remaining-label { color: var(--dsw-alias-label-tertiary, currentColor); font-size: .75rem; }
      .wb-settings__credit-meta { display: flex; gap: 18px; flex-wrap: wrap; }
      .wb-settings__metric { display: grid; gap: 2px; min-width: 4.5rem; }
      .wb-settings__metric-label { color: var(--dsw-alias-label-tertiary, currentColor); font-size: .72rem; }
      .wb-settings__metric-value { font-size: .9rem; font-variant-numeric: tabular-nums; }
      .wb-settings__credit-note { width: 100%; margin-top: 2px; }
      .wb-settings__alert { margin: 0 0 12px; padding: 10px 12px; border-left: 3px solid currentColor; background: var(--dsw-alias-bg-layer-1, transparent); font-size: .86rem; line-height: 1.5; }
      .wb-settings__alert--error { color: var(--dsw-alias-state-error-primary, currentColor); }
      .wb-settings__actions { display: flex; gap: 8px; flex-wrap: wrap; }
      .wb-settings__button { appearance: none; min-height: 34px; max-width: 100%; padding: 6px 12px; border: .5px solid var(--dsw-alias-border-l3, currentColor); border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: .86rem; line-height: 1.2; cursor: pointer; }
      .wb-settings__button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
      .wb-settings__button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
      .wb-settings__button:disabled { cursor: not-allowed; opacity: .48; }
      .wb-settings__risk { margin-top: 10px; }
      .wb-settings__guide { margin: 10px 0 0; font-size: .86rem; line-height: 1.55; }
      .wb-settings__link { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
      .wb-settings__button[data-wb-selected="true"] { border-color: currentColor; font-weight: 600; }
      .wb-settings__code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: .82em; }
      @media (max-width: 560px) {
        .wb-settings__rows { grid-template-columns: minmax(0, 1fr); gap: 2px; }
        .wb-settings__rows dd { text-align: left; margin-bottom: 8px; }
        .wb-settings__credits { align-items: flex-start; }
        .wb-settings__credit-meta { width: 100%; }
        .wb-settings__actions { display: grid; grid-template-columns: minmax(0, 1fr); }
        .wb-settings__button { width: 100%; }
      }
      @media (prefers-reduced-motion: reduce) {
        .wb-settings *, .wb-settings *::before, .wb-settings *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
      }
    `

    function finiteNumber(value) {
      const number = Number(value)
      return Number.isFinite(number) ? number : 0
    }

    function shortText(value) {
      return typeof value === 'string' ? value.slice(0, 160) : ''
    }

    /**
     * 服务端给的 hint 是客户端**唯一**会整段展示的非固定文案，因此在边界上再设一道形状闸门：
     * 含有一长串无空格的字面（>=24 个 [A-Za-z0-9_-]）即视为可能夹带令牌，整条丢弃。
     * 本插件自己的 hint 全是中文句子，最长连写是 `codebuddy` / `{$wbEncrypted}`，
     * 因此这条规则不会误伤真实文案，却能让「上游某天把令牌塞进 hint」到不了用户眼前。
     */
    function safeHint(value) {
      const text = shortText(value)
      if (text === '') return ''
      return /[A-Za-z0-9_-]{24,}/.test(text) ? '' : text
    }

    // 只有这份最小 DTO 能进入组件 state；响应中的其它键（尤其令牌）在请求边界被丢弃。
    /**
     * 签到摘要白名单：只留六个安全键，计数一律归一成非负整数。
     * Host 侧已做过一次同样的投影，这里是前端侧的防御（响应体永远不信任）。
     */
    function normalizeCheckin(value) {
      const count = (raw) => (Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Math.floor(Number(raw)) : 0)
      return {
        enabled: value?.enabled === true,
        totalAccounts: count(value?.totalAccounts),
        doneToday: count(value?.doneToday),
        skippedToday: count(value?.skippedToday),
        failedToday: count(value?.failedToday),
        lastRunAt: count(value?.lastRunAt),
      }
    }

    // 余额失败枚举与宿主 status.mjs 的白名单保持同一份语义：未知值一律 unavailable。
    const CREDIT_ERRORS = ['unavailable', 'auth-rejected', 'request-failed', 'upstream-invalid']

    function normalizeStatus(value) {
      const account = value?.account
      const token = value?.token
      const state = value?.state
      const credits = value?.credits
      const accounts = value?.accounts
      const checkin = value?.checkin
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        account: {
          nickname: shortText(account?.nickname),
          uidTail: shortText(account?.uidTail),
          phoneMasked: shortText(account?.phoneMasked),
        },
        credits: credits?.ok === true
          ? {
              ok: true,
              remaining: finiteNumber(credits.remaining),
              total: finiteNumber(credits.total),
              used: finiteNumber(credits.used),
              fetchedAt: finiteNumber(credits.fetchedAt),
              stale: credits.stale === true,
            }
          : { ok: false, error: credits?.ok === false && CREDIT_ERRORS.includes(credits.error) ? credits.error : 'unavailable' },
        token: {
          accessExpiresAt: finiteNumber(token?.accessExpiresAt),
          accessDaysLeft: finiteNumber(token?.accessDaysLeft),
          refreshExpiresAt: finiteNumber(token?.refreshExpiresAt),
          refreshDaysLeft: finiteNumber(token?.refreshDaysLeft),
          lastRefreshTime: finiteNumber(token?.lastRefreshTime),
        },
        state: {
          credentialReadable: state?.credentialReadable === true,
          credentialEncrypted: state?.credentialEncrypted === true,
          credentialHint: safeHint(state?.credentialHint),
          userAgentFix: state?.userAgentFix === true,
          upstreamHost: shortText(state?.upstreamHost),
        },
        // 多账号：enabled 由 Host 决定；列表逐条白名单化（id/label 三字段/到期/加密/失效），其余丢弃。
        accounts: accounts?.enabled === true
          ? {
              enabled: true,
              activeId: shortText(accounts.activeId),
              sources: (Array.isArray(accounts.sources) ? accounts.sources : []).slice(0, 32).map((source) => ({
                id: shortText(source?.id),
                label: {
                  nickname: shortText(source?.label?.nickname),
                  uidTail: shortText(source?.label?.uidTail),
                  phoneMasked: shortText(source?.label?.phoneMasked),
                },
                accessExpiresAt: finiteNumber(source?.accessExpiresAt),
                encrypted: source?.encrypted === true,
                stale: source?.stale === true,
              })),
            }
          : { enabled: false, activeId: '', sources: [] },
        // 签到：服务缺席时 Host 给的是关闭的零值 DTO，前端归一后形状恒定。
        checkin: normalizeCheckin(checkin),
      }
    }

    function normalizeAction(value) {
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        status: finiteNumber(value?.status),
        sseChunks: value?.sseChunks === true,
        model: shortText(value?.model),
        refreshed: value?.refreshed === true,
        throttled: value?.throttled === true,
        expiresAt: finiteNumber(value?.expiresAt),
      }
    }

    async function readJsonResponse(response, normalize) {
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${finiteNumber(response?.status)}：响应不是有效 JSON`)
      }
      if (response?.ok !== true) {
        // 服务端给了 hint 就用它当正文：`HTTP 500：HTTP 401` 只报事实，
        // 而用户需要的是「下一步做什么」。hint 缺席时回落到既有的状态码文案。
        const hint = safeHint(payload?.hint)
        if (hint !== '') throw new Error(hint)
        const detail = shortText(payload?.error)
        throw new Error(`HTTP ${finiteNumber(response?.status)}${detail === '' ? '' : `：${detail}`}`)
      }
      return normalize(payload)
    }

    async function requestStatus(fetchImpl, signal) {
      const response = await fetchImpl(STATUS_ROUTE, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeStatus)
    }

    /** 多账号：账号列表（GET）。响应经 normalizeAccountSources 白名单化。 */
    function normalizeAccountSources(value) {
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        activeId: shortText(value?.activeId),
        sources: (Array.isArray(value?.sources) ? value.sources : []).slice(0, 32).map((source) => ({
          id: shortText(source?.id),
          label: {
            nickname: shortText(source?.label?.nickname),
            uidTail: shortText(source?.label?.uidTail),
            phoneMasked: shortText(source?.label?.phoneMasked),
          },
          accessExpiresAt: finiteNumber(source?.accessExpiresAt),
          encrypted: source?.encrypted === true,
          stale: source?.stale === true,
        })),
      }
    }

    async function requestCredentialSources(fetchImpl, signal) {
      const response = await fetchImpl(SOURCES_ROUTE, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAccountSources)
    }

    /** 多账号：切换激活账号（POST，body 只带 id）。 */
    async function requestActivateCredentialSource(id, fetchImpl, signal) {
      const response = await fetchImpl(ACTIVE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (value) => ({
        ok: value?.ok === true,
        error: shortText(value?.error),
        activeId: shortText(value?.activeId),
        persisted: value?.persisted === true,
      }))
    }

    // 登录失败的诊断面（与宿主白名单**同源**）：失败时要能说清「哪一步、哪台上游、什么时候」，
    // 而不是只把一个错误码甩给用户。规则本体在 lib/diagnostic-display.mjs；客户端半区由宿主以
    // 经典脚本装载（window.__ModuleLoader__.load 的 factory），不能用 ESM import，这里保留一份
    // 同规则副本，一致性由 test/client-login-hint.test.mjs 的跨层对比（__test.displayRules）锁定。
    //
    // 为什么不是形状正则：`TOKENCANARY.example`、`p13800138000.example`、`{error:'13800138000'}` 与
    // `{code:'13800138000'}` 都能过形状闸门并出现在文案里。只认已知取值，展示面才收敛成有限集合。
    const LOGIN_DIAGNOSTIC_REASONS = ['network', 'http', 'upstream', 'region', 'payload', 'store', 'timeout']
    const LOGIN_DIAGNOSTIC_FIELDS = ['at', 'step', 'reason', 'host', 'domain', 'httpStatus', 'code', 'error']
    const LOGIN_TRACE_LIMIT = 24
    const LOGIN_DISPLAY_STEPS = ['state', 'token', 'credential', 'store']
    const LOGIN_DISPLAY_ERROR_NAMES = ['Error', 'TypeError', 'AbortError', 'SyntaxError']
    const LOGIN_DISPLAY_CODES = [0, 401, 11128, 11217, 12403]
    const LOGIN_DISPLAY_HTTP_MIN = 100
    const LOGIN_DISPLAY_HTTP_MAX = 599
    // 已知域：与宿主 lib/origins.mjs 的 DISPLAY_DOMAINS 同集合（两地区认证域 apex 与主域、
    // CN 生产落款域 www.codebuddy.cn、Intl 后端 host）。
    const LOGIN_DISPLAY_DOMAINS = [
      'copilot.tencent.com',
      'tencent.com',
      'codebuddy.cn',
      'www.codebuddy.cn',
      'workbuddy.ai',
      'codebuddy.ai',
      'www.workbuddy.ai',
      'www.codebuddy.ai',
    ]

    /** 域归一化：能当 URL 解析就走 URL，否则按 host[:port] 处理（小写、去尾点、丢路径与 query）。 */
    function normalizeLoginHost(value) {
      if (typeof value !== 'string') return ''
      const raw = value.trim()
      if (raw === '') return ''
      try {
        const url = new URL(raw.includes('//') ? raw : `https://${raw}`)
        return url.hostname.replace(/\.$/, '').toLowerCase()
      } catch {
        return ''
      }
    }

    /** 阶段名的展示文案；枚举外的值不认识，也不回显原值。 */
    const LOGIN_STAGE_LABELS = {
      state: '获取授权链接',
      token: '轮询授权结果',
      credential: '解析凭据',
      store: '写入账号池',
    }

    /**
     * 单个诊断字段的展示判定（与宿主 `displayField` 同规则）：字符串只认枚举与已知域，
     * 数字只认 `at` / `httpStatus` / `code` 各自的范围，两者互不兜底，其余一律丢字段。
     */
    function loginDisplayField(key, value) {
      if (typeof value === 'string') {
        if (value === '') return undefined
        if (key === 'step') return LOGIN_DISPLAY_STEPS.includes(value) ? value : undefined
        if (key === 'error') return LOGIN_DISPLAY_ERROR_NAMES.includes(value) ? value : undefined
        if (key === 'host' || key === 'domain') {
          const host = normalizeLoginHost(value)
          return LOGIN_DISPLAY_DOMAINS.includes(host) ? host : undefined
        }
        return undefined
      }
      if (!Number.isSafeInteger(value) || value < 0) return undefined
      if (key === 'at') return value
      if (key === 'httpStatus') return value >= LOGIN_DISPLAY_HTTP_MIN && value <= LOGIN_DISPLAY_HTTP_MAX ? value : undefined
      if (key === 'code') return LOGIN_DISPLAY_CODES.includes(value) ? value : undefined
      return undefined
    }

    function normalizeLoginDiagnostic(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const event = {}
      if (LOGIN_DIAGNOSTIC_REASONS.includes(value.reason)) event.reason = value.reason
      for (const key of LOGIN_DIAGNOSTIC_FIELDS) {
        if (key === 'reason') continue
        const item = loginDisplayField(key, value[key])
        if (item !== undefined) event[key] = item
      }
      return Object.keys(event).length === 0 ? null : event
    }

    /** 多账号：浏览器登录（POST 开始 / GET 轮询）。 */
    function normalizeLogin(value) {
      return {
        ok: value?.ok === true,
        error: shortText(value?.error),
        status: LOGIN_STATUSES.includes(value?.status) ? value.status : 'idle',
        region: value?.region === 'cn' || value?.region === 'intl' ? value.region : '',
        authUrl: typeof value?.authUrl === 'string' && value.authUrl.startsWith('https://') ? value.authUrl : '',
        progress: shortText(value?.progress),
        reason: LOGIN_DIAGNOSTIC_REASONS.includes(value?.reason) ? value.reason : '',
        detail: normalizeLoginDiagnostic(value?.detail),
        trace: Array.isArray(value?.trace)
          ? value.trace.map(normalizeLoginDiagnostic).filter((event) => event !== null).slice(-LOGIN_TRACE_LIMIT)
          : [],
        startedAt: finiteNumber(value?.startedAt),
        completedAt: finiteNumber(value?.completedAt),
        account: {
          id: shortText(value?.account?.id),
          nickname: shortText(value?.account?.nickname),
          phoneMasked: shortText(value?.account?.phoneMasked),
          uidTail: shortText(value?.account?.uidTail),
          sourceId: shortText(value?.account?.sourceId),
        },
      }
    }

    async function requestStartLogin(region, fetchImpl, signal) {
      const response = await fetchImpl(LOGIN_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ region }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeLogin)
    }

    /** 签到：开关（POST checkin/settings）与手动触发（POST checkin/now），两者都返回摘要。 */
    async function requestCheckinSettings(enabled, fetchImpl, signal) {
      const response = await fetchImpl(CHECKIN_SETTINGS_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: enabled === true }),
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (payload) => normalizeCheckin(payload?.checkin))
    }

    async function requestCheckinNow(fetchImpl, signal) {
      const response = await fetchImpl(CHECKIN_NOW_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, (payload) => normalizeCheckin(payload?.checkin))
    }

    async function requestLoginStatus(fetchImpl, signal) {
      const response = await fetchImpl(LOGIN_STATUS_ROUTE, {
        method: 'GET',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeLogin)
    }

    /**
     * 轮询登录状态直到 complete/error/idle、取消或达到上界。
     * 为什么不在这里 setInterval：SSR 与测试都要能确定性推进，等待函数由调用方注入。
     */
    async function followLoginStatus(fetchImpl, options = {}) {
      const signal = options.signal
      const onUpdate = options.onUpdate
      const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : LOGIN_POLL_INTERVAL_MS
      const maxPolls = Number.isFinite(options.maxPolls) ? options.maxPolls : LOGIN_MAX_POLLS
      let flow = null
      for (let poll = 0; poll < maxPolls; poll += 1) {
        if (signal?.aborted === true) return flow
        try {
          flow = await requestLoginStatus(fetchImpl, signal)
        } catch (error) {
          if (signal?.aborted === true) return flow
          return normalizeLogin({ ok: false, status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
        if (typeof onUpdate === 'function') onUpdate(flow)
        if (flow.status !== 'pending') return flow
        if (signal?.aborted === true) return flow
        await wait(intervalMs)
      }
      return flow
    }

    /** 只放行 https 授权链接；其余协议（含 javascript:/data:）一律拒绝。 */
    function openAuthUrl(authUrl, open = typeof window === 'undefined' ? undefined : window.open) {
      if (typeof authUrl !== 'string' || !authUrl.startsWith('https://')) return false
      if (typeof open !== 'function') return false
      try {
        open(authUrl, '_blank', 'noopener,noreferrer')
        return true
      } catch {
        return false
      }
    }

    async function requestAction(action, fetchImpl, signal) {
      const route = ACTION_ROUTES[action]
      if (route === undefined) throw new Error('未知的 WorkBuddy 动作')
      const response = await fetchImpl(route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: JSON_HEADERS,
        body: '{}',
        ...(signal === undefined ? {} : { signal }),
      })
      return readJsonResponse(response, normalizeAction)
    }

    async function runActionAndReload(action, fetchImpl, signal) {
      let actionResult
      let actionError = ''
      try {
        actionResult = await requestAction(action, fetchImpl, signal)
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error)
      }

      let status
      let statusError = ''
      try {
        status = await requestStatus(fetchImpl, signal)
      } catch (error) {
        statusError = error instanceof Error ? error.message : String(error)
      }
      return { actionResult, actionError, status, statusError }
    }

    function formatNumber(value) {
      return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
    }

    function formatTime(value) {
      if (!Number.isFinite(value) || value <= 0) return '未提供'
      try {
        return new Intl.DateTimeFormat('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(value))
      } catch {
        return '未提供'
      }
    }

    function formatExpiry(expiresAt, daysLeft) {
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) return '未提供'
      return `${formatTime(expiresAt)} · ${daysLeft} 天`
    }

    function displayText(value) {
      return value === '' ? '未提供' : value
    }

    function DataRows({ rows }) {
      return h(
        'dl',
        { className: 'wb-settings__rows' },
        rows.flatMap(([label, value], index) => [
          h('dt', { key: `label-${index}` }, label),
          h('dd', { key: `value-${index}` }, value),
        ]),
      )
    }

    // 余额失败文案：按宿主下发的稳定枚举给出可行动提示；未知/缺省退化为旧文案。
    function creditsErrorText(error) {
      if (error === 'auth-rejected') return '凭据已被上游拒绝（HTTP 401）。请重新登录该账号后查看余额'
      if (error === 'request-failed') return '余额请求失败（网络或上游暂时不可用），请稍后重试或重新打开设置'
      if (error === 'upstream-invalid') return '上游响应无法解析为余额，请稍后重试；若持续出现请反馈'
      return '上游未提供余额'
    }

    function Credits({ credits }) {
      if (credits?.ok !== true) {
        return h('p', { className: 'wb-settings__muted' }, creditsErrorText(credits?.error))
      }
      return h(
        'div',
        { className: 'wb-settings__credits' },
        h(
          'div',
          { className: 'wb-settings__balance', 'aria-label': `剩余 ${formatNumber(credits.remaining)}` },
          h('span', { className: 'wb-settings__diamond', 'aria-hidden': 'true' }, '♦'),
          h('strong', { className: 'wb-settings__remaining' }, formatNumber(credits.remaining)),
          h('span', { className: 'wb-settings__remaining-label' }, '剩余'),
        ),
        h(
          'div',
          { className: 'wb-settings__credit-meta' },
          h('span', { className: 'wb-settings__metric' },
            h('span', { className: 'wb-settings__metric-label' }, '总额'),
            h('span', { className: 'wb-settings__metric-value' }, formatNumber(credits.total)),
          ),
          h('span', { className: 'wb-settings__metric' },
            h('span', { className: 'wb-settings__metric-label' }, '已用'),
            h('span', { className: 'wb-settings__metric-value' }, formatNumber(credits.used)),
          ),
        ),
        h(
          'p',
          { className: 'wb-settings__muted wb-settings__credit-note' },
          credits.stale === true ? '上次成功值 · 按 WorkBuddy 服务端余额口径' : '按 WorkBuddy 服务端余额口径',
        ),
      )
    }

    function actionMessage(action, result) {
      if (action === 'test') {
        if (result?.ok === true) return `连接测试通过${result.model === '' ? '' : ` · ${result.model}`}`
        const status = result?.status > 0 ? `（HTTP ${result.status}）` : ''
        return `连接测试未通过${status}`
      }
      if (action === 'refresh') {
        return result?.throttled === true ? '刷新受安全间隔限制；状态已重新读取。' : '刷新凭证已完成；状态已重新读取。'
      }
      return 'CodeBuddy 登录态已重新读取。'
    }

    /** 多账号切换区：只在 Host 启用（accounts.enabled）时由 Section 渲染。 */
    function AccountSwitcher({ accounts, onSwitch, switchingId }) {
      if (accounts?.enabled !== true || accounts.sources.length === 0) return null
      return h(
        'div',
        { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '切换账号'),
        h(
          'div',
          { className: 'wb-settings__actions', role: 'group', 'aria-label': '切换 WorkBuddy 账号' },
          accounts.sources.map((source) =>
            h(
              'button',
              {
                key: source.id,
                type: 'button',
                className: 'wb-settings__button',
                'data-wb-active': source.id === accounts.activeId ? 'true' : undefined,
                disabled: source.id === accounts.activeId || switchingId !== '',
                onClick: () => onSwitch(source.id),
              },
              `${source.label.nickname === '' ? '未命名账号' : source.label.nickname}${source.label.phoneMasked === '' ? '' : ` · ${source.label.phoneMasked}`}${source.id === accounts.activeId ? '（当前）' : ''}${source.encrypted ? '（已加密）' : ''}${source.stale ? '（已失效）' : ''}`,
            ),
          ),
        ),
        accounts.sources.some((source) => source.stale)
          ? h('p', { className: 'wb-settings__muted wb-settings__risk' }, '标「已失效」的账号被上游拒绝过（401/403）；切过去前建议先在 CodeBuddy 里重新登录。')
          : null,
        accounts.sources.some((source) => source.encrypted)
          ? h('p', { className: 'wb-settings__muted' }, '标「已加密」的账号由 WorkBuddy 桌面端加密保存，本插件读不到令牌，因此无法刷新或切换；用下方浏览器登录添加一份自己的凭据即可。')
          : null,
        switchingId !== '' ? h('p', { className: 'wb-settings__muted', role: 'status' }, '正在切换账号…') : null,
      )
    }

    /** 登录区：只在 Host 启用多账号时渲染；成功只添加账号，不切换激活账号。 */
    function LoginPanel({ login, region, onRegion, onStart, busy, enabled }) {
      if (enabled !== true) return null
      const status = login?.status ?? 'idle'
      const regionButton = (value, label) => h(
        'button',
        {
          type: 'button',
          className: 'wb-settings__button',
          'data-wb-region': value,
          'data-wb-selected': region === value ? 'true' : undefined,
          disabled: busy,
          onClick: () => onRegion(value),
        },
        label,
      )
      return h(
        'div',
        { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '添加账号'),
        h(
          'div',
          { className: 'wb-settings__actions', role: 'group', 'aria-label': '登录地区' },
          regionButton('cn', '国内版'),
          regionButton('intl', '国际版'),
        ),
        h(
          'div',
          { className: 'wb-settings__actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'wb-settings__button',
              disabled: busy,
              onClick: () => onStart(region),
            },
            status === 'pending' ? '等待授权…' : '开始登录',
          ),
        ),
        status === 'pending' ? h('p', { className: 'wb-settings__muted', role: 'status' }, login.progress === '' ? '等待浏览器授权…' : login.progress) : null,
        status === 'pending' && login.authUrl !== ''
          ? h('p', { className: 'wb-settings__guide' },
            h('a', { className: 'wb-settings__link', href: login.authUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开授权页面'))
          : null,
        status === 'complete'
          ? h('p', { className: 'wb-settings__alert wb-settings__risk', role: 'status' },
            `已添加：${displayText(login.account.nickname)}${login.account.phoneMasked === '' ? '' : ` · ${login.account.phoneMasked}`}（推理仍使用当前激活账号）`)
          : null,
        status === 'error'
          ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `登录失败：${displayText(login.error)}`)
          : null,
        status === 'error' ? h('p', { className: 'wb-settings__muted' }, loginFailureHint(login)) : null,
        h('p', { className: 'wb-settings__muted wb-settings__risk' }, '浏览器登录会打开上游授权页面；完成后账号进入本机加密账号池，不会自动切换当前账号。'),
      )
    }

    /** 失败反馈：先给「下一步该做什么」（宿主 progress 里的可行动文案），再补一格脱敏定位。 */
    function loginFailureHint(login) {
      const action = login.progress === '' ? '请重新登录；若反复失败，请检查网络或代理后重试' : login.progress
      const where = loginFailureWhere(login)
      return where === '' ? action : `${action}（${where}）`
    }

    /** 取最后一条轨迹（退化为 detail）：阶段 · 上游 · HTTP · 业务码 · 时间，全是脱敏短标量。 */
    function loginFailureWhere(login) {
      const last = login.trace.length > 0 ? login.trace[login.trace.length - 1] : login.detail
      if (last === null || typeof last !== 'object') return ''
      const parts = []
      if (typeof last.step === 'string') parts.push(LOGIN_STAGE_LABELS[last.step] ?? '未知阶段')
      const host = last.host ?? last.domain
      if (typeof host === 'string') parts.push(host)
      if (Number.isSafeInteger(last.httpStatus)) parts.push(`HTTP ${last.httpStatus}`)
      if (Number.isSafeInteger(last.code)) parts.push(`业务码 ${last.code}`)
      if (Number.isSafeInteger(last.at)) parts.push(formatTime(last.at))
      return parts.join(' · ')
    }

    /**
     * 自动签到区：只读展示当日计数，写操作走两条 POST 路由。
     * busy 期间两个控件都禁用；失败只显示路由给的固定错误码，绝不回显原始错误对象。
     */
    function CheckinPanel({ checkin, busy, onToggle, onRun }) {
      const disabled = busy !== ''
      return h(
        'div',
        { className: 'wb-settings__section' },
        h('h4', { className: 'wb-settings__section-title' }, '自动签到'),
        h(
          'div',
          { className: 'wb-settings__actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'wb-settings__button',
              disabled,
              'data-wb-checkin-toggle': checkin.enabled ? 'on' : 'off',
              'aria-pressed': checkin.enabled,
              onClick: () => onToggle(!checkin.enabled),
            },
            busy === 'toggle' ? '保存中…' : checkin.enabled ? '关闭自动签到' : '开启自动签到',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wb-settings__button',
              disabled,
              'data-wb-checkin-run': 'true',
              onClick: () => onRun(),
            },
            busy === 'manual' ? '签到进行中…' : '立即签到',
          ),
        ),
        h(
          'p',
          { className: 'wb-settings__hint', role: 'status' },
          `今日成功 ${checkin.doneToday} · 跳过 ${checkin.skippedToday} · 失败 ${checkin.failedToday} · 可用账号 ${checkin.totalAccounts}`,
        ),
        h('p', { className: 'wb-settings__muted' }, `最近一次：${checkin.lastRunAt > 0 ? formatTime(checkin.lastRunAt) : '—'}`),
        h('p', { className: 'wb-settings__muted wb-settings__risk' }, '自动签到每天一次，只为国内版账号执行；国际版与加密信封账号跳过。手动签到会立即排队执行。'),
      )
    }

    function Section({ initialStatus, initialLogin, initialCheckinBusy } = {}) {
      const [status, setStatus] = useState(() => initialStatus === undefined ? null : normalizeStatus(initialStatus))
      const [loading, setLoading] = useState(initialStatus === undefined)
      const [loadError, setLoadError] = useState('')
      const [busyAction, setBusyAction] = useState('')
      const [switchingId, setSwitchingId] = useState('')
      const [login, setLogin] = useState(() => initialLogin === undefined ? null : normalizeLogin(initialLogin))
      const [loginRegion, setLoginRegion] = useState(() => (initialLogin?.region === 'intl' ? 'intl' : 'cn'))
      const [loginBusy, setLoginBusy] = useState(false)
      const [checkinBusy, setCheckinBusy] = useState(() => (initialCheckinBusy === 'toggle' || initialCheckinBusy === 'manual' ? initialCheckinBusy : ''))
      const [notice, setNotice] = useState(null)
      const mountedRef = useRef(false)
      const controllerRef = useRef(null)
      const actionInFlightRef = useRef(false)

      useEffect(() => {
        mountedRef.current = true
        const controller = new AbortController()
        controllerRef.current = controller
        setLoading(true)
        requestStatus(fetch, controller.signal).then(
          (nextStatus) => {
            if (!mountedRef.current || controller.signal.aborted) return
            setStatus(nextStatus)
            setLoadError('')
            setLoading(false)
          },
          (error) => {
            if (!mountedRef.current || controller.signal.aborted) return
            setLoadError(error instanceof Error ? error.message : String(error))
            setLoading(false)
          },
        )
        return () => {
          mountedRef.current = false
          actionInFlightRef.current = false
          controller.abort()
          if (controllerRef.current === controller) controllerRef.current = null
        }
      }, [])

      const runAction = async (action) => {
        if (actionInFlightRef.current) return
        actionInFlightRef.current = true
        setBusyAction(action)
        setNotice(null)
        const signal = controllerRef.current?.signal
        const result = await runActionAndReload(action, fetch, signal)
        if (signal?.aborted === true) return

        if (result.status !== undefined) {
          setStatus(result.status)
          setLoadError('')
        } else if (result.statusError !== '') {
          setLoadError(result.statusError)
        }

        if (result.actionError !== '') {
          setNotice({ kind: 'error', text: `${result.actionError}；已尝试重新读取状态。` })
        } else if (result.statusError !== '') {
          setNotice({ kind: 'error', text: `动作已完成，但重新读取状态失败：${result.statusError}` })
        } else {
          const ok = result.actionResult?.ok === true
          setNotice({ kind: ok ? 'success' : 'error', text: actionMessage(action, result.actionResult) })
        }
        actionInFlightRef.current = false
        setBusyAction('')
      }

      const runSwitch = async (id) => {
        if (actionInFlightRef.current || switchingId !== '') return
        actionInFlightRef.current = true
        setSwitchingId(id)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let switchError = ''
        try {
          await requestActivateCredentialSource(id, fetch, signal)
        } catch (error) {
          switchError = error instanceof Error ? error.message : String(error)
        }
        let nextStatus
        let statusError = ''
        try {
          nextStatus = await requestStatus(fetch, signal)
        } catch (error) {
          statusError = error instanceof Error ? error.message : String(error)
        }
        if (signal?.aborted === true) return
        if (nextStatus !== undefined) {
          setStatus(nextStatus)
          setLoadError('')
        } else if (statusError !== '') {
          setLoadError(statusError)
        }
        setNotice(switchError === ''
          ? { kind: 'success', text: '账号已切换；推理与积分将使用新账号。' }
          : { kind: 'error', text: `切换失败：${switchError}` })
        actionInFlightRef.current = false
        setSwitchingId('')
      }

      const isBusy = busyAction !== '' || switchingId !== '' || loginBusy || checkinBusy !== ''
      const controlsDisabled = isBusy || loading

      /**
       * 开始浏览器登录：Host 返回授权 URL → 打开新标签 → 轮询本机状态。
       * 成功只刷新账号列表，绝不切换激活账号（登录=添加）。
       */
      const runLogin = async (region) => {
        if (actionInFlightRef.current) return
        actionInFlightRef.current = true
        setLoginBusy(true)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let flow = null
        try {
          flow = await requestStartLogin(region, fetch, signal)
        } catch (error) {
          flow = normalizeLogin({ ok: false, status: 'error', region, error: error instanceof Error ? error.message : String(error) })
        }
        if (signal?.aborted === true) return
        setLogin(flow)
        if (flow.ok === true && flow.status === 'pending') {
          openAuthUrl(flow.authUrl)
          flow = await followLoginStatus(fetch, {
            signal,
            onUpdate: (next) => {
              if (signal?.aborted !== true) setLogin(next)
            },
          })
          if (signal?.aborted === true) return
          setLogin(flow)
          if (flow.status === 'complete') {
            let nextStatus
            try {
              nextStatus = await requestStatus(fetch, signal)
            } catch {
              nextStatus = undefined
            }
            if (signal?.aborted === true) return
            if (nextStatus !== undefined) {
              setStatus(nextStatus)
              setLoadError('')
            }
            setNotice({ kind: 'success', text: '已添加账号；推理仍使用当前激活账号。' })
          }
        }
        setLoginBusy(false)
        actionInFlightRef.current = false
      }

      /**
       * 签到写操作（开关 / 手动）后重新读取 status：/status 只读本地状态，
       * 因此这里拿到的是调度器最新落盘的计数，不会额外触发上游请求。
       */
      const reloadAfterCheckin = async (signal, failureText) => {
        let nextStatus
        try {
          nextStatus = await requestStatus(fetch, signal)
        } catch {
          nextStatus = undefined
        }
        if (signal?.aborted === true) return
        if (nextStatus !== undefined) {
          setStatus(nextStatus)
          setLoadError('')
        }
        setNotice(failureText === ''
          ? { kind: 'success', text: '签到设置已更新。' }
          : { kind: 'error', text: failureText })
      }

      const runCheckin = async (mode, run) => {
        if (actionInFlightRef.current) return
        actionInFlightRef.current = true
        setCheckinBusy(mode)
        setNotice(null)
        const signal = controllerRef.current?.signal
        let failure = ''
        try {
          await run(signal)
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
        await reloadAfterCheckin(signal, failure === '' ? '' : `${mode === 'manual' ? '签到失败' : '设置失败'}：${failure}`)
        setCheckinBusy('')
        actionInFlightRef.current = false
      }
      const runCheckinToggle = (enabled) => runCheckin('toggle', (signal) => requestCheckinSettings(enabled, fetch, signal))
      const runCheckinNow = () => runCheckin('manual', (signal) => requestCheckinNow(fetch, signal))

      const button = (action, label) => h(
        'button',
        {
          className: 'wb-settings__button',
          type: 'button',
          disabled: controlsDisabled,
          onClick: () => runAction(action),
        },
        busyAction === action ? `${label}中…` : label,
      )

      return h(
        'section',
        { className: 'wb-settings', 'aria-labelledby': 'workbuddy-settings-title', 'aria-busy': isBusy || loading },
        h('style', null, styles),
        h(
          'header',
          { className: 'wb-settings__head' },
          h('h3', { className: 'wb-settings__title', id: 'workbuddy-settings-title' }, 'WorkBuddy'),
          h('p', { className: 'wb-settings__lede' }, '使用本机 CodeBuddy 登录态'),
        ),
        loadError === '' ? null : h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'alert' }, `状态读取失败：${loadError}`),
        status?.ok === false
          ? h('p', { className: 'wb-settings__alert wb-settings__alert--error', role: 'status' }, `凭据状态不可用：${displayText(status.error)}`)
          : null,
        status === null && loading
          ? h('p', { className: 'wb-settings__muted', role: 'status' }, '正在读取 WorkBuddy 状态…')
          : null,
        status === null ? null : h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'wb-settings__section' },
            h('h4', { className: 'wb-settings__section-title' }, '账号'),
            h(DataRows, { rows: [
              ['昵称', displayText(status.account.nickname)],
              ['账号 ID 后四位', displayText(status.account.uidTail)],
              ['手机号', displayText(status.account.phoneMasked)],
            ] }),
          ),
          h(AccountSwitcher, { accounts: status.accounts, onSwitch: runSwitch, switchingId }),
          h(LoginPanel, {
            login,
            region: loginRegion,
            onRegion: setLoginRegion,
            onStart: runLogin,
            busy: isBusy,
            enabled: status.accounts.enabled,
          }),
          // 签到依赖账号目录（服务缺席时路由降级），因此与多账号开关一起出现/消失。
          status.accounts.enabled
            ? h(CheckinPanel, { checkin: status.checkin, busy: checkinBusy, onToggle: runCheckinToggle, onRun: runCheckinNow })
            : null,
          h(
            'div',
            { className: 'wb-settings__section' },
            h('h4', { className: 'wb-settings__section-title' }, 'WorkBuddy 积分'),
            h(Credits, { credits: status.credits }),
          ),
          h(
            'div',
            { className: 'wb-settings__section' },
            h('h4', { className: 'wb-settings__section-title' }, '令牌'),
            h(DataRows, { rows: [
              ['Access 到期', formatExpiry(status.token.accessExpiresAt, status.token.accessDaysLeft)],
              ['Refresh 到期', formatExpiry(status.token.refreshExpiresAt, status.token.refreshDaysLeft)],
              ['上次刷新', formatTime(status.token.lastRefreshTime)],
            ] }),
          ),
          h(
            'div',
            { className: 'wb-settings__section' },
            h('h4', { className: 'wb-settings__section-title' }, '状态'),
            h(DataRows, { rows: [
              ['凭据可解析', status.state.credentialReadable ? '是' : '否'],
              ['上游 UA 修复', status.state.userAgentFix ? '已生效' : '未生效'],
              ['上游域名', displayText(status.state.upstreamHost)],
            ] }),
            // 「读不到 + 下一步做什么」由 Host 给出。这是唯一会整段展示非固定文案的地方，
            // 因此先过 safeHint（夹带长字面即整条丢弃），再交给用户。
            status.state.credentialHint === ''
              ? null
              : h(
                  'p',
                  { className: 'wb-settings__alert wb-settings__alert--error wb-settings__risk', role: 'status' },
                  status.state.credentialEncrypted
                    ? `凭据已加密：${status.state.credentialHint}`
                    : status.state.credentialHint,
                ),
          ),
        ),
        h(
          'div',
          { className: 'wb-settings__section' },
          h('h4', { className: 'wb-settings__section-title' }, '动作'),
          h('div', { className: 'wb-settings__actions' },
            button('test', '测试连接'),
            button('refresh', '刷新凭证'),
            button('reload', '重新读取'),
          ),
          notice === null ? null : h(
            'p',
            {
              className: notice.kind === 'error'
                ? 'wb-settings__alert wb-settings__alert--error wb-settings__risk'
                : 'wb-settings__alert wb-settings__risk',
              role: notice.kind === 'error' ? 'alert' : 'status',
              'aria-live': 'polite',
            },
            notice.text,
          ),
          h('p', { className: 'wb-settings__muted wb-settings__risk' }, '刷新凭证会轮换 refresh token。此前实测旧 access token 仍有效，但上游行为可能变化，请勿将此视为对所有版本的保证。'),
          h(
            'p',
            { className: 'wb-settings__guide' },
            '除浏览器登录外，也可先打开 CodeBuddy，或在终端运行 ',
            h('code', { className: 'wb-settings__code' }, 'codebuddy'),
            ' 完成登录，然后点击“重新读取”。',
          ),
        ),
      )
    }

    return {
      name: 'dsh-workbuddy-auth',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'workbuddy',
          order: 46,
          label: () => 'WorkBuddy',
        }, Section))
      },
      __test: { Section, styles, normalizeStatus, normalizeCheckin, normalizeLogin, requestStatus, requestAction, runActionAndReload, requestCredentialSources, requestActivateCredentialSource, requestStartLogin, requestLoginStatus, requestCheckinSettings, requestCheckinNow, followLoginStatus, openAuthUrl, displayRules: { domains: LOGIN_DISPLAY_DOMAINS, steps: LOGIN_DISPLAY_STEPS, errorNames: LOGIN_DISPLAY_ERROR_NAMES, codes: LOGIN_DISPLAY_CODES, reasons: LOGIN_DIAGNOSTIC_REASONS, fields: LOGIN_DIAGNOSTIC_FIELDS, httpStatusMin: LOGIN_DISPLAY_HTTP_MIN, httpStatusMax: LOGIN_DISPLAY_HTTP_MAX, traceLimit: LOGIN_TRACE_LIMIT } },
    }
  },
})
