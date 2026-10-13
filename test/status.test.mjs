// 脱敏状态 DTO 的纯函数测试 —— 不读盘、不联网。
//
// 本文件的核心契约（对应设计文档 §10.3）：`buildStatus` 的返回值**任何情况下都不含
// accessToken / refreshToken 的值**。因此除了逐字段断言，还用「整串扫描」与「字段白名单」
// 两种反向断言把它钉死：前者防止令牌经某个字段溜出去，后者防止将来有人往 DTO 里加字段。
// 所有令牌均为运行时合成的假串（SECRET-A / SECRET-R），不含任何真实机密。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildStatus, maskPhone, tail } from '../lib/status.mjs'

/**
 * 非周期合成令牌（160 位十六进制，运行时由固定字符串派生）。
 *
 * 为什么不用 `'SECRET-A'.repeat(20)`：那样的串**周期重复**，任意偏移的片段都可能恰好等于
 * 「从头开始的片段」，于是「只判前缀」的旧守卫也能误打误撞地拦住它——用例会假绿。
 * 用 sha256 派生的十六进制串保证任意两个不同偏移的 64 位片段互不相等，
 * 「后段 / 中段」这类非零偏移的片段**只可能**被真正的子串判定拦住。
 * 这是本文件里唯一用于钉住非零偏移泄漏的串，不含任何真实机密。
 */
const NON_PERIODIC_TOKEN = [
  'status-test-offset-a',
  'status-test-offset-b',
  'status-test-offset-c',
  'status-test-offset-d',
  'status-test-offset-e',
].map((seed) => createHash('sha256').update(seed).digest('hex')).join('')

test('NON_PERIODIC_TOKEN 自检：非零偏移的 64 位片段不等于任何前缀（否则下面的用例会假绿）', () => {
  const token = NON_PERIODIC_TOKEN
  assert.equal(token.length, 320)
  const head = token.slice(0, 64)
  for (const offset of [32, 48, 64, 96]) {
    assert.notEqual(token.slice(offset, offset + 64), head, `偏移 ${offset} 的片段不得等于前 64 位`)
    assert.equal(head.startsWith(token.slice(offset, offset + 64)), false)
  }
})

const SEC_A = 'SECRET-A'.repeat(20)
const RAW = JSON.stringify({
  account: { uid: '00000000-1111-4222-8333-444444444444', nickname: '测试用户', phoneNumber: '13800001234' },
  auth: { accessToken: SEC_A, refreshToken: 'SECRET-R'.repeat(20), expiresAt: 1702592000000, refreshExpiresAt: 1705184000000, lastRefreshTime: 1700000000000 },
})

test('buildStatus 只暴露脱敏字段', () => {
  const s = buildStatus({ rawText: RAW, now: 1700000000000, userAgentFix: true, upstreamHost: 'copilot.tencent.com' })
  assert.equal(s.ok, true)
  assert.equal(s.account.nickname, '测试用户')
  assert.equal(s.account.uidTail, '4444')
  assert.equal(s.account.phoneMasked, '138****1234')
  assert.equal(s.state.userAgentFix, true)
  assert.equal(s.state.credentialReadable, true)
})

test('buildStatus 结果里绝不出现令牌值', () => {
  const s = JSON.stringify(buildStatus({ rawText: RAW, now: 1700000000000, userAgentFix: true, upstreamHost: 'x' }))
  assert.equal(s.includes('SECRET-A'), false)
  assert.equal(s.includes('SECRET-R'), false)
})

test('buildStatus 在凭据不可解析时给出 ok:false 与错误信息', () => {
  const s = buildStatus({ rawText: 'not json', now: 0, userAgentFix: false, upstreamHost: 'x' })
  assert.equal(s.ok, false)
  assert.equal(s.state.credentialReadable, false)
  assert.ok(typeof s.error === 'string' && s.error.length > 0)
})

test('maskPhone / tail 的边界', () => {
  assert.equal(maskPhone('13800001234'), '138****1234')
  assert.equal(maskPhone(''), '')
  assert.equal(maskPhone('123'), '123')
  assert.equal(tail('abcdef', 4), 'cdef')
  assert.equal(tail('abc', 4), 'abc')
})

// —— 以下为 brief 之外的补充用例（不修改上面的断言）——

