// Host 入口（apply / syncCredential）的 seam 测试 —— 全部依赖注入。
//
// 本文件绝不发起真实网络请求，也绝不读写真实凭据文件：
//   * readFile / refresh / writeFile / setCredential 一律传假实现；
//   * 唯一能接触网络的路径（apply 组装的 refresh）用**计数型 spy fetch** 注入，
//     并断言「刷新前置条件不成立时 fetch 调用次数为 0」；
//   * 时间通过 deps.now 注入（见节流用例），不依赖真实等待。
// 所有 token 均为运行时合成的假串（live / old / brand-new / R），不含任何真实机密。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncCredential, createSyncDeps, runSync, apply, TOKEN_REF, REFRESH_MARGIN_MS, TICK_MS, name, inject } from '../lib/index.mjs'
import { installUserAgentFix } from '../lib/user-agent.mjs'

const raw = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'live', refreshToken: 'R', tokenType: 'Bearer', expiresAt: Date.now() + 90 * 864e5 } })

const baseDeps = (over = {}) => ({
  readFile: async () => raw,
  refresh: async () => { throw new Error('refresh should not be called') },
  writeFile: async () => {},
  setCredential: async () => {},
  ...over,
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 计数型 spy fetch：记录调用次数，绝不发真实请求。 */
const spyFetch = (respond = async () => ({ ok: true, status: 200, text: async () => '{"data":{"accessToken":"brand-new"}}' })) => {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return respond(url, init)
  }
  impl.calls = calls
  return impl
}

test('导出契约', () => {
  assert.equal(name, 'dsh-workbuddy-auth')
  assert.deepEqual(inject, ['credentials'])
  assert.equal(TOKEN_REF, 'WORKBUDDY_ACCESS_TOKEN')
})

test('凭据未临近过期时直接写入 seam，不刷新', async () => {
  let written = null
  const r = await syncCredential(baseDeps({ setCredential: async (ref, v) => { written = [ref, v] } }))
  assert.equal(r.refreshed, false)
  assert.deepEqual(written, [TOKEN_REF, 'live'])
})

test('临近过期时刷新、写回文件并更新 seam', async () => {
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: Date.now() + 1000 } })
  const calls = []
  const r = await syncCredential(baseDeps({
    readFile: async () => soon,
    refresh: async () => ({ accessToken: 'brand-new' }),
    writeFile: async (text) => calls.push(['write', JSON.parse(text).auth.accessToken]),
    setCredential: async () => calls.push(['set']),
  }))
  assert.equal(r.refreshed, true)
  assert.equal(r.token, 'brand-new')
  assert.deepEqual(calls, [['write', 'brand-new'], ['set']])
})

test('读取失败时抛出且不写 seam', async () => {
  let set = false
  await assert.rejects(() => syncCredential(baseDeps({ readFile: async () => { throw new Error('ENOENT') }, setCredential: async () => { set = true } })), /ENOENT/)
  assert.equal(set, false)
})

// —— 以下为 brief 之外的补充用例（不修改上面的断言）——

test('守卫：refreshToken 缺失时在调用 fetch 之前就抛错，零网络请求', async () => {
  // 全链路：一条已过期、且 auth.refreshToken 缺失的记录，必须在触碰网络之前就失败。
  const noRefresh = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'live', expiresAt: Date.now() - 1000 } })
  const fetchImpl = spyFetch()
  const ctx = { credentials: { set: async () => { throw new Error('set should not be called') } } }
  const deps = createSyncDeps(ctx, {}, fetchImpl)

  let wrote = false
  let set = false
  await assert.rejects(
    () => syncCredential({ ...deps, readFile: async () => noRefresh, writeFile: async () => { wrote = true }, setCredential: async () => { set = true } }),
    /credential record is missing refreshToken/,
  )
  assert.equal(fetchImpl.calls.length, 0, 'fetch 必须零调用')
  assert.equal(wrote, false, '刷新前置条件不成立时不得写回文件')
  assert.equal(set, false, '刷新前置条件不成立时不得写 seam')

  // 直接走 apply 组装的 refresh 闭包，语义相同：抛错且零请求。
  await assert.rejects(() => deps.refresh({ accessToken: 'live', refreshToken: '', expiresAt: 0 }), /credential record is missing refreshToken/)
  await assert.rejects(() => deps.refresh(undefined), /credential record is missing refreshToken/)
  assert.equal(fetchImpl.calls.length, 0, 'fetch 必须零调用')
})

