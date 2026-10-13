// 余额失败文案分层测试：credits.error 的三种已分类枚举在设置卡里必须各自给出可行动提示，
// 未分类的 'unavailable' 维持原文案。复用 client-error-hint 的客户端加载方式，SSR 渲染全卡片。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHomeRoots } from './fixtures/react-roots.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clientPath = join(pkgRoot, 'lib', 'client.js')

function candidateRoots() {
  const roots = []
  if (process.env.DSH_SMOKE_REACT_ROOT) roots.push(process.env.DSH_SMOKE_REACT_ROOT)
  roots.push(join(pkgRoot, 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'web', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'node_modules'))
  roots.push(...dshHomeRoots())
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
    } catch { /* 换下一个本机依赖根 */ }
  }
  throw new Error('找不到可用的 react/react-dom；可用 DSH_SMOKE_REACT_ROOT 指定依赖目录')
}

const { React, renderToStaticMarkup } = loadReact()

function loadClient() {
  const loaderRegistrations = []
  const originalWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (registration) => loaderRegistrations.push(registration) } }
  try {
    new Function(readFileSync(clientPath, 'utf8'))()
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

/** 渲染母体（注册设置卡 section），返回整卡 HTML。 */
function renderCard(credits) {
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
  const status = {
    ok: true,
    account: { nickname: '测试甲', uidTail: 'aaa1', phoneMasked: '138****0001' },
    credits,
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state: { credentialReadable: true, userAgentFix: true, upstreamHost: 'copilot.tencent.com' },
  }
  return renderToStaticMarkup(React.createElement(registered.component, { initialStatus: status }))
}

test('credits auth-rejected：文案指向重新登录，而不是说「上游未提供余额」', () => {
  const html = renderCard({ ok: false, error: 'auth-rejected' })
  assert.match(html, /重新登录/)
  assert.doesNotMatch(html, /上游未提供余额/)
})

test('credits request-failed：文案指向网络/重试，而不是说「上游未提供余额」', () => {
  const html = renderCard({ ok: false, error: 'request-failed' })
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /上游未提供余额/)
})

test('credits upstream-invalid：文案说明上游报文不可解析', () => {
  const html = renderCard({ ok: false, error: 'upstream-invalid' })
  assert.match(html, /无法解析/)
  assert.doesNotMatch(html, /上游未提供余额/)
})

test('credits unavailable：维持既有文案「上游未提供余额」', () => {
  const html = renderCard({ ok: false, error: 'unavailable' })
  assert.match(html, /上游未提供余额/)
})

test('credits 缺失 error 字段：退化为「上游未提供余额」而不是崩掉', () => {
  const html = renderCard({ ok: false })
  assert.match(html, /上游未提供余额/)
})
