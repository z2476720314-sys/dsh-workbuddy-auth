// 刷新结果的原子写回 —— 合并语义与落盘语义测试。
// 本文件只使用临时目录 + 运行时合成的假串：绝不读写真实凭据文件，也绝不打印任何 token。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeRefreshedRecord, writeCredentialAtomically } from '../lib/writeback.mjs'
// 仅用于补充用例：验证「保留原值」不变量在下游 needsRefresh 上不产生刷新风暴。
import { parseCredentialRecord, needsRefresh } from '../lib/credential.mjs'

const RAW = JSON.stringify({ account: { uid: 'u' }, auth: { accessToken: 'old', refreshToken: 'R1', expiresAt: 1, refreshExpiresAt: 2, lastRefreshTime: 10 }, other: { keep: true } })

test('mergeRefreshedRecord 更新 auth 字段并保留其余内容', () => {
  const out = JSON.parse(mergeRefreshedRecord(RAW, { accessToken: 'new', refreshToken: 'R2', expiresAt: 111 }, 12345))
  assert.equal(out.auth.accessToken, 'new')
  assert.equal(out.auth.refreshToken, 'R2')
  assert.equal(out.auth.expiresAt, 111)
  assert.equal(out.auth.refreshExpiresAt, 2, '未提供的字段保持原值')
  assert.equal(out.auth.lastRefreshTime, 12345)
  assert.equal(out.other.keep, true)
})

test('mergeRefreshedRecord 缺 refreshToken 时保留旧值', () => {
  const out = JSON.parse(mergeRefreshedRecord(RAW, { accessToken: 'new' }, 1))
  assert.equal(out.auth.refreshToken, 'R1')
})

test('writeCredentialAtomically 落盘且不留临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')
  writeCredentialAtomically(file, '{"ok":true}')
  assert.equal(readFileSync(file, 'utf8'), '{"ok":true}')
  assert.deepEqual(readdirSync(dir), ['cred.info'])
})

// —— 以下为 brief 之外的补充边界用例（不修改上面的断言）——

test('不变量：未提供的刷新字段绝不写成 undefined，下游 needsRefresh 不会因此触发刷新风暴', () => {
  // 只给 accessToken：其余字段全部缺省，必须全部沿用旧值（而不是被写成 undefined）。
  const text = mergeRefreshedRecord(RAW, { accessToken: 'new' }, 999)
  const out = JSON.parse(text)
  // 真正的风险是「键被静默删除」：JSON 里不存在 undefined，一旦某字段被写成 undefined，
  // JSON.stringify 会直接丢掉该键，因此必须用「键存在」而不是「值 !== undefined」来断言
  // （后者作用在 JSON.parse 的结果上恒为真，对任何实现都通过，给不出任何保证）。
  assert.equal(out.auth.accessToken, 'new')
  assert.ok('accessToken' in out.auth, 'accessToken 键必须存在')
  assert.ok('refreshToken' in out.auth, 'refreshToken 键必须存在')
  assert.ok('expiresAt' in out.auth, 'expiresAt 键必须存在')
  assert.ok('refreshExpiresAt' in out.auth, 'refreshExpiresAt 键必须存在')
  assert.ok('lastRefreshTime' in out.auth, 'lastRefreshTime 键必须存在')
  assert.equal(out.auth.expiresAt, 1, 'expiresAt 必须保留旧值')
  assert.equal(out.auth.refreshExpiresAt, 2, 'refreshExpiresAt 必须保留旧值')

  // 下游后果：若 expiresAt 被写成 undefined，needsRefresh 会把它当成「缺失=需刷新」而永远为真。
  const record = parseCredentialRecord(mergeRefreshedRecord(RAW, { accessToken: 'new' }, 999))
  assert.equal(needsRefresh(record, 0, 0), false, '刚写回的记录不应立刻又要求刷新')
})

