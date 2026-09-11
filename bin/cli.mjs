#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import {
  backupSettings,
  createDshValidator,
  createLegacyPatchEditor,
  createSettingsEditor,
  hasPluginDependency,
  isPluginInstalled,
  loadDshYaml,
  loadProfileManifest,
  readCodeBuddyIdentity,
  readSettings,
  replaceSettingsAtomically,
  replaceTextAtomically,
  resolveDshInstallRoot,
  restoreProfilePatch,
  restoreSettings,
  withValidatedTemp,
} from './config.mjs'

const PACKAGE_NAME = 'dsh-workbuddy-auth'
const PACKAGE_VERSION = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const DEFAULT_PACKAGE_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`
const SAFE_CREDENTIAL_DISPLAY = String.raw`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info`
const USAGE = `Usage: dsh-workbuddy-auth <install|uninstall|doctor> [--profile <name>] [--dry-run] [--package-spec <spec>]`

const ERROR_MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Invalid command arguments. Run with install, uninstall, or doctor and supported options.',
  UNSUPPORTED_PLATFORM: 'dsh-workbuddy-auth supports Windows only.',
  DSH_UNAVAILABLE: 'DSH is required and must be available on PATH.',
  LOGIN_UNAVAILABLE: `CodeBuddy login is unavailable. Sign in first; expected credential location: ${SAFE_CREDENTIAL_DISPLAY}`,
  CONFIG_CONFLICT: 'Existing WorkBuddy configuration is not owned by dsh-workbuddy-auth; no changes were made.',
  PLUGIN_ADD_FAILED: 'DSH plugin add failed; settings were not changed.',
  PLUGIN_ADD_ROLLBACK_FAILED: 'DSH plugin add failed and rollback was incomplete; restore the legacy profile patch from this run\'s backup.',
  PLUGIN_REMOVE_FAILED: 'DSH plugin remove failed; settings were rolled back.',
  INSTALL_FAILED: 'Installation failed; prior configuration was restored where possible.',
  INSTALL_FAILED_DEPENDENCY_PRESERVED: 'Installation failed; prior configuration was restored and the existing dependency was preserved for manual review.',
  UNINSTALL_FAILED: 'Uninstallation failed; prior configuration was restored where possible.',
  OPERATION_FAILED: 'Operation failed; no credential or path details were printed.',
})

class CliError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new CliError(code)
}

function parseArgs(argv) {
  const options = { command: undefined, profile: 'web', dryRun: false, packageSpec: DEFAULT_PACKAGE_SPEC, packageSpecOverridden: false }
  const args = [...argv]
  options.command = args.shift()
  while (args.length > 0) {
    const arg = args.shift()
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--profile') {
      const value = args.shift()
      if (!value) fail('INVALID_ARGUMENT')
      options.profile = value
    } else if (arg === '--package-spec') {
      const value = args.shift()
      if (!value) fail('INVALID_ARGUMENT')
      options.packageSpec = value
      options.packageSpecOverridden = true
    } else fail('INVALID_ARGUMENT')
  }
  if (!['install', 'uninstall', 'doctor'].includes(options.command)) fail('INVALID_ARGUMENT')
  if (!/^[A-Za-z0-9._-]+$/u.test(options.profile) || options.profile === '.' || options.profile === '..') fail('INVALID_ARGUMENT')
  if (options.packageSpecOverridden) {
    const localSpec = options.packageSpec.startsWith('file:') ? options.packageSpec.slice(5) : options.packageSpec
    if (/["'&|<>^%!`$();\r\n]/u.test(options.packageSpec) || !isAbsolute(localSpec)) fail('INVALID_ARGUMENT')
  }
  if (options.command !== 'install' && options.packageSpecOverridden) fail('INVALID_ARGUMENT')
  return options
}

function resolvePaths(env, profile) {
  const dshHome = env.DSH_HOME || join(env.USERPROFILE || homedir(), '.dsh')
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) fail('OPERATION_FAILED')
  return {
    dshHome,
    settingsPath: join(dshHome, 'settings.yaml'),
    profilePath: join(dshHome, 'profiles', profile, 'package.json'),
    profilePatchPath: join(dshHome, 'profiles', profile, 'cordis.patch.yml'),
    credentialPath: join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info'),
  }
}

