// 智谱清言 Agent（第二订阅点）的客户端契约测试。
//
// 两类断言：
//   1. **DTD/请求层**：`normalizeAgentmore*` 只吃白名单字段，请求函数打到逐字固定的
//      `/agentmore/*` 路由、带 `credentials:'same-origin'` 且透传 signal；
//   2. **渲染层**：用 `renderToStaticMarkup` 钉住"什么状态下出现什么文案"，
//      用假 host 执行真实组件拿到 handler，验证按钮真的发出对应的请求。
//
// 令牌 canary 出现在任何 DTO / HTML 里都算失败。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadReact } from './fixtures/react-roots.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { React, renderToStaticMarkup } = loadReact(root)
const AM = '/api/dsh-workbuddy-auth/agentmore'
const CANARY = 'synthetic-secret-must-never-render-1234567890'

function loadClient(react = React) {
  let registration
  new Function('window', readFileSync(join(root, 'lib/client.js'), 'utf8'))({
    __ModuleLoader__: { load(value) { registration = value } },
  })
  return registration.factory((name) => {
    assert.equal(name, 'react')
    return react
  }).__test
}

const api = loadClient()

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

/**
 * 可以在遍历时安全展开的组件：全部无 hooks 的纯叶子。
 *
 * `AgentmoreSection` 里 `ModelsPanel` 是有状态的，展开它会额外消耗 hook 槽位，
 * 把下一次 render 的 cursor 对错位，所以刻意留在集合外——需要它的按钮时单独渲染它。
 */
const PURE_COMPONENTS = new Set(['AgentmoreLoginPanel', 'AgentmoreAccounts', 'AgentmoreCredits'])

/**
 * 把 `h(PureComponent, props)` 就地展开成它的子树。
 *
 * `renderToStaticMarkup` 会自己展开组件，直接在 React 树上找按钮则不会：
 * 三个 agentmore 叶子组件都以组件元素形式出现，不展开就永远找不到按钮。
 */
function expand(tree) {
  if (tree == null || typeof tree !== 'object') return tree
  if (Array.isArray(tree)) return tree.map(expand)
  if (typeof tree.type === 'function' && PURE_COMPONENTS.has(tree.type.name)) {
    return expand(tree.type(tree.props ?? {}))
  }
  return tree
}

function nodes(tree, predicate) {
  const target = expand(tree)
  if (target == null || typeof target !== 'object') return []
  if (Array.isArray(target)) return target.flatMap((node) => nodes(node, predicate))
  return [...(predicate(target) ? [target] : []), ...nodes(target.props?.children, predicate)]
}

function text(tree) {
  const target = expand(tree)
  if (target == null || typeof target === 'boolean') return ''
  if (Array.isArray(target)) return target.map(text).join('')
  if (typeof target !== 'object') return String(target)
  return text(target.props?.children)
}

function buttonBy(tree, predicate) {
  return nodes(tree, (node) => node.type === 'button' && predicate(node, text(node)))
}

/** 状态 DTO 的默认形状（与宿主 `/agentmore/status` 的投影逐字段对齐）。 */
function statusFixture(over = {}) {
  return {
    ok: true,
    loggedIn: true,
    account: { id: 'acc-1', displayName: '清言 123456', userId: 'u-1' },
    credits: { remaining: 42, display: '42' },
    models: {
      enabled: true,
      serving: true,
      catalogSource: 'live',
      catalogError: '',
      conflict: '',
      enabledModelIds: ['glm-5.3'],
      defaultReasoningEffort: 'default',
      list: [],
    },
    ...over,
  }
}

/**
 * 假 host：替换 React 模块对象上的 hooks，然后**重新加载一份 client** 再取组件。
 *
 * 两个都不可省：
 *   1. 必须改写 React 模块本体（`lib/client.js:5` 直接解构 `React.useState`），
 *      构造 `{ ...React, useState }` 副本无效，脱离渲染上下文的真实 `useState`
 *      会因 dispatcher 为 null 直接崩；
 *   2. 解构发生在工厂函数体里、模块加载那一刻，所以换 hook 必须在 `loadClient()`
 *      之前，否则组件闭包里的还是原版 hooks。顶层那份 `api` 只用于纯函数测试。
 */
