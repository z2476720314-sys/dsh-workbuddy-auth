// 登录失败反馈：设置卡要说清「下一步做什么 + 哪一步 / 哪台上游 / 什么时候」，
// 而不是只甩一个 WORKBUDDY_LOGIN_POLL_FAILED。诊断字段一律脱敏（令牌 / state / 路径不进 UI）。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHomeRoots } from './fixtures/react-roots.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'

// 前端（经典脚本）不能 import 诊断规则模块，只能保留一份副本；
// 这组导入就是为了把两份副本逐项对比，漂移即测试失败。
import {
  DISPLAY_DIAGNOSTIC_FIELDS,
  DISPLAY_DOMAINS,
  DISPLAY_ERROR_NAMES,
  DISPLAY_HTTP_STATUS_MAX,
  DISPLAY_HTTP_STATUS_MIN,
  DISPLAY_REASONS,
  DISPLAY_STEPS,
  DISPLAY_TRACE_LIMIT,
  DISPLAY_UPSTREAM_CODES,
} from '../lib/diagnostic-display.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const clientPath = join(pkgRoot, 'lib', 'client.js')
const TOKEN = 'synthetic-access-token-must-never-render'
const STATE = 'state-4f8c-must-never-render'

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
  return loaderRegistrations[0].factory(() => React)
}

const clientExports = loadClient()

function baseStatus() {
  return {
    ok: false,
    account: { nickname: '', uidTail: '58a7', phoneMasked: '' },
    credits: { ok: false, error: 'unavailable' },
    token: { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 },
    state: { credentialReadable: true, credentialEncrypted: false, upstreamHost: 'copilot.tencent.com' },
    accounts: { enabled: true, activeId: '', sources: [] },
  }
}

function renderLogin(login) {
  const { Section } = clientExports.__test
  return renderToStaticMarkup(React.createElement(Section, { initialStatus: baseStatus(), initialLogin: login }))
}

test('SSR：失败态给出可行动文案 + 阶段/上游/HTTP 状态/时间', () => {
  const html = renderLogin({
    ok: false,
    status: 'error',
    region: 'cn',
    error: 'WORKBUDDY_LOGIN_POLL_FAILED',
    progress: '轮询授权结果时上游返回 HTTP 503。',
    detail: { step: 'token', reason: 'http', host: 'copilot.tencent.com', httpStatus: 503, at: 1791900000000 },
    trace: [
      { step: 'token', reason: 'http', host: 'copilot.tencent.com', httpStatus: 503, at: 1791900000000 },
    ],
  })
  assert.match(html, /登录失败：WORKBUDDY_LOGIN_POLL_FAILED/)
  assert.match(html, /轮询授权结果时上游返回 HTTP 503。/)
  assert.match(html, /轮询授权结果/)
  assert.match(html, /copilot\.tencent\.com/)
  assert.match(html, /HTTP 503/)
})

test('SSR：只有错误码时退化为默认建议，不渲染空括号', () => {
  const html = renderLogin({ ok: false, status: 'error', error: 'WORKBUDDY_LOGIN_POLL_FAILED' })
  assert.match(html, /登录失败：WORKBUDDY_LOGIN_POLL_FAILED/)
  assert.match(html, /请重新登录/)
  assert.doesNotMatch(html, /（）/)
})

test('脱敏：令牌、state 与本地路径即使夹带在诊断里也不得渲染', () => {
  const html = renderLogin({
    ok: false,
    status: 'error',
    error: 'WORKBUDDY_LOGIN_POLL_FAILED',
    progress: '无法连接上游，请检查网络或代理后重试。',
    reason: 'network',
    detail: {
      step: 'token',
      reason: 'network',
      host: 'copilot.tencent.com',
      error: 'Error',
      at: 1791900000000,
      accessToken: TOKEN,
      state: STATE,
      file: 'secret-tokens.json',
    },
    trace: [
      { step: 'token', reason: 'network', accessToken: TOKEN, state: STATE, at: 1791900000000 },
      'not-an-object',
    ],
  })
  assert.doesNotMatch(html, new RegExp(TOKEN))
  assert.doesNotMatch(html, new RegExp(STATE))
  assert.doesNotMatch(html, /secret-tokens/)
  assert.match(html, /无法连接上游/)
})