test('buildStatus 的字段白名单：多一个字段就可能多一处令牌泄漏面', () => {
  const s = buildStatus({ rawText: RAW, now: 1700000000000, userAgentFix: true, upstreamHost: 'copilot.tencent.com' })
  // 多账号启用后 buildStatus 恒定带 accounts 字段（未启用时 enabled:false），
  // 且它的内部结构同样被白名单钉住（见 status-multi-account.test.mjs）。
  // 签到（签到计划 Task 4）同理恒定带 checkin 字段（服务缺席时为关闭的零值）。
  assert.deepEqual(Object.keys(s).sort(), ['account', 'accounts', 'checkin', 'ok', 'state', 'token'])
  assert.deepEqual(Object.keys(s.checkin).sort(), ['doneToday', 'enabled', 'failedToday', 'lastRunAt', 'skippedToday', 'totalAccounts'])
  assert.deepEqual(Object.keys(s.accounts).sort(), ['activeId', 'enabled', 'sources'])
  assert.deepEqual(Object.keys(s.account).sort(), ['nickname', 'phoneMasked', 'uidTail'])
  assert.deepEqual(Object.keys(s.token).sort(), ['accessDaysLeft', 'accessExpiresAt', 'lastRefreshTime', 'refreshDaysLeft', 'refreshExpiresAt'])
  // credentialEncrypted / credentialHint 是 0.2.3 起的固定字段：加密凭据与「下一步做什么」
  // 必须走这条白名单路径透出，而不是让前端去猜错误文案（见 route-error-hint.test.mjs）。
  assert.deepEqual(Object.keys(s.state).sort(), ['credentialEncrypted', 'credentialHint', 'credentialReadable', 'upstreamHost', 'userAgentFix'])
  // 成功路径不得带 error 字段（唯一允许出现在失败路径上的可读错误）。
  assert.equal('error' in s, false)
})

test('buildStatus 透出记录里的到期时间与上次刷新时间（不含令牌）', () => {
  const s = buildStatus({ rawText: RAW, now: 1700000000000, userAgentFix: false, upstreamHost: 'copilot.tencent.com' })
  assert.equal(s.token.accessExpiresAt, 1702592000000)
  assert.equal(s.token.refreshExpiresAt, 1705184000000)
  assert.equal(s.token.lastRefreshTime, 1700000000000)
  // 合成固定时钟相差整 30 天，断言由字面量独立给出。
  assert.equal(s.token.accessDaysLeft, 30)
  assert.ok(s.token.refreshDaysLeft > s.token.accessDaysLeft, 'refresh 到期必须比 access 更远')
  assert.equal(s.account.phoneMasked, '138****1234')
})

test('accessDaysLeft 到期为 0 而不是负数（Math.max(0, …)）', () => {
  const raw = JSON.stringify({ account: { uid: 'u1' }, auth: { accessToken: 't', expiresAt: 1000, refreshExpiresAt: 2000 } })
  const s = buildStatus({ rawText: raw, now: 999_999_999, userAgentFix: false, upstreamHost: 'x' })
  assert.equal(s.ok, true)
  assert.equal(s.token.accessDaysLeft, 0)
  assert.equal(s.token.refreshDaysLeft, 0)
})

test('buildStatus 接受调用方传入的读取错误（凭据文件 ENOENT 等），不抛错', () => {
  const err = new Error('ENOENT: no such file or directory')
  const s = buildStatus({ rawText: undefined, now: 0, userAgentFix: true, upstreamHost: 'copilot.tencent.com', error: err })
  assert.equal(s.ok, false)
  assert.equal(s.state.credentialReadable, false)
  assert.match(s.error, /ENOENT/)
  assert.deepEqual(s.account, { nickname: '', uidTail: '', phoneMasked: '' }, '不可读时账号字段一律留空')
  assert.deepEqual(s.token, { accessExpiresAt: 0, accessDaysLeft: 0, refreshExpiresAt: 0, refreshDaysLeft: 0, lastRefreshTime: 0 })
  assert.equal(s.state.userAgentFix, true, '凭据不可读不影响 UA 修复状态的如实上报')
  assert.ok(!JSON.stringify(s).includes('SECRET'), '错误路径同样不得带出任何令牌')
})

test('buildStatus 对缺 accessToken 的记录报错而不是抛错', () => {
  const s = buildStatus({ rawText: JSON.stringify({ auth: { refreshToken: 'R' } }), now: 0, userAgentFix: false, upstreamHost: 'x' })
  assert.equal(s.ok, false)
  assert.equal(s.state.credentialReadable, false)
  assert.match(s.error, /accessToken/)
})

