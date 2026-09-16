// installUserAgentFix 的纯函数测试 —— 关键性质全部由「注入假 fetch」验证，零真实网络请求。
//
// 为什么这层包装必须存在（缺陷实证）：
//   WorkBuddy 推理网关按 User-Agent 做安全策略拦截。真实请求隔离实验显示
//   请求体 + 任意其它 UA（含不显式带 UA）→ 200；只有 DSH 自己的
//   `deepseek-harness/0.1.5-rc.1 (+https://github.com/deepseek-ai/deepseek-harness)`
//   → 400 {"code":11128,"msg":"request illegal"}。该 UA 由 @deepseek-ai/dsh-llm 的
//   attributionHeaders() 生成，适配器 dsh-llm-pi-ai 用 headers.set(...) **无条件覆盖**，
//   路由配置里的 headers 改不动它，配置层够不着 → 唯一可干预点就是宿主进程内的本插件。
//
// 测试策略：
//   * 一律注入假 fetch 作为被包装的实现，globalThis.fetch 上装的是我们那层；
//   * 每个用例结束（含失败）都必须把 globalThis.fetch 复原 —— 只在 finally 里调用
//     dispose / 恢复，绝不在恢复到真实 fetch 之后再发任何请求，因此不会触网；
//   * 反向断言（非目标域名零改动）用**对象同一性**钉住：init / Request 必须是同一个引用被透传，
//     一旦实现改成「复制一份再转发」或「顺手统一 header 形态」，该用例立刻失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installUserAgentFix, DEFAULT_UPSTREAM_HOST, DEFAULT_UPSTREAM_USER_AGENT } from '../lib/user-agent.mjs'

const HOST = DEFAULT_UPSTREAM_HOST
const UA = DEFAULT_UPSTREAM_USER_AGENT

/** 计数型假 fetch：记录输入（含实参个数），绝不发真实请求。 */
function makeFake(response = { ok: true, status: 200 }) {
  const calls = []
  const impl = async function fakeFetch(input, init) {
    calls.push({ input, init, argc: arguments.length })
    return response
  }
  impl.calls = calls
  return impl
}

/**
 * 安装修复并在用例结束后无条件复原 globalThis.fetch。
 * fn 收到的 dispose 由用例自行调用（用于验证 disposer 语义）；finally 只是兜底。
 */
async function withFix(params, fn) {
  const saved = globalThis.fetch
  let dispose
  try {
    dispose = installUserAgentFix(params)
    return await fn(dispose)
  } finally {
    dispose?.() // 幂等：已经 dispose 过或当前已不是我们那层时是 no-op
    globalThis.fetch = saved
  }
}

test('导出默认值：上游域名与替代 UA', () => {
  assert.equal(HOST, 'copilot.tencent.com')
  assert.equal(UA, 'dsh-workbuddy/0.1')
})

test('目标域名请求的 user-agent 被改写，其余头与 init 字段保持不变', async () => {
  const fake = makeFake()
  const init = { method: 'POST', headers: { authorization: 'Bearer test', 'user-agent': 'deepseek-harness/0.1.5-rc.1', 'content-type': 'application/json' } }

  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(`https://${HOST}/v1/chat/completions`, init)

    assert.equal(fake.calls.length, 1)
    const sent = fake.calls[0].init
    const headers = new Headers(sent.headers)
    assert.equal(headers.get('user-agent'), UA, '目标域名的 UA 必须被改写成 dsh-workbuddy/0.1')
    assert.equal(headers.get('authorization'), 'Bearer test', '其它请求头不得丢失')
    assert.equal(headers.get('content-type'), 'application/json')
    assert.equal(sent.method, 'POST', 'method 等字段必须保留')
    assert.notEqual(sent, init, '不得就地改写调用方传入的 init')
    assert.equal(init.headers['user-agent'], 'deepseek-harness/0.1.5-rc.1', '调用方的对象必须保持原样')
  })
})

