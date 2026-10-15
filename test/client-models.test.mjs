import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(process.env.DSH_SMOKE_REACT_ROOT || join(root, 'node_modules'), 'model-tests.cjs'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ROUTE = '/api/dsh-workbuddy-auth/models'
const CANARY = 'synthetic-secret-must-never-render-123456'

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

function fixture(overrides = {}) {
  return {
    ok: true, enabled: true, enabledModelIds: [], defaultReasoningEffort: null,
    contextWindowOverrides: {}, region: 'cn', catalogSource: 'live', catalogError: null,
    serving: false, conflict: null,
    models: [
      { id: 'model-a', name: 'Model A', contextWindow: 32000, maxContextWindow: 128000, maxTokens: 4096,
        inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low',
        enabled: false, contextWindowOverride: null, effectiveContextWindow: 32000, effectiveReasoningEffort: 'low' },
      { id: 'model-b', name: 'Model B', contextWindow: 16000, maxContextWindow: null, maxTokens: 2048,
        inputModalities: ['text'], reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium',
        enabled: false, contextWindowOverride: null, effectiveContextWindow: 16000, effectiveReasoningEffort: 'medium' },
    ],
    ...overrides,
  }
}

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const api = loadClient()

function nodes(tree, predicate) {
  if (tree == null || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate))
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)]
}
function text(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (Array.isArray(tree)) return tree.map(text).join('')
  if (typeof tree !== 'object') return String(tree)
  return text(tree.props?.children)
}
const button = (tree, label) => {
  const found = nodes(tree, (node) => node.type === 'button' && text(node) === label)[0]
  assert.ok(found, `Missing button: ${label}`)
  return found
}
const input = (tree, label) => {
  const found = nodes(tree, (node) => node.props?.['aria-label'] === label)[0]
  assert.ok(found, `Missing input: ${label}`)
  return found
}

// Execute the actual component handlers with deterministic state/effect scheduling.
function mount(t, fetchImpl, props = {}, componentName = 'ModelsPanel') {
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  const hooks = []
  let cursor = 0
  let pending = []
  let unmounted = false
  let writesAfterUnmount = 0
  const host = { ...React,
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (value) => {
        if (unmounted) writesAfterUnmount++
        hooks[index] = typeof value === 'function' ? value(hooks[index]) : value
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        hooks[index] = { deps, cleanup: previous?.cleanup }
        pending.push(() => {
          hooks[index].cleanup?.()
          hooks[index].cleanup = effect()
        })
      }
    },
  }
  const component = loadClient(host)[componentName]
  assert.equal(typeof component, 'function')
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
    get writesAfterUnmount() { return writesAfterUnmount },
  }
  t.after(() => {
    instance.unmount()
    globalThis.fetch = originalFetch
  })
  return instance
}

function stubApi(handler) {
  const calls = []
  return { calls, fetch: async (url, init) => {
    calls.push({ url, init })
    assert.ok(url === ROUTE || url === `${ROUTE}/refresh` || url.startsWith('/api/dsh-workbuddy-auth/'), 'Local plugin routes only')
    return handler(url, init, calls.length)
  } }
}

test('DTO normalization is top-level, whitelisted, and defaults to zero selection', () => {
  assert.equal(typeof api.normalizeModels, 'function')
  const initial = api.normalizeModels({ ok: true })
  assert.equal(initial.enabled, true)
  assert.deepEqual(initial.enabledModelIds, [])
  assert.equal(initial.defaultReasoningEffort, null)
  assert.deepEqual(initial.contextWindowOverrides, {})
  const normal = api.normalizeModels(fixture({ accessToken: CANARY,
    catalogError: CANARY, conflict: CANARY,
    models: [{ ...fixture().models[0], accessToken: CANARY, reasoningEfforts: ['low', 'off', 'high', 'high'] }],
  }))
  assert.deepEqual(normal.models[0].reasoningEfforts, ['low', 'high'])
  assert.equal(JSON.stringify(normal).includes(CANARY), false)
  assert.deepEqual(Object.keys(normal), ['ok', 'enabled', 'enabledModelIds', 'defaultReasoningEffort',
    'contextWindowOverrides', 'region', 'catalogSource', 'catalogError', 'serving', 'conflict', 'models'])
})