test('createSyncDeps 显式注入 fetch：刷新走注入实现，未提供的字段沿用旧值', async () => {
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: Date.now() + 1000 } })
  const fetchImpl = spyFetch() // 响应只带 accessToken，refreshToken / expiresAt 缺席
  const ctx = { credentials: { set: async () => {} } }
  const deps = createSyncDeps(ctx, {}, fetchImpl)

  let written = null
  const r = await syncCredential({ ...deps, readFile: async () => soon, writeFile: async (text) => { written = JSON.parse(text) } })

  assert.equal(fetchImpl.calls.length, 1, '刷新必须走注入的 fetch，而不是全局 fetch')
  assert.equal(fetchImpl.calls[0].init.headers['X-Refresh-Token'], 'R')
  assert.equal(r.refreshed, true)
  assert.equal(r.token, 'brand-new')
  // undefined 的语义是「本次响应没给，沿用旧值」：既不能丢键，也不能被改写为 0 / null / ''。
  assert.equal(written.auth.refreshToken, 'R')
  assert.equal(written.auth.expiresAt, JSON.parse(soon).auth.expiresAt)
  assert.equal(written.auth.accessToken, 'brand-new')
})

test('刷新失败时不写文件、不写 seam，错误向上抛出', async () => {
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: Date.now() + 1000 } })
  let wrote = false
  let set = false
  await assert.rejects(
    () => syncCredential(baseDeps({
      readFile: async () => soon,
      refresh: async () => { throw new Error('refresh failed: HTTP 401') },
      writeFile: async () => { wrote = true },
      setCredential: async () => { set = true },
    })),
    /refresh failed: HTTP 401/,
  )
  assert.equal(wrote, false)
  assert.equal(set, false, '旧 token 仍是唯一可用凭据，刷新失败不得写 seam')
})