test('脱敏（复审 2026-10-13）：未知域 / 数字错误名 / 数字串业务码都不得渲染成事实', () => {
  // 两条渲染路径都要走：loginFailureWhere 优先取最后一条 trace，trace 为空时才退化为 detail。
  // 只喂 detail 而带着 trace，脏值根本到不了 DOM——那个用例会假绿（逆实验 M4 已实证）。
  const dirtyDetail = {
    step: 'TOKENCANARY',
    reason: 'http',
    host: 'TOKENCANARY.example',
    domain: 'p13800138000.example',
    httpStatus: '13800138000',
    code: 13800138000,
    error: 13800138000,
    at: 1791900000000,
  }
  const dirtyTrace = {
    step: 'TOKENCANARY',
    reason: 'http',
    host: 'TOKENCANARY.example',
    httpStatus: '13800138000',
    code: '13800138000',
    error: '13800138000',
    at: 1791900000000,
  }
  const legalTrace = { step: 'token', reason: 'http', host: 'copilot.tencent.com', httpStatus: 503, at: 1791900000000 }
  const dirty = (marker) => (html) => {
    assert.doesNotMatch(html, /13800138000/, `${marker}：手机号不得渲染`)
    assert.doesNotMatch(html, /TOKENCANARY/, `${marker}：无点标识符不得渲染`)
    assert.doesNotMatch(html, /p13800138000/, `${marker}：假域不得渲染`)
  }

  // A. trace 为空 → 渲染路径落在 detail 上
  const detailPath = renderLogin({
    ok: false,
    status: 'error',
    error: 'WORKBUDDY_LOGIN_POLL_FAILED',
    progress: '登录失败。',
    reason: 'http',
    detail: dirtyDetail,
    trace: [],
  })
  dirty('detail 路径')(detailPath)

  // B. 最后一条 trace 就是脏值 → 必须被丢掉（前面的合法条目不受影响）
  const tracePath = renderLogin({
    ok: false,
    status: 'error',
    error: 'WORKBUDDY_LOGIN_POLL_FAILED',
    progress: '登录失败。',
    reason: 'http',
    detail: dirtyDetail,
    trace: [legalTrace, dirtyTrace],
  })
  dirty('trace 路径')(tracePath)
  assert.doesNotMatch(tracePath, /HTTP 13800138000/)

  // C. 合法值照旧渲染：已知 host + 三位状态码 + 阶段名
  const legal = renderLogin({
    ok: false,
    status: 'error',
    error: 'WORKBUDDY_LOGIN_POLL_FAILED',
    progress: '登录失败。',
    reason: 'http',
    detail: legalTrace,
    trace: [legalTrace],
  })
  assert.match(legal, /copilot\.tencent\.com/)
  assert.match(legal, /HTTP 503/)
  assert.match(legal, /轮询授权结果/)
})

test('三层规则同源：前端诊断白名单与 lib/diagnostic-display.mjs 完全一致', () => {
  const rules = clientExports.__test.displayRules
  assert.ok(rules, '前端必须暴露自己那份规则的取值集合（供跨层一致性对比）')
  assert.deepEqual([...rules.domains].sort(), [...DISPLAY_DOMAINS].sort())
  assert.deepEqual([...rules.steps].sort(), [...DISPLAY_STEPS].sort())
  assert.deepEqual([...rules.errorNames].sort(), [...DISPLAY_ERROR_NAMES].sort())
  assert.deepEqual([...rules.codes].sort(), [...DISPLAY_UPSTREAM_CODES].sort())
  assert.deepEqual([...rules.reasons].sort(), [...DISPLAY_REASONS].sort())
  assert.deepEqual([...rules.fields].sort(), [...DISPLAY_DIAGNOSTIC_FIELDS].sort())
  assert.equal(rules.httpStatusMin, DISPLAY_HTTP_STATUS_MIN)
  assert.equal(rules.httpStatusMax, DISPLAY_HTTP_STATUS_MAX)
  assert.equal(rules.traceLimit, DISPLAY_TRACE_LIMIT)
})
