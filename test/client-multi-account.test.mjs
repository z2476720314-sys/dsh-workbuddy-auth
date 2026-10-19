// 设置卡多账号 UI 冒烟（离线 SSR）：账号选择器渲染与切换请求。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadReact } from './fixtures/react-roots.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clientPath = join(pkgRoot, 'lib', 'client.js')
const TOK_A = 'synthetic-access-token-must-never-render'

const { React, renderToStaticMarkup } = loadReact(pkgRoot)

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
  const registered = new Map()
  const ctx = {
    slots: {
      inject: (name, callback) => callback(),
      // 插件现在注册两个分区（workbuddy / agentmore），按 id 取才不会随注册顺序漂移。
      register: (metadata, component) => {
        registered.set(metadata.id, { metadata, component })
        return () => {}
      },
    },
  }
  clientExports.apply(ctx)
  const section = registered.get('workbuddy')
  assert.ok(section, 'WorkBuddy 分区必须被注册')
  // 单一入口之后这张座位渲染的是 SubscriptionHub（默认总览）。把组件包成
  // 「直接落在 WorkBuddy 详情页」的薄垫片，本文件所有断言都不必改动。
  const hub = section.component
  section.component = (props = {}) => React.createElement(hub, {
    initialView: { view: 'detail', id: 'workbuddy' },
    ...props,
  })
  return section
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
  const fetchImpl = stubFetch([{ match: /credentials\/sources$/, body: { ...SOURCES_FIXTURE, accessToken: TOK_A, } }]).fetchImpl
  const sources = await requestCredentialSources(fetchImpl)
  assert.equal(JSON.stringify(sources).includes(TOK_A), false)
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
  assert.doesNotMatch(html, new RegExp(TOK_A))
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

const LOGIN_ROUTE = '/api/dsh-workbuddy-auth/accounts/login'
const LOGIN_STATUS_ROUTE = '/api/dsh-workbuddy-auth/accounts/login/status'

function accountsStatus(over = {}) {
  return {
    ok: true,
    account: { nickname: '测试甲', uidTail: 'aaa1', phoneMasked: '138****0001' },
    credits: { ok: false, error: 'unavailable' },
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state: { credentialReadable: true, userAgentFix: true, upstreamHost: 'copilot.tencent.com' },
    accounts: { enabled: true, activeId: 'src-0000000000000001', sources: SOURCES_FIXTURE.sources },
    ...over,
  }
}

test('请求开始登录：POST accounts/login，body 只带 region，响应白名单且令牌不进入返回值', async () => {
  const { requestStartLogin } = clientExports.__test
  assert.equal(typeof requestStartLogin, 'function')

  const { fetchImpl, calls } = stubFetch([{
    match: /accounts\/login$/,
    method: 'POST',
    body: {
      ok: true,
      status: 'pending',
      region: 'cn',
      authUrl: 'https://copilot.tencent.com/v2/plugin/auth?state=abc',
      progress: '等待浏览器授权',
      startedAt: 1760000000000,
      accessToken: TOK_A,
      refreshToken: TOK_A,
      detail: TOK_A,
    },
  }])
  const login = await requestStartLogin('cn', fetchImpl)
  assert.equal(calls[0].url, LOGIN_ROUTE)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { region: 'cn' })
  assert.equal(login.status, 'pending')
  assert.equal(login.region, 'cn')
  assert.equal(login.authUrl, 'https://copilot.tencent.com/v2/plugin/auth?state=abc')
  assert.equal(login.progress, '等待浏览器授权')
  assert.deepEqual(Object.keys(login).sort(), ['account', 'authUrl', 'completedAt', 'detail', 'error', 'ok', 'progress', 'reason', 'region', 'startedAt', 'status', 'trace'])
  // 诊断面只认对象形状：字符串 detail（这里夹带令牌）一律降级为 null，不进 UI 数据。
  assert.equal(login.detail, null)
  assert.deepEqual(login.trace, [])
  assert.deepEqual(Object.keys(login.account).sort(), ['id', 'nickname', 'phoneMasked', 'sourceId', 'uidTail'])
  assert.equal(JSON.stringify(login).includes(TOK_A), false)
})