test('apply：启动读取失败只告警不抛错，日志无令牌，dispose 后停止轮询', async () => {
  const infos = []
  const warnings = []
  const disposers = []
  let setCalls = 0
  const ctx = {
    credentials: { set: async () => { setCalls += 1 } },
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warnings.push(String(m)) },
    // 收集**全部** effect 的 disposer：apply 现在注册两个副作用（上游 UA 修复 + 凭据同步轮询），
    // 两个都必须在卸载时复原，只留最后一个会漏掉另一个（并让包装层残留在 globalThis.fetch 上）。
    effect: (fn) => { disposers.push(fn()) },
    // 设置卡路由走**声明式**依赖（`ctx.inject(['webServer'], cb)`，见 lib/index.mjs）。
    // 本用例是非 web 组合：webServer 永不到来，回调不执行，因此 effect 恰好是两个。
    inject: () => ({ deps: ['webServer'] }),
  }

  // 记录 apply 创建的定时器是否被真正清掉：只靠 stopped 标志的话行为上看不出差别，
  // 但一个活到进程结束的死定时器仍是未回收的副作用。
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const intervals = []
  const cleared = []
  globalThis.setInterval = (...args) => { const handle = realSetInterval(...args); intervals.push(handle); return handle }
  globalThis.clearInterval = (handle) => { cleared.push(handle); return realClearInterval(handle) }

  try {
    // 指向一个不存在的临时路径：读盘 ENOENT，因此既不碰真实凭据文件，也走不到网络/写盘。
    apply(ctx, { credentialFile: join(tmpdir(), `wb-auth-apply-${process.pid}-missing`, 'Tencent-Cloud.coding-copilot.info'), tickMs: 5 })

    await delay(30)
    assert.equal(disposers.length, 2, 'apply 必须把上游 UA 修复与凭据同步轮询都注册为可回收副作用')
    assert.ok(disposers.every((d) => typeof d === 'function'), 'apply 必须通过 ctx.effect 注册可回收的副作用')
    assert.ok(warnings.length >= 1, '启动失败必须留下告警')
    assert.match(warnings[0], /startup failed/)
    assert.match(warnings[0], /ENOENT/)
    assert.equal(infos.filter((m) => m.includes('token ready')).length, 0, '读取失败时不得报告 token ready')
    assert.equal(setCalls, 0, '读取失败时不得写 seam')
    assert.ok(!warnings.join(' ').includes('live'), '日志不得出现令牌值')

    for (const d of disposers) d()
    assert.equal(intervals.length, 1, 'apply 应恰好创建一个轮询定时器')
    assert.ok(cleared.includes(intervals[0]), 'dispose 必须清掉定时器，而不是只置停止标志')

    await delay(20) // 让 dispose 之前已触发的最后一次 tick 告警落定
    const settled = warnings.length
    await delay(60) // 若轮询未停止，这期间（≈12 个 tick）会继续新增告警
    assert.equal(warnings.length, settled, 'dispose 后必须停止轮询')
    assert.equal(setCalls, 0)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

// —— 以下是修复「刷新响应缺 expiresAt 时每 tick 轮换一次 refresh token」的用例 ——
//
// 缺陷机制：mergeRefreshedRecord 对缺席的 expiresAt 沿用旧值，而旧值按定义就在刷新阈值内，
// 于是 needsRefresh 在每个 tick 恒真 → 每次同步都不可逆地轮换一次 refresh token 并重写凭据文件。
// 下面三条分别钉住修复的三个部分：节流（a）、失效告警（b）、可注入时钟（c）。

test('刷新节流（a/c）：刷新响应缺 expiresAt 时，后续 tick 不再轮换 refresh token', async () => {
  const T0 = 1_700_000_000_000
  const clock = { t: T0 }
  // 注入时钟：全部时间判断走 deps.now，用例不需要真的等 10 分钟 / 12 小时。
  let fileText = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: T0 + 1000 } })
  const writes = []
  const sets = []
  const fetchImpl = spyFetch() // 响应只带 accessToken：expiresAt 缺席，合并后沿用旧的过期时间
  const ctx = { credentials: { set: async (ref, value) => sets.push([ref, value]) } }
  const deps = {
    ...createSyncDeps(ctx, {}, fetchImpl),
    readFile: async () => fileText,
    writeFile: async (text) => { writes.push(JSON.parse(text).auth.accessToken); fileText = text },
    now: () => clock.t,
  }

  // 第一次：记录临近过期 → 注入的 spy 刷新 → 写回 → 写 seam（seam 仍是最后一步）。
  const first = await syncCredential(deps)
  assert.equal(first.refreshed, true)
  assert.equal(first.throttled, false)
  assert.equal(first.staleAfterRefresh, true, '响应缺 expiresAt，合并后记录仍在阈值内')
  assert.equal(first.token, 'brand-new')
  assert.equal(fetchImpl.calls.length, 1)
  assert.deepEqual(writes, ['brand-new'])
  assert.deepEqual(sets, [[TOKEN_REF, 'brand-new']])

  // 一个 tick（10 分钟）之后：记录依然「临近过期」，但节流必须挡住第二次 refresh token 轮换。
  clock.t += TICK_MS
  const second = await syncCredential(deps)
  assert.equal(second.refreshed, false, '第二次不得再刷新')
  assert.equal(second.throttled, true)
  assert.equal(second.token, 'brand-new', '沿用上一次刷新写回的 token')
  assert.equal(fetchImpl.calls.length, 1, '第二次必须零新增网络调用')
  assert.equal(writes.length, 1, '第二次不得重写凭据文件')
  assert.equal(sets.length, 2, 'seam 仍要更新（当前 token 可用）')

  // 再一个 tick 仍被节流：证明「每 10 分钟轮换一次」已不复现。
  clock.t += TICK_MS
  const third = await syncCredential(deps)
  assert.equal(third.refreshed, false)
  assert.equal(third.throttled, true)
  assert.equal(fetchImpl.calls.length, 1)

  // 但节流必须有界：最小间隔（默认 marginMs / 2）过去后允许再次刷新，不能把登录态永久卡死。
  clock.t += REFRESH_MARGIN_MS / 2
  const fourth = await syncCredential(deps)
  assert.equal(fourth.refreshed, true, '节流窗口过去后必须恢复刷新')
  assert.equal(fourth.throttled, false)
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(writes.length, 2)
})