test('纵深防御：账号展示字段若与令牌值相同，一律置空而不是回显', () => {
  // 异常/串位的记录：昵称与手机号恰好等于令牌值。若不拦截，令牌就会经由
  // 「脱敏后的展示字段」原样回到浏览器 —— 这正是本任务最不能出的错。
  const token = 'SECRET-A'.repeat(20)
  const raw = JSON.stringify({
    account: { uid: 'u1', nickname: token, phoneNumber: token.slice(0, 11) },
    auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
  })
  const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })
  const text = JSON.stringify(s)
  assert.equal(text.includes('SECRET-A'), false, '令牌值不得经昵称/手机号字段回显')
  assert.equal(text.includes(token.slice(0, 11)), false, '手机号若等于令牌前缀也不得回显')
  assert.equal(s.account.nickname, '')
  assert.equal(s.account.phoneMasked, '')
})

// —— 非零偏移的令牌片段（评审 Critical #1）——
//
// 旧守卫判的是「v == 令牌」「v 是令牌的**前缀**」「v **包含整条**令牌」三种。
// 漏掉的第四种是**字符串位置任意**：v 只是令牌中段/后段的一段，或是把令牌一段夹在
// 其它文本里。正常路径下令牌根本不进返回值，但凭据文件异常/字段串位时这些字段会被
// 原样回显 —— 而该模块声明的契约是「令牌值不得出现在任何响应体」。
// 下面四条把三类非零偏移片段全部钉住。

test('纵深防御：昵称等于令牌的**后段** 64 位时置空（非零偏移，旧守卫漏判）', () => {
  const token = NON_PERIODIC_TOKEN
  const raw = JSON.stringify({
    account: { uid: 'u1', nickname: token.slice(-64), phoneNumber: '13800001234' },
    auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
  })
  const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })
  assert.equal(s.account.nickname, '', '令牌后段 64 位必须被置空，而不是原样回显')
  assert.equal(JSON.stringify(s).includes(token.slice(-64)), false, '响应里不得出现令牌后段')
})

test('纵深防御：昵称等于令牌的**中段** 64 位时置空（非零偏移，旧守卫漏判）', () => {
  const token = NON_PERIODIC_TOKEN
  const raw = JSON.stringify({
    account: { uid: 'u1', nickname: token.slice(48, 112), phoneNumber: '13800001234' },
    auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
  })
  const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })
  assert.equal(s.account.nickname, '', '令牌中段 64 位必须被置空')
  assert.equal(JSON.stringify(s).includes(token.slice(48, 112)), false, '响应里不得出现令牌中段')
})

test('纵深防御：手机号等于令牌**后** 11 位时置空（打码会留下 7 个令牌字符）', () => {
  const token = NON_PERIODIC_TOKEN
  const raw = JSON.stringify({
    account: { uid: 'u1', nickname: '测试用户', phoneNumber: token.slice(-11) },
    auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
  })
  const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })
  // 关键：这里**不能**只看「令牌整串有没有出现」。maskPhone 会把中间换成星号，
  // 于是原始片段的字符被拆成「前 3 位 + 后 4 位」两截，整串扫描抓不到。
  assert.equal(s.account.phoneMasked, '', '令牌后 11 位经打码后仍会吐出 7 个令牌字符，必须整字段置空')
  assert.equal(s.account.nickname, '测试用户', '正常昵称不受影响')
})

test('纵深防御：令牌片段**嵌在文本里**（如「测试用户: <令牌前 58 位>」）同样置空', () => {
  const token = NON_PERIODIC_TOKEN
  const embedded = `测试用户: ${token.slice(0, 58)}`
  const raw = JSON.stringify({
    account: { uid: 'u1', nickname: embedded, phoneNumber: '13800001234' },
    auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
  })
  const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })
  assert.equal(s.account.nickname, '', '夹带 58 位令牌片段的昵称必须置空')
  assert.equal(s.account.phoneMasked, '138****1234', '正常手机号不受影响')
  for (let offset = 0; offset + 32 <= 58; offset += 8) {
    assert.equal(JSON.stringify(s).includes(token.slice(offset, offset + 32)), false, `响应里不得出现令牌的 32 位片段（偏移 ${offset}）`)
  }
})