test('request helpers use exact routes, top-level DTO, and preference-only POST bodies', async () => {
  const stub = stubApi(() => response(fixture()))
  const signal = new AbortController().signal
  await api.requestModels(stub.fetch, signal)
  await api.requestSaveModels({ enabled: false, enabledModelIds: ['model-a'], defaultReasoningEffort: null,
    contextWindowOverrides: { 'model-a': null }, accessToken: CANARY, models: ['drop'] }, stub.fetch, signal)
  await api.requestRefreshModels(stub.fetch, signal)
  assert.deepEqual(stub.calls.map(({ url, init }) => [url, init.method]), [[ROUTE, 'GET'], [ROUTE, 'POST'], [`${ROUTE}/refresh`, 'POST']])
  assert.deepEqual(JSON.parse(stub.calls[1].init.body), { enabled: false, enabledModelIds: ['model-a'],
    defaultReasoningEffort: null, contextWindowOverrides: { 'model-a': null } })
  assert.ok(stub.calls.every(({ init }) => init.signal === signal && init.credentials === 'same-origin'))
  assert.equal(stub.calls[2].init.body, undefined)
})

test('layout: existing usage follows enhancements without changing its credit values', () => {
  const html = renderToStaticMarkup(React.createElement(api.Section, { initialStatus: { ok: true,
    credits: { ok: true, remaining: 7, used: 3, total: 10 } }, initialModels: fixture() }))
  assert.ok(html.indexOf('增强功能') < html.indexOf('用量与配额'))
  assert.equal((html.match(/aria-label="剩余 7"/g) || []).length, 1)
})

test('layout: compact model choices are separate from the single enhancement editor', () => {
  const tree = api.ModelsPanel ? React.createElement(api.ModelsPanel, { initialModels: fixture() }) : null
  const html = renderToStaticMarkup(tree)
  assert.match(html, /aria-label="可用模型"/)
  assert.match(html, /aria-label="增强功能"/)
  assert.ok(html.indexOf('aria-label="可用模型"') < html.indexOf('aria-label="增强功能"'))
  assert.equal((html.match(/aria-label="默认思考深度"/g) || []).length, 1)
  assert.equal((html.match(/type="text"/g) || []).length, 0, 'No context editors before any model is selected')
  assert.match(html, /还没有勾选任何模型/)
  assert.doesNotMatch(html, /保存后思考深度|当前有效上下文|官方输出上限/)
})

test('context controls: only selected models are editable and hiding preserves the unsaved value', async (t) => {
  const stub = stubApi(() => response(fixture()))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  let tree = panel.render()
  assert.equal(nodes(tree, (node) => node.type === 'input' && node.props.type === 'text').length, 0)
  input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
  tree = panel.render()
  assert.equal(nodes(tree, (node) => node.type === 'input' && node.props.type === 'text').length, 1)
  tree = panel.render()
  input(tree, 'Model A 上下文覆盖').props.onChange({ target: { value: '64000' } })
  input(tree, '选择 Model A').props.onChange({ target: { checked: false } })
  tree = panel.render()
  assert.equal(nodes(tree, (node) => node.type === 'input' && node.props.type === 'text').length, 0)
  input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
  assert.equal(input(panel.render(), 'Model A 上下文覆盖').props.value, '64000')
  assert.equal(stub.calls.length, 1, 'Presentation changes do not send requests')
})

