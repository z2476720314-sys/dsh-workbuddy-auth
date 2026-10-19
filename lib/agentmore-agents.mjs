/**
 * 智能体（agent）绑定解析。
 *
 * `/chatglm/agent-api/stream` 的请求体里 `agent_id` 是**必填**：上游用它决定
 * 这次对话挂在哪个智能体下（不同智能体有不同的 system prompt 与工具面）。
 * APK 的做法是在 `Ld/b;` 里：
 *
 *   1. `GET /chatglm/agent-api/project/list?page=1&page_size=30`（label「获取智能体列表」）
 *   2. 取 `result`（缺失回退 `data`）下的 `list` 数组；
 *      逐项读 `meta_data.type`，**只认 `agent`**，取 `agent_info.id` → `relate_id` →
 *      `agent_id` 中第一个非空串，name 取 `agent_info.name` → `title`；
 *      同时记 `is_default` / `default`。
 *   3. 选中优先级（`Ld/b;->b(ArrayList)`）：
 *      默认为真 → 名字含「助手」或「通用」 → 列表第一个。
 *   4. `list` 缺失或筛完为空时，降级成**递归深扫**（`Ld/b;->d`）：
 *      先只认 `meta_data.type ∈ {group, showcase}` 的容器（严格模式），
 *      再放开成任意含 `agent_id`/`id` 的对象（宽松模式）；
 *      每层都试 `list` / `agents` / `data` / `items` 四个键。
 *   5. 全都拿不到 → 抛 `upstream_error`「无法从智能体列表里找到可用的 agent」。
 *
 * 结果按**凭据作用域**缓存在进程内（APK 是 `HashMap<key, agentId>`，key 是 apiKey）。
 * 缓存不落盘：agent 绑定是上游服务端状态，落盘缓存迟早与账号实际权限错位。
 */
import { upstreamError } from './agentmore-protocol.mjs'
import { agentmoreScope } from './agentmore-catalog.mjs'

/** 严格模式唯一认可的容器类型（`Ld/b;->d` 里 `"group"` / `"showcase"` 两个字面量）。 */
const CONTAINER_TYPES = new Set(['group', 'showcase'])
/** 直接列表模式唯一认可的类型（`Ld/b;->c` 里 `"agent"` 字面量）。 */
const AGENT_TYPE = 'agent'
/** 宽松模式下的候选键：`agent_info.id` 优先，其次这几个顶层键。 */
const AGENT_ID_KEYS = ['relate_id', 'agent_id', 'id', 'agentId']
/** 递归时要展开的子容器键（`Ld/b;->c` 的 `list`/`agents`/`data`/`items`）。 */
const CHILD_KEYS = ['list', 'agents', 'data', 'items']
/** 名字偏好的两个关键词（`Ld/b;->b` 里的「助手」「通用」）。 */
const PREFERRED_NAMES = ['助手', '通用']
/** 深扫上限：防止上游返回病态嵌套时把进程拖死。 */
const MAX_DEPTH = 8
const MAX_NODES = 20_000

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** `Ld/b;->a(String[])`：第一个非空串。 */
function firstNonEmpty(values) {
  for (const value of values) {
    const candidate = text(value)
    if (candidate !== '') return candidate
  }
  return ''
}

/** 从一条 `list[]` 项里取 agent（直接列表模式，`Ld/b;->c` 的循环体）。 */
function fromListItem(item) {
  if (!isObject(item)) return null
  const meta = item.meta_data
  const type = isObject(meta) ? text(meta.type) : ''
  if (type !== AGENT_TYPE) return null
  const info = isObject(item.agent_info) ? item.agent_info : null
  const id = firstNonEmpty([info?.id, item.relate_id, item.agent_id])
  if (id === '') return null
  const name = firstNonEmpty([info?.name, item.title])
  const preferred = item.is_default === true || item.default === true
  return { id, name, preferred }
}

/**
 * 选中一条（`Ld/b;->b(ArrayList)`）：默认 → 名字含「助手/通用」→ 第一个。
 *
 * 这个顺序不是审美选择：上游把多数账号的默认 agent 标成 `is_default`，
 * 但有一部分账号（尤其是从网页侧改过设置的）没有任何标记，
 * 这时选「通用助手」比选列表第一个更接近用户预期。
 */
function choose(candidates) {
  const explicit = candidates.find((entry) => entry.preferred)
  if (explicit !== undefined) return explicit
  const named = candidates.find((entry) => PREFERRED_NAMES.some((keyword) => entry.name.includes(keyword)))
  if (named !== undefined) return named
  return candidates[0]
}

/**
 * 递归深扫（`Ld/b;->d`）。
 *
 * @param {unknown} node
 * @param {boolean} strict 严格模式只下沉 `group`/`showcase` 容器
 * @param {Array<{id:string,name:string,preferred:boolean}>} out
 * @param {Set<string>} seen 去重（同 id 只收一次）
 * @param {{nodes:number}} budget
 */