test('请求登录状态：GET accounts/login/status，非 https 授权链接与未知字段被丢弃', async () => {
  const { requestLoginStatus } = clientExports.__test
  assert.equal(typeof requestLoginStatus, 'function')

  const { fetchImpl, calls } = stubFetch([{
    match: /accounts\/login\/status$/,
    body: {
      ok: true,
      status: 'complete',
      region: 'intl',
      authUrl: 'javascript:alert(1)',
      progress: '已添加',
      account: { nickname: '新账号', phoneMasked: '138****0009', uidTail: 'ccc3', sourceId: 'managed:abc', accessToken: TOK_A, },
      detail: 'drop-me',
    },
  }])
  const flow = await requestLoginStatus(fetchImpl)
  assert.equal(calls[0].url, LOGIN_STATUS_ROUTE)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(flow.status, 'complete')
  assert.equal(flow.region, 'intl')
  assert.equal(flow.authUrl, '', '非 https 授权链接必须被丢弃')
  assert.equal(flow.account.sourceId, 'managed:abc')
  assert.equal(JSON.stringify(flow).includes('drop-me'), false)
  assert.equal(JSON.stringify(flow).includes(TOK_A), false)
})

test('轮询登录状态：pending→complete 逐次回调；error 立即停止；取消后不再请求', async () => {
  const { followLoginStatus } = clientExports.__test
  assert.equal(typeof followLoginStatus, 'function')
  const noWait = async () => {}

  const script = ['pending', 'pending', 'complete']
  let index = 0
  const updates = []
  const polling = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, status: script[Math.min(index++, script.length - 1)], region: 'cn' }) })
  const done = await followLoginStatus(polling, { wait: noWait, onUpdate: (flow) => updates.push(flow.status) })
  assert.deepEqual(updates, ['pending', 'pending', 'complete'])
  assert.equal(done.status, 'complete')

  let errorPolls = 0
  const failing = async () => { errorPolls += 1; return { ok: true, status: 200, json: async () => ({ ok: false, status: 'error', error: 'WORKBUDDY_LOGIN_TIMEOUT' }) } }
  const errored = await followLoginStatus(failing, { wait: noWait })
  assert.equal(errored.status, 'error')
  assert.equal(errored.error, 'WORKBUDDY_LOGIN_TIMEOUT')
  assert.equal(errorPolls, 1, 'error 状态必须立即停止轮询')

  const controller = new AbortController()
  let pendingPolls = 0
  const pending = async () => {
    pendingPolls += 1
    if (pendingPolls === 2) controller.abort()
    return { ok: true, status: 200, json: async () => ({ ok: true, status: 'pending' }) }
  }
  const cancelled = await followLoginStatus(pending, { signal: controller.signal, wait: noWait })
  assert.equal(cancelled.status, 'pending')
  assert.equal(pendingPolls, 2, '取消后不得继续轮询')

  let boundedPolls = 0
  const forever = async () => { boundedPolls += 1; return { ok: true, status: 200, json: async () => ({ ok: true, status: 'pending' }) } }
  await followLoginStatus(forever, { wait: noWait, maxPolls: 3 })
  assert.equal(boundedPolls, 3, '轮询次数必须有上界')
})

test('打开授权链接：只放行 https，其它协议一律拒绝且不触达 window.open', () => {
  const { openAuthUrl } = clientExports.__test
  assert.equal(typeof openAuthUrl, 'function')
  const opened = []
  const open = (url, target, features) => {
    opened.push({ url, target, features })
    return {}
  }

  assert.equal(openAuthUrl('https://copilot.tencent.com/v2/plugin/auth?state=abc', open), true)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].target, '_blank')
  assert.match(opened[0].features, /noopener/)
  assert.match(opened[0].features, /noreferrer/)

  assert.equal(openAuthUrl('javascript:alert(1)', open), false)
  assert.equal(openAuthUrl('http://copilot.tencent.com/x', open), false)
  assert.equal(openAuthUrl('', open), false)
  assert.equal(openAuthUrl(undefined, open), false)
  assert.equal(opened.length, 1, '被拒绝的链接不得触达 window.open')
})

