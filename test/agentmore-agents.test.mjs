import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentResolver, parseAgentBinding } from '../lib/agentmore-agents.mjs'

const agentItem = (overrides = {}) => ({
  meta_data: { type: 'agent' },
  agent_info: { id: 'ag-1', name: '通用助手' },
  ...overrides,
})
const credential = (overrides = {}) => ({ id: 'acc-1', userId: 'u-1', deviceId: 'dev-1', ...overrides })

test('直接列表：只认 meta_data.type === "agent"', () => {
  const binding = parseAgentBinding({
    result: {
      list: [
        agentItem({ agent_info: { id: 'ag-a', name: 'A' }, meta_data: { type: 'group' } }),
        agentItem({ agent_info: { id: 'ag-b', name: 'B' } }),
        null,
        'x',
      ],
    },
  })
  assert.deepEqual(binding, { id: 'ag-b', name: 'B' })
})

test('id 回退顺序 agent_info.id → relate_id → agent_id', () => {
  assert.equal(parseAgentBinding({ list: [{ meta_data: { type: 'agent' }, relate_id: 'r-1', agent_id: 'a-1' }] }).id, 'r-1')
  assert.equal(parseAgentBinding({ list: [{ meta_data: { type: 'agent' }, agent_id: 'a-1' }] }).id, 'a-1')
  // 只有空串/空白时该项被跳过
  assert.throws(
    () => parseAgentBinding({ list: [{ meta_data: { type: 'agent' }, agent_info: { id: '  ' }, relate_id: '', agent_id: '' }] }),
    { code: 'AGENTMORE_AGENT_NOT_FOUND', status: 502 },
  )
})

test('name 回退顺序 agent_info.name → title；全空时用 id 补齐', () => {
  assert.equal(parseAgentBinding({ list: [agentItem({ agent_info: { id: 'i', name: '' }, title: '标题' })] }).name, '标题')
  assert.equal(parseAgentBinding({ list: [agentItem({ agent_info: { id: 'i' } })] }).name, 'i')
})

test('选中优先级：is_default/default → 名字含「助手」或「通用」→ 第一个', () => {
  const three = {
    list: [
      agentItem({ agent_info: { id: 'a', name: '随便' } }),
      agentItem({ agent_info: { id: 'b', name: '通用助手' } }),
      agentItem({ agent_info: { id: 'c', name: '被标默认' }, is_default: true }),
    ],
  }
  assert.equal(parseAgentBinding(three).id, 'c', '默认标记最优先')

  const noDefault = {
    list: [
      agentItem({ agent_info: { id: 'a', name: '随便' } }),
      agentItem({ agent_info: { id: 'b', name: '我的通用助手' } }),
    ],
  }
  assert.equal(parseAgentBinding(noDefault).id, 'b', '名字含关键词次优先')

  const plain = { list: [agentItem({ agent_info: { id: 'x', name: '甲' } }), agentItem({ agent_info: { id: 'y', name: '乙' } })] }
  assert.equal(parseAgentBinding(plain).id, 'x', '否则取第一个')

  assert.equal(parseAgentBinding({ list: [agentItem({ agent_info: { id: 'd', name: '甲' }, default: true })] }).id, 'd')
})

test('顶层 result / data / 裸 payload 三种包装都接受', () => {
  const body = { list: [agentItem()] }
  assert.deepEqual(parseAgentBinding({ result: body }).id, 'ag-1')
  assert.deepEqual(parseAgentBinding({ data: body }).id, 'ag-1')
  assert.deepEqual(parseAgentBinding(body).id, 'ag-1')
})

test('无 list 时降级递归深扫（严格模式先下沉 group/showcase）', () => {
  const binding = parseAgentBinding({
    result: {
      list: [
        {
          meta_data: { type: 'group' },
          agents: [{ agent_info: { id: 'deep-1', name: '深扫命中' } }],
        },
      ],
    },
  })
  assert.deepEqual(binding, { id: 'deep-1', name: '深扫命中' })
})

test('严格模式失败后放开宽松模式；四个子键都试', () => {
  for (const key of ['list', 'agents', 'data', 'items']) {
    const binding = parseAgentBinding({ result: { [key]: [{ agent_id: 'k', name: '宽松命中' }] } })
    assert.deepEqual(binding, { id: 'k', name: '宽松命中' }, key)
  }
})

