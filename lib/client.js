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

    // 只有这份最小 DTO 能进入组件 state；响应中的其它键（尤其令牌）在请求边界被丢弃。
    function normalizeStatus(value) {
      const account = value?.account
      const token = value?.token
      const state = value?.state
      const credits = value?.credits
      const accounts = value?.accounts
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
          : { ok: false, error: 'unavailable' },
        token: {
          accessExpiresAt: finiteNumber(token?.accessExpiresAt),
          accessDaysLeft: finiteNumber(token?.accessDaysLeft),
          refreshExpiresAt: finiteNumber(token?.refreshExpiresAt),
          refreshDaysLeft: finiteNumber(token?.refreshDaysLeft),
          lastRefreshTime: finiteNumber(token?.lastRefreshTime),
        },
        state: {
          credentialReadable: state?.credentialReadable === true,
          userAgentFix: state?.userAgentFix === true,
          upstreamHost: shortText(state?.upstreamHost),
        },
        // 多账号：enabled 由 Host 决定；列表逐条白名单化（id/label 三字段/到期），其余丢弃。
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
              })),
            }
          : { enabled: false, activeId: '', sources: [] },
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

    function Credits({ credits }) {
      if (credits?.ok !== true) {
        return h('p', { className: 'wb-settings__muted' }, '上游未提供余额')
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
              `${source.label.nickname === '' ? '未命名账号' : source.label.nickname}${source.label.phoneMasked === '' ? '' : ` · ${source.label.phoneMasked}`}${source.id === accounts.activeId ? '（当前）' : ''}`,
            ),
          ),
        ),
        switchingId !== '' ? h('p', { className: 'wb-settings__muted', role: 'status' }, '正在切换账号…') : null,
      )
    }

    function Section({ initialStatus } = {}) {
      const [status, setStatus] = useState(() => initialStatus === undefined ? null : normalizeStatus(initialStatus))
      const [loading, setLoading] = useState(initialStatus === undefined)
      const [loadError, setLoadError] = useState('')
      const [busyAction, setBusyAction] = useState('')
      const [switchingId, setSwitchingId] = useState('')
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

      const isBusy = busyAction !== '' || switchingId !== ''
      const controlsDisabled = isBusy || loading
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
            'DSH 内无法完成 CodeBuddy OAuth。请先打开 CodeBuddy，或在终端运行 ',
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
      __test: { Section, styles, normalizeStatus, requestStatus, requestAction, runActionAndReload, requestCredentialSources, requestActivateCredentialSource },
    }
  },
})