function deepScan(node, strict, out, seen, budget, depth = 0) {
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) return
  if (Array.isArray(node)) {
    for (const child of node) deepScan(child, strict, out, seen, budget, depth + 1)
    return
  }
  if (!isObject(node)) return
  budget.nodes += 1

  const meta = isObject(node.meta_data) ? node.meta_data : null
  const type = isObject(meta) ? text(meta.type) : ''
  // 严格模式：只认容器类型，容器本身不产出 agent，继续往里走。
  const descendOnly = strict && !CONTAINER_TYPES.has(type)

  if (!descendOnly) {
    const info = isObject(node.agent_info) ? node.agent_info : null
    const id = firstNonEmpty([info?.id, ...AGENT_ID_KEYS.map((key) => node[key])])
    const name = firstNonEmpty([info?.name, node.name, node.agent_name, node.title])
    if (id !== '' && name !== '' && !seen.has(id)) {
      seen.add(id)
      out.push({ id, name, preferred: node.is_default === true || node.default === true })
    }
  }

  for (const key of CHILD_KEYS) {
    const child = node[key]
    if (Array.isArray(child) || isObject(child)) deepScan(child, strict, out, seen, budget, depth + 1)
  }
}

/** 顶层容器候选（`Ld/b;->c` 的降级路径：`list`/`agents`/`data`/`items` → `data` → 整个 result）。 */
function rootCandidates(result) {
  const roots = []
  for (const key of CHILD_KEYS) {
    const value = result[key]
    if (Array.isArray(value) || isObject(value)) roots.push(value)
  }
  if (roots.length === 0) {
    const data = result.data
    if (Array.isArray(data) || isObject(data)) roots.push(data)
  }
  if (roots.length === 0) roots.push(result)
  return roots
}

/**
 * 从 `/project/list` 的完整 payload 里解析 agent 绑定。
 *
 * 纯函数，无网络：便于用真实 payload 片段做断言。
 *
 * @param {unknown} payload `Ld/h;->g` 的返回值（已 JSON 化）
 * @returns {{id:string, name:string}} 解析失败抛 `AGENTMORE_AGENT_NOT_FOUND`
 */
export function parseAgentBinding(payload) {
  const payloadObject = isObject(payload) ? payload : {}
  const result = isObject(payloadObject.result) ? payloadObject.result : isObject(payloadObject.data) ? payloadObject.data : payloadObject

  // 路径一：`list` 里 `meta_data.type === 'agent'` 的项。
  const listed = []
  const list = Array.isArray(result.list) ? result.list : []
  for (const item of list) {
    const candidate = fromListItem(item)
    if (candidate !== null) listed.push(candidate)
  }
  if (listed.length > 0) {
    const picked = choose(listed)
    return { id: picked.id, name: picked.name === '' ? picked.id : picked.name }
  }

  // 路径二：递归深扫，严格模式优先，空了再放开。
  const roots = rootCandidates(result)
  for (const strict of [true, false]) {
    const out = []
    const seen = new Set()
    const budget = { nodes: 0 }
    for (const root of roots) deepScan(root, strict, out, seen, budget)
    if (out.length > 0) {
      const picked = choose(out)
      return { id: picked.id, name: picked.name === '' ? picked.id : picked.name }
    }
  }

  // 文案与 APK 的 `Ld/x("upstream_error", "无法从智能体列表里找到可用的 agent")` 一致，
  // 但错误码用独立标识，便于设置卡把它与「上游 502」区分开（前者要用户重登，后者要重试）。
  throw upstreamError('agent_not_found', '无法从智能体列表里找到可用的 agent', 502)
}

/**
 * @param {object} options
 * @param {(credential:object, signal?:AbortSignal) => Promise<unknown>} options.fetchAgents 拉 `/project/list`
 * @param {(message:string)=>void} [options.log] 选用日志（APK 用 `Lc/f;->c`）
 */
export function createAgentResolver({ fetchAgents, log } = {}) {
  /** scope → {id, name}；账号切换后 scope 变，自然失效，不需要显式清理。 */
  const bindings = new Map()
  /** scope → 在飞请求：同一账号并发首字时只拉一次目录。 */
  const inFlight = new Map()

  async function resolve(credential, signal) {
    const scope = agentmoreScope(credential)
    // 凭据里显式钉住的 agentId 优先：用户可能手工指定过某个智能体。
    const pinned = text(credential?.agentId)
    if (pinned !== '') return pinned
    const cached = bindings.get(scope)
    if (cached !== undefined) return cached.id
    const pending = inFlight.get(scope)
    if (pending !== undefined) return pending

    const work = (async () => {
      const payload = await fetchAgents(credential, signal)
      const binding = parseAgentBinding(payload)
      bindings.set(scope, binding)
      // APK 的日志原文：「选用智能体：<name>（<id>）」。
      log?.(`选用智能体：${binding.name}（${binding.id}）`)
      return binding.id
    })().finally(() => {
      inFlight.delete(scope)
    })
    inFlight.set(scope, work)
    return work
  }

  return {
    resolve,
    /** 账号切换 / 用户手改绑定后调用，下一次请求重新拉取。 */
    invalidate({ scope } = {}) {
      if (scope === undefined) bindings.clear()
      else bindings.delete(scope)
    },
    /** 诊断用：当前缓存的绑定（不含任何令牌）。 */
    describe() {
      return [...bindings.entries()].map(([scope, binding]) => ({ scope: scope.slice(0, 12), id: binding.id, name: binding.name }))
    },
  }
}
