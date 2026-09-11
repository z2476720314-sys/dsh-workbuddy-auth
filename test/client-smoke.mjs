// 离线客户端冒烟：桩掉浏览器模块加载器与 fetch，不启动 dsh web、不发网络请求。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clientPath = join(pkgRoot, 'lib', 'client.js')
const ACCESS_TOKEN = 'synthetic-access-token-must-never-render'
const REFRESH_TOKEN = 'synthetic-refresh-token-must-never-render'

function candidateRoots() {
  const roots = []
  if (process.env.DSH_SMOKE_REACT_ROOT) roots.push(process.env.DSH_SMOKE_REACT_ROOT)
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'web', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'node_modules'))

  const npxRoot = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) roots.push(join(npxRoot, entry, 'node_modules'))
  }
  return roots
}

function loadReact() {
  for (const root of candidateRoots()) {
    try {
      const require = createRequire(join(root, 'resolve-baseline.cjs'))
      return { React: require('react'), renderToStaticMarkup: require('react-dom/server').renderToStaticMarkup }
    } catch {
      // 换下一个本机依赖根；插件自身不打包 React。
    }
  }
  throw new Error('找不到可用的 react/react-dom；可用 DSH_SMOKE_REACT_ROOT 指定依赖目录')
}

const { React, renderToStaticMarkup } = loadReact()

function loadClient() {
  assert.ok(existsSync(clientPath), 'lib/client.js 必须存在')
  const loaderRegistrations = []
  const originalWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: {
      load: (registration) => loaderRegistrations.push(registration),
    },
  }
  try {
    const source = readFileSync(clientPath, 'utf8')
    // client.js 是交给 DSH 浏览器模块加载器的手写惰性 CJS bundle。
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }

  assert.equal(loaderRegistrations.length, 1)
  const registration = loaderRegistrations[0]
  assert.equal(registration.id, 'dsh-workbuddy-auth')
  assert.equal(typeof registration.factory, 'function')
  return registration.factory((specifier) => {
    assert.equal(specifier, 'react', `unexpected require(${specifier})`)
    return React
  })
}

const clientExports = loadClient()

function registerSection() {
  let injectedSlot = null
  let registered = null
  const ctx = {
    slots: {
      inject: (name, callback) => {
        injectedSlot = name
        return callback()
      },
      register: (metadata, component) => {
        registered = { metadata, component }
        return () => {}
      },
    },
  }
  clientExports.apply(ctx)
  assert.equal(injectedSlot, 'settings.section')
  assert.ok(registered)
  return registered
}

function normalStatus(overrides = {}) {
  return {
    ok: true,
    account: { nickname: '测试用户', uidTail: '4444', phoneMasked: '138****1234' },
    credits: { ok: true, remaining: 950.25, total: 1234, used: 283.75, fetchedAt: 1700000000000, stale: false },
    token: {
      accessExpiresAt: 1702592000000,
      accessDaysLeft: 30,
      refreshExpiresAt: 1705184000000,
      refreshDaysLeft: 60,
      lastRefreshTime: 1700000000000,
    },
    state: { credentialReadable: true, userAgentFix: true, upstreamHost: 'copilot.tencent.com' },
    // 模拟 Host 意外多给敏感字段：客户端必须白名单化，既不持有也不渲染。
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    ...overrides,
  }
}

function renderStatus(status) {
  const registered = registerSection()
  return renderToStaticMarkup(React.createElement(registered.component, { initialStatus: status }))
}

test('客户端惰性 bundle 注册 WorkBuddy settings.section 且导出离线测试 seam', () => {
  assert.equal(clientExports.name, 'dsh-workbuddy-auth')
  assert.deepEqual(clientExports.inject, ['slots'])
  assert.equal(typeof clientExports.apply, 'function')
  assert.equal(typeof clientExports.__test?.requestStatus, 'function')
  assert.equal(typeof clientExports.__test?.requestAction, 'function')
  assert.equal(typeof clientExports.__test?.runActionAndReload, 'function')

  const registered = registerSection()
  assert.equal(registered.metadata.name, 'settings.section')
  assert.equal(registered.metadata.id, 'workbuddy')
  assert.equal(registered.metadata.order, 46)
  assert.equal(typeof registered.metadata.label, 'function')
  assert.equal(registered.metadata.label(), 'WorkBuddy')
  assert.equal(typeof registered.component, 'function')
})

