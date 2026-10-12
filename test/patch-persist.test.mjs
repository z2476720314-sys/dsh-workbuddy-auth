// RED：账号切换的持久化必须真的生效，且**不得破坏用户 patch 的 YAML 形状**。
//
// 线上两个真实缺陷：
//   1. 用户 patch 里从来没有 config.patchFile → persist 恒 false，切换重启即丢；
//      需要能从 DSH_PROFILE_DIR 推断出 profile 的 cordis.patch.yml。
//   2. 用户 patch 的那一行是**覆盖行**（`- id:` + `name:` + 已有 `config:` 块）；
//      旧实现无条件在 name 后追加一行新的 `config:` → 同一个 mapping 出现两个 config 键，
//      YAML 解析直接报错（而 persist 还返回 true，谎报成功）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistCredentialFileToPatch, resolvePatchFile } from '../lib/index.mjs'

const CRED = String.raw`C:\auth\workbuddy-desktop.info`

test('覆盖行 + 已有 config 块：把 credentialFile 插进该块，而不是再造一个 config 键', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-patch-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, [
      '# user patch',
      '- id: dsh-workbuddy-auth',
      '  name: dsh-workbuddy-auth',
      '  config:',
      String.raw`    authDir: 'C:\auth'`,
      '',
      '- id: other-plugin',
      '  name: other-plugin',
      '',
    ].join('\n'))

    assert.equal(await persistCredentialFileToPatch(file, CRED), true)
    const text = readFileSync(file, 'utf8')
    assert.equal((text.match(/^\s*config:/gm) ?? []).length, 1, '同一个条目只能有一个 config 键')
    assert.equal((text.match(/credentialFile:/g) ?? []).length, 1)
    assert.ok(text.includes(`credentialFile: ${CRED}`), text)
    assert.ok(text.includes(String.raw`authDir: 'C:\auth'`), '既有配置必须原样保留')
    assert.ok(text.includes('other-plugin'), '其它条目必须原样保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('insert 包裹形态仍然支持（老 patch 不被破坏）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-patch-insert-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, '# user patch\n- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n')
    assert.equal(await persistCredentialFileToPatch(file, CRED), true)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.includes(`credentialFile: ${CRED}`), text)
    assert.equal((text.match(/^\s*config:/gm) ?? []).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 线上 patch 就是这样被写坏的：insert 包裹形态 + 已有 config.authDir，
// 旧实现用「条目缩进 + 2」= 6 空格插 credentialFile，而 authDir 在 8 空格 ——
// credentialFile 与 config 同级，config 变 null，整个 profile 的 YAML 解析失败。
test('insert 包裹 + 已有 config 块：credentialFile 必须落进 config 里，与已有子键同缩进', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-patch-insert-config-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, [
      '# user patch',
      '- insert:',
      '    - id: dsh-workbuddy-auth',
      '      name: dsh-workbuddy-auth',
      '      config:',
      String.raw`        authDir: 'C:\auth'`,
      '',
      '- insert:',
      '    - id: other-plugin',
      '      name: other-plugin',
      '',
    ].join('\n'))

    assert.equal(await persistCredentialFileToPatch(file, CRED), true)
    const lines = readFileSync(file, 'utf8').split('\n')
    const credentialLine = lines.find((line) => line.includes('credentialFile:'))
    const authDirLine = lines.find((line) => line.includes('authDir:'))
    assert.ok(credentialLine !== undefined && authDirLine !== undefined)
    // 两者必须是 config 的同级子键 —— 缩进相同。
    assert.equal(
      credentialLine.length - credentialLine.trimStart().length,
      authDirLine.length - authDirLine.trimStart().length,
      `credentialFile 与 authDir 必须同缩进，实际：${JSON.stringify({ credentialLine, authDirLine })}`,
    )
    // config: 之后紧跟的子键缩进必须大于 config 自身。
    const configIndex = lines.findIndex((line) => /^\s*config:\s*$/.test(line))
    const configIndent = lines[configIndex].length - lines[configIndex].trimStart().length
    assert.ok(configIndent < credentialLine.length - credentialLine.trimStart().length, '子键必须比 config 更深')
    assert.equal(lines.filter((line) => /^\s*config:\s*$/.test(line)).length, 1, '同一个条目只能有一个 config 键')
    assert.equal((readFileSync(file, 'utf8').match(/credentialFile:/g) ?? []).length, 1)
    assert.ok(readFileSync(file, 'utf8').includes('other-plugin'), '其它条目必须原样保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已有 credentialFile 行时原地替换，不追加', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-patch-replace-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, `- id: dsh-workbuddy-auth\n  name: dsh-workbuddy-auth\n  config:\n    credentialFile: C:\\old.info\n`)
    assert.equal(await persistCredentialFileToPatch(file, CRED), true)
    const text = readFileSync(file, 'utf8')
    assert.equal((text.match(/credentialFile:/g) ?? []).length, 1)
    assert.ok(text.includes(CRED))
    assert.equal(text.includes('old.info'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('找不到本插件条目时返回 false，绝不改动文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-patch-miss-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    const original = '- id: dsh-mnemon\n  name: dsh-mnemon\n'
    writeFileSync(file, original)
    assert.equal(await persistCredentialFileToPatch(file, CRED), false)
    assert.equal(readFileSync(file, 'utf8'), original, '未命中必须原地不动')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolvePatchFile：显式配置优先，其次从 DSH_PROFILE_DIR 推断，都没有则空串', () => {
  assert.equal(resolvePatchFile({ patchFile: 'X:/p.yml' }, { DSH_PROFILE_DIR: 'D:/.dsh/profiles/desktop' }), 'X:/p.yml')
  assert.equal(
    resolvePatchFile({}, { DSH_PROFILE_DIR: join('D:', 'dsh', 'profiles', 'desktop') }),
    join('D:', 'dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
  )
  assert.equal(resolvePatchFile({ patchFile: '' }, {}), '', '空串是显式关闭（与 authDir 同语义）')
  assert.equal(resolvePatchFile({}, {}), '')
})