test('mergeRefreshedRecord 缺少 accessToken 时拒绝写回，绝不静默删除该键', () => {
  // accessToken 是本函数唯一无条件的必填字段：若把它写成 undefined，
  // JSON.stringify 会静默删除该键，原子写回的记录将不含 accessToken，
  // 旧 token 已被覆盖、登录态被销毁（parseCredentialRecord 会直接抛错）。
  // 因此这里必须显式拒绝，而不是产出「看起来合法」的残缺文本。
  for (const refreshed of [{}, { refreshToken: 'R2' }, { expiresAt: 111 }, { accessToken: undefined }]) {
    assert.throws(
      () => mergeRefreshedRecord(RAW, refreshed, 1),
      /refreshed record is missing accessToken/,
      `必须拒绝缺 accessToken 的结果：${JSON.stringify(refreshed)}`,
    )
  }
  // 非字符串 / 空串同样不构成可用令牌。
  for (const accessToken of ['', null, 0, false, ['a']]) {
    assert.throws(() => mergeRefreshedRecord(RAW, { accessToken }, 1), /refreshed record is missing accessToken/)
  }
  // 反向对照：既不能抛错的合法输入依然被接受，并真的带出 accessToken 键。
  const ok = JSON.parse(mergeRefreshedRecord(RAW, { accessToken: 'new' }, 1))
  assert.equal(ok.auth.accessToken, 'new')
})

test('writeCredentialAtomically 覆盖已有文件且目录中不残留 .tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')
  writeCredentialAtomically(file, '{"accessToken":"a1"}')
  writeCredentialAtomically(file, '{"accessToken":"a2"}')
  assert.equal(readFileSync(file, 'utf8'), '{"accessToken":"a2"}')
  assert.deepEqual(readdirSync(dir), ['cred.info'], '两次写入后都不得留下临时文件')
})

test('writeCredentialAtomically 在目标不存在时也能创建文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'fresh.info')
  writeCredentialAtomically(file, '{"ok":true}')
  assert.equal(readFileSync(file, 'utf8'), '{"ok":true}')
  assert.deepEqual(readdirSync(dir), ['fresh.info'])
})

test('mergeRefreshedRecord 缺失 auth 时按新记录补齐而不是抛出', () => {
  const out = JSON.parse(mergeRefreshedRecord(JSON.stringify({ account: { uid: 'u' } }), { accessToken: 'new', expiresAt: 5 }, 7))
  assert.equal(out.auth.accessToken, 'new')
  assert.equal(out.auth.expiresAt, 5)
  assert.equal(out.auth.lastRefreshTime, 7)
  assert.equal(out.account.uid, 'u')
})

// —— 写回失败路径 ——
//
// 评审在 %TEMP% 实测复现的缺陷：renameSync 抛 EPERM 时旧实现直接把错误扔出来，
// 目录里留下含**完整新凭据**的 `*.tmp`，目标文件仍是可能已失效的旧 refresh token。
// 服务端这次刷新已经把 refresh token 轮换掉了，新值只存在于那个 .tmp 里 —— 续期链路卡死。
// 下面五条分别钉住：失败必清理 tmp、目标不变、错误原样抛出、rename 重试一次、fsync 在 rename 之前。

/**
 * 构造可控的 fs 假实现。默认全部直接落盘（真实 I/O），只把指定的"破坏"注入进去 ——
 * 这样断言里的 tmp 残留检查依然是对真实目录做 `readdirSync`，而不是对着假实现自说自话。
 *
 * `unlinkFails` 是「清理能失败几次」的**显式**计数器：>0 时前 N 次 unlink 抛 EPERM
 * （模拟占位进程同时锁住 tmp），之后恢复可删。用显式计数器而不是让 rename 失败自动连带锁住 tmp，
 * 是为了让每个用例只钉住一个语义，而不是把两条因果链缠在一起。
 *
 * @param {{failWriteTimes?:number, failRenameTimes?:number, unlinkFails?:number}} [opts]
 */