test('纵深防御不误伤：正常的昵称 / 手机号 / uid 尾号原样保留', () => {
  const s = buildStatus({ rawText: RAW, now: 1700000000000, userAgentFix: true, upstreamHost: 'copilot.tencent.com' })
  assert.equal(s.account.nickname, '测试用户', '正常中文昵称不得被误判为令牌片段')
  assert.equal(s.account.phoneMasked, '138****1234')
  assert.equal(s.account.uidTail, '4444')
})

for (const length of [4, 5, 6, 7]) {
  test(`纵深防御：昵称与手机号等于令牌中后段的 ${length} 字符子串时置空`, () => {
    // 该变异专门咬住「最短窗口仍是 8」的旧实现：片段取自非零偏移，且长度不足 8。
    const token = NON_PERIODIC_TOKEN
    const fragment = token.slice(73, 73 + length)
    const raw = JSON.stringify({
      account: { uid: 'normal-user-id', nickname: fragment, phoneNumber: fragment },
      auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
    })

    const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })

    assert.equal(s.account.nickname.length, 0, `${length} 字符的完整昵称是令牌子串时必须清空`)
    assert.equal(s.account.phoneMasked.length, 0, `${length} 字符的原手机号是令牌子串时必须在 maskPhone 前清空`)
  })
}

test('纵深防御：uidTail 等于令牌中段 4 字符子串时清空', () => {
  const token = NON_PERIODIC_TOKEN
  const fragment = token.slice(91, 95)
  const raw = JSON.stringify({
    account: { uid: `ordinary-id-${fragment}`, nickname: '测试用户', phoneNumber: '13800001234' },
    auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
  })

  const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })

  assert.equal(s.account.uidTail.length, 0, '截断后的 4 字符 tail 与令牌子串重合时必须清空')
})

test('最终 DTO 兜底：昵称嵌入 4–7 个连续令牌字符时不得返回该片段', () => {
  const token = 'ABCDEFGH0123456789'
  for (const length of [4, 5, 6, 7]) {
    const fragment = token.slice(1, 1 + length)
    const raw = JSON.stringify({
      account: { uid: 'normal-user-id', nickname: `prefix-${fragment}`, phoneNumber: '13800001234' },
      auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
    })
    const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })
    assert.equal(s.account.nickname.includes(fragment), false, `最终昵称不得含 ${length} 个连续令牌字符`)
  }
})

test('最终 DTO 兜底：phoneMasked 的可见后四位若是令牌片段则清空', () => {
  const token = 'zzzzTOKEN1234yyyy'
  const raw = JSON.stringify({
    account: { uid: 'normal-user-id', nickname: '测试用户', phoneNumber: '55555551234' },
    auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
  })

  const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })

  assert.equal(s.account.phoneMasked, '', '打码后仍可见的连续 4 字符令牌片段必须触发清空')
  assert.equal(JSON.stringify(s).includes('1234'), false)
})

test('纵深防御不误伤：正常英文昵称与数字昵称保留', () => {
  for (const { nickname, token } of [
    { nickname: 'Alice_42', token: NON_PERIODIC_TOKEN },
    { nickname: '20260911', token: NON_PERIODIC_TOKEN },
    // 不能把短 token 的任意 1 字符当成嵌入泄漏，否则几乎所有普通昵称都会被误杀。
    { nickname: 'Alice_42', token: 'i' },
    { nickname: '20260911', token: '2' },
  ]) {
    const raw = JSON.stringify({
      account: { uid: 'normal-user-id', nickname, phoneNumber: '13800001234' },
      auth: { accessToken: token, refreshToken: token, expiresAt: 2000 },
    })
    const s = buildStatus({ rawText: raw, now: 0, userAgentFix: false, upstreamHost: 'x' })
    assert.equal(s.account.nickname, nickname)
  }
})

test('maskPhone / tail 对非字符串输入安全降级', () => {
  assert.equal(maskPhone(undefined), '')
  assert.equal(maskPhone(null), '')
  assert.equal(maskPhone(13800001234), '')
  assert.equal(tail(undefined, 4), '')
  assert.equal(tail(null, 4), '')
  assert.equal(tail('abcdef', 0), '')
  assert.equal(tail('abcdef', -1), '')
  assert.equal(maskPhone('1234567'), '123****4567')
})