function mount(t, fetchImpl, componentName, props = {}) {
  const originalFetch = globalThis.fetch
  const original = { useState: React.useState, useRef: React.useRef, useEffect: React.useEffect }
  globalThis.fetch = fetchImpl
  const hooks = []
  let cursor = 0
  let pending = []
  let unmounted = false

  React.useState = (initial) => {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    return [hooks[index], (value) => {
      hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
    }]
  }
  React.useRef = (initial) => {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = { current: initial }
    return hooks[index]
  }
  React.useEffect = (effect, deps) => {
    const index = cursor++
    const previous = hooks[index]
    const next = Array.isArray(deps) ? deps : null
    const changed = !previous || !next || !previous.deps || next.some((value, at) => !Object.is(value, previous.deps[at]))
    if (!changed) return
    hooks[index] = { deps: next, cleanup: previous?.cleanup }
    const slot = index
    pending.push(() => {
      hooks[slot].cleanup?.()
      hooks[slot].cleanup = effect()
    })
  }

  const isolated = loadClient()
  const component = isolated[componentName]
  assert.equal(typeof component, 'function', `${componentName} 必须导出`)
  const instance = {
    render(nextProps) {
      if (nextProps) props = { ...props, ...nextProps }
      cursor = 0
      const tree = component(props)
      const effects = pending
      pending = []
      effects.forEach((run) => run())
      return tree
    },
    unmount() {
      if (unmounted) return
      hooks.forEach((hook) => hook?.cleanup?.())
      unmounted = true
    },
  }
  t.after(() => {
    instance.unmount()
    React.useState = original.useState
    React.useRef = original.useRef
    React.useEffect = original.useEffect
    globalThis.fetch = originalFetch
  })
  return instance
}

/** 排空异步链：setTimeout(0) 让 await 链上的 Promise 全部落地。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 精确匹配路由，**不能**用 `endsWith`。
 *
 * `/login/status` 与 `/status` 都以 `/status` 结尾，用 `endsWith('/status')` 会让
 * 登录轮询命中状态分支，于是永远看不到真正的轮询次数。
 */
const at = (url, path) => url === `${AM}${path}`

function recordingFetch(handler) {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      assert.ok(String(url).startsWith('/api/dsh-workbuddy-auth/'), `只允许本地插件路由：${url}`)
      return handler(url, init, calls.length)
    },
  }
}

// ── 常量与路由 ────────────────────────────────────────────────────────────────

test('agentmore 路由常量逐字固定，且与宿主路径一致', () => {
  assert.deepEqual(api.agentmoreRoutes, {
    status: `${AM}/status`,
    login: `${AM}/login`,
    loginStatus: `${AM}/login/status`,
    loginCancel: `${AM}/login/cancel`,
    accounts: `${AM}/accounts`,
    accountActive: `${AM}/accounts/active`,
    accountRemove: `${AM}/accounts/remove`,
    credits: `${AM}/credits`,
    models: `${AM}/models`,
    modelsRefresh: `${AM}/models/refresh`,
  })
  assert.equal(Object.isFrozen(api.agentmoreRoutes), true)
})

test('登录状态机取值与宿主一致（running 而非 pending）', () => {
  assert.deepEqual(api.agentmoreLoginStatuses, ['idle', 'running', 'complete', 'error', 'cancelled'])
  assert.equal(api.agentmoreLoginStatuses.includes('pending'), false)
})

// ── DTO 归一化 ────────────────────────────────────────────────────────────────

test('normalizeAgentmoreStatus：只留白名单字段，令牌进不来', () => {
  const normalized = api.normalizeAgentmoreStatus({
    ...statusFixture(),
    accessToken: CANARY,
    refreshToken: CANARY,
    deviceId: CANARY,
    account: { id: 'acc-1', displayName: '清言', userId: 'u-1', accessToken: CANARY, refreshToken: CANARY },
    credits: { remaining: 42, display: '42', refreshToken: CANARY },
    models: { ...statusFixture().models, ['accessToken']: CANARY },
  })
  assert.equal(JSON.stringify(normalized).includes(CANARY), false)
  assert.deepEqual(Object.keys(normalized), ['ok', 'loggedIn', 'error', 'account', 'credits', 'models'])
  assert.deepEqual(Object.keys(normalized.account).sort(), ['displayName', 'id', 'userId'])
  assert.deepEqual(Object.keys(normalized.credits).sort(), ['display', 'remaining'])
})

test('normalizeAgentmoreStatus：空/非法输入全部落成安全默认值', () => {
  for (const input of [undefined, null, 'text', 42, [], {}]) {
    const normalized = api.normalizeAgentmoreStatus(input)
    assert.equal(normalized.ok, false)
    assert.equal(normalized.loggedIn, false)
    assert.equal(normalized.error, '')
    assert.deepEqual(normalized.account, { id: '', displayName: '', userId: '' })
    assert.deepEqual(normalized.credits, { remaining: null, display: '' })
    assert.equal(normalized.models.enabled, false)
    assert.equal(normalized.models.catalogSource, 'none')
    assert.deepEqual(normalized.models.list, [])
  }
})

