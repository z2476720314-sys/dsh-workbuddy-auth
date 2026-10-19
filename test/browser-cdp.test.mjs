// 回归护栏：登录探测必须用**浏览器级可用**的 CDP 域，且永久性协议错误不能被轮询吞掉。
//
// 背景（真实故障）：`allCookies()` 曾发 `Network.getAllCookies` —— 那是 page 域方法，
// 挂在浏览器级 socket 上只会得到 `-32601 'Network.getAllCookies' wasn't found`。
// 而 `run()` 把所有探测异常都当瞬时抖动 `.catch` 掉，于是用户登录成功后界面永久停在
// 「等待登录」，没有任何错误线索。本文件同时锁住这两半。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { toProtocolError } from '../lib/browser-cdp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = resolve(here, '..', 'lib')

test('allCookies 用 Storage.getCookies，不用 page 域的 Network.getAllCookies', () => {
  const source = readFileSync(join(libDir, 'browser-cdp.mjs'), 'utf8')
  // 只看实际发出去的调用，不看注释；注释里保留这段历史是刻意的。
  const sent = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  assert.match(sent, /cdp\.send\('Storage\.getCookies'\)/, '必须用浏览器级可用的 Storage 域')
  assert.equal(
    /cdp\.send\('Network\.getAllCookies'/.test(sent),
    false,
    'Network 是 page 域，挂在浏览器级 socket 上会 -32601',
  )
})

test('toProtocolError：-32601 / -32602 标为永久错误，其余为可重试', () => {
  const missing = toProtocolError({ code: -32601, message: "'Network.getAllCookies' wasn't found" })
  assert.equal(missing instanceof Error, true)
  assert.equal(missing.code, 'CDP_METHOD_UNAVAILABLE')
  assert.equal(missing.permanent, true)
  assert.equal(missing.cdpCode, -32601)
  assert.match(missing.message, /Network\.getAllCookies/)

  const badParams = toProtocolError({ code: -32602, message: 'Invalid parameters' })
  assert.equal(badParams.code, 'CDP_INVALID_PARAMS')
  assert.equal(badParams.permanent, true)

  // 其它协议错误（例如 target 正在导航导致的临时失败）不标永久，轮询可以继续。
  const transient = toProtocolError({ code: -32000, message: 'Cannot find context' })
  assert.equal(transient.code, 'CDP_PROTOCOL_ERROR')
  assert.equal(transient.permanent, false)

  // 非对象输入也不能抛：协议层给什么都要能包成 Error。
  const weird = toProtocolError('boom')
  assert.equal(weird instanceof Error, true)
  assert.equal(weird.permanent, false)
})

test('登录轮询遇到永久性错误立刻收尾，不把它当作可重试抖动', () => {
  const source = readFileSync(join(libDir, 'agentmore-login.mjs'), 'utf8')
  const body = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  // 必须显式判别 permanent 并落成 error 状态。
  assert.match(body, /error\?\.permanent === true/)
  assert.match(body, /runState\.status = 'error'/)
  // 且不能退回到「把 tryComplete 整个 .catch 成 false」的旧写法：
  // 那正是让 -32601 永久静默的写法。
  assert.equal(
    /tryComplete\(runState\)\.catch\(/.test(body),
    false,
    '不能再用 .catch(() => false) 吞掉全部探测异常',
  )
})
