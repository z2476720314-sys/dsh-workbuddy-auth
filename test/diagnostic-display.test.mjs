// F1/F2/F3（复审 2026-10-13）：诊断字段的**展示白名单**必须按「已知取值」判定，
// 不能按「形状像不像域名 / 标识符」判定。
//
// 为什么：形状闸门（`[a-z0-9.-]`、标识符正则）对上游完全可控的字符串是无效防线——
// 复审已实证 `TOKENCANARY.example`、`p13800138000.example`、`{error:'13800138000'}`、
// `{code:'13800138000'}` 四类字符串都能整串过关，然后以「域 / 错误名 / 业务码」的身份
// 出现在 progress、detail 与 trace 三处文案里（手机号与令牌串就这么漏出去）。
//
// 本文件锁定三层共用的规则模块：合法值原样保留，其余一律**丢字段**（不是截断、不是替换），
// 需要占位词的地方由文案侧自行显示「未知」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DISPLAY_DOMAINS,
  DISPLAY_ERROR_NAMES,
  DISPLAY_HTTP_STATUS_MAX,
  DISPLAY_HTTP_STATUS_MIN,
  DISPLAY_STEPS,
  DISPLAY_UPSTREAM_CODES,
  UNKNOWN_DISPLAY_DOMAIN,
  displayDomain,
  displayField,
  isDisplayDomain,
} from '../lib/diagnostic-display.mjs'

/** 上游完全可控的 canary：任何一个被当成域 / 错误名 / 业务码展示出来都算漏。 */
const TOKEN_CANARY = 'TOKENCANARY'
const PHONE_CANARY = '13800138000'
const PATH_CANARY = 'C:\\private\\secret-token.json?state=STATE_CANARY&token=TOKEN_CANARY'

test('已知域集合：CN / Intl 认证域与后端 host 在表内，其余一律不是域', () => {
  for (const known of [
    'copilot.tencent.com',
    'tencent.com',
    'codebuddy.cn',
    'www.codebuddy.cn',
    'workbuddy.ai',
    'www.workbuddy.ai',
    'codebuddy.ai',
    'www.codebuddy.ai',
  ]) {
    assert.equal(DISPLAY_DOMAINS.has(known), true, `${known} 是已知域`)
    assert.equal(isDisplayDomain(known), true, `${known} 可展示`)
    assert.equal(displayDomain(known), known)
  }
  for (const unknown of [
    'www.example-alien.cn',
    'TOKENCANARY.example',
    'p13800138000.example',
    TOKEN_CANARY,
    PHONE_CANARY,
    'token.copilot.tencent.com',
    PATH_CANARY,
    'https://copilot.tencent.com.evil.example/',
  ]) {
    assert.equal(isDisplayDomain(unknown), false, `${unknown} 不是已知域`)
    assert.equal(displayDomain(unknown), UNKNOWN_DISPLAY_DOMAIN)
  }
})

test('域展示只输出表内固定值：origin / 带路径 query 的串先归一化再判表', () => {
  assert.equal(displayDomain('https://copilot.tencent.com/login?state=STATE_CANARY'), 'copilot.tencent.com')
  assert.equal(displayDomain('COPILOT.TENCENT.COM.'), 'copilot.tencent.com')
  assert.equal(displayDomain(PATH_CANARY), UNKNOWN_DISPLAY_DOMAIN)
})

test('error 只认运行时真实错误名枚举，标识符串与手机号一律丢', () => {
  for (const name of DISPLAY_ERROR_NAMES) {
    assert.equal(displayField('error', name), name)
  }
  assert.deepEqual([...DISPLAY_ERROR_NAMES].sort(), ['AbortError', 'Error', 'SyntaxError', 'TypeError'])
  for (const bad of [TOKEN_CANARY, PHONE_CANARY, 'E'.repeat(400), PATH_CANARY, '../../etc/passwd']) {
    assert.equal(displayField('error', bad), undefined, `${bad} 不得作为错误名展示`)
  }
})

