import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { defaultDshCommandPath, defaultRunDsh } from '../bin/cli.mjs'

async function createStub() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-runner-'))
  const stubDir = join(root, 'stub & safe')
  const scriptPath = join(root, 'stub.mjs')
  const commandPath = join(stubDir, 'dsh.cmd')
  await mkdir(stubDir)
  await writeFile(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", 'utf8')
  await writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\nexit /b %DSH_STUB_EXIT_CODE%\r\n`, 'utf8')
  return { root, commandPath }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('Windows command lookup resolves dsh.cmd specifically', async () => {
  const commandPath = await defaultDshCommandPath({ platform: 'win32', env: process.env })
  assert.match(commandPath, /dsh\.cmd$/iu)
})

test('Windows runner invokes the installed dsh.cmd --version successfully', async () => {
  const result = await defaultRunDsh(['--version'], {
    platform: 'win32',
    candidates: ['dsh.cmd'],
    env: process.env,
  })

  assert.equal(result.code, 0)
  assert.match(result.stdout, /^\d+\.\d+\.\d+/u)
})

test('Windows runner invokes a real dsh.cmd without EINVAL and preserves hostile profile/packageSpec text', async (t) => {
  const stub = await createStub()
  t.after(() => rm(stub.root, { recursive: true, force: true }))
  const canaryPath = join(stub.root, 'injected.txt').replaceAll('\\', '/')
  const profile = `profile&echo INJECTED>${canaryPath}|rem <input ^caret %PATH% !bang! (paren)`
  const packageSpec = `file:C:/fixture/pkg & | < > ^ %PATH% !bang! (test)`
  const env = { ...process.env, DSH_STUB_EXIT_CODE: '23' }

  const result = await defaultRunDsh(['plugin', '--profile', profile, 'add', packageSpec], {
    platform: 'win32',
    candidates: [stub.commandPath],
    env,
  })

  assert.equal(result.code, 23)
  assert.deepEqual(JSON.parse(result.stdout), ['plugin', '--profile', profile, 'add', packageSpec])
  assert.equal(await pathExists(canaryPath), false)
})

test('Windows runner preserves a resolved command path containing percent signs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-runner-'))
  const commandDir = join(root, '%PATH% safe')
  const commandPath = join(commandDir, 'dsh.cmd')
  await mkdir(commandDir)
  await writeFile(commandPath, '@echo off\r\nexit /b 29\r\n', 'utf8')
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await defaultRunDsh([], { platform: 'win32', candidates: [commandPath], env: process.env })
  assert.equal(result.code, 29)
})

test('Windows runner preserves one or multiple trailing backslashes through a real dsh.cmd', async (t) => {
  const stub = await createStub()
  t.after(() => rm(stub.root, { recursive: true, force: true }))
  const packageSpecs = ['file:C:\\fixture\\pkg\\', 'file:C:\\fixture\\pkg\\\\']

  const result = await defaultRunDsh(packageSpecs, {
    platform: 'win32',
    candidates: [stub.commandPath],
    env: { ...process.env, DSH_STUB_EXIT_CODE: '0' },
  })

  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), packageSpecs)
})

test('Windows runner resolves a real dsh.cmd from PATH after a nonexistent candidate', async (t) => {
  const stub = await createStub()
  t.after(() => rm(stub.root, { recursive: true, force: true }))
  const missingPath = join(stub.root, 'missing-dsh.cmd')
  const env = {
    ...process.env,
    DSH_STUB_EXIT_CODE: '0',
    PATH: `${join(stub.root, 'stub & safe')}${delimiter}${process.env.PATH ?? ''}`,
  }

  const result = await defaultRunDsh(['--version'], {
    platform: 'win32',
    candidates: [missingPath, 'dsh.cmd'],
    env,
  })

  assert.equal(result.code, 0)
  assert.equal(result.command, 'dsh.cmd')
  assert.deepEqual(JSON.parse(result.stdout), ['--version'])
})

test('non-Windows runner directly spawns the candidate without shell interpretation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-runner-posix-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const scriptPath = join(root, 'stub.mjs')
  const canaryPath = join(root, 'injected.txt').replaceAll('\\', '/')
  const hostile = `value&echo INJECTED>${canaryPath}`
  await writeFile(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", 'utf8')

  const result = await defaultRunDsh([scriptPath, hostile], {
    platform: 'linux',
    candidates: [process.execPath],
  })

  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), [hostile])
  assert.equal(await pathExists(canaryPath), false)
})
