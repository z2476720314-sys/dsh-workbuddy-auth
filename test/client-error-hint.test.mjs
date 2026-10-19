// RED：设置卡错误提示必须优先显示服务端给的 hint（可行动），而不是把 `HTTP 500：HTTP 401`
// 这种只有状态码的行甩给用户。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadReact } from './fixtures/react-roots.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clientPath = join(pkgRoot, 'lib', 'client.js')
const TOKEN = 'synthetic-access-token-must-never-render'

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
  return loaderRegistrations[0].factory(() => React)
}

const clientExports = loadClient()

function responding(body, status) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
}

function baseStatus(state) {
  return {
    ok: false,
    account: { nickname: '', uidTail: '58a7', phoneMasked: '' },
    credits: { ok: false, error: 'unavailable' },
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state,
    accounts: { enabled: false, activeId: '', sources: [] },
  }
}

test('服务端给了 hint：错误消息就是 hint（不再以 HTTP 500 开头）', async () => {
  const { requestAction } = clientExports.__test
  const fetchImpl = responding({ ok: false, error: 'HTTP 401', hint: '当前账号登录态已失效。请切换账号，或运行 codebuddy 重新登录。' }, 500)
  await assert.rejects(
    () => requestAction('refresh', fetchImpl),
    (error) => {
      assert.match(error.message, /登录态已失效/)
      assert.doesNotMatch(error.message, /^HTTP 500/, '有 hint 时不该再拿状态码当正文')
      return true
    },
  )
})

test('没有 hint 时保持既有契约：HTTP <状态码>：<错误码>', async () => {
  const { requestAction } = clientExports.__test
  const fetchImpl = responding({ ok: false, error: 'HTTP 401' }, 500)
  // assert.rejects 传 RegExp 时是对 String(error)（含 'Error: ' 前缀）匹配，锚点会失配；
  // 用函数式断言拿到 error.message 本体。
  await assert.rejects(
    () => requestAction('refresh', fetchImpl),
    (error) => {
      assert.equal(error.message, 'HTTP 500：HTTP 401')
      return true
    },
  )
})

test('hint 里夹带的令牌不会进入错误消息（白名单化必须对 hint 同样生效）', async () => {
  const { requestAction } = clientExports.__test
  const fetchImpl = responding({ ok: false, error: 'request failed', hint: `坏消息 ${TOKEN}` }, 500)
  const message = await requestAction('refresh', fetchImpl).then(() => '', (error) => error.message)
  assert.equal(message.includes(TOKEN), false)
})

test('SSR：status.state.credentialHint 渲染给用户，加密标记如实展示', async () => {
  const { Section } = clientExports.__test
  const html = renderToStaticMarkup(React.createElement(Section, {
    initialStatus: baseStatus({
      credentialReadable: false,
      userAgentFix: true,
      upstreamHost: 'copilot.tencent.com',
      credentialEncrypted: true,
      credentialHint: '凭据已被 WorkBuddy 桌面端加密，DSH 读不到明文令牌。',
    }),
  }))
  assert.match(html, /WorkBuddy 桌面端加密/)
  assert.match(html, /已加密/)
})

test('normalizeStatus 白名单保留 credentialEncrypted 与 credentialHint', () => {
  const { normalizeStatus } = clientExports.__test
  const normalized = normalizeStatus(baseStatus({
    credentialReadable: false,
    userAgentFix: false,
    upstreamHost: 'copilot.tencent.com',
    credentialEncrypted: true,
    credentialHint: 'hint 文本',
  }))
  assert.equal(normalized.state.credentialEncrypted, true)
  assert.equal(normalized.state.credentialHint, 'hint 文本')
})