test('step 只认本插件自己写下的阶段字面量', () => {
  assert.deepEqual([...DISPLAY_STEPS].sort(), ['credential', 'state', 'store', 'token'])
  assert.equal(displayField('step', 'token'), 'token')
  assert.equal(displayField('step', '../../etc/passwd'), undefined)
  assert.equal(displayField('step', TOKEN_CANARY), undefined)
})

test('业务码只认有代码证据的协议码；数字串不因能转数字而被放行', () => {
  assert.deepEqual([...DISPLAY_UPSTREAM_CODES].sort((a, b) => a - b), [0, 401, 11128, 11217, 12403])
  for (const known of DISPLAY_UPSTREAM_CODES) {
    assert.equal(displayField('code', known), known)
  }
  // 500 只是 HTTP 状态，不是有证据的**业务**码（复审之前它靠形状闸门原样展示）。
  for (const bad of [500, 13800138000, PHONE_CANARY, -1, 1.5]) {
    assert.equal(displayField('code', bad), undefined, `${bad} 不得作为业务码展示`)
  }
})

test('数值字段按 key 各自的范围判定，其他 key 的数值绝不外泄', () => {
  assert.equal(displayField('at', 1791900000000), 1791900000000)
  assert.equal(displayField('at', -1), undefined)
  assert.equal(displayField('at', '1791900000000'), undefined)
  assert.equal(displayField('httpStatus', 503), 503)
  assert.equal(displayField('httpStatus', DISPLAY_HTTP_STATUS_MIN), DISPLAY_HTTP_STATUS_MIN)
  assert.equal(displayField('httpStatus', DISPLAY_HTTP_STATUS_MAX), DISPLAY_HTTP_STATUS_MAX)
  assert.equal(displayField('httpStatus', 600), undefined)
  assert.equal(displayField('httpStatus', 99), undefined)
  assert.equal(displayField('httpStatus', PHONE_CANARY), undefined)
  // 上游把数字塞进字符串字段（或字符串塞进数字字段）——两个方向都不放行。
  assert.equal(displayField('error', PHONE_CANARY), undefined)
  assert.equal(displayField('host', 13800138000), undefined)
  assert.equal(displayField('domain', 13800138000), undefined)
  // 数字分支按 key 走：只有 at / httpStatus / code 收数字，error / step 收数字必须丢。
  assert.equal(displayField('error', 13800138000), undefined)
  assert.equal(displayField('step', 13800138000), undefined)
  assert.equal(displayField('step', 5), undefined)
})

test('canary 全字段扫描：任意 key 都不得把令牌 / 手机号 / 本地路径带出去', () => {
  const dirty = {
    step: TOKEN_CANARY,
    reason: 'network',
    host: PATH_CANARY,
    domain: `p${PHONE_CANARY}.example`,
    httpStatus: PHONE_CANARY,
    code: PHONE_CANARY,
    error: PHONE_CANARY,
    at: PHONE_CANARY,
  }
  const dirtyNumeric = {
    step: 13800138000,
    reason: 'network',
    host: 13800138000,
    domain: 13800138000,
    httpStatus: 13800138000,
    code: 13800138000,
    error: 13800138000,
    at: -13800138000,
  }
  const kept = Object.fromEntries(
    Object.keys(dirty)
      .map((key) => [key, displayField(key, dirty[key])])
      .filter(([, value]) => value !== undefined),
  )
  const keptNumeric = Object.fromEntries(
    Object.keys(dirtyNumeric)
      .map((key) => [key, displayField(key, dirtyNumeric[key])])
      .filter(([, value]) => value !== undefined),
  )
  const rendered = JSON.stringify(kept) + JSON.stringify(keptNumeric)
  assert.equal(rendered.includes(TOKEN_CANARY), false, `不得回显令牌 canary：${rendered}`)
  assert.equal(rendered.includes(PHONE_CANARY), false, `不得回显手机号 canary：${rendered}`)
  assert.equal(rendered.includes('secret-token.json'), false, `不得回显本地路径：${rendered}`)
  assert.deepEqual(kept, {}, '整条脏事件不该留下任何可展示字段')
})