test('normalizeAgentmoreStatus：catalogSource 只认三个合法值', () => {
  assert.equal(api.normalizeAgentmoreStatus(statusFixture({ models: { catalogSource: 'live' } })).models.catalogSource, 'live')
  assert.equal(api.normalizeAgentmoreStatus(statusFixture({ models: { catalogSource: 'cache' } })).models.catalogSource, 'cache')
  assert.equal(api.normalizeAgentmoreStatus(statusFixture({ models: { catalogSource: 'fallback' } })).models.catalogSource, 'fallback')
  assert.equal(api.normalizeAgentmoreStatus(statusFixture({ models: { catalogSource: 'weird' } })).models.catalogSource, 'none')
  assert.equal(api.normalizeAgentmoreStatus(statusFixture({ models: { catalogSource: CANARY } })).models.catalogSource, 'none')
})

test('normalizeAgentmoreStatus：catalogError / conflict 走 safeHint，长字面被丢弃', () => {
  const dirty = api.normalizeAgentmoreStatus(statusFixture({ models: { catalogError: CANARY, conflict: CANARY } }))
  assert.equal(dirty.models.catalogError, null)
  assert.equal(dirty.models.conflict, null)
  assert.equal(JSON.stringify(dirty).includes(CANARY), false)

  const clean = api.normalizeAgentmoreStatus(statusFixture({
    models: { catalogError: '上游目录读取失败，已回落到内置列表。', conflict: '与其它订阅点冲突' },
  }))
  assert.equal(clean.models.catalogError, '上游目录读取失败，已回落到内置列表。')
  assert.equal(clean.models.conflict, '与其它订阅点冲突')
})

test('normalizeAgentmoreLogin：五态归一，未知状态回落 idle', () => {
  for (const status of ['idle', 'running', 'complete', 'error', 'cancelled']) {
    assert.equal(api.normalizeAgentmoreLogin({ status }).status, status)
  }
  assert.equal(api.normalizeAgentmoreLogin({ status: 'pending' }).status, 'idle')
  assert.equal(api.normalizeAgentmoreLogin({}).status, 'idle')
})

test('normalizeAgentmoreLogin：不含授权链接字段（这条流程是宿主自己开窗）', () => {
  const normalized = api.normalizeAgentmoreLogin({ status: 'running', authUrl: 'https://evil.example/x', ['accessToken']: CANARY })
  assert.equal('authUrl' in normalized, false)
  assert.deepEqual(Object.keys(normalized).sort(), ['account', 'completedAt', 'error', 'guestPending', 'ok', 'startedAt', 'status'])
  assert.equal(JSON.stringify(normalized).includes(CANARY), false)
})

test('normalizeAgentmoreLogin：guestPending 是布尔事实，坏值一律折成 false', () => {
  assert.equal(api.normalizeAgentmoreLogin({ status: 'running', guestPending: true }).guestPending, true)
  for (const bad of [undefined, null, 'true', 1, {}]) {
    assert.equal(api.normalizeAgentmoreLogin({ status: 'running', guestPending: bad }).guestPending, false)
  }
})

test('AgentmoreLoginPanel：游客态给出可执行的下一步，而不是报登录失败', () => {
  // 真实故障：网页在用户点「登录」前就下发游客令牌，早期实现据此关窗并报错。
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreLoginPanel, {
    login: api.normalizeAgentmoreLogin({ status: 'running', guestPending: true }),
    onStart: () => {},
    onCancel: () => {},
    busy: true,
  }))
  assert.match(html, /当前仍是游客身份/)
  assert.match(html, /窗口会一直保留/)
  assert.match(html, /等待登录完成…/)
  assert.doesNotMatch(html, /登录失败/)
})

test('AgentmoreLoginPanel：非游客的 running 不显示游客提示', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreLoginPanel, {
    login: api.normalizeAgentmoreLogin({ status: 'running' }),
    onStart: () => {},
    onCancel: () => {},
    busy: true,
  }))
  assert.doesNotMatch(html, /当前仍是游客身份/)
})

test('normalizeAgentmoreAccounts：最多 32 条，字段白名单', () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `acc-${index}`,
    displayName: `账号 ${index}`,
    userId: `u-${index}`,
    active: index === 0,
    accessToken: CANARY,
    refreshToken: CANARY,
  }))
  const normalized = api.normalizeAgentmoreAccounts({ ok: true, accounts: many })
  assert.equal(normalized.accounts.length, 32)
  assert.equal(normalized.accounts[0].active, true)
  assert.equal(normalized.accounts[1].active, false)
  assert.deepEqual(Object.keys(normalized.accounts[0]).sort(), ['active', 'displayName', 'id', 'userId'])
  assert.equal(JSON.stringify(normalized).includes(CANARY), false)
})