test('reset contexts: clears visible and hidden overrides without changing selection or effort', async (t) => {
  const initial = fixture({ enabledModelIds: ['model-a'], defaultReasoningEffort: 'high',
    contextWindowOverrides: { 'model-a': 64000, 'model-b': 24000, 'retired-model': 8000 } })
  const stub = stubApi((url, init) => response(init.method === 'GET' ? initial : fixture()))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  button(panel.render(), '全部恢复默认').props.onClick()
  const tree = panel.render()
  assert.equal(input(tree, '选择 Model A').props.checked, true)
  assert.equal(input(tree, '选择 Model B').props.checked, false)
  assert.equal(input(tree, '默认思考深度').props.value, 'high')
  assert.equal(input(tree, 'Model A 上下文覆盖').props.value, '')
  assert.equal(stub.calls.length, 1)
  await button(tree, '保存模型设置').props.onClick()
  assert.deepEqual(JSON.parse(stub.calls[1].init.body), { enabled: true, enabledModelIds: ['model-a'],
    defaultReasoningEffort: 'high', contextWindowOverrides: { 'model-a': null, 'model-b': null, 'retired-model': null } })
})

test('SSR: model management inherits the settings section, shows metadata, and starts unchecked', () => {
  const html = renderToStaticMarkup(React.createElement(api.Section, { initialStatus: { ok: true }, initialModels: fixture() }))
  assert.match(html, /模型管理/)
  assert.match(html, /已选 0/)
  assert.match(html, /中国大陆/)
  assert.match(html, /官方实时目录/)
  assert.match(html, /增强功能/)
  assert.match(html, /32K · 图片 · low\/high/)
  assert.doesNotMatch(html, /aria-label="Model A 上下文覆盖"/)
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3)
  assert.equal((html.match(/checked=""/g) || []).length, 1, 'Only the default provider switch is checked')
  assert.doesNotMatch(html, new RegExp(CANARY))
})

test('interaction: GET leaves all models unchecked; checkbox, auto effort, null clearing save and reload', async (t) => {
  const stub = stubApi((url, init) => response(init.method === 'GET' ? fixture({ contextWindowOverrides: { 'model-a': 64000 } }) : fixture({
    serving: true, enabledModelIds: ['model-a'], models: [{ ...fixture().models[0], enabled: true }, fixture().models[1]],
  })))
  const panel = mount(t, stub.fetch)
  assert.match(text(panel.render()), /正在读取模型/)
  await tick()
  let tree = panel.render()
  assert.equal(input(tree, '选择 Model A').props.checked, false)
  input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
  tree = panel.render()
  input(tree, 'Model A 上下文覆盖').props.onChange({ target: { value: '' } })
  input(tree, '默认思考深度').props.onChange({ target: { value: '' } })
  tree = panel.render()
  await button(tree, '保存模型设置').props.onClick()
  assert.deepEqual(JSON.parse(stub.calls[1].init.body), { enabled: true, enabledModelIds: ['model-a'],
    defaultReasoningEffort: null, contextWindowOverrides: { 'model-a': null } })
  assert.match(text(panel.render()), /模型设置已保存/)
  assert.equal(stub.calls.length, 2, 'No inference or duplicate reload on save')
  const reloaded = renderToStaticMarkup(React.createElement(api.ModelsPanel, { initialModels: fixture({ enabledModelIds: ['model-a'] }) }))
  assert.match(reloaded, /已选 1/)
})

test('interaction: refresh preserves unsaved selection and override; failed save/refresh preserve all edits', async (t) => {
  let fail = false
  const stub = stubApi((url) => fail
    ? response({ ok: false, error: CANARY, hint: CANARY }, 503)
    : response(fixture({ catalogSource: 'cache', models: [{ ...fixture().models[0], maxContextWindow: 256000 }] })))
  const panel = mount(t, stub.fetch, { initialModels: fixture() })
  panel.render()
  await tick()
  let tree = panel.render()
  input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
  tree = panel.render()
  input(tree, 'Model A 上下文覆盖').props.onChange({ target: { value: '64000' } })
  input(tree, '默认思考深度').props.onChange({ target: { value: 'high' } })
  tree = panel.render()
  await button(tree, '刷新模型目录').props.onClick()
  tree = panel.render()
  assert.equal(input(tree, '选择 Model A').props.checked, true)
  assert.equal(input(tree, 'Model A 上下文覆盖').props.value, '64000')
  assert.equal(input(tree, '默认思考深度').props.value, 'high')
  fail = true
  await button(tree, '保存模型设置').props.onClick()
  await button(panel.render(), '刷新模型目录').props.onClick()
  tree = panel.render()
  assert.equal(input(tree, '选择 Model A').props.checked, true)
  assert.equal(input(tree, 'Model A 上下文覆盖').props.value, '64000')
  assert.equal(input(tree, '默认思考深度').props.value, 'high')
  assert.match(text(tree), /503/)
  assert.doesNotMatch(text(tree), new RegExp(CANARY))
})