function fakeFs({ failWriteTimes = 0, failRenameTimes = 0, unlinkFails = 0 } = {}) {
  const calls = []
  const renames = []
  const state = { renameFailuresLeft: failRenameTimes, writeFailuresLeft: failWriteTimes, unlinkFailuresLeft: unlinkFails, unlinkCalls: 0, cleanupSucceeded: false }
  return {
    calls,
    renames,
    state,
    writeFileSync: (p, c) => { calls.push('write'); if (state.writeFailuresLeft > 0) { state.writeFailuresLeft -= 1; throw new Error('EIO: write failed') } writeFileSync(p, c, 'utf8') },
    openSync: (p, f) => { calls.push('open'); if (state.writeFailuresLeft > 0) { state.writeFailuresLeft -= 1; throw new Error('EIO: open failed') } return openSync(p, f) },
    writeSync: (fd, c) => { calls.push('writeSync'); if (state.writeFailuresLeft > 0) { state.writeFailuresLeft -= 1; throw new Error('EIO: write failed') } return writeSync(fd, c, null, 'utf8') },
    fsyncSync: (fd) => { calls.push('fsync'); return fsyncSync(fd) },
    closeSync: (fd) => { calls.push('close'); return closeSync(fd) },
    renameSync: (from, to) => {
      calls.push('rename')
      if (state.renameFailuresLeft > 0) {
        state.renameFailuresLeft -= 1
        const err = new Error('EPERM: operation not permitted, rename')
        err.code = 'EPERM'
        throw err
      }
      renames.push([from, to])
      return renameSync(from, to)
    },
    unlinkSync: (p) => {
      state.unlinkCalls += 1
      calls.push('unlink')
      if (state.unlinkFailuresLeft > 0) {
        state.unlinkFailuresLeft -= 1
        const err = new Error('EPERM: operation not permitted, unlink')
        err.code = 'EPERM'
        throw err
      }
      state.cleanupSucceeded = true
      return unlinkSync(p)
    },
  }
}

test('写入阶段失败：清理 tmp、目标文件不变、原始错误被原样抛出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')

  // 在真正的写入阶段（open/write）注入一次 EIO：这是比"磁盘满/句柄失效"更接近现实的失败点。
  const fsImpl = fakeFs({ failWriteTimes: 1 })
  assert.throws(() => writeCredentialAtomically(file, '{"accessToken":"brand-new"}', fsImpl), /EIO: open failed/)
  assert.equal(readFileSync(file, 'utf8'), RAW, '目标文件内容必须不变')
  assert.deepEqual(readdirSync(dir), ['cred.info'], '不得残留 .tmp')
  assert.equal(fsImpl.state.unlinkCalls, 1, '必须尝试清理 tmp')
  assert.ok(!fsImpl.calls.includes('rename'), '写入阶段失败后不得继续 rename')
})

test('renameSync 持续失败（EPERM 复现）：只重试一次、目标不变、错误抛出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')

  // failRenameTimes=99 且 unlinkFails=99：两次 rename 尝试与清理尝试全部失败（tmp 被占用时两者同源被拒）。
  const fsImpl = fakeFs({ failRenameTimes: 99, unlinkFails: 99 })
  assert.throws(() => writeCredentialAtomically(file, '{"accessToken":"brand-new","refreshToken":"R2"}', fsImpl), /EPERM/)
  assert.equal(fsImpl.state.renameFailuresLeft, 97, '必须恰好重试一次（两次 rename 尝试）')
  assert.equal(fsImpl.state.unlinkCalls, 1, '两次 rename 尝试都失败后才尝试清理一次（重试先于删除）；清理被拒后原样抛出原始错误，不再重试')
  assert.equal(readFileSync(file, 'utf8'), RAW, '目标文件必须保持旧值')
})

test('renameSync 持续失败但源可删：含新轮换凭据的 .tmp 必须被清掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')

  const fsOk = fakeFs({ failRenameTimes: 99 })
  assert.throws(() => writeCredentialAtomically(file, '{"accessToken":"brand-new","refreshToken":"R2"}', fsOk), /EPERM/)
  assert.equal(fsOk.state.renameFailuresLeft, 97, '重试一次后放弃（恰好两次 rename 尝试）')
  assert.ok(fsOk.state.unlinkCalls >= 1, '失败后必须尝试清理 tmp')
  assert.equal(readFileSync(file, 'utf8'), RAW, '目标文件必须保持旧值')
  // 这是本次修复的核心断言：旧实现在这里会留下含**完整新凭据**的 .tmp。
  assert.deepEqual(readdirSync(dir), ['cred.info'], '含新轮换凭据的 .tmp 必须被清掉')
})