test('深扫同 id 去重，且跳过 name 为空的候选', () => {
  const binding = parseAgentBinding({
    items: [
      { agent_id: 'dup', name: '第一个' },
      { agent_id: 'dup', name: '重复' },
      { agent_id: 'no-name' },
    ],
  })
  assert.deepEqual(binding, { id: 'dup', name: '第一个' })
})

test('全空 payload → AGENT_NOT_FOUND', () => {
  for (const payload of [null, {}, { list: [] }, { list: [{}] }, 'x', 0, { result: { list: [] } }]) {
    assert.throws(() => parseAgentBinding(payload), { code: 'AGENTMORE_AGENT_NOT_FOUND', status: 502 }, JSON.stringify(payload))
  }
})

test('resolver：凭据里钉住的 agentId 直接用，不发请求', async () => {
  let calls = 0
  const resolver = createAgentResolver({ fetchAgents: async () => { calls += 1; return { list: [agentItem()] } } })
  assert.equal(await resolver.resolve(credential({ agentId: 'pinned-1' })), 'pinned-1')
  assert.equal(calls, 0)
})

test('resolver：首次解析后按 scope 缓存', async () => {
  let calls = 0
  const resolver = createAgentResolver({ fetchAgents: async () => { calls += 1; return { list: [agentItem()] } } })
  assert.equal(await resolver.resolve(credential()), 'ag-1')
  assert.equal(await resolver.resolve(credential()), 'ag-1')
  assert.equal(calls, 1)
})

test('resolver：不同账号 scope 各自解析', async () => {
  let calls = 0
  const resolver = createAgentResolver({
    fetchAgents: async (cred) => {
      calls += 1
      return { list: [agentItem({ agent_info: { id: `ag-${cred.userId}`, name: '同名' } })] }
    },
  })
  assert.equal(await resolver.resolve(credential({ userId: 'u-1' })), 'ag-u-1')
  assert.equal(await resolver.resolve(credential({ userId: 'u-2' })), 'ag-u-2')
  assert.equal(calls, 2)
})

test('resolver：并发首字只拉一次目录', async () => {
  let calls = 0
  const resolver = createAgentResolver({
    fetchAgents: async () => {
      calls += 1
      await new Promise((resolve) => setImmediate(resolve))
      return { list: [agentItem()] }
    },
  })
  const results = await Promise.all([resolver.resolve(credential()), resolver.resolve(credential()), resolver.resolve(credential())])
  assert.deepEqual(results, ['ag-1', 'ag-1', 'ag-1'])
  assert.equal(calls, 1)
})

test('resolver：失败后可重试（在飞标记清理干净）', async () => {
  let attempt = 0
  const resolver = createAgentResolver({
    fetchAgents: async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return { list: [agentItem()] }
    },
  })
  await assert.rejects(resolver.resolve(credential()))
  assert.equal(await resolver.resolve(credential()), 'ag-1')
})

test('resolver：选用日志文案与 APK 一致', async () => {
  const logs = []
  const resolver = createAgentResolver({ fetchAgents: async () => ({ list: [agentItem({ agent_info: { id: 'ag-1', name: '通用助手' } })] }), log: (line) => logs.push(line) })
  await resolver.resolve(credential())
  assert.deepEqual(logs, ['选用智能体：通用助手（ag-1）'])
})

test('resolver：invalidate 清指定 scope 或全部', async () => {
  let calls = 0
  const resolver = createAgentResolver({ fetchAgents: async () => { calls += 1; return { list: [agentItem()] } } })
  await resolver.resolve(credential({ userId: 'u-1' }))
  await resolver.resolve(credential({ userId: 'u-2' }))
  assert.equal(calls, 2)

  resolver.invalidate()
  await resolver.resolve(credential({ userId: 'u-1' }))
  assert.equal(calls, 3)

  const described = resolver.describe()
  assert.equal(described.length, 1)
  assert.equal(described[0].id, 'ag-1')
})

test('resolver：describe 只暴露 scope 前 12 位，不含令牌', async () => {
  const resolver = createAgentResolver({ fetchAgents: async () => ({ list: [agentItem()] }) })
  await resolver.resolve(credential({ ['accessToken']: 'SECRET-CANARY' }))
  const described = resolver.describe()
  assert.equal(described[0].scope.length, 12)
  assert.equal(JSON.stringify(described).includes('SECRET-CANARY'), false)
})