test('刷新节流（a）不会误伤正常路径：拿到足够远的 expiresAt 时不被节流', async () => {
  const T0 = 1_700_000_000_000
  const clock = { t: T0 }
  let fileText = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: T0 + 1000 } })
  // 正常响应：带一个足够远的 expiresAt（30 天），刷新后应完全脱离阈值。
  const fetchImpl = spyFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: { accessToken: 'brand-new', expiresAt: T0 + 30 * 864e5 } }) }))
  const deps = {
    ...createSyncDeps({ credentials: { set: async () => {} } }, {}, fetchImpl),
    readFile: async () => fileText,
    writeFile: async (text) => { fileText = text },
    now: () => clock.t,
  }

  const first = await syncCredential(deps)
  assert.equal(first.refreshed, true)
  assert.equal(first.staleAfterRefresh, false, '新 expiresAt 足够远时不得误报失效')

  clock.t += TICK_MS
  const second = await syncCredential(deps)
  assert.equal(second.refreshed, false)
  assert.equal(second.throttled, false, '未临近过期时走 needsRefresh=false，而不是被节流挡住')
  assert.equal(fetchImpl.calls.length, 1)
})

test('失效告警（b）：刷新后仍在阈值内时，打出区别于失败 warn 的告警且日志无令牌', async () => {
  const infos = []
  const warnings = []
  const logger = { info: (m) => infos.push(String(m)), warn: (m) => warnings.push(String(m)) }
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: Date.now() + 1000 } })

  const r = await runSync(baseDeps({ readFile: async () => soon, refresh: async () => ({ accessToken: 'brand-new' }) }), logger, 'tick')

  assert.equal(r.refreshed, true)
  assert.equal(r.staleAfterRefresh, true, '响应缺 expiresAt 时必须标记为「仍在阈值内」')
  assert.equal(warnings.length, 1, '不能把这种刷新静默成普通成功')
  assert.match(warnings[0], /stale-expiry after refresh/)
  assert.match(warnings[0], /expiresAt/, '告警必须点明是服务端没给到期字段')
  assert.doesNotMatch(warnings[0], /failed/, '必须与读/刷新/写回失败的普通 warn 区分开')
  assert.ok(infos.some((m) => m.includes('token ready')), '成功路径的 info 仍然保留')
  assert.ok(!`${infos.join(' ')} ${warnings.join(' ')}`.includes('brand-new'), '日志不得出现令牌值')
})

test('节流是可观测的：被挡下的那次同步留下 info（不是告警）说明原因', async () => {
  const T0 = 1_700_000_000_000
  const clock = { t: T0 }
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: T0 + 1000 } })
  const infos = []
  const warnings = []
  const logger = { info: (m) => infos.push(String(m)), warn: (m) => warnings.push(String(m)) }
  let refreshCalls = 0
  const deps = baseDeps({
    readFile: async () => soon,
    refresh: async () => { refreshCalls += 1; return { accessToken: 'brand-new' } },
    now: () => clock.t,
  })

  await runSync(deps, logger, 'tick')
  assert.equal(refreshCalls, 1)
  assert.equal(warnings.length, 1, '第一次刷新后仍在阈值内 → 一条失效告警')

  clock.t += TICK_MS
  warnings.length = 0
  infos.length = 0
  const second = await runSync(deps, logger, 'tick')

  assert.equal(second.throttled, true)
  assert.equal(refreshCalls, 1, '第二次不得再刷新')
  assert.equal(warnings.length, 0, '节流是节流的正常工作状态，不得重复告警')
  assert.ok(infos.some((m) => m.includes('refresh throttled')), '节流必须留下可观测的 info')
  assert.ok(infos.some((m) => m.includes('token ready')))
})

