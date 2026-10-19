// 余额失败文案分层测试：credits.error 的三种已分类枚举在设置卡里必须各自给出可行动提示，
// 未分类的 'unavailable' 维持原文案。复用 client-error-hint 的客户端加载方式，SSR 渲染全卡片。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadReact } from './fixtures/react-roots.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clientPath = join(pkgRoot, 'lib', 'client.js')

const { React, renderToStaticMarkup } = loadReact(pkgRoot)

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
  const status = {
    ok: true,
    account: { nickname: '测试甲', uidTail: 'aaa1', phoneMasked: '138****0001' },
    credits,
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state: { credentialReadable: true, userAgentFix: true, upstreamHost: 'copilot.tencent.com' },
  }
  const section = registered.get('workbuddy')
  assert.ok(section, 'WorkBuddy 分区必须被注册')
  return renderToStaticMarkup(React.createElement(section.component, {
    initialView: { view: 'detail', id: 'workbuddy' },
    initialStatus: status,
  }))
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