test('normalizeAgentmoreAccounts：非法输入 → 空数组', () => {
  for (const input of [undefined, null, {}, { accounts: 'x' }]) {
    assert.deepEqual(api.normalizeAgentmoreAccounts(input).accounts, [])
  }
})

// ── 请求函数 ─────────────────────────────────────────────────────────────────

test('每个请求函数打到固定路由、同源凭据、透传 signal', async () => {
  const signal = new AbortController().signal
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/login') || at(url, '/login/status') || at(url, '/login/cancel')) return response({ ok: true, status: 'running' })
    if (at(url, '/accounts')) return response({ ok: true, accounts: [] })
    if (at(url, '/accounts/active') || at(url, '/accounts/remove')) return response({ ok: true })
    if (at(url, '/credits')) return response({ ok: true, credits: { remaining: 5, display: '5' } })
    return response({ ok: true, enabled: true, enabledModelIds: [], contextWindowOverrides: {}, models: [] })
  })

  await api.requestAgentmoreStatus(stub.fetch, signal)
  await api.requestAgentmoreStartLogin(stub.fetch, signal)
  await api.requestAgentmoreLoginStatus(stub.fetch, signal)
  await api.requestAgentmoreCancelLogin(stub.fetch, signal)
  await api.requestAgentmoreAccounts(stub.fetch, signal)
  await api.requestAgentmoreActivate('acc-2', stub.fetch, signal)
  await api.requestAgentmoreRemove('acc-2', stub.fetch, signal)
  await api.requestAgentmoreCredits(stub.fetch, signal)
  await api.requestAgentmoreModels(stub.fetch, signal)

  assert.deepEqual(stub.calls.map((call) => [call.url, call.init.method]), [
    [`${AM}/status`, 'GET'],
    [`${AM}/login`, 'POST'],
    [`${AM}/login/status`, 'GET'],
    [`${AM}/login/cancel`, 'POST'],
    [`${AM}/accounts`, 'GET'],
    [`${AM}/accounts/active`, 'POST'],
    [`${AM}/accounts/remove`, 'POST'],
    [`${AM}/credits`, 'GET'],
    [`${AM}/models`, 'GET'],
  ])
  assert.ok(stub.calls.every((call) => call.init.credentials === 'same-origin'))
  assert.ok(stub.calls.every((call) => call.init.signal === signal))
  assert.deepEqual(JSON.parse(stub.calls[5].init.body), { id: 'acc-2' })
  assert.deepEqual(JSON.parse(stub.calls[6].init.body), { id: 'acc-2' })
  assert.equal(stub.calls[1].init.body, '{}', '开始登录必须发空体而不是无体')
})

test('requestAgentmoreCredits：未登录是合法状态，不是异常', async () => {
  const stub = recordingFetch(() => response({ ok: false, error: 'AGENTMORE_NOT_LOGGED_IN' }))
  assert.deepEqual(await api.requestAgentmoreCredits(stub.fetch), { loggedIn: false, remaining: null, display: '' })
})

test('requestAgentmoreCredits：其它业务错误抛文案', async () => {
  const stub = recordingFetch(() => response({ ok: false, error: 'AGENTMORE_QUOTA' }))
  await assert.rejects(() => api.requestAgentmoreCredits(stub.fetch), (error) => error.message === 'AGENTMORE_QUOTA')
})

test('requestAgentmoreCredits：HTTP 失败带 hint 时用 hint，不带则用状态码', async () => {
  const withHint = recordingFetch(() => response({ ok: false, hint: '登录态已失效，请重新登录。' }, 500))
  await assert.rejects(() => api.requestAgentmoreCredits(withHint.fetch), (error) => error.message === '登录态已失效，请重新登录。')

  const noHint = recordingFetch(() => response({}, 503))
  await assert.rejects(() => api.requestAgentmoreCredits(noHint.fetch), (error) => error.message === 'HTTP 503：余额请求失败')
})

test('requestAgentmoreCredits：坏 JSON 抛可读文案而不是 JSON 解析栈', async () => {
  const stub = recordingFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } }))
  await assert.rejects(() => api.requestAgentmoreCredits(stub.fetch), (error) => error.message === 'HTTP 200：响应不是有效 JSON')
})