test('SSR：多账号启用时渲染登录区（地区选择 + 登录按钮），未启用时不渲染', () => {
  const registered = registerSection()
  const html = renderToStaticMarkup(React.createElement(registered.component, { initialStatus: accountsStatus() }))
  assert.match(html, /添加账号/)
  assert.match(html, /data-wb-region="cn"/)
  assert.match(html, /data-wb-region="intl"/)
  assert.match(html, /开始登录/)
  assert.doesNotMatch(html, new RegExp(TOK_A))

  const disabled = renderToStaticMarkup(React.createElement(registered.component, {
    initialStatus: accountsStatus({ accounts: { enabled: false, activeId: '', sources: [] } }),
  }))
  assert.doesNotMatch(disabled, /添加账号/)
  assert.doesNotMatch(disabled, /开始登录/)
})

const CHECKIN_SETTINGS_ROUTE = '/api/dsh-workbuddy-auth/checkin/settings'
const CHECKIN_NOW_ROUTE = '/api/dsh-workbuddy-auth/checkin/now'
const CHECKIN_FIXTURE = { enabled: true, totalAccounts: 2, doneToday: 1, skippedToday: 1, failedToday: 0, lastRunAt: 1760000000000 }

test('请求签到开关：POST checkin/settings，body 只带 enabled，响应白名单且令牌不进入返回值', async () => {
  const { requestCheckinSettings } = clientExports.__test
  assert.equal(typeof requestCheckinSettings, 'function')

  const { fetchImpl, calls } = stubFetch([{
    match: /checkin\/settings$/,
    method: 'POST',
    body: { ok: true, checkin: { ...CHECKIN_FIXTURE, accessToken: TOK_A, filePath: 'C:\\synthetic-root\\x\\workbuddy-auth-checkin.json' } },
  }])
  const checkin = await requestCheckinSettings(true, fetchImpl)
  assert.equal(calls[0].url, CHECKIN_SETTINGS_ROUTE)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { enabled: true })
  assert.deepEqual(checkin, CHECKIN_FIXTURE)
  assert.equal(JSON.stringify(checkin).includes(TOK_A), false)

  const off = stubFetch([{ match: /checkin\/settings$/, method: 'POST', body: { ok: true, checkin: { ...CHECKIN_FIXTURE, enabled: false } } }])
  await requestCheckinSettings(false, off.fetchImpl)
  assert.deepEqual(JSON.parse(off.calls[0].init.body), { enabled: false }, '非 true 的取值必须显式归一成 false')
})

test('请求立即签到：POST checkin/now，返回白名单摘要', async () => {
  const { requestCheckinNow } = clientExports.__test
  assert.equal(typeof requestCheckinNow, 'function')

  const { fetchImpl, calls } = stubFetch([{
    match: /checkin\/now$/,
    method: 'POST',
    body: { ok: true, checkin: { ...CHECKIN_FIXTURE, doneToday: 2, skippedToday: 0, detail: 'drop-me' } },
  }])
  const checkin = await requestCheckinNow(fetchImpl)
  assert.equal(calls[0].url, CHECKIN_NOW_ROUTE)
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(checkin, { ...CHECKIN_FIXTURE, doneToday: 2, skippedToday: 0 })
  assert.equal(JSON.stringify(checkin).includes('drop-me'), false)
})