// —— 重入保护：慢刷新期间 tick 不得发起第二次网络调用 ——
//
// 缺陷机制：`apply` 每 10 分钟无条件再起一次 `runSync`，不看上一次是否在飞。
// 刷新一旦挂住（此前还没有超时），后续每个 tick 都会叠一次刷新请求，
// 而每次成功的刷新都是一次**不可逆的** refresh token 轮换。

test('重入保护：上一次同步仍在飞时，后续 tick 直接跳过、零新增网络调用', async () => {
  const T0 = 1_700_000_000_000
  const clock = { t: T0 }
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: T0 + 1000 } })
  const infos = []
  const warnings = []
  const logger = { info: (m) => infos.push(String(m)), warn: (m) => warnings.push(String(m)) }

  // 可控刷新：一直挂起，直到用例显式放行 —— 模拟"慢刷新"。
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  let refreshCalls = 0
  const deps = baseDeps({
    readFile: async () => soon,
    refresh: async () => { refreshCalls += 1; await blocked; return { accessToken: 'brand-new' } },
    setCredential: async () => {},
    now: () => clock.t,
  })

  const first = runSync(deps, logger, 'tick') // 不 await：让它处于在飞状态
  await delay(0) // 让第一次同步推进到 refresh 的 await 点

  const skipped = await runSync(deps, logger, 'tick')
  assert.equal(skipped, undefined, '在飞期间必须直接跳过，而不是排队再刷一次')
  assert.equal(refreshCalls, 1, '在飞期间不得发起第二次刷新')
  assert.equal(warnings.length, 0, '跳过不是失败，不得留下告警')

  release()
  const r = await first
  assert.equal(r.refreshed, true)
  assert.equal(r.token, 'brand-new')
  assert.equal(refreshCalls, 1)

  // 在飞标记必须被清掉：下一次 tick 仍能正常刷新（否则会把续期永久卡死）。
  clock.t += REFRESH_MARGIN_MS / 2
  const after = await runSync(deps, logger, 'tick')
  assert.equal(after.refreshed, true, '在飞标记必须在结束后释放')
  assert.equal(refreshCalls, 2)
})

// —— §5 承诺的「凭据文件缺失时给出一行可执行指引」 ——

test('凭据文件缺失：告警给出可执行指引与安全文件定位，不泄露解析后的绝对路径', async () => {
  const warnings = []
  const infos = []
  const logger = { info: (m) => infos.push(String(m)), warn: (m) => warnings.push(String(m)) }
  const missing = 'C:\\Users\\synthetic-user\\private-temp\\Tencent-Cloud.coding-copilot.info'
  const safeDisplayPath = String.raw`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`
  const err = new Error(`ENOENT: no such file or directory, open '${missing}'`)
  err.code = 'ENOENT'

  const r = await runSync(baseDeps({ readFile: async () => { throw err }, credentialFilePath: missing }), logger, 'startup')

  assert.equal(r, undefined)
  assert.equal(warnings.length, 1, '一条 warn 承载结构化错误 + 指引，而不是两条互相割裂的消息')
  assert.match(warnings[0], /startup failed/)
  assert.match(warnings[0], /ENOENT/)
  assert.match(warnings[0], /codebuddy/, '必须指出先运行一次 codebuddy 登录')
  assert.ok(warnings[0].includes(safeDisplayPath), '必须给出不含用户名的安全凭据文件定位')
  assert.equal(warnings[0].includes(missing), false, '不得输出 deps.credentialFilePath 的解析后绝对路径')
  assert.equal(warnings[0].includes('synthetic-user'), false, '不得输出绝对路径中的用户名')
  assert.deepEqual(infos, [], '失败路径不得报告 token ready')
})

test('非凭据缺失类错误不得误报登录指引', async () => {
  const warnings = []
  const logger = { info: () => {}, warn: (m) => warnings.push(String(m)) }
  await runSync(baseDeps({ refresh: async () => { throw new Error('refresh failed: HTTP 401') }, readFile: async () => JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: Date.now() + 1000 } }) }), logger, 'tick')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /HTTP 401/)
  assert.doesNotMatch(warnings[0], /codebuddy/, '刷新失败与"未登录"是两回事，不能给错指引')
})