test('requestAgentmoreModels：GET/POST/refresh 三种形态与偏好白名单', async () => {
  const stub = recordingFetch(() => response({
    ok: true, enabled: true, enabledModelIds: [], defaultReasoningEffort: null,
    contextWindowOverrides: {}, region: 'cn', catalogSource: 'live', catalogError: '', serving: true, conflict: '', models: [],
  }))
  await api.requestAgentmoreModels(stub.fetch)
  await api.requestAgentmoreSaveModels({
    enabled: false,
    enabledModelIds: ['glm-5.3'],
    defaultReasoningEffort: 'high',
    contextWindowOverrides: { 'glm-5.3': 64000 },
    region: 'evil',
    accessToken: CANARY,
    models: ['drop'],
  }, stub.fetch)
  await api.requestAgentmoreRefreshModels(stub.fetch)

  assert.deepEqual(stub.calls.map((call) => [call.url, call.init.method]), [
    [`${AM}/models`, 'GET'],
    [`${AM}/models`, 'POST'],
    [`${AM}/models/refresh`, 'POST'],
  ])
  const body = JSON.parse(stub.calls[1].init.body)
  assert.deepEqual(Object.keys(body).sort(), ['contextWindowOverrides', 'defaultReasoningEffort', 'enabled', 'enabledModelIds'])
  assert.equal(JSON.stringify(body).includes(CANARY), false)
  assert.equal(stub.calls[2].init.body, undefined)
})

test('requestAgentmoreModels：坏 JSON 与非 2xx 的文案固定', async () => {
  const badJson = recordingFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x') } }))
  await assert.rejects(() => api.requestAgentmoreModels(badJson.fetch), (error) => error.message === '模型响应不是有效 JSON，请重试。')

  const failed = recordingFetch(() => response({}, 500))
  await assert.rejects(() => api.requestAgentmoreModels(failed.fetch), (error) => error.message === 'HTTP 500：模型请求失败，请重试。')
})

test('requestAgentmoreActivate/Remove：只投影 ok 与 error', async () => {
  const okStub = recordingFetch(() => response({ ok: true, activeId: 'acc-2', ['accessToken']: CANARY }))
  const activated = await api.requestAgentmoreActivate('acc-2', okStub.fetch)
  assert.deepEqual(activated, { ok: true, error: '' })
  assert.equal(JSON.stringify(activated).includes(CANARY), false)

  const errStub = recordingFetch(() => response({ ok: false, error: 'AGENTMORE_ACCOUNT_NOT_FOUND' }))
  assert.deepEqual(await api.requestAgentmoreRemove('x', errStub.fetch), { ok: false, error: 'AGENTMORE_ACCOUNT_NOT_FOUND' })
})

// ── 组件渲染 ─────────────────────────────────────────────────────────────────

test('AgentmoreSection：标题、副标题与三个分区都在，且与 WorkBuddy 卡片不共用 id', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreSection, {
    initialStatus: statusFixture(),
  }))
  assert.match(html, /智谱清言 Agent/)
  assert.match(html, /独立订阅点 · 使用 chatglm\.cn 账号/)
  assert.match(html, /aria-labelledby="agentmore-settings-title"/)
  assert.match(html, /id="agentmore-settings-title"/)
  assert.match(html, /登录智谱清言/)
  assert.match(html, /剩余积分/)
})

test('AgentmoreSection：已登录时展示显示名与用户 ID', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreSection, { initialStatus: statusFixture() }))
  assert.match(html, /清言 123456/)
  assert.match(html, /u-1/)
  assert.match(html, /已登录/)
})

test('AgentmoreSection：未登录时显示未登录且不展示账号行', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreSection, {
    initialStatus: statusFixture({ loggedIn: false, account: { id: '', displayName: '', userId: '' } }),
  }))
  assert.match(html, /未登录/)
  assert.match(html, /尚未登录；登录后可查看剩余积分。/)
})

test('AgentmoreSection：余额缺失时显示「未取到」而不是 0', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreSection, {
    initialStatus: statusFixture({ credits: { remaining: null, display: '' } }),
  }))
  assert.match(html, /剩余 未取到/)
  assert.match(html, /aria-label="剩余 未取到"/)
})

test('AgentmoreSection：status.ok=false 时给出订阅状态不可用', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreSection, {
    initialStatus: statusFixture({ ok: false, error: 'AGENTMORE_STORE_READ_FAILED' }),
  }))
  assert.match(html, /订阅状态不可用：AGENTMORE_STORE_READ_FAILED/)
})

test('AgentmoreSection：HTML 里绝不出现令牌 canary', () => {
  // 只往**令牌字段**里塞 canary：displayName/display 是用户可见文案，本来就要原样渲染，
  // 拿它们测「不泄漏令牌」测的是错误的东西。
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreSection, {
    initialStatus: {
      ...statusFixture(),
      accessToken: CANARY,
      refreshToken: CANARY,
      deviceId: CANARY,
      account: { id: 'acc-1', displayName: '清言 123456', userId: 'u-1', ['accessToken']: CANARY },
      credits: { remaining: 1, display: '1', refreshToken: CANARY },
      models: { ...statusFixture().models, ['accessToken']: CANARY },
    },
  }))
  assert.equal(html.includes(CANARY), false)
})