test('interaction: explicit select-all keeps unavailable preferences, clear-all and provider off are intentional', async (t) => {
  const stub = stubApi((url, init) => response(init.method === 'GET' ? fixture({ enabledModelIds: ['retired-model'] }) : fixture({ enabled: false })))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  let tree = panel.render()
  assert.match(text(tree), /当前目录外/)
  button(tree, '全选').props.onClick()
  tree = panel.render()
  assert.ok(nodes(tree, (node) => node.props?.type === 'checkbox' && node.props['data-wb-model-id']).every((node) => node.props.checked))
  button(tree, '全不选').props.onClick()
  tree = panel.render()
  assert.match(text(tree), /已选 0/)
  input(tree, '启用 WorkBuddy 模型供应商').props.onChange({ target: { checked: false } })
  await button(panel.render(), '保存模型设置').props.onClick()
  assert.deepEqual(JSON.parse(stub.calls.at(-1).init.body).enabledModelIds, [])
  assert.equal(JSON.parse(stub.calls.at(-1).init.body).enabled, false)
})

test('interaction: invalid context blocks POST; official default is not the maximum; unsupported effort uses official default', async (t) => {
  const stub = stubApi((url, init) => response(init.method === 'GET' ? fixture() : fixture()))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  let tree = panel.render()
  input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
  tree = panel.render()
  const options = nodes(input(tree, '默认思考深度'), (node) => node.type === 'option').map((node) => node.props.value)
  assert.deepEqual(options, ['', 'low', 'high', 'medium'])
  input(tree, '默认思考深度').props.onChange({ target: { value: 'high' } })
  tree = panel.render()
  assert.equal(input(tree, '默认思考深度').props.value, 'high')
  assert.equal(api.normalizeModels(fixture()).models[1].effectiveReasoningEffort, 'medium')
  assert.match(text(tree), /默认 32K · 上限 128K/)
  for (const value of ['-1', '0', '1.5', '1e3', '128001']) {
    tree = panel.render()
  input(tree, 'Model A 上下文覆盖').props.onChange({ target: { value } })
    await button(panel.render(), '保存模型设置').props.onClick()
    assert.equal(stub.calls.length, 1, `Invalid override must not POST: ${value}`)
    assert.ok(nodes(panel.render(), (node) => node.props?.role === 'alert').length)
  }
  tree = panel.render()
  tree = panel.render()
  input(tree, 'Model A 上下文覆盖').props.onChange({ target: { value: '64000' } })
  await button(panel.render(), '保存模型设置').props.onClick()
  assert.equal(JSON.parse(stub.calls[1].init.body).contextWindowOverrides['model-a'], 64000)
})

test('interaction: synchronous lock prevents duplicate model operations; loading disables controls', async (t) => {
  let release
  const stub = stubApi((url, init) => init.method === 'GET' ? response(fixture()) : new Promise((resolve) => { release = resolve }))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  const tree = panel.render()
  const saving = button(tree, '保存模型设置').props.onClick()
  button(tree, '刷新模型目录').props.onClick()
  const busy = panel.render()
  assert.ok(nodes(busy, (node) => ['button', 'input', 'select'].includes(node.type)).every((node) => node.props.disabled))
  assert.equal(stub.calls.length, 2)
  release(response(fixture()))
  await saving
  assert.equal(button(panel.render(), '保存模型设置').props.disabled, false)
})

