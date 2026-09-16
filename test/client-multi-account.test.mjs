// 设置卡多账号 UI 冒烟（离线 SSR）：账号选择器渲染与切换请求。
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clientPath = join(pkgRoot, 'lib', 'client.js')
const ACCESS_TOKEN = 'synthetic-access-token-must-never-render'

function candidateRoots() {
  const roots = []
  if (process.env.DSH_SMOKE_REACT_ROOT) roots.push(process.env.DSH_SMOKE_REACT_ROOT)
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'web', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'node_modules'))
  return roots
}

function loadReact() {
  for (const root of candidateRoots()) {
    try {
      const require = createRequire(join(root, 'resolve-baseline.cjs'))
      return { React: require('react'), renderToStaticMarkup: require('react-dom/server').renderToStaticMarkup }
    } catch { /* next root */ }
  }
  throw new Error('找不到可用的 react/react-dom；可用 DSH_SMOKE_REACT_ROOT 指定依赖目录')
}

const { React, renderToStaticMarkup } = loadReact()

function loadClient() {
  assert.ok(existsSync(clientPath), 'lib/client.js 必须存在')
  const loaderRegistrations = []
  const originalWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (registration) => loaderRegistrations.push(registration) } }
  try {
    const source = readFileSync(clientPath, 'utf8')
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
  assert.equal(loaderRegistrations.length, 1)
  const registration = loaderRegistrations[0]
  return registration.factory((specifier) => {
    assert.equal(specifier, 'react', `unexpected require(${specifier})`)
    return React
  })
}

const clientExports = loadClient()

function registerSection() {
  let registered = null
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (metadata, component) => {
        registered = { metadata, component }
        return () => {}
      },
    },
  }
  clientExports.apply(ctx)
  return registered
}

/** 账号选择器的离线数据夹具：全部明显虚构。 */
const SOURCES_FIXTURE = {
  ok: true,
  activeId: 'src-0000000000000001',
  sources: [
    { id: 'src-0000000000000001', label: { nickname: '测试甲', uidTail: 'aaa1', phoneMasked: '138****0001' }, accessExpiresAt: 1800000000000 },
    { id: 'src-0000000000000002', label: { nickname: '测试乙', uidTail: 'bbb2', phoneMasked: '139****0002' }, accessExpiresAt: 1800000000000 },
  ],
}

function stubFetch(responses) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const respond = responses.find((r) => r.match.test(url) && (r.method === undefined || r.method === init?.method))
    if (respond === undefined) throw new Error(`unexpected fetch: ${url}`)
    return {
      ok: true,
      status: 200,
      json: async () => (typeof respond.body === 'function' ? respond.body(calls.length) : respond.body),
    }
  }
  return { fetchImpl, calls }
}

test('请求账号列表走 GET credentials/sources，切换走 POST credentials/active', async () => {
  const { requestCredentialSources, requestActivateCredentialSource } = clientExports.__test
  assert.equal(typeof requestCredentialSources, 'function')
  assert.equal(typeof requestActivateCredentialSource, 'function')

  const sourcesFetch = stubFetch([{ match: /credentials\/sources$/, body: SOURCES_FIXTURE }])
  const sources = await requestCredentialSources(sourcesFetch.fetchImpl)
  assert.equal(sources.activeId, 'src-0000000000000001')
  assert.equal(sources.sources.length, 2)
  assert.equal(sourcesFetch.calls[0].init.method, 'GET')

  const activateFetch = stubFetch([{ match: /credentials\/active$/, method: 'POST', body: { ok: true, activeId: 'src-0000000000000002', persisted: true } }])
  const result = await requestActivateCredentialSource('src-0000000000000002', activateFetch.fetchImpl)
  assert.equal(result.ok, true)
  assert.equal(result.activeId, 'src-0000000000000002')
  assert.equal(activateFetch.calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(activateFetch.calls[0].init.body), { id: 'src-0000000000000002' })
})

test('请求边界白名单：账号列表响应中的令牌不进入返回值', async () => {
  const { requestCredentialSources } = clientExports.__test
  const fetchImpl = stubFetch([{ match: /credentials\/sources$/, body: { ...SOURCES_FIXTURE, accessToken: ACCESS_TOKEN } }]).fetchImpl
  const sources = await requestCredentialSources(fetchImpl)
  assert.equal(JSON.stringify(sources).includes(ACCESS_TOKEN), false)
})

test('SSR：多账号启用时渲染账号切换按钮且当前账号高亮禁用', async () => {
  const registered = registerSection()
  const status = {
    ok: true,
    account: { nickname: '测试甲', uidTail: 'aaa1', phoneMasked: '138****0001' },
    credits: { ok: false, error: 'unavailable' },
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state: { credentialReadable: true, userAgentFix: true, upstreamHost: 'copilot.tencent.com' },
    accounts: { enabled: true, activeId: 'src-0000000000000001', sources: SOURCES_FIXTURE.sources },
  }
  const html = renderToStaticMarkup(React.createElement(registered.component, { initialStatus: status }))
  assert.match(html, /切换账号/)
  assert.match(html, /测试甲/)
  assert.match(html, /测试乙/)
  assert.match(html, /data-wb-active="true"/)
  assert.doesNotMatch(html, new RegExp(ACCESS_TOKEN))
})

test('SSR：未启用多账号（accounts 缺失）时不渲染切换区', () => {
  const registered = registerSection()
  const status = {
    ok: true,
    account: { nickname: '测试甲', uidTail: 'aaa1', phoneMasked: '' },
    credits: { ok: false, error: 'unavailable' },
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state: { credentialReadable: true, userAgentFix: true, upstreamHost: 'copilot.tencent.com' },
  }
  const html = renderToStaticMarkup(React.createElement(registered.component, { initialStatus: status }))
  assert.doesNotMatch(html, /切换账号/)
})