test('反向断言：非目标域名请求零改动（init / Request 原样透传，UA 不被改写）', async () => {
  const fake = makeFake()
  const url = 'https://api.deepseek.com/v1/chat/completions'
  const init = { method: 'POST', headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.1', authorization: 'Bearer test' } }
  const req = new Request(url, { method: 'POST', headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.1' } })

  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(url, init)
    await globalThis.fetch(url)
    await globalThis.fetch(req)

    assert.equal(fake.calls.length, 3)
    assert.equal(fake.calls[0].input, url)
    assert.equal(fake.calls[0].init, init, 'init 必须是同一个对象引用（未被复制 / 重建）')
    assert.equal(fake.calls[0].argc, 2)
    assert.equal(fake.calls[1].input, url)
    assert.equal(fake.calls[1].init, undefined)
    assert.equal(fake.calls[1].argc, 1, '单参调用必须仍以单参转发')
    assert.equal(fake.calls[2].input, req, 'Request 对象必须原样透传')
    assert.equal(fake.calls[2].argc, 1)
    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), 'deepseek-harness/0.1.5-rc.1', '非目标域名不得改写 UA')
    assert.equal(req.headers.get('user-agent'), 'deepseek-harness/0.1.5-rc.1', 'Request 不得被就地改写')
  })
})

test('目标 host 只按解析后的 hostname 精确匹配，不受无关 URL 的 path/query 欺骗', async () => {
  const fake = makeFake()
  const spoofed = `https://example.invalid/redirect?target=https://${HOST}/v1/models`
  const init = { headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.1' } }

  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(spoofed, init)

    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].input, spoofed)
    assert.equal(fake.calls[0].init, init, 'hostname 不匹配时必须原样透传')
    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), 'deepseek-harness/0.1.5-rc.1')
  })
})

test('目标 host 不被后缀域名命中（copilot.tencent.com.evil 必须原样透传）', async () => {
  const fake = makeFake()
  const evil = `https://${HOST}.evil/v1/chat/completions`
  const init = { headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.1' } }

  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(evil, init)

    assert.equal(fake.calls.length, 1)
    assert.equal(fake.calls[0].init, init, '子串匹配会把 copilot.tencent.com.evil 误判成目标上游')
    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), 'deepseek-harness/0.1.5-rc.1')
  })
})

test('目标 host 带端口/大小写时仍按 hostname 命中（端口的 hostname 相等）', async () => {
  const fake = makeFake()

  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(`https://${HOST}:443/v1/models`, { headers: {} })
    await globalThis.fetch(`https://${HOST.toUpperCase()}/v1/models`, { headers: {} })

    assert.equal(fake.calls.length, 2)
    for (const call of fake.calls) {
      assert.equal(new Headers(call.init.headers).get('user-agent'), UA)
    }
  })
})

test('disposer 复原原 fetch；复原后不再经过我们那层', async () => {
  const fake = makeFake()
  const saved = globalThis.fetch
  const dispose = installUserAgentFix({ fetchImpl: fake })
  const wrapper = globalThis.fetch

  try {
    assert.notEqual(wrapper, saved, '安装后 globalThis.fetch 应指向包装层')
    assert.equal(dispose.installed, true)
    assert.equal(dispose.reason, 'installed')

    await globalThis.fetch(`https://${HOST}/v1/models`, { headers: {} })
    assert.equal(fake.calls.length, 1)

    dispose()
    assert.equal(globalThis.fetch, saved, 'dispose 必须恢复安装前的 fetch')
    assert.equal(fake.calls.length, 1, '复原后不得再触发被包装的实现')

    dispose() // 幂等：重复调用不得抛错，也不得改变现状
    assert.equal(globalThis.fetch, saved)
  } finally {
    globalThis.fetch = saved
  }
})

test('幂等：重复安装不叠加包装层，第二次的 host/UA 参数不生效', async () => {
  const fake = makeFake()

  await withFix({ fetchImpl: fake }, async (dispose) => {
    const first = globalThis.fetch
    const second = installUserAgentFix({ fetchImpl: fake, host: 'other.example', userAgent: 'other/9' })

    assert.equal(globalThis.fetch, first, '重复安装必须复用已装的那层，而不是再包一层')
    assert.equal(second.installed, false)
    assert.equal(second.reason, 'already-installed')

    // 第二次返回的 disposer 是 no-op：卸载第二个挂载点不得掀掉第一个挂载点仍在用的那层。
    second()
    assert.equal(globalThis.fetch, first)

    await globalThis.fetch(`https://${HOST}/v1/chat/completions`, { headers: {} })
    assert.equal(fake.calls.length, 1, '一次调用只能穿过一层包装（叠加会重复调用被包装实现）')
    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), UA, '第二次安装的参数不得改写已有那层')

    dispose()
    assert.notEqual(globalThis.fetch, first, '第一个挂载点的 disposer 仍能正常复原')
  })
})