test('states: fallback, empty catalog, no account, conflict and error do not auto-enable candidates', () => {
  for (const data of [fixture({ region: null, catalogSource: 'none', models: [], catalogError: '请先登录账号' }),
    fixture({ catalogSource: 'fallback', conflict: '供应商注册冲突' }), fixture({ catalogSource: 'live', models: [] })]) {
    const html = renderToStaticMarkup(React.createElement(api.ModelsPanel, { initialModels: data }))
    assert.match(html, /已选 0/)
    assert.doesNotMatch(html, /value="off"/)
  }
  assert.match(renderToStaticMarkup(React.createElement(api.ModelsPanel, { initialModels: fixture({ models: [] }) })), /暂无可用模型/)
})

test('interaction: account revision aborts old request, late response cannot replace new catalog; unmount ignores writes', async (t) => {
  let oldResponse
  const stub = stubApi((url, init, count) => count === 1 ? new Promise((resolve) => { oldResponse = resolve })
    : response(fixture({ region: 'intl', models: [{ ...fixture().models[0], id: 'intl-model', name: 'Intl Model' }] })))
  const panel = mount(t, stub.fetch, { accountRevision: 0 })
  panel.render()
  panel.render({ accountRevision: 1 })
  await tick()
  assert.equal(stub.calls[0].init.signal.aborted, true)
  oldResponse(response(fixture()))
  await tick()
  assert.match(text(panel.render()), /Intl Model/)
  assert.doesNotMatch(text(panel.render()), /Model A/)
  panel.unmount()
  await tick()
  assert.equal(panel.writesAfterUnmount, 0)
})

test('interaction: unchecking one model persists; unavailable selection survives select-all/save', async (t) => {
  const stub = stubApi((url, init) => response(init.method === 'GET'
    ? fixture({ enabledModelIds: ['retired-model', 'model-a'] }) : fixture({ enabledModelIds: JSON.parse(init.body).enabledModelIds })))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  let tree = panel.render()
  input(tree, '选择 Model A').props.onChange({ target: { checked: false } })
  await button(panel.render(), '保存模型设置').props.onClick()
  assert.deepEqual(JSON.parse(stub.calls.at(-1).init.body).enabledModelIds, ['retired-model'])
  tree = panel.render()
  button(tree, '全选').props.onClick()
  await button(panel.render(), '保存模型设置').props.onClick()
  assert.deepEqual(JSON.parse(stub.calls.at(-1).init.body).enabledModelIds, ['retired-model', 'model-a', 'model-b'])
})

test('interaction: pending load and pending save abort on unmount without late state writes', async (t) => {
  let releaseLoad
  const loadStub = stubApi(() => new Promise((resolve) => { releaseLoad = resolve }))
  const loading = mount(t, loadStub.fetch)
  loading.render()
  loading.unmount()
  releaseLoad(response(fixture()))
  await tick()
  assert.equal(loadStub.calls[0].init.signal.aborted, true)
  assert.equal(loading.writesAfterUnmount, 0)

  let releaseSave
  const saveStub = stubApi((url, init) => init.method === 'GET' ? response(fixture())
    : new Promise((resolve) => { releaseSave = resolve }))
  const saving = mount(t, saveStub.fetch)
  saving.render()
  await tick()
  const pending = button(saving.render(), '保存模型设置').props.onClick()
  saving.unmount()
  releaseSave(response(fixture()))
  await pending
  assert.equal(saveStub.calls[1].init.signal.aborted, true)
  assert.equal(saving.writesAfterUnmount, 0)
})

test('interaction: failed initial GET retries; HTTP-200 catalog failure keeps draft; corrupt config disables saving', async (t) => {
  let mode = 'network'
  const stub = stubApi(() => mode === 'network' ? Promise.reject(new Error(CANARY))
    : response(mode === 'catalog' ? fixture({ catalogSource: 'cache', catalogError: '目录获取失败' })
      : mode === 'corrupt' ? fixture({ ok: false, catalogError: '模型配置损坏', models: [] }) : fixture()))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  assert.match(text(panel.render()), /模型状态读取失败/)
  assert.doesNotMatch(text(panel.render()), new RegExp(CANARY))
  mode = 'normal'
  await button(panel.render(), '刷新模型目录').props.onClick()
  let tree = panel.render()
  input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
  mode = 'catalog'
  await button(panel.render(), '刷新模型目录').props.onClick()
  tree = panel.render()
  assert.match(text(tree), /目录获取失败/)
  assert.equal(input(tree, '选择 Model A').props.checked, true)
  mode = 'corrupt'
  panel.render({ accountRevision: 1 })
  await tick()
  tree = panel.render()
  assert.equal(button(tree, '保存模型设置').props.disabled, true)
  assert.match(text(tree), /模型配置不可用/)
})