test('SSR 正常状态展示账号、紧凑积分、令牌、状态和三个动作，且绝不渲染令牌', () => {
  const html = renderStatus(normalStatus())

  for (const expected of [
    'WorkBuddy',
    '使用本机 CodeBuddy 登录态',
    '测试用户',
    '4444',
    '♦',
    '950.25',
    '总额',
    '1,234',
    '已用',
    '283.75',
    '30 天',
    '60 天',
    'copilot.tencent.com',
    '测试连接',
    '刷新凭证',
    '重新读取',
  ]) assert.match(html, new RegExp(expected))
  assert.match(html, /138\*{4}1234/)

  assert.doesNotMatch(html, new RegExp(ACCESS_TOKEN))
  assert.doesNotMatch(html, new RegExp(REFRESH_TOKEN))
})

test('SSR status ok:false 显示可读错误与登录引导，不伪造账号或令牌状态', () => {
  const html = renderStatus({
    ok: false,
    error: 'credential record is unreadable',
    account: { nickname: '', uidTail: '', phoneMasked: '' },
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state: { credentialReadable: false, userAgentFix: true, upstreamHost: 'copilot.tencent.com' },
    credits: { ok: false, error: 'unavailable' },
  })

  assert.match(html, /凭据状态不可用/)
  assert.match(html, /credential record is unreadable/)
  assert.match(html, /DSH 内无法完成 CodeBuddy OAuth/)
  assert.match(html, /运行[\s\S]*codebuddy[\s\S]*完成登录/)
  assert.match(html, /然后点击“重新读取”/)
  assert.doesNotMatch(html, /未提供 · 0 天/)
})

test('SSR credits unavailable 明确显示上游未提供余额，绝不以 0 冒充成功', () => {
  const html = renderStatus(normalStatus({ credits: { ok: false, error: 'unavailable' } }))

  assert.match(html, /上游未提供余额/)
  assert.doesNotMatch(html, /♦\s*0(?:<|\s)/)
  assert.doesNotMatch(html, /总额[^<]*0/)
  assert.doesNotMatch(html, /已用[^<]*0/)
})

test('SSR credits stale 保留上次成功读数并明确标为上次成功值', () => {
  const status = normalStatus()
  status.credits = { ...status.credits, remaining: 18.5, total: 20, used: 1.5, stale: true }
  const html = renderStatus(status)

  assert.match(html, /♦/)
  assert.match(html, /18\.5/)
  assert.match(html, /上次成功值/)
  assert.match(html, /按 WorkBuddy 服务端余额口径/)
})

test('刷新风险文案准确保守，不承诺所有上游版本或 CLI 永远不受影响', () => {
  const html = renderStatus(normalStatus())

  assert.match(html, /刷新凭证会轮换 refresh token/)
  assert.match(html, /此前实测旧 access token 仍有效/)
  assert.match(html, /上游行为可能变化/)
  assert.doesNotMatch(html, /CodeBuddy CLI 若正在使用不受影响/)
})

test('SSR 保留语义结构、宿主主题 token、移动端重排、焦点与 reduced-motion 规则', () => {
  const html = renderStatus(normalStatus())
  const css = clientExports.__test.styles

  assert.match(html, /<section[^>]*aria-labelledby="workbuddy-settings-title"/)
  assert.match(html, /<h3[^>]*id="workbuddy-settings-title"/)
  assert.match(html, /<dl[^>]*>[\s\S]*<dt>昵称<\/dt><dd>测试用户<\/dd>/)
  assert.match(css, /--dsw-alias-label-primary/)
  assert.match(css, /--dsw-alias-state-business-primary/)
  assert.match(css, /--dsw-alias-border-l3/)
  assert.match(css, /@media \(max-width: 560px\)/)
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(css, /focus-visible/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/)
})

