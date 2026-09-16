// X-User-Id 动态同步：包装层把目标上游请求的 x-user-id 头改写为当前激活凭据的 uid。
//
// 背景：settings.yaml 路由 headers 里的 X-User-Id 是静态值（旧账号 uid），账号切换后
// 无法跟随。实测该头即使与 token 不配对也 200（网关不校验），但为让请求语义与当前
// 账号一致（并防上游未来收紧校验），由本插件在宿主进程内与 UA 同层改写。
// 优先级：包装层改写 > 路由 headers 静态值 > 不带头。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installUserAgentFix } from '../lib/user-agent.mjs'

const HOST = 'copilot.tencent.com'
const UA = 'dsh-workbuddy/0.1'

function makeFake(response = { ok: true, status: 200 }) {
  const calls = []
  const impl = async function fakeFetch(input, init) {
    calls.push({ input, init })
    return response
  }
  impl.calls = calls
  return impl
}

async function withFix(params, fn) {
  const saved = globalThis.fetch
  let dispose
  try {
    dispose = installUserAgentFix(params)
    return await fn(dispose)
  } finally {
    dispose?.()
    globalThis.fetch = saved
  }
}

/** 从 fake fetch 收到的 init 里读出头值（大小写不敏感）。 */
function headerOf(call, name) {
  const headers = call?.init?.headers ?? (call?.init === undefined ? call?.input?.headers : undefined)
  if (headers === undefined || headers === null) return undefined
  // Headers.get 对不存在的头返回 null；普通对象返回 undefined —— 统一成 undefined。
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return found?.[1]
}

test('提供 uidProvider 时：目标上游请求的 x-user-id 被改写为动态值', async () => {
  const fake = makeFake()
  const init = { method: 'POST', headers: { authorization: 'Bearer t', 'x-user-id': 'old-account-uid' } }
  await withFix({ fetchImpl: fake, uidProvider: () => 'new-account-uid' }, async () => {
    await globalThis.fetch(`https://${HOST}/v2/chat/completions`, init)
  })
  assert.equal(headerOf(fake.calls[0], 'x-user-id'), 'new-account-uid')
  assert.equal(headerOf(fake.calls[0], 'user-agent'), UA)
})

test('uidProvider 返回空串时：删除 x-user-id 头而不是发空值', async () => {
  const fake = makeFake()
  const init = { method: 'POST', headers: { 'x-user-id': 'stale-uid' } }
  await withFix({ fetchImpl: fake, uidProvider: () => '' }, async () => {
    await globalThis.fetch(`https://${HOST}/v2/chat/completions`, init)
  })
  assert.equal(headerOf(fake.calls[0], 'x-user-id'), undefined)
})

test('未提供 uidProvider 时：x-user-id 原样保留（纯 UA 行为不变）', async () => {
  const fake = makeFake()
  const init = { method: 'POST', headers: { 'x-user-id': 'static-uid' } }
  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(`https://${HOST}/v2/chat/completions`, init)
  })
  assert.equal(headerOf(fake.calls[0], 'x-user-id'), 'static-uid')
})

test('非目标上游的 x-user-id 绝不被改写（对象同一性透传）', async () => {
  const fake = makeFake()
  const init = { method: 'POST', headers: { 'x-user-id': 'internal-uid' } }
  await withFix({ fetchImpl: fake, uidProvider: () => 'should-not-appear' }, async () => {
    await globalThis.fetch('https://example.com/api', init)
  })
  assert.equal(fake.calls[0].init, init)
  assert.equal(headerOf(fake.calls[0], 'x-user-id'), 'internal-uid')
})

test('uidProvider 抛错时：请求照发（保留原头），不让账号切换瞬间断推理', async () => {
  const fake = makeFake()
  const init = { method: 'POST', headers: { 'x-user-id': 'fallback-uid' } }
  await withFix({ fetchImpl: fake, uidProvider: () => { throw new Error('transient') } }, async () => {
    await globalThis.fetch(`https://${HOST}/v2/chat/completions`, init)
  })
  assert.equal(headerOf(fake.calls[0], 'x-user-id'), 'fallback-uid')
})

test('Request 输入：x-user-id 同样被改写', async () => {
  const fake = makeFake()
  await withFix({ fetchImpl: fake, uidProvider: () => 'request-uid' }, async () => {
    const request = new Request(`https://${HOST}/v2/chat/completions`, {
      method: 'POST',
      headers: { 'x-user-id': 'old-uid', 'user-agent': 'deepseek-harness/x' },
      body: '{}',
    })
    await globalThis.fetch(request)
  })
  assert.equal(headerOf(fake.calls[0], 'x-user-id'), 'request-uid')
})