test('同步依赖抛错时日志只保留结构化状态，不回显任意错误消息中的令牌值', async () => {
  const syntheticSecret = `synthetic-${'x'.repeat(80)}`
  const warnings = []
  const logger = { info: () => {}, warn: (m) => warnings.push(String(m)) }
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: Date.now() + 1000 } })

  await runSync(baseDeps({
    readFile: async () => soon,
    refresh: async () => { throw new Error(`upstream body contained ${syntheticSecret}`) },
  }), logger, 'tick')

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /credential operation failed/)
  assert.doesNotMatch(warnings[0], new RegExp(syntheticSecret), '任意依赖错误消息不得进入日志')
})

test('写回路径 EPERM/EACCES 不得误报登录指引，应指向文件占用或权限且不泄露绝对路径', async () => {
  // 本插件自己的 renameSync/unlinkSync 在目标文件被占用时抛的也是 EPERM/EACCES。
  // 把这两个码一律当作「凭据缺失」会打印「请先运行一次 codebuddy 完成登录」，
  // 把用户指向完全错误的原因（登录态其实好着呢，只是文件被占着写不进去）。
  const warnings = []
  const logger = { info: () => {}, warn: (m) => warnings.push(String(m)) }
  const file = 'C:\\Users\\synthetic-user\\locked\\Tencent-Cloud.coding-copilot.info'
  const safeDisplayPath = String.raw`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`
  const soon = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 'old', refreshToken: 'R', expiresAt: Date.now() + 1000 } })

  for (const code of ['EPERM', 'EACCES']) {
    warnings.length = 0
    const err = new Error(`${code}: operation not permitted, rename '${file}.123.tmp' -> '${file}'`)
    err.code = code

    const r = await runSync(baseDeps({
      readFile: async () => soon,
      refresh: async () => ({ accessToken: 'brand-new' }),
      writeFile: async () => { throw err },
      credentialFilePath: file,
    }), logger, 'tick')

    assert.equal(r, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], new RegExp(code), '必须保留原始错误码')
    assert.doesNotMatch(warnings[0], /codebuddy/, `${code} 来自写回路径，不是"未登录"，不得建议重新登录`)
    assert.match(warnings[0], /占用|权限/, `${code} 应指向文件被占用/权限不足`)
    assert.ok(warnings[0].includes(safeDisplayPath), '仍应给出安全的凭据文件定位')
    assert.equal(warnings[0].includes(file), false, '不得输出 deps.credentialFilePath 的解析后绝对路径')
    assert.equal(warnings[0].includes('synthetic-user'), false, '不得输出绝对路径中的用户名')
  }
})

// —— 上游 UA 修复的挂载点：apply 必须在宿主进程内装上、并在卸载时复原 ——
//
// 缺陷机制：WorkBuddy 网关按 User-Agent 拦截 `deepseek-harness/*`（400 code 11128），
// 而适配器发请求前用 headers.set(...) 无条件覆盖 UA、配置层改不动它；
// 唯一可干预点就是本插件在宿主进程内包一层 globalThis.fetch。

/** apply 用例用的 ctx：收集全部 effect disposer，并保留日志（两个副作用都要能复原）。 */
const makeApplyCtx = () => {
  const disposers = []
  const infos = []
  const warnings = []
  return {
    disposers,
    infos,
    warnings,
    ctx: {
      credentials: { set: async () => {} },
      logger: { info: (m) => infos.push(String(m)), warn: (m) => warnings.push(String(m)) },
      effect: (fn) => { disposers.push(fn()) },
      // 设置卡路由声明式依赖（lib/index.mjs）：本组用例不提供 webServer，
      // 因此回调永不执行，effect 数仍是 2（UA 修复 + 凭据同步）。
      inject: () => ({ deps: ['webServer'] }),
    },
  }
}

/** 指向不存在路径的配置：启动同步读盘 ENOENT，既不碰真实凭据文件，也走不到网络。 */
const missingCredentialConfig = (over = {}) => ({
  credentialFile: join(tmpdir(), `wb-auth-ua-${process.pid}-missing`, 'Tencent-Cloud.coding-copilot.info'),
  tickMs: 60_000,
  ...over,
})