test('interaction: successful account switch invalidates catalog even if subsequent status read fails', async (t) => {
  const status = { ok: true, accounts: { enabled: true, activeId: 'src-a', sources: [] } }
  const stub = stubApi((url, init, count) => response(url.endsWith('/credentials/active') ? { ok: true, activeId: 'src-b' }
    : count === 1 ? status : { ok: false, error: 'request failed' }, count > 2 ? 503 : 200))
  const section = mount(t, stub.fetch, { initialStatus: status }, 'Section')
  section.render()
  await tick()
  const tree = section.render()
  const before = nodes(tree, (node) => node.type?.name === 'ModelsPanel')[0].props.accountRevision
  await nodes(tree, (node) => node.type?.name === 'AccountSwitcher')[0].props.onSwitch('src-b')
  assert.notEqual(nodes(section.render(), (node) => node.type?.name === 'ModelsPanel')[0].props.accountRevision, before)
})

test('interaction: account switch and status reload update the model panel revision without changing chat model', async (t) => {
  const status = { ok: true, accounts: { enabled: true, activeId: 'src-a', sources: [] } }
  const stub = stubApi((url) => response(url.endsWith('/credentials/active') ? { ok: true, activeId: 'src-b' }
    : { ...status, accounts: { ...status.accounts, activeId: 'src-b' } }))
  const section = mount(t, stub.fetch, { initialStatus: status, initialModels: fixture() }, 'Section')
  section.render()
  await tick()
  let tree = section.render()
  const before = nodes(tree, (node) => node.type === api.ModelsPanel || node.type?.name === 'ModelsPanel')[0].props.accountRevision
  const switcher = nodes(tree, (node) => node.type?.name === 'AccountSwitcher')[0]
  await switcher.props.onSwitch('src-b')
  tree = section.render()
  const after = nodes(tree, (node) => node.type?.name === 'ModelsPanel')[0].props.accountRevision
  assert.notEqual(after, before)
  assert.deepEqual(stub.calls.slice(-2).map(({ url }) => url), ['/api/dsh-workbuddy-auth/credentials/active', '/api/dsh-workbuddy-auth/status'])
})

for (const catalogSource of ['cache', 'fallback']) {
  test(`interaction: valid ${catalogSource} refresh recovers candidates after initial GET failure`, async (t) => {
    const stub = stubApi((url, init) => {
      if (init.method === 'GET') throw new Error('initial load failed')
      return response(url.endsWith('/refresh')
        ? fixture({ catalogSource, catalogError: 'catalog unavailable' })
        : fixture({ enabledModelIds: JSON.parse(init.body).enabledModelIds }))
    })
    const panel = mount(t, stub.fetch)
    panel.render()
    await tick()
    assert.equal(button(panel.render(), '保存模型设置').props.disabled, true)
    await button(panel.render(), '刷新模型目录').props.onClick()
    let tree = panel.render()
    assert.deepEqual(nodes(tree, (node) => node.props?.['data-wb-model-id']).map((node) => node.props['data-wb-model-id']), ['model-a', 'model-b'])
    assert.equal(button(tree, '保存模型设置').props.disabled, false)
    assert.match(text(tree), /catalog unavailable/)
    assert.equal(input(tree, '选择 Model A').props.checked, false)
    assert.equal(input(tree, '选择 Model B').props.checked, false)
    input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
    await button(panel.render(), '保存模型设置').props.onClick()
    tree = panel.render()
    assert.equal(input(tree, '选择 Model A').props.checked, true)
    assert.deepEqual(JSON.parse(stub.calls.at(-1).init.body).enabledModelIds, ['model-a'])
  })
}