test('fetch(url) 单参形式与 Request 对象形式都被覆盖', async () => {
  const fake = makeFake()

  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(`https://${HOST}/v1/chat/completions`)

    assert.equal(fake.calls.length, 1)
    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), UA, '单参也必须补上 UA')

    const req = new Request(`https://${HOST}/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer test' } })
    await globalThis.fetch(req)

    assert.equal(fake.calls.length, 2)
    const sent = fake.calls[1].input
    assert.ok(sent instanceof Request, 'Request 输入必须仍以 Request 转发')
    assert.equal(sent.headers.get('user-agent'), UA, 'Request 形式必须被改写')
    assert.equal(sent.headers.get('authorization'), 'Bearer test', 'Request 原有头必须保留')
    assert.equal(sent.url, `https://${HOST}/v1/messages`)
    assert.equal(sent.method, 'POST')
    assert.equal(req.headers.get('user-agent'), null, '原 Request 不得被就地改写')
  })
})

test('input 为 URL 对象、init.headers 为 Headers / 数组 / 普通对象时都应改写', async () => {
  const fake = makeFake()

  await withFix({ fetchImpl: fake }, async () => {
    await globalThis.fetch(new URL(`https://${HOST}/v1/models`), { headers: new Headers({ 'user-agent': 'x' }) })
    await globalThis.fetch(`https://${HOST}/v1/models`, { headers: [['user-agent', 'x'], ['accept', 'application/json']] })
    await globalThis.fetch(`https://${HOST}/v1/models`, { headers: { 'user-agent': 'x' } })

    assert.equal(fake.calls.length, 3)
    for (const call of fake.calls) {
      assert.equal(new Headers(call.init.headers).get('user-agent'), UA)
    }
    assert.equal(new Headers(fake.calls[1].init.headers).get('accept'), 'application/json')
  })
})

test('自定义 host / userAgent 生效，且只影响包含该 host 的请求', async () => {
  const fake = makeFake()

  await withFix({ host: 'upstream.example', userAgent: 'custom/9', fetchImpl: fake }, async () => {
    await globalThis.fetch('https://upstream.example/v1/chat/completions', { headers: {} })
    await globalThis.fetch(`https://${HOST}/v1/chat/completions`, { headers: {} })

    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), 'custom/9')
    assert.equal(new Headers(fake.calls[1].init.headers).get('user-agent'), null, '默认域名不在本次自定义范围内，必须原样透传')
  })
})

test('fetchImpl 不可用时安全跳过：不改动 globalThis.fetch，返回 no-op disposer', async () => {
  const saved = globalThis.fetch

  try {
    const skipped = installUserAgentFix({ fetchImpl: 42, host: HOST })
    assert.equal(typeof skipped, 'function')
    assert.equal(skipped.installed, false)
    assert.equal(skipped.reason, 'fetch-unavailable')
    assert.equal(globalThis.fetch, saved, '无可用 fetch 时不得改动 globalThis.fetch')

    skipped() // 幂等：重复调用不得抛错
    assert.equal(globalThis.fetch, saved)
  } finally {
    globalThis.fetch = saved
  }
})

test('disposer 只复原属于自己那层：别人后装的 fetch 不被覆盖', async () => {
  const fake = makeFake()

  await withFix({ fetchImpl: fake }, async (dispose) => {
    const theirs = async () => ({ ok: true, status: 204 })
    globalThis.fetch = theirs

    dispose()
    assert.equal(globalThis.fetch, theirs, '当前装的不是我们那层时，disposer 必须保持沉默')

    dispose()
    assert.equal(globalThis.fetch, theirs)
  })
})