test('apply 安装上游 UA 修复：写入日志、非目标域名零改动、卸载后复原 globalThis.fetch', async () => {
  const realFetch = globalThis.fetch
  const fake = spyFetch()
  const { ctx, disposers, infos } = makeApplyCtx()

  globalThis.fetch = fake
  try {
    apply(ctx, missingCredentialConfig())

    assert.equal(disposers.length, 2, 'UA 修复与凭据同步都必须注册为可回收副作用')
    assert.notEqual(globalThis.fetch, fake, 'apply 必须把上游 UA 修复装到 globalThis.fetch 上')
    assert.ok(
      infos.some((m) => m.includes('user-agent') && m.includes('copilot.tencent.com') && m.includes('dsh-workbuddy/0.1')),
      `安装必须留下可观测的一行 info，实际：${JSON.stringify(infos)}`,
    )

    await globalThis.fetch('https://copilot.tencent.com/v1/chat/completions', { method: 'POST', headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.1' } })
    assert.equal(fake.calls.length, 1)
    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), 'dsh-workbuddy/0.1')

    // 反向断言在 apply 层同样成立：非目标域名原样透传（对象同一性）。
    const init = { method: 'GET', headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.1' } }
    await globalThis.fetch('https://api.deepseek.com/v1/models', init)
    assert.equal(fake.calls[1].init, init, '非目标域名必须原样透传（同一对象引用）')
    assert.equal(new Headers(fake.calls[1].init.headers).get('user-agent'), 'deepseek-harness/0.1.5-rc.1')

    for (const d of disposers) d()
    assert.equal(globalThis.fetch, fake, '插件卸载后必须复原 globalThis.fetch')
  } finally {
    for (const d of disposers) d?.()
    await delay(20) // 让启动同步的 ENOENT 告警落定，避免污染后续用例
    globalThis.fetch = realFetch
  }
})

test('apply 的 upstreamHost / upstreamUserAgent 配置生效且只影响目标域名', async () => {
  const realFetch = globalThis.fetch
  const fake = spyFetch()
  const { ctx, disposers, infos } = makeApplyCtx()

  globalThis.fetch = fake
  try {
    apply(ctx, missingCredentialConfig({ upstreamHost: 'upstream.example', upstreamUserAgent: 'custom/9' }))

    assert.ok(infos.some((m) => m.includes('upstream.example') && m.includes('custom/9')), `日志必须写明实际生效的 host/UA，实际：${JSON.stringify(infos)}`)

    await globalThis.fetch('https://upstream.example/v1/chat/completions', { headers: {} })
    assert.equal(new Headers(fake.calls[0].init.headers).get('user-agent'), 'custom/9')

    const init = { headers: { 'user-agent': 'deepseek-harness/0.1.5-rc.1' } }
    await globalThis.fetch('https://copilot.tencent.com/v1/chat/completions', init)
    assert.equal(fake.calls[1].init, init, '默认域名不在本次自定义范围内，必须原样透传')
  } finally {
    for (const d of disposers) d?.()
    await delay(20)
    globalThis.fetch = realFetch
  }
})

test('已有包装层时 apply 只记一行跳过日志，且卸载本插件不得掀掉已装的那层', async () => {
  const realFetch = globalThis.fetch
  const fake = spyFetch()
  const { ctx, disposers, infos } = makeApplyCtx()

  globalThis.fetch = fake
  try {
    const pre = installUserAgentFix({ fetchImpl: fake }) // 模拟另一个挂载点已经装好
    const preLayer = globalThis.fetch
    assert.equal(pre.installed, true)

    apply(ctx, missingCredentialConfig())

    assert.equal(globalThis.fetch, preLayer, '不得叠加第二层包装')
    assert.ok(infos.some((m) => m.includes('skipped')), `跳过安装同样必须留下日志，实际：${JSON.stringify(infos)}`)

    for (const d of disposers) d()
    assert.equal(globalThis.fetch, preLayer, '本插件卸载只能回收自己注册的副作用，不得掀掉别人装的层')

    pre()
    assert.equal(globalThis.fetch, fake)
  } finally {
    for (const d of disposers) d?.()
    await delay(20)
    globalThis.fetch = realFetch
  }
})