test('normalizeCheckin：脏输入只留六个白名单键，计数取整且非负', () => {
  const { normalizeCheckin } = clientExports.__test
  assert.equal(typeof normalizeCheckin, 'function')
  assert.deepEqual(normalizeCheckin(undefined), { enabled: false, totalAccounts: 0, doneToday: 0, skippedToday: 0, failedToday: 0, lastRunAt: 0 })
  assert.deepEqual(
    normalizeCheckin({ enabled: 'yes', totalAccounts: 2.7, doneToday: -1, skippedToday: 'x', failedToday: 3, lastRunAt: 1, accessToken: TOK_A, outcomes: [] }),
    { enabled: false, totalAccounts: 2, doneToday: 0, skippedToday: 0, failedToday: 3, lastRunAt: 1 },
    'enabled 必须是严格 true；计数必须是非负整数',
  )
})

test('SSR：签到区渲染自动开关与手动按钮，并显示当日计数', () => {
  const registered = registerSection()
  const html = renderToStaticMarkup(React.createElement(registered.component, { initialStatus: accountsStatus({ checkin: CHECKIN_FIXTURE }) }))
  assert.match(html, /自动签到/)
  assert.match(html, /data-wb-checkin-toggle="on"/)
  assert.match(html, /立即签到/)
  assert.match(html, /成功 1/)
  assert.match(html, /跳过 1/)
  assert.doesNotMatch(html, new RegExp(TOK_A))

  const off = renderToStaticMarkup(React.createElement(registered.component, {
    initialStatus: accountsStatus({ checkin: { ...CHECKIN_FIXTURE, enabled: false } }),
  }))
  assert.match(off, /data-wb-checkin-toggle="off"/)
})

test('SSR：多账号关闭时不渲染签到区（签到依赖账号目录，路由也会降级）', () => {
  const registered = registerSection()
  const html = renderToStaticMarkup(React.createElement(registered.component, {
    initialStatus: accountsStatus({ accounts: { enabled: false, activeId: '', sources: [] }, checkin: CHECKIN_FIXTURE }),
  }))
  assert.doesNotMatch(html, /自动签到/)
  assert.doesNotMatch(html, /立即签到/)
})

test('SSR：签到进行中显示忙碌态且按钮禁用，不渲染原始错误', () => {
  const registered = registerSection()
  const html = renderToStaticMarkup(React.createElement(registered.component, {
    initialStatus: accountsStatus({ checkin: CHECKIN_FIXTURE }),
    initialCheckinBusy: 'manual',
  }))
  assert.match(html, /签到进行中/)
  assert.match(html, /disabled/)
})

test('SSR：登录中/成功/失败三态只渲染白名单字段，且不渲染令牌或本地路径', () => {
  const registered = registerSection()

  const pending = renderToStaticMarkup(React.createElement(registered.component, {
    initialStatus: accountsStatus(),
    initialLogin: { ok: true, status: 'pending', region: 'intl', progress: '等待浏览器授权', authUrl: 'https://www.workbuddy.ai/v2/plugin/auth?state=abc' },
  }))
  assert.match(pending, /等待浏览器授权/)
  assert.match(pending, /打开授权页面/)

  const complete = renderToStaticMarkup(React.createElement(registered.component, {
    initialStatus: accountsStatus(),
    initialLogin: { ok: true, status: 'complete', region: 'intl', account: { nickname: '新账号', phoneMasked: '138****0009', uidTail: 'ccc3', sourceId: 'managed:abc' } },
  }))
  assert.match(complete, /新账号/)
  assert.match(complete, /138\*\*\*\*0009/)
  assert.match(complete, /已添加/)

  const failed = renderToStaticMarkup(React.createElement(registered.component, {
    initialStatus: accountsStatus(),
    initialLogin: { ok: false, status: 'error', region: 'cn', error: 'WORKBUDDY_LOGIN_TIMEOUT' },
  }))
  assert.match(failed, /WORKBUDDY_LOGIN_TIMEOUT/)

  const combined = pending + complete + failed
  assert.doesNotMatch(combined, new RegExp(TOK_A))
  assert.doesNotMatch(combined, /C:\\private|Tencent-Cloud\.coding-copilot\.info/)
})