const CHECKIN_RAW = JSON.stringify({
  auth: { accessToken: 'ck-tok1', refreshToken: 'checkin-refresh-0002', expiresAt: 1_760_000_000_000 + 86_400_000, refreshExpiresAt: 0, lastRefreshTime: 0 },
  account: { uid: 'uid-checkin-0001', nickname: '签到用户', phoneNumber: '13800000007' },
})

test('withCheckin：status 携带签到白名单 DTO，计数取整、脏键与令牌一律丢弃', async () => {
  const { withCheckin } = await import('../lib/status.mjs')
  const envelope = withCheckin(CHECKIN_RAW, {
    enabled: true,
    totalAccounts: 3.9,
    doneToday: 2,
    skippedToday: 1,
    failedToday: 0,
    lastRunAt: 1_760_000_000_000,
    accessToken: 'ck-tok1',
    filePath: 'C:\\synthetic-root\\someone\\workbuddy-auth-checkin.json',
    outcomes: [{ accountId: 'managed:x', done: true }],
  })
  const status = buildStatus({ rawText: envelope, now: 1_760_000_000_000 })
  assert.deepEqual(status.checkin, {
    enabled: true,
    totalAccounts: 3,
    doneToday: 2,
    skippedToday: 1,
    failedToday: 0,
    lastRunAt: 1_760_000_000_000,
  }, '签到 DTO 必须只有白名单六个键')
  assert.equal(JSON.stringify(status).includes('ck-tok1'), false)
  assert.equal(JSON.stringify(status).includes('C:\\\\Users'), false)
  assert.equal(JSON.stringify(status).includes('managed:x'), false)
})

test('withCheckin：缺席时给出关闭的零值 DTO（设置卡无需区分「没有签到」与「签到关闭」）', () => {
  const status = buildStatus({ rawText: CHECKIN_RAW, now: 1_760_000_000_000 })
  assert.deepEqual(status.checkin, { enabled: false, totalAccounts: 0, doneToday: 0, skippedToday: 0, failedToday: 0, lastRunAt: 0 })
})

test('withCheckin 与 withCredits 叠加：异步摘要互不覆盖，失败降级为关闭的零值', async () => {
  const { withCheckin, withCredits } = await import('../lib/status.mjs')
  const envelope = withCheckin(
    withCredits(CHECKIN_RAW, Promise.resolve({ ok: true, remaining: 5, total: 10, used: 5, fetchedAt: 1_760_000_000_000 })),
    Promise.resolve({ enabled: true, totalAccounts: 1, doneToday: 1, skippedToday: 0, failedToday: 0, lastRunAt: 2 }),
  )
  const status = await buildStatus({ rawText: envelope, now: 1_760_000_000_000 })
  assert.equal(status.credits.ok, true)
  assert.equal(status.credits.remaining, 5)
  assert.equal(status.checkin.doneToday, 1)

  const rejected = await buildStatus({ rawText: withCheckin(CHECKIN_RAW, Promise.reject(new Error('store unreadable'))), now: 1_760_000_000_000 })
  assert.equal(rejected.ok, true, '签到状态读失败不得让整个 status 失败')
  assert.deepEqual(rejected.checkin, { enabled: false, totalAccounts: 0, doneToday: 0, skippedToday: 0, failedToday: 0, lastRunAt: 0 })
})

test('buildStatus 无参调用不抛错（route 层依赖它必须永远返回一个对象）', () => {
  const s = buildStatus()
  assert.equal(s.ok, false)
  assert.equal(typeof s.error, 'string')
  assert.equal(s.state.credentialReadable, false)
})

test('attachCredits 失败分支按白名单透传分类枚举，未知值收敛为 unavailable', async () => {
  const { attachCredits } = await import('../lib/status.mjs')
  // 已知枚举必须原样到达 DTO（客户端才能区分「重新登录」与「稍后重试」）
  for (const code of ['auth-rejected', 'request-failed', 'upstream-invalid']) {
    const dto = attachCredits({}, { ok: false, error: code })
    assert.deepEqual(dto.credits, { ok: false, error: code }, `error=${code}`)
  }
  // 未知 / 自由文本一律收敛为 unavailable：错误枚举是脱敏边界，不透传任意字符串
  for (const bad of ['weird', undefined]) {
    const dto = attachCredits({}, { ok: false, error: bad })
    assert.deepEqual(dto.credits, { ok: false, error: 'unavailable' })
  }
  const fallingBack = attachCredits({}, { ok: false })
  assert.deepEqual(fallingBack.credits, { ok: false, error: 'unavailable' })
})