test('requestStatus 使用同源 GET、白名单化 DTO，fetch 桩全程不联网', async () => {
  const calls = []
  const status = normalStatus()
  const result = await clientExports.__test.requestStatus(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => status }
  })

  assert.deepEqual(calls, [{
    url: '/api/dsh-workbuddy-auth/status',
    init: {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    },
  }])
  assert.deepEqual(Object.keys(result).sort(), ['account', 'credits', 'error', 'ok', 'state', 'token'])
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${ACCESS_TOKEN}|${REFRESH_TOKEN}`))
})

test('requestAction 把三个动作逐字映射到同源 POST，均发送 application/json 空对象', async () => {
  const expectedPaths = {
    test: '/api/dsh-workbuddy-auth/connection/test',
    refresh: '/api/dsh-workbuddy-auth/credential/refresh',
    reload: '/api/dsh-workbuddy-auth/credential/reload',
  }

  for (const [action, expectedPath] of Object.entries(expectedPaths)) {
    const calls = []
    const result = await clientExports.__test.requestAction(action, async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 200, sseChunks: true, model: 'glm-5.3', accessToken: ACCESS_TOKEN }) }
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, expectedPath)
    assert.deepEqual(calls[0].init, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.doesNotMatch(JSON.stringify(result), new RegExp(ACCESS_TOKEN))
  }
})

test('动作完成后总会重新 GET status；动作失败与状态刷新失败分别保留可读结果', async () => {
  const calls = []
  const responses = [
    { ok: true, status: 200, json: async () => ({ ok: true, refreshed: false, throttled: false, expiresAt: 0 }) },
    { ok: true, status: 200, json: async () => normalStatus() },
  ]
  const success = await clientExports.__test.runActionAndReload('reload', async (url, init) => {
    calls.push({ url, init })
    return responses.shift()
  })

  assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
    ['/api/dsh-workbuddy-auth/credential/reload', 'POST'],
    ['/api/dsh-workbuddy-auth/status', 'GET'],
  ])
  assert.equal(success.actionError, '')
  assert.equal(success.statusError, '')
  assert.equal(success.status.ok, true)

  const failureCalls = []
  const failure = await clientExports.__test.runActionAndReload('refresh', async (url) => {
    failureCalls.push(url)
    return failureCalls.length === 1
      ? { ok: false, status: 500, json: async () => ({ ok: false, error: 'request failed' }) }
      : { ok: false, status: 503, json: async () => ({ ok: false, error: 'network request failed' }) }
  })
  assert.deepEqual(failureCalls, [
    '/api/dsh-workbuddy-auth/credential/refresh',
    '/api/dsh-workbuddy-auth/status',
  ])
  assert.match(failure.actionError, /HTTP 500/)
  assert.match(failure.statusError, /HTTP 503/)
})

test('组件 effect：挂载 GET、加载期间禁用动作、卸载中止请求且迟到结果不触发 setState', async () => {
  const originalFetch = globalThis.fetch
  const originalAbortController = globalThis.AbortController
  const originalUseEffect = React.useEffect
  const originalUseRef = React.useRef
  const originalUseState = React.useState
  const effects = []
  const cleanups = []
  const setters = []
  const controllers = []
  const calls = []
  let resolveStatus

  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false }
      controllers.push(this)
    }

    abort() {
      this.signal.aborted = true
    }
  }

  React.useState = (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    const setState = () => { setters.push('called') }
    return [value, setState]
  }
  React.useRef = (initial) => ({ current: initial })
  React.useEffect = (effect) => effects.push(effect)
  globalThis.AbortController = FakeAbortController
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return new Promise((resolve) => { resolveStatus = resolve })
  }

  try {
    const isolatedExports = loadClient()
    const tree = isolatedExports.__test.Section()
    const buttons = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type === 'button') buttons.push(node)
      const children = node.props?.children
      for (const child of Array.isArray(children) ? children : [children]) visit(child)
    }
    visit(tree)

    assert.equal(effects.length, 1)
    assert.equal(buttons.length, 3)
    assert.ok(buttons.every((item) => item.props.disabled === true), '初始 GET 完成前所有动作必须禁用')
    const cleanup = effects[0]()
    cleanups.push(cleanup)
    assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [['/api/dsh-workbuddy-auth/status', 'GET']])
    assert.equal(calls[0].init.signal, controllers[0].signal)

    cleanup()
    assert.equal(controllers[0].signal.aborted, true)
    const setterCountAfterUnmount = setters.length
    resolveStatus({ ok: true, status: 200, json: async () => normalStatus() })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(setters.length, setterCountAfterUnmount, '卸载后的迟到请求不得 setState')
  } finally {
    for (const cleanup of cleanups) cleanup?.()
    React.useEffect = originalUseEffect
    React.useRef = originalUseRef
    React.useState = originalUseState
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
    if (originalAbortController === undefined) delete globalThis.AbortController
    else globalThis.AbortController = originalAbortController
  }
})

test('组件交互：实际点击后立即锁住全部动作，拒绝第二个动作，并按 POST→GET 更新可读结果', async () => {
  const originalFetch = globalThis.fetch
  const originalUseEffect = React.useEffect
  const originalUseRef = React.useRef
  const originalUseState = React.useState
  const state = new Map()
  const refs = []
  const calls = []
  let hookIndex = 0
  let refIndex = 0
  let resolvePost

  React.useState = (initial) => {
    const index = hookIndex
    hookIndex += 1
    if (!state.has(index)) state.set(index, typeof initial === 'function' ? initial() : initial)
    return [state.get(index), (value) => state.set(index, typeof value === 'function' ? value(state.get(index)) : value)]
  }
  React.useRef = (initial) => {
    const index = refIndex
    refIndex += 1
    if (refs[index] === undefined) refs[index] = { current: initial }
    return refs[index]
  }
  React.useEffect = () => {}
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) return new Promise((resolve) => { resolvePost = resolve })
    return { ok: true, status: 200, json: async () => normalStatus() }
  }

  const buttonsFrom = (tree) => {
    const buttons = []
    const visit = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type === 'button') buttons.push(node)
      const children = node.props?.children
      for (const child of Array.isArray(children) ? children : [children]) visit(child)
    }
    visit(tree)
    return buttons
  }
  const textFrom = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    const children = node.props?.children
    return (Array.isArray(children) ? children : [children]).map(textFrom).join('')
  }

  try {
    const isolatedExports = loadClient()
    const render = () => {
      hookIndex = 0
      refIndex = 0
      return isolatedExports.__test.Section({ initialStatus: normalStatus() })
    }

    const initialButtons = buttonsFrom(render())
    assert.ok(initialButtons.every((button) => button.props.disabled === false))
    const firstAction = initialButtons[0].props.onClick()
    initialButtons[1].props.onClick()
    assert.deepEqual(calls.map((call) => call.url), ['/api/dsh-workbuddy-auth/connection/test'], '第二个动作必须被同步 ref 锁挡住')

    const busyButtons = buttonsFrom(render())
    assert.ok(busyButtons.every((button) => button.props.disabled === true), '动作 in-flight 时三个按钮必须全部 disabled')
    assert.equal(textFrom(busyButtons[0]), '测试连接中…')

    resolvePost({ ok: false, status: 503, json: async () => ({ ok: false, error: 'request failed' }) })
    await firstAction
    assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
      ['/api/dsh-workbuddy-auth/connection/test', 'POST'],
      ['/api/dsh-workbuddy-auth/status', 'GET'],
    ])

    const settledTree = render()
    assert.match(textFrom(settledTree), /HTTP 503/)
    assert.match(textFrom(settledTree), /已尝试重新读取状态/)
    assert.ok(buttonsFrom(settledTree).every((button) => button.props.disabled === false))
  } finally {
    React.useEffect = originalUseEffect
    React.useRef = originalUseRef
    React.useState = originalUseState
    if (originalFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = originalFetch
  }
})

test('request helper 对 HTTP error 抛出含状态码的可读错误，不发第二次请求', async () => {
  let calls = 0
  const fetchStub = async () => {
    calls += 1
    return { ok: false, status: 503, json: async () => ({ ok: false, error: 'request failed', accessToken: ACCESS_TOKEN }) }
  }

  await assert.rejects(
    clientExports.__test.requestAction('test', fetchStub),
    (error) => {
      assert.match(error.message, /HTTP 503/)
      assert.match(error.message, /request failed/)
      assert.doesNotMatch(error.message, new RegExp(ACCESS_TOKEN))
      return true
    },
  )
  assert.equal(calls, 1)
})