test('interaction: valid degraded refresh replaces candidates without discarding dirty preferences', async (t) => {
  const refreshed = fixture({ catalogSource: 'cache', catalogError: 'catalog unavailable',
    models: [fixture().models[0], { ...fixture().models[1], name: 'Updated Model B' }],
  })
  const stub = stubApi((url, init) => response(init.method === 'GET'
    ? fixture({ enabledModelIds: ['retired-model'] }) : url.endsWith('/refresh') ? refreshed : fixture()))
  const panel = mount(t, stub.fetch)
  panel.render()
  await tick()
  let tree = panel.render()
  input(tree, '选择 Model A').props.onChange({ target: { checked: true } })
  input(tree, '启用 WorkBuddy 模型供应商').props.onChange({ target: { checked: false } })
  input(tree, '默认思考深度').props.onChange({ target: { value: 'high' } })
  tree = panel.render()
  input(tree, 'Model A 上下文覆盖').props.onChange({ target: { value: '64000' } })
  await button(panel.render(), '刷新模型目录').props.onClick()
  tree = panel.render()
  assert.match(text(tree), /Updated Model B/)
  assert.match(text(tree), /catalog unavailable/)
  assert.equal(input(tree, '选择 Model A').props.checked, true)
  assert.equal(input(tree, '选择 Updated Model B').props.checked, false)
  assert.equal(input(tree, '启用 WorkBuddy 模型供应商').props.checked, false)
  assert.equal(input(tree, '默认思考深度').props.value, 'high')
  assert.equal(input(tree, 'Model A 上下文覆盖').props.value, '64000')
  assert.equal(button(tree, '保存模型设置').props.disabled, false)
  await button(tree, '保存模型设置').props.onClick()
  assert.deepEqual(JSON.parse(stub.calls.at(-1).init.body), {
    enabled: false, enabledModelIds: ['retired-model', 'model-a'], defaultReasoningEffort: 'high',
    contextWindowOverrides: { 'model-a': 64000 },
  })
})

test('interaction: completed login invalidates catalog despite status failure without activating the new account', async (t) => {
  const status = { ok: true, accounts: { enabled: true, activeId: '', sources: [] } }
  const pending = { ok: true, error: '', status: 'pending', region: 'cn', authUrl: 'https://example.test/auth',
    progress: '', reason: '', detail: null, trace: [], startedAt: 1, completedAt: null,
    account: { id: '', nickname: '', phoneMasked: '', uidTail: '', sourceId: '' },
  }
  let statusReads = 0
  const stub = stubApi((url, init) => {
    if (url.endsWith('/accounts/login') && init.method === 'POST') return response(pending)
    if (url.endsWith('/accounts/login/status') && init.method === 'GET') return response({ ...pending, status: 'complete', completedAt: 2,
      account: { ...pending.account, id: 'new-account', sourceId: 'new-source' },
    })
    assert.equal(url, '/api/dsh-workbuddy-auth/status')
    return ++statusReads === 1 ? response(status) : response({ ok: false, error: 'status unavailable' }, 503)
  })
  const section = mount(t, stub.fetch, { initialStatus: status }, 'Section')
  section.render()
  await tick()
  const tree = section.render()
  const before = nodes(tree, (node) => node.type?.name === 'ModelsPanel')[0].props.accountRevision
  await nodes(tree, (node) => node.type?.name === 'LoginPanel')[0].props.onStart('cn')
  const after = section.render()
  assert.equal(nodes(after, (node) => node.type?.name === 'ModelsPanel')[0].props.accountRevision, before + 1)
  assert.equal(nodes(after, (node) => node.type?.name === 'LoginPanel')[0].props.login.status, 'complete')
  assert.equal(nodes(after, (node) => node.type?.name === 'AccountSwitcher')[0].props.accounts.activeId, '')
  assert.equal(statusReads, 2)
  assert.equal(stub.calls.some(({ url }) => url.endsWith('/credentials/active')), false)
})