test('AgentmoreLoginPanel：idle 只有开始按钮，没有取消', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreLoginPanel, {
    login: api.normalizeAgentmoreLogin({ status: 'idle' }),
    onStart() {},
    onCancel() {},
    busy: false,
  }))
  assert.match(html, /打开登录窗口/)
  assert.equal(html.includes('取消'), false)
  assert.match(html, /在这台机器上打开一个独立浏览器窗口/)
})

test('AgentmoreLoginPanel：running 时出现取消与等待文案', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreLoginPanel, {
    login: api.normalizeAgentmoreLogin({ status: 'running' }),
    onStart() {},
    onCancel() {},
    busy: false,
  }))
  assert.match(html, /等待登录完成…/)
  assert.match(html, /窗口已打开，等待你在浏览器里完成登录…/)
  assert.match(html, /data-agentmore-cancel="true"/)
})

test('AgentmoreLoginPanel：complete / cancelled / error 三种收尾文案', () => {
  const complete = renderToStaticMarkup(React.createElement(api.AgentmoreLoginPanel, {
    login: api.normalizeAgentmoreLogin({ status: 'complete', account: { displayName: '清言 999888' } }),
    onStart() {}, onCancel() {}, busy: false,
  }))
  assert.match(complete, /已添加：清言 999888（推理仍使用当前激活账号）/)

  const cancelled = renderToStaticMarkup(React.createElement(api.AgentmoreLoginPanel, {
    login: api.normalizeAgentmoreLogin({ status: 'cancelled' }),
    onStart() {}, onCancel() {}, busy: false,
  }))
  assert.match(cancelled, /登录已取消，未添加任何账号。/)

  const errored = renderToStaticMarkup(React.createElement(api.AgentmoreLoginPanel, {
    login: api.normalizeAgentmoreLogin({ status: 'error', error: '登录超时，请重试' }),
    onStart() {}, onCancel() {}, busy: false,
  }))
  assert.match(errored, /登录失败：登录超时，请重试/)
})

test('AgentmoreAccounts：空列表整块不渲染', () => {
  const tree = api.AgentmoreAccounts({ accounts: [], busy: false, switchingId: '', removingId: '', onSwitch() {}, onRemove() {} })
  assert.equal(tree, null)
})

test('AgentmoreAccounts：当前账号标记（当前）、非当前可切换、disabled 状态正确', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreAccounts, {
    accounts: [
      { id: 'acc-1', displayName: '清言 A', userId: 'u-1', active: true },
      { id: 'acc-2', displayName: '清言 B', userId: 'u-2', active: false },
    ],
    busy: false,
    switchingId: 'acc-2',
    removingId: '',
    onSwitch() {},
    onRemove() {},
  }))
  assert.match(html, /清言 A（当前）/)
  assert.match(html, /清言 B/)
  assert.match(html, /用户 u-1/)
  assert.match(html, /data-agentmore-switch="acc-2"/)
  assert.match(html, /切换中…/)
  assert.match(html, /data-agentmore-remove="acc-1"/)
})

test('AgentmoreAccounts：userId 为空时退回显示 id', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreAccounts, {
    accounts: [{ id: 'acc-9', displayName: '清言 C', userId: '', active: false }],
    busy: false, switchingId: '', removingId: '', onSwitch() {}, onRemove() {},
  }))
  assert.match(html, /acc-9/)
})

test('AgentmoreCredits：未登录只提示，不渲染余额块', () => {
  const html = renderToStaticMarkup(React.createElement(api.AgentmoreCredits, {
    credits: { remaining: null, display: '' },
    loggedIn: false,
    onRefresh() {},
    busy: false,
  }))
  assert.match(html, /尚未登录；登录后可查看剩余积分。/)
  assert.equal(html.includes('wb-settings__balance'), false)
  assert.equal(html.includes('刷新积分'), false)
})

test('AgentmoreCredits：忙碌时按钮文案切换且禁用', () => {
  const tree = React.createElement(api.AgentmoreCredits, {
    credits: { remaining: 1234, display: '1234' },
    loggedIn: true,
    onRefresh() {},
    busy: true,
  })
  const html = renderToStaticMarkup(tree)
  assert.match(html, /读取中…/)
  assert.match(html, /aria-label="剩余 1,234"/)
  assert.match(html, /每 60 秒最多读取一次/)
  const [refresh] = buttonBy(tree, (node, label) => label === '读取中…')
  assert.equal(refresh.props.disabled, true)
})