test('renameSync 首次 EPERM、重试成功：新内容落盘且不留 tmp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')

  // 真实的瞬时冲突只有一种语义：首次 rename 被拒，但 tmp **仍在**（还没被清理），
  // 因此第二次 rename 才有成功的可能。旧用例把 unlinkFails: 1 说成「Windows 上的现实路径」，
  // 那是为了让「先清理再重试」这种错误顺序也能通过而硬造的前提 —— 实际上清理一旦成功，
  // tmp 就没了，重试只可能抛 ENOENT。这里不再注入清理失败。
  const fsImpl = fakeFs({ failRenameTimes: 1 })
  writeCredentialAtomically(file, '{"accessToken":"a2"}', fsImpl)
  assert.equal(fsImpl.state.renameFailuresLeft, 0, '重试必须真的发生')
  assert.equal(fsImpl.renames.length, 1, '重试的那次 rename 必须成功')
  assert.equal(fsImpl.state.unlinkCalls, 0, '重试成功时 tmp 已被 rename 消费，不得再尝试清理')
  assert.equal(readFileSync(file, 'utf8'), '{"accessToken":"a2"}')
  assert.deepEqual(readdirSync(dir), ['cred.info'])
})

test('rename 先重试后清理：清理不得把原始 EPERM 顶替成 ENOENT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')

  // rename 持续被拒（目标文件被占用），但 tmp 本身可删。
  // 旧顺序「先 removeTmp() 再重试」会让第二次 rename 面对一个已被删掉的 tmp，
  // 必然抛 ENOENT —— 真实的 EPERM（目标被占用）就这样被顶替成误导性的「文件不存在」。
  const fsImpl = fakeFs({ failRenameTimes: 99 })
  let thrown
  try {
    writeCredentialAtomically(file, '{"accessToken":"brand-new","refreshToken":"R2"}', fsImpl)
    assert.fail('rename 持续失败时必须抛出')
  } catch (error) {
    thrown = error
  }

  const renameIdx = fsImpl.calls.reduce((acc, c, i) => (c === 'rename' ? [...acc, i] : acc), [])
  assert.equal(renameIdx.length, 2, '必须恰好两次 rename 尝试')
  assert.ok(fsImpl.calls.includes('unlink'), '仍失败后必须尝试清理 tmp')
  assert.ok(renameIdx[1] < fsImpl.calls.indexOf('unlink'), '第二次 rename（重试）必须发生在删除 tmp 之前')
  assert.equal(thrown.code, 'EPERM', '最终抛出的必须是**首次** rename 的原始 EPERM')
  assert.doesNotMatch(String(thrown.message), /ENOENT/, '不得被「清理后 tmp 已不存在」的 ENOENT 顶替')
  assert.equal(readFileSync(file, 'utf8'), RAW, '目标文件内容必须不变')
  assert.deepEqual(readdirSync(dir), ['cred.info'], 'tmp 可删时不得残留')
})

test('rename 前先 fsync（断电窗口不得把凭据文件变成 0 字节）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  const fsImpl = fakeFs()
  writeCredentialAtomically(file, '{"ok":true}', fsImpl)
  assert.ok(fsImpl.calls.includes('fsync'), '必须调用 fsyncSync')
  assert.ok(fsImpl.calls.indexOf('fsync') < fsImpl.calls.indexOf('rename'), 'fsync 必须发生在 rename 之前')
  assert.deepEqual(fsImpl.calls.slice(-2), ['close', 'rename'])
  assert.equal(fsImpl.state.unlinkCalls, 0, '成功路径不做任何清理')
  assert.deepEqual(readdirSync(dir), ['cred.info'])
  assert.equal(readFileSync(file, 'utf8'), '{"ok":true}')
})

test('清理 tmp 自身失败时不得掩盖原始错误（tmp 残留作为已知限制被如实钉住）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-'))
  const file = join(dir, 'cred.info')
  writeFileSync(file, RAW, 'utf8')

  const fsImpl = fakeFs({ failRenameTimes: 99, unlinkFails: 99 })
  assert.throws(() => writeCredentialAtomically(file, '{"accessToken":"brand-new"}', fsImpl), /EPERM/)
  assert.equal(readFileSync(file, 'utf8'), RAW, '目标文件仍必须保持旧值')
  // 清理失败时 tmp 必然残留 —— 这里如实地把这条限制钉住，而不是假装它不会发生。
  // （实现选择"原样重抛原始错误"，因此不为此再抛第二个错误。）
  assert.ok(readdirSync(dir).some((n) => n.endsWith('.tmp')), 'unlink 失败时 tmp 会残留（已如实记录的限制）')
})