function executableCandidates(platform = process.platform) {
  return platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
}

function spawnResult(file, args, options, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr, command }))
  })
}

async function cmdInvocation(command, args, env) {
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe'
  const wrapperDir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-runner-'))
  const wrapperPath = join(wrapperDir, 'run.cmd')
  const argNames = args.map((_, index) => `DSH_WORKBUDDY_ARG_${index}`)
  const childEnv = { ...env }
  for (const [index, value] of args.entries()) childEnv[argNames[index]] = value.replace(/(\\+)$/u, '$1$1')
  childEnv.DSH_WORKBUDDY_COMMAND = command
  const invocation = `"%DSH_WORKBUDDY_COMMAND%"${argNames.map((name) => ` "%${name}%"`).join('')}`
  await writeFile(wrapperPath, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${invocation}\r\nexit /b %errorlevel%\r\n`, 'utf8')
  return { file: comspec, args: ['/d', '/v:off', '/c', 'call', wrapperPath], env: childEnv, wrapperDir }
}

async function whereCmdCandidate(command, env) {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    await access(command)
    return command
  }
  const where = await spawnResult('where.exe', [command], { env }, 'where.exe')
  if (where.code === 0) {
    const match = where.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
    if (match) return match
  }
  const error = new Error('DSH executable is unavailable.')
  error.code = 'ENOENT'
  throw error
}

export async function defaultRunDsh(args, overrides = {}) {
  const platform = overrides.platform ?? process.platform
  const candidates = overrides.candidates ?? executableCandidates(platform)
  const env = overrides.env ?? process.env
  let lastError
  for (const command of candidates) {
    try {
      if (platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
        const commandPath = await whereCmdCandidate(command, env)
        const invocation = await cmdInvocation(commandPath, args, env)
        try {
          return await spawnResult(invocation.file, invocation.args, { env: invocation.env }, command)
        } finally {
          await rm(invocation.wrapperDir, { recursive: true, force: true })
        }
      }
      return await spawnResult(command, args, { env }, command)
    } catch (error) {
      lastError = error
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw lastError ?? new Error('DSH executable is unavailable.')
}

export async function defaultDshCommandPath(overrides = {}) {
  const { spawn: spawnChild } = await import('node:child_process')
  const platform = overrides.platform ?? process.platform
  const env = overrides.env ?? process.env
  const command = platform === 'win32' ? 'where.exe' : 'which'
  const target = platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const result = await new Promise((resolve, reject) => {
    const child = spawnChild(command, [target], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
  if (result.code !== 0 || result.stdout.trim() === '') throw new Error('DSH is required and must be available on PATH.')
  return result.stdout.trim().split(/\r?\n/u)[0]
}

function safeStamp(now) {
  return now.toISOString().replace(/[-:TZ.]/g, '')
}

function safeError(error) {
  return error instanceof CliError && Object.hasOwn(ERROR_MESSAGES, error.code)
    ? ERROR_MESSAGES[error.code]
    : ERROR_MESSAGES.OPERATION_FAILED
}

async function checkDsh(deps) {
  const result = await deps.runDsh(['--version'])
  if (result.code !== 0) fail('DSH_UNAVAILABLE')
}

async function readOptionalFile(fs, path) {
  try {
    await fs.access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  return fs.readFile(path, 'utf8')
}

async function getConfigTools(deps) {
  if (deps.validateSettingsText && deps.settingsEditor && deps.editLegacyPatch) {
    return { validate: deps.validateSettingsText, editor: deps.settingsEditor, editLegacyPatch: deps.editLegacyPatch }
  }
  const commandPath = deps.dshCommandPath ? await deps.dshCommandPath() : await defaultDshCommandPath()
  const dshInstallRoot = resolveDshInstallRoot(commandPath)
  const yaml = deps.yaml ?? await loadDshYaml(dshInstallRoot)
  return {
    validate: deps.validateSettingsText ?? await createDshValidator(dshInstallRoot, yaml),
    editor: deps.settingsEditor ?? createSettingsEditor(yaml),
    editLegacyPatch: deps.editLegacyPatch ?? createLegacyPatchEditor(yaml),
  }
}

async function install(options, deps, paths) {
  const { validate, editor, editLegacyPatch } = await getConfigTools(deps)
  const original = await deps.fs.readSettings(paths.settingsPath)
  const credentialText = await deps.fs.readFile(paths.credentialPath, 'utf8').catch(() => fail('LOGIN_UNAVAILABLE'))
  const identity = readCodeBuddyIdentity(credentialText)
  let next
  try {
    next = editor.setManagedProvider(original, identity.uid)
  } catch {
    fail('CONFIG_CONFLICT')
  }
  await withValidatedTemp(paths.settingsPath, next, validate, 'present', deps.randomId())
  if (options.dryRun) {
    deps.stdout.write(JSON.stringify({ status: 'dry-run', command: 'install', profile: options.profile }) + '\n')
    return 0
  }

  const beforeManifest = await loadProfileManifest(paths.profilePath)
  const dependencyExisted = hasPluginDependency(beforeManifest)
  const originalPatch = await readOptionalFile(deps.fs, paths.profilePatchPath)
  let legacyPatch = { migrated: false }
  if (originalPatch !== undefined) {
    try {
      legacyPatch = editLegacyPatch(originalPatch)
    } catch {
      fail('CONFIG_CONFLICT')
    }
  }
  let backupDir
  if (legacyPatch.migrated) {
    backupDir = await deps.fs.backupSettings(paths.settingsPath, paths.dshHome, `${safeStamp(deps.now())}-${deps.randomId()}`, paths.profilePatchPath)
    await deps.fs.replaceTextAtomically(paths.profilePatchPath, legacyPatch.text, deps.randomId())
  }
  let add
  try {
    add = await deps.runDsh(['plugin', '--profile', options.profile, 'add', options.packageSpec])
  } catch {
    if (legacyPatch.migrated) {
      try { await deps.fs.restoreProfilePatch(paths.profilePatchPath, backupDir) } catch { fail('PLUGIN_ADD_ROLLBACK_FAILED') }
    }
    fail('PLUGIN_ADD_FAILED')
  }
  if (add.code !== 0) {
    if (legacyPatch.migrated) {
      try { await deps.fs.restoreProfilePatch(paths.profilePatchPath, backupDir) } catch { fail('PLUGIN_ADD_ROLLBACK_FAILED') }
    }
    fail('PLUGIN_ADD_FAILED')
  }
  let installedManifest
  try {
    installedManifest = await loadProfileManifest(paths.profilePath)
  } catch {}
  if (!isPluginInstalled(installedManifest)) {
    let rollbackFailed = false
    if (legacyPatch.migrated) {
      try { await deps.fs.restoreProfilePatch(paths.profilePatchPath, backupDir) } catch { rollbackFailed = true }
    }
    if (!dependencyExisted) {
      try {
        const remove = await deps.runDsh(['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME])
        if (remove.code !== 0) rollbackFailed = true
      } catch {
        rollbackFailed = true
      }
    }
    fail(rollbackFailed ? 'PLUGIN_ADD_ROLLBACK_FAILED' : 'PLUGIN_ADD_FAILED')
  }

  try {
    if (!backupDir) backupDir = await deps.fs.backupSettings(paths.settingsPath, paths.dshHome, `${safeStamp(deps.now())}-${deps.randomId()}`)
    await deps.fs.replaceSettingsAtomically(paths.settingsPath, next, deps.randomId())
    await validate(await deps.fs.readSettings(paths.settingsPath), 'present', paths.settingsPath)
  } catch (error) {
    const failures = []
    if (backupDir) {
      try { await deps.fs.restoreSettings(paths.settingsPath, backupDir) } catch { failures.push('settings rollback') }
    }
    if (legacyPatch.migrated) {
      try { await deps.fs.restoreProfilePatch(paths.profilePatchPath, backupDir) } catch { failures.push('profile patch rollback') }
    }
    if (!dependencyExisted) {
      const remove = await deps.runDsh(['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME])
      if (remove.code !== 0) failures.push('plugin rollback')
    }
    fail(dependencyExisted ? 'INSTALL_FAILED_DEPENDENCY_PRESERVED' : 'INSTALL_FAILED')
  }
  deps.stdout.write(JSON.stringify({ status: 'installed', profile: options.profile, restartRequired: true }) + '\n')
  return 0
}

async function uninstall(options, deps, paths) {
  const { validate, editor } = await getConfigTools(deps)
  const original = await deps.fs.readSettings(paths.settingsPath)
  const manifest = await loadProfileManifest(paths.profilePath)
  const pluginExists = hasPluginDependency(manifest) || Boolean(manifest?.dsh?.profile?.bundles?.includes(PACKAGE_NAME))
  const providerExists = editor.hasManagedProvider(original)
  if (!providerExists && editor.hasProviderConflict?.(original)) fail('CONFIG_CONFLICT')
  if (!providerExists && !pluginExists) {
    deps.stdout.write(JSON.stringify({ status: 'already-uninstalled', profile: options.profile }) + '\n')
    return 0
  }
  let next
  try {
    next = editor.removeManagedProvider(original)
  } catch {
    fail('CONFIG_CONFLICT')
  }
  await withValidatedTemp(paths.settingsPath, next, validate, 'absent', deps.randomId())
  if (options.dryRun) {
    deps.stdout.write(JSON.stringify({ status: 'dry-run', command: 'uninstall', profile: options.profile }) + '\n')
    return 0
  }

  const backupDir = await deps.fs.backupSettings(paths.settingsPath, paths.dshHome, `${safeStamp(deps.now())}-${deps.randomId()}`)
  try {
    await deps.fs.replaceSettingsAtomically(paths.settingsPath, next, deps.randomId())
    await validate(await deps.fs.readSettings(paths.settingsPath), 'absent', paths.settingsPath)
    if (pluginExists) {
      const remove = await deps.runDsh(['plugin', '--profile', options.profile, 'remove', PACKAGE_NAME])
      if (remove.code !== 0) fail('PLUGIN_REMOVE_FAILED')
    }
  } catch (error) {
    try {
      await deps.fs.restoreSettings(paths.settingsPath, backupDir)
    } catch {
      fail('UNINSTALL_FAILED')
    }
    if (error instanceof CliError && error.code === 'PLUGIN_REMOVE_FAILED') throw error
    fail('UNINSTALL_FAILED')
  }
  deps.stdout.write(JSON.stringify({ status: 'uninstalled', profile: options.profile, restartRequired: true }) + '\n')
  return 0
}

async function doctor(options, deps, paths) {
  let dsh = false
  let codebuddyLogin = false
  let provider = false
  let plugin = false
  try {
    await checkDsh(deps)
    dsh = true
  } catch {}
  try {
    readCodeBuddyIdentity(await deps.fs.readFile(paths.credentialPath, 'utf8'))
    codebuddyLogin = true
  } catch {}
  try {
    const { editor } = await getConfigTools(deps)
    provider = editor.hasManagedProvider(await deps.fs.readSettings(paths.settingsPath))
  } catch {}
  plugin = isPluginInstalled(await loadProfileManifest(paths.profilePath))
  deps.stdout.write(JSON.stringify({ dsh, codebuddyLogin, provider, plugin, profile: options.profile }) + '\n')
  return dsh && codebuddyLogin && provider && plugin ? 0 : 1
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const deps = {
    env: process.env,
    platform: process.platform,
    runDsh: defaultRunDsh,
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => new Date(),
    randomId: randomUUID,
    ...overrides,
    fs: {
      access,
      readFile,
      readSettings,
      backupSettings,
      restoreSettings,
      restoreProfilePatch,
      replaceSettingsAtomically,
      replaceTextAtomically,
      ...(overrides.fs ?? {}),
    },
  }
  try {
    const options = parseArgs(argv)
    if (deps.platform !== 'win32') fail('UNSUPPORTED_PLATFORM')
    const paths = resolvePaths(deps.env, options.profile)
    if (options.command !== 'doctor') await checkDsh(deps)
    if (options.command === 'install') return await install(options, deps, paths)
    if (options.command === 'uninstall') return await uninstall(options, deps, paths)
    return await doctor(options, deps, paths)
  } catch (error) {
    deps.stderr.write(`dsh-workbuddy-auth: ${safeError(error)}\n`)
    return 1
  }
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isEntryPoint) process.exitCode = await main()