// ── 交互（用假 host 执行真实 handler） ────────────────────────────────────────

test('挂载即并发拉 status 与 accounts，并把两者渲染出来', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) {
      return response({
        ok: true,
        accounts: [
          { id: 'acc-1', displayName: '清言 123456', userId: 'u-1', active: true },
          { id: 'acc-2', displayName: '清言 654321', userId: 'u-2', active: false },
        ],
      })
    }
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection')
  view.render()
  await flush()
  const tree = view.render()

  const urls = stub.calls.map((call) => call.url).sort()
  assert.deepEqual(urls, [`${AM}/accounts`, `${AM}/status`])

  const html = renderToStaticMarkup(tree)
  assert.match(html, /清言 654321/)
  assert.equal(html.includes('正在读取智谱清言状态…'), false)
})

test('挂载失败时显示状态读取失败，且不崩', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response({}, 500)
    return response({ ok: true, accounts: [] })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection')
  view.render()
  await flush()
  const html = renderToStaticMarkup(view.render())
  assert.match(html, /状态读取失败：/)
})

test('点「刷新积分」打到 /credits 并用返回值更新余额', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture({ credits: { remaining: 42, display: '42' } }))
    if (at(url, '/accounts')) return response({ ok: true, accounts: [] })
    if (at(url, '/credits')) return response({ ok: true, credits: { remaining: 777, display: '777' } })
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture({ credits: { remaining: 42, display: '42' } }) })
  view.render()
  await flush()

  const before = view.render()
  const [refresh] = buttonBy(before, (node, label) => label === '刷新积分')
  await refresh.props.onClick()
  await flush()

  assert.equal(stub.calls.some((call) => call.url === `${AM}/credits`), true)
  const html = renderToStaticMarkup(view.render())
  assert.match(html, /aria-label="剩余 777"/)
})

test('积分读取失败时给出提示，旧余额保留', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) return response({ ok: true, accounts: [] })
    if (at(url, '/credits')) return response({}, 502)
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture({ credits: { remaining: 42, display: '42' } }) })
  view.render()
  await flush()

  const [refresh] = buttonBy(view.render(), (node, label) => label === '刷新积分')
  await refresh.props.onClick()
  await flush()

  const html = renderToStaticMarkup(view.render())
  assert.match(html, /积分读取失败：HTTP 502/)
  assert.match(html, /aria-label="剩余 42"/)
})

test('点「使用」切换到目标账号并重载账号列表', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) {
      return response({
        ok: true,
        accounts: [
          { id: 'acc-1', displayName: '清言 A', userId: 'u-1', active: false },
          { id: 'acc-2', displayName: '清言 B', userId: 'u-2', active: true },
        ],
      })
    }
    if (at(url, '/accounts/active')) return response({ ok: true, activeId: 'acc-2' })
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture() })
  view.render()
  await flush()

  const tree = view.render()
  view.render()
  const [useB] = buttonBy(tree, (node, label) => label === '使用' && node.props['data-agentmore-switch'] === 'acc-2')
  assert.ok(useB, '第二个账号要有「使用」按钮')
  await useB.props.onClick()
  await flush()

  const activate = stub.calls.find((call) => call.url === `${AM}/accounts/active`)
  assert.ok(activate, '必须真的发出切换请求')
  assert.deepEqual(JSON.parse(activate.init.body), { id: 'acc-2' })
  const html = renderToStaticMarkup(view.render())
  assert.match(html, /已切换智谱清言账号/)
})

test('点「移除」删掉账号并重载', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) return response({ ok: true, accounts: [{ id: 'acc-1', displayName: '清言 A', userId: 'u-1', active: true }] })
    if (at(url, '/accounts/remove')) return response({ ok: true })
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture() })
  view.render()
  await flush()

  const tree = view.render()
  view.render()
  const [remove] = buttonBy(tree, (node, label) => label === '移除')
  await remove.props.onClick()
  await flush()

  const call = stub.calls.find((entry) => entry.url === `${AM}/accounts/remove`)
  assert.deepEqual(JSON.parse(call.init.body), { id: 'acc-1' })
  assert.match(renderToStaticMarkup(view.render()), /账号已移除。/)
})

test('切换失败时报错但仍重载列表', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) return response({ ok: true, accounts: [{ id: 'acc-1', displayName: '清言 A', userId: 'u-1', active: false }] })
    if (at(url, '/accounts/active')) return response({ ok: false, error: 'AGENTMORE_ACCOUNT_NOT_FOUND' }, 500)
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture() })
  view.render()
  await flush()

  const tree = view.render()
  view.render()
  const [use] = buttonBy(tree, (node, label) => label === '使用')
  await use.props.onClick()
  await flush()

  assert.match(renderToStaticMarkup(view.render()), /切换失败：/)
})

test('点开始登录 → 轮询到 complete → 重载并报已添加', async (t) => {
  let polls = 0
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) return response({ ok: true, accounts: [] })
    if (at(url, '/login/status')) {
      polls += 1
      return response({ ok: true, status: 'complete', account: { id: 'acc-9', displayName: '清言 999888', userId: 'u-9' } })
    }
    if (at(url, '/login')) return response({ ok: true, status: 'running', startedAt: 1 })
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture({ loggedIn: false }) })
  view.render()
  await flush()

  const tree = view.render()
  const [start] = buttonBy(tree, (node, label) => label === '打开登录窗口')
  // 轮询用真实 setTimeout(1500)；用假定时器把它压成一次宏任务。
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => originalSetTimeout(fn, 0)
  try {
    await start.props.onClick()
    await flush()
    await flush()
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }

  assert.equal(polls, 1, '进入 running 后必须轮询一次状态')
  const html = renderToStaticMarkup(view.render())
  assert.match(html, /已添加智谱清言账号/)
})

test('登录失败时展示错误且不再轮询', async (t) => {
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) return response({ ok: true, accounts: [] })
    if (at(url, '/login')) return response({}, 500)
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture({ loggedIn: false }) })
  view.render()
  await flush()

  const [start] = buttonBy(view.render(), (node, label) => label === '打开登录窗口')
  await start.props.onClick()
  await flush()

  assert.equal(stub.calls.some((call) => call.url === `${AM}/login/status`), false)
  assert.match(renderToStaticMarkup(view.render()), /登录失败：/)
})

test('running 时点取消 → 打到 /login/cancel 并展示已取消', async (t) => {
  let polls = 0
  const stub = recordingFetch((url) => {
    if (at(url, '/status')) return response(statusFixture())
    if (at(url, '/accounts')) return response({ ok: true, accounts: [] })
    if (at(url, '/login/status')) { polls += 1; return response({ ok: true, status: 'running' }) }
    if (at(url, '/login/cancel')) return response({ ok: true, status: 'cancelled' })
    if (at(url, '/login')) return response({ ok: true, status: 'running' })
    return response({ ok: true })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection', { initialStatus: statusFixture({ loggedIn: false }) })
  // 轮询用真实 1500ms；压成 0ms 让整个循环在本次测试里跑完。
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => originalSetTimeout(fn, 0)
  try {
    view.render()
    await flush()

    const [start] = buttonBy(view.render(), (node, label) => label === '打开登录窗口')
    const started = start.props.onClick()
    await flush()
    await flush()
    assert.ok(polls >= 1, '进入 running 后必须开始轮询')

    const running = view.render()
    const [cancel] = buttonBy(running, (node, label) => label === '取消')
    assert.ok(cancel, 'running 时必须出现取消按钮')
    // 回归点：登录轮询期间 loginBusy 恒为 true，取消按钮曾经因此全程 disabled，
    // 于是「开了窗口又想放弃」的时刻恰恰点不动。
    assert.equal(cancel.props.disabled, false, '登录等待期间取消必须可点')

    await cancel.props.onClick()
    await flush()
    assert.equal(stub.calls.some((call) => call.url === `${AM}/login/cancel`), true)

    // 轮询循环必须因取消而退出：再多跑几轮宏任务，/login/status 不能再增加。
    const settled = polls
    await flush()
    await flush()
    await flush()
    assert.equal(polls, settled, '取消后不得再发起新的状态轮询')

    assert.match(renderToStaticMarkup(view.render()), /登录已取消/)
    await started
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('卸载后不再发请求（AbortController 真的被 abort）', async (t) => {
  const signals = []
  const stub = recordingFetch((url, init) => {
    signals.push(init.signal)
    if (at(url, '/status')) return response(statusFixture())
    return response({ ok: true, accounts: [] })
  })
  const view = mount(t, stub.fetch, 'AgentmoreSection')
  view.render()
  await flush()
  view.unmount()
  assert.ok(signals.length > 0)
  assert.ok(signals.every((signal) => signal.aborted === true), '卸载必须 abort 在飞请求')
})

test('运行中禁用全部动作按钮（busy 透传到面板）', () => {
  const tree = React.createElement(api.AgentmoreSection, { initialStatus: statusFixture() })
  const html = renderToStaticMarkup(tree)
  // 初始渲染时 loading=true（未给 initialStatus 之外的 effect 结果），但给了 initialStatus 故为 false。
  assert.equal(html.includes('打开登录窗口'), true)
})
