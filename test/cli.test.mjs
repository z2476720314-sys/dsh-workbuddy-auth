import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { main } from '../bin/cli.mjs'
import {
  MANAGED_PROVIDER_BEGIN,
  MANAGED_PROVIDER_END,
  createSettingsEditor,
  loadDshYaml,
  resolveDshInstallRoot,
} from '../bin/config.mjs'

const UID = 'fixture-workbuddy-user-id-not-real'
const TOKEN = 'obviously-fake-cli-token-for-tests-only'
const PHONE = 'not-a-real-cli-phone'
const EMAIL = 'fixture-cli-email-at-invalid'
const yaml = await loadDshYaml(resolveDshInstallRoot(join(process.env.APPDATA, 'npm', 'dsh.cmd')))
const settingsEditor = createSettingsEditor(yaml)

const BASE_SETTINGS = [
  'locale: zh',
  'llm-pi-ai:',
  '  providers:',
  '    existing:',
  '      displayName: Existing',
  'after: keep',
  '',
].join('\n')

const LEGACY_PROVIDER_LINES = (await readFile(new URL('./fixtures/legacy-settings-provider.yml', import.meta.url), 'utf8'))
  .trimEnd()
  .replace('__WORKBUDDY_UID__', 'legacy-fixture-uid-not-real')
  .split(/\r?\n/u)

const LEGACY_SETTINGS = [
  '\uFEFFlocale: zh',
  "'llm-pi-ai':",
  "  'providers':",
  '    existing:',
  '      displayName: Existing',
  ...LEGACY_PROVIDER_LINES,
  'after: keep',
  '',
].join('\r\n')

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-cli-'))
  const dshHome = join(root, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const localAppData = join(root, 'local-app-data')
  const credentialPath = join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'Tencent-Cloud.coding-copilot.info')
  const settingsPath = join(dshHome, 'settings.yaml')
  const profilePath = join(profileDir, 'package.json')
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  await mkdir(join(credentialPath, '..'), { recursive: true })
  await mkdir(profileDir, { recursive: true })
  await writeFile(settingsPath, options.settings ?? BASE_SETTINGS, 'utf8')
  await writeFile(credentialPath, JSON.stringify({ account: { uid: options.uid ?? UID, phone: PHONE, email: EMAIL }, auth: { accessToken: TOKEN } }), 'utf8')
  await writeFile(profilePath, JSON.stringify(options.profileManifest ?? { dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
  await writeFile(profilePatchPath, options.profilePatch ?? '- keep: other\n', 'utf8')

  const calls = []
  const output = []
  const errors = []
  let validatorCalls = 0
  const runDsh = options.runDsh ?? (async (args) => {
    calls.push([...args])
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5', stderr: '' }
    if (args[0] === 'plugin' && args.at(-2) === 'add') {
      const selectedProfile = args[args.indexOf('--profile') + 1]
      const selectedProfilePath = join(dshHome, 'profiles', selectedProfile, 'package.json')
      const manifest = JSON.parse(await readFile(selectedProfilePath, 'utf8'))
      manifest.dependencies['dsh-workbuddy-auth'] = options.packageSpec ?? '0.1.0'
      if (!manifest.dsh.profile.bundles.includes('dsh-workbuddy-auth')) manifest.dsh.profile.bundles.push('dsh-workbuddy-auth')
      await writeFile(selectedProfilePath, JSON.stringify(manifest, null, 2), 'utf8')
    }
    if (args[0] === 'plugin' && args.at(-2) === 'remove') {
      const selectedProfile = args[args.indexOf('--profile') + 1]
      const selectedProfilePath = join(dshHome, 'profiles', selectedProfile, 'package.json')
      const manifest = JSON.parse(await readFile(selectedProfilePath, 'utf8'))
      delete manifest.dependencies['dsh-workbuddy-auth']
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item) => item !== 'dsh-workbuddy-auth')
      await writeFile(selectedProfilePath, JSON.stringify(manifest, null, 2), 'utf8')
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  const validateSettingsText = options.validateSettingsText ?? (async (text, expectation) => {
    validatorCalls += 1
    if (options.failValidationAt === validatorCalls) throw new Error('synthetic schema rejection')
    const beginCount = text.split(MANAGED_PROVIDER_BEGIN).length - 1
    const endCount = text.split(MANAGED_PROVIDER_END).length - 1
    assert.equal(beginCount, endCount)
    const parsed = yaml.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
    const provider = parsed?.['llm-pi-ai']?.providers?.workbuddy
    if (expectation === 'present') {
      assert.equal(beginCount, 1)
      assert.equal(provider.headers['X-User-Id'], UID)
      assert.equal(provider.models.length, 28)
      assert.equal(provider.models.filter((model) => Array.isArray(model.input)).length, 19)
    } else {
      assert.equal(beginCount, 0)
      assert.equal(provider, undefined)
    }
    return { modelCount: expectation === 'present' ? 28 : 0, imageModelCount: expectation === 'present' ? 19 : 0 }
  })

  const env = { DSH_HOME: dshHome, LOCALAPPDATA: localAppData, USERPROFILE: join(root, 'user-profile') }
  const fsOverrides = options.fs ?? {}
  const backupImpl = fsOverrides.backupSettings
  fsOverrides.backupSettings = async (...args) => {
    fsOverrides.backupSettingsCalls = (fsOverrides.backupSettingsCalls ?? 0) + 1
    if (backupImpl) return backupImpl(...args)
    const { backupSettings } = await import('../bin/config.mjs')
    return backupSettings(...args)
  }
  const deps = {
    env,
    platform: 'win32',
    runDsh,
    validateSettingsText,
    settingsEditor,
    editLegacyPatch: options.editLegacyPatch ?? ((text) => {
      const begins = text.split('# BEGIN dsh-workbuddy-auth managed block').length - 1
      const ends = text.split('# END dsh-workbuddy-auth managed block').length - 1
      if (begins !== ends || begins > 1) throw new Error('legacy conflict')
      if (begins === 1) {
        const pattern = /^# BEGIN dsh-workbuddy-auth managed block\r?\n- insert:\r?\n {4}- id: dsh-workbuddy-auth\r?\n {6}name: dsh-workbuddy-auth\r?\n# END dsh-workbuddy-auth managed block(?:\r?\n)?/mu
        if (!pattern.test(text)) throw new Error('legacy conflict')
        return { text: text.replace(pattern, ''), migrated: true }
      }
      const parsed = yaml.parse(text)
      const serialized = JSON.stringify(parsed)
      if (serialized.includes('dsh-workbuddy-auth')) throw new Error('legacy conflict')
      return { text, migrated: false }
    }),
    stdout: { write: (text) => output.push(String(text)) },
    stderr: { write: (text) => errors.push(String(text)) },
    now: () => new Date('2026-09-11T12:00:00.000Z'),
    randomId: (() => { let id = 0; return () => `fixture-${++id}` })(),
    fs: fsOverrides,
  }
  return { root, dshHome, profileDir, localAppData, credentialPath, settingsPath, profilePath, profilePatchPath, calls, output, errors, deps }
}

function allOutput(f) {
  return [...f.output, ...f.errors].join('')
}

function assertPrivateOutput(f) {
  const rendered = allOutput(f)
  for (const privateValue of [UID, TOKEN, PHONE, EMAIL, f.root, f.dshHome, f.localAppData]) {
    assert.equal(rendered.includes(privateValue), false, `output leaked private value: ${privateValue}`)
  }
}


test('install invokes official dsh plugin add and writes the owned 28-model provider', async () => {
  const f = await fixture({ packageSpec: 'file:C:/fixture/package' })
  const code = await main(['install', '--package-spec', 'file:C:/fixture/package'], f.deps)
  assert.equal(code, 0)
  assert.deepEqual(f.calls, [
    ['--version'],
    ['plugin', '--profile', 'web', 'add', 'file:C:/fixture/package'],
  ])
  const settings = await readFile(f.settingsPath, 'utf8')
  assert.match(settings, /    # BEGIN dsh-workbuddy-auth managed provider/)
  assert.match(settings, /    existing:\n      displayName: Existing/)
  assert.match(settings, /after: keep/)
  const provider = yaml.parse(settings)['llm-pi-ai'].providers.workbuddy
  assert.equal(provider.models.length, 28)
  assert.equal(provider.models.filter((model) => Array.isArray(model.input)).length, 19)
  assertPrivateOutput(f)
})

test('fresh profile install calls plugin add before inspecting add-created profile state', async () => {
  const f = await fixture()
  await rm(f.profileDir, { recursive: true, force: true })
  f.deps.runDsh = async (args) => {
    f.calls.push([...args])
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5', stderr: '' }
    assert.deepEqual(args, ['plugin', '--profile', 'web', 'add', 'dsh-workbuddy-auth@0.1.0'])
    await mkdir(f.profileDir, { recursive: true })
    await writeFile(f.profilePath, JSON.stringify({ dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } }), 'utf8')
    await writeFile(f.profilePatchPath, '- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n', 'utf8')
    return { code: 0, stdout: '', stderr: '' }
  }

  assert.equal(await main(['install'], f.deps), 0)
  assert.deepEqual(f.calls, [
    ['--version'],
    ['plugin', '--profile', 'web', 'add', 'dsh-workbuddy-auth@0.1.0'],
  ])
  assert.equal(JSON.parse(await readFile(f.profilePath, 'utf8')).dependencies['dsh-workbuddy-auth'], '0.1.0')
  assert.equal(settingsEditor.hasManagedProvider(await readFile(f.settingsPath, 'utf8')), true)
  assertPrivateOutput(f)
})

test('install treats a missing profile patch as no legacy migration without reading or backing it up', async () => {
  const f = await fixture()
  await rm(f.profilePatchPath)
  let missingPatchRead = false
  f.deps.fs.readFile = async (path, ...args) => {
    if (path === f.profilePatchPath) missingPatchRead = true
    return readFile(path, ...args)
  }

  assert.equal(await main(['install'], f.deps), 0)
  assert.equal(f.calls.some((args) => args.includes('add')), true)
  assert.equal(missingPatchRead, false)
  assert.equal(f.deps.fs.backupSettingsCalls, 1)
  assert.equal(settingsEditor.hasManagedProvider(await readFile(f.settingsPath, 'utf8')), true)
})

test('install rolls back a newly added plugin when add does not create readable installed profile state', async () => {
  const f = await fixture()
  await rm(f.profileDir, { recursive: true, force: true })
  f.deps.runDsh = async (args) => {
    f.calls.push([...args])
    return { code: 0, stdout: args[0] === '--version' ? '0.1.5' : '', stderr: '' }
  }

  assert.equal(await main(['install'], f.deps), 1)
  assert.deepEqual(f.calls, [
    ['--version'],
    ['plugin', '--profile', 'web', 'add', 'dsh-workbuddy-auth@0.1.0'],
    ['plugin', '--profile', 'web', 'remove', 'dsh-workbuddy-auth'],
  ])
  assert.match(allOutput(f), /plugin add failed/i)
  assertPrivateOutput(f)
})

test('install is byte-idempotent and keeps one ownership block', async () => {
  const f = await fixture()
  assert.equal(await main(['install'], f.deps), 0)
  const once = await readFile(f.settingsPath, 'utf8')
  assert.equal(await main(['install'], f.deps), 0)
  const twice = await readFile(f.settingsPath, 'utf8')
  assert.equal(twice, once)
  assert.equal(twice.split(MANAGED_PROVIDER_BEGIN).length - 1, 1)
  assert.equal(f.calls.filter((args) => args.includes('add')).length, 2)
})

test('install migrates the known legacy profile patch ownership block before plugin add', async () => {
  const legacy = [
    '- keep: before',
    '# BEGIN dsh-workbuddy-auth managed block',
    '- insert:',
    '    - id: dsh-workbuddy-auth',
    '      name: dsh-workbuddy-auth',
    '# END dsh-workbuddy-auth managed block',
    '- keep: after',
    '',
  ].join('\n')
  const f = await fixture({ profilePatch: legacy })
  let patchSeenByAdd
  const baseRun = f.deps.runDsh
  f.deps.runDsh = async (args) => {
    if (args.includes('add')) patchSeenByAdd = await readFile(f.profilePatchPath, 'utf8')
    return baseRun(args)
  }
  assert.equal(await main(['install'], f.deps), 0)
  assert.equal(patchSeenByAdd, '- keep: before\n- keep: after\n')
  assert.equal(await readFile(f.profilePatchPath, 'utf8'), '- keep: before\n- keep: after\n')
  assert.equal(f.deps.fs.backupSettingsCalls, 1)
})

test('one-click install migrates the exact legacy settings provider and profile patch together', async () => {
  const legacyPatch = [
    '- keep: before',
    '# BEGIN dsh-workbuddy-auth managed block',
    '- insert:',
    '    - id: dsh-workbuddy-auth',
    '      name: dsh-workbuddy-auth',
    '# END dsh-workbuddy-auth managed block',
    '- keep: after',
    '',
  ].join('\r\n')
  const f = await fixture({ settings: LEGACY_SETTINGS, profilePatch: legacyPatch })
  assert.equal(settingsEditor.hasManagedProvider(LEGACY_SETTINGS), true)
  assert.equal(await main(['install'], f.deps), 0)
  const settings = await readFile(f.settingsPath, 'utf8')
  assert.equal(settings.startsWith('\uFEFF'), true)
  assert.equal(settings.includes('\r\n'), true)
  assert.equal((settings.match(/BEGIN dsh-workbuddy-auth managed provider/g) ?? []).length, 1)
  assert.equal(yaml.parse(settings.slice(1))['llm-pi-ai'].providers.workbuddy.headers['X-User-Id'], UID)
  assert.equal(await readFile(f.profilePatchPath, 'utf8'), '- keep: before\r\n- keep: after\r\n')
  assert.equal(f.calls.filter((args) => args.includes('add')).length, 1)
  assert.equal(f.deps.fs.backupSettingsCalls, 1)
  assertPrivateOutput(f)
})

test('install refuses an unmarked legacy profile patch conflict before plugin add', async () => {
  const f = await fixture({ profilePatch: '- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n' })
  const before = await readFile(f.profilePatchPath, 'utf8')
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.profilePatchPath, 'utf8'), before)
  assert.equal(f.calls.some((args) => args.includes('add')), false)
})

test('plugin add failure restores a migrated legacy profile patch', async () => {
  const legacy = '# BEGIN dsh-workbuddy-auth managed block\n- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n# END dsh-workbuddy-auth managed block\n'
  const f = await fixture({ profilePatch: legacy })
  f.deps.runDsh = async (args) => {
    f.calls.push([...args])
    return args[0] === '--version' ? { code: 0, stdout: '0.1.5', stderr: '' } : { code: 19, stdout: '', stderr: '' }
  }
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.profilePatchPath, 'utf8'), legacy)
})

test('spawn failure restores a migrated legacy profile patch', async () => {
  const legacy = '# BEGIN dsh-workbuddy-auth managed block\n- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n# END dsh-workbuddy-auth managed block\n'
  const f = await fixture({ profilePatch: legacy })
  f.deps.runDsh = async (args) => {
    f.calls.push([...args])
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5', stderr: '' }
    throw new Error(`EACCES spawn ${f.root}`)
  }
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.profilePatchPath, 'utf8'), legacy)
  assertPrivateOutput(f)
})

test('spawn failure reports incomplete rollback when the migrated patch cannot be restored', async () => {
  const legacy = '# BEGIN dsh-workbuddy-auth managed block\n- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n# END dsh-workbuddy-auth managed block\n'
  const f = await fixture({ profilePatch: legacy })
  f.deps.runDsh = async (args) => {
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5', stderr: '' }
    throw new Error('synthetic spawn failure')
  }
  f.deps.fs.restoreProfilePatch = async () => { throw new Error('synthetic restore failure') }
  assert.equal(await main(['install'], f.deps), 1)
  assert.match(allOutput(f), /rollback was incomplete/i)
  assertPrivateOutput(f)
})

test('unconfirmed add state reports incomplete rollback when the migrated patch cannot be restored', async () => {
  const legacy = '# BEGIN dsh-workbuddy-auth managed block\n- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n# END dsh-workbuddy-auth managed block\n'
  const f = await fixture({ profilePatch: legacy })
  f.deps.runDsh = async (args) => {
    f.calls.push([...args])
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5', stderr: '' }
    if (args.includes('add')) return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  f.deps.fs.restoreProfilePatch = async () => { throw new Error('synthetic restore failure') }
  assert.equal(await main(['install'], f.deps), 1)
  assert.match(allOutput(f), /rollback was incomplete/i)
  assertPrivateOutput(f)
})

test('settings failure restores a migrated legacy profile patch', async () => {
  const legacy = '# BEGIN dsh-workbuddy-auth managed block\n- insert:\n    - id: dsh-workbuddy-auth\n      name: dsh-workbuddy-auth\n# END dsh-workbuddy-auth managed block\n'
  const f = await fixture({ profilePatch: legacy, failValidationAt: 2 })
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.profilePatchPath, 'utf8'), legacy)
})

test('known and unknown failures render fixed messages without fixture paths or usernames', async () => {
  const cases = [
    async (f) => { f.deps.fs.readSettings = async () => { throw new Error(`ENOENT settings ${f.root} user-${UID}`) } },
    async (f) => { f.deps.fs.access = async () => { throw new Error(`EACCES patch ${f.root} user-${UID}`) } },
    async (f) => { f.deps.fs.backupSettings = async () => { throw new Error(`backup ${f.root} user-${UID}`) } },
    async (f) => { f.deps.fs.replaceSettingsAtomically = async () => { throw new Error(`rename ${f.root} user-${UID}`) } },
  ]
  for (const prepare of cases) {
    const f = await fixture()
    await prepare(f)
    assert.equal(await main(['install'], f.deps), 1)
    assertPrivateOutput(f)
    assert.match(allOutput(f), /dsh-workbuddy-auth: [A-Za-z]/u)
  }
})

test('settings backup failure removes a newly added plugin and leaves settings untouched', async () => {
  const f = await fixture()
  await writeFile(join(f.dshHome, 'dsh-workbuddy-auth-backups'), 'synthetic backup-root conflict', 'utf8')
  const before = await readFile(f.settingsPath, 'utf8')
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.settingsPath, 'utf8'), before)
  assert.equal(f.calls.filter((args) => args.includes('remove')).length, 1)
  assertPrivateOutput(f)
})

test('install refuses an unmarked workbuddy provider before plugin add', async () => {
  const f = await fixture({ settings: `${BASE_SETTINGS.replace('after: keep\n', '')}    workbuddy:\n      displayName: Manual\nafter: keep\n` })
  const before = await readFile(f.settingsPath, 'utf8')
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.settingsPath, 'utf8'), before)
  assert.equal(f.calls.some((args) => args.includes('add')), false)
  assert.match(allOutput(f), /not owned by dsh-workbuddy-auth/i)
  assertPrivateOutput(f)
})

test('failed plugin add never changes settings', async () => {
  const f = await fixture({
    runDsh: async (args) => {
      f?.calls.push([...args])
      return args[0] === '--version' ? { code: 0, stdout: '0.1.5', stderr: '' } : { code: 27, stdout: `path ${f?.root}`, stderr: TOKEN }
    },
  })
  const before = await readFile(f.settingsPath, 'utf8')
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.settingsPath, 'utf8'), before)
  assert.match(allOutput(f), /plugin add failed/i)
  assertPrivateOutput(f)
})

test('settings failure restores settings and removes only a plugin newly installed by this run', async () => {
  const f = await fixture({ failValidationAt: 2 })
  const before = await readFile(f.settingsPath, 'utf8')
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(await readFile(f.settingsPath, 'utf8'), before)
  assert.deepEqual(f.calls.filter((args) => args[0] === 'plugin'), [
    ['plugin', '--profile', 'web', 'add', 'dsh-workbuddy-auth@0.1.0'],
    ['plugin', '--profile', 'web', 'remove', 'dsh-workbuddy-auth'],
  ])
  assertPrivateOutput(f)
})

test('settings failure does not remove a dependency-only package that existed before this install', async () => {
  const f = await fixture({
    failValidationAt: 2,
    profileManifest: { dependencies: { 'dsh-workbuddy-auth': 'file:C:/legacy/package' }, dsh: { profile: { bundles: [] } } },
  })
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(f.calls.filter((args) => args.includes('remove')).length, 0)
  assert.match(allOutput(f), /dependency was preserved for manual review/i)
})

test('settings failure does not remove a plugin that existed before this install', async () => {
  const f = await fixture({
    failValidationAt: 2,
    profileManifest: { dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } },
  })
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(f.calls.filter((args) => args.includes('remove')).length, 0)
})

test('default install package spec pins this package exact version', async () => {
  const f = await fixture()
  assert.equal(await main(['install'], f.deps), 0)
  assert.deepEqual(f.calls.find((args) => args.includes('add')), ['plugin', '--profile', 'web', 'add', 'dsh-workbuddy-auth@0.1.0'])
})

test('package spec accepts only absolute local paths or safe file specs', async () => {
  const f = await fixture()
  for (const packageSpec of ['.', 'dsh-workbuddy-auth@latest', 'file:../relative', 'file:C:/fixture/pkg&whoami', 'C:/fixture/pkg|whoami']) {
    assert.equal(await main(['install', '--package-spec', packageSpec], f.deps), 1)
  }
  assert.deepEqual(f.calls, [])
})

test('uninstall removes only the owned provider before official plugin remove', async () => {
  const installed = settingsEditor.setManagedProvider(BASE_SETTINGS, UID)
  const f = await fixture({
    settings: installed,
    profileManifest: { dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } },
  })
  const snapshots = []
  const baseRun = f.deps.runDsh
  f.deps.runDsh = async (args) => {
    if (args.includes('remove')) snapshots.push(await readFile(f.settingsPath, 'utf8'))
    return baseRun(args)
  }
  assert.equal(await main(['uninstall'], f.deps), 0)
  assert.equal(await readFile(f.settingsPath, 'utf8'), BASE_SETTINGS)
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].includes(MANAGED_PROVIDER_BEGIN), false)
  assert.deepEqual(f.calls.filter((args) => args[0] === 'plugin'), [
    ['plugin', '--profile', 'web', 'remove', 'dsh-workbuddy-auth'],
  ])
  assertPrivateOutput(f)
})

test('failed plugin remove rolls settings back', async () => {
  const installed = settingsEditor.setManagedProvider(BASE_SETTINGS, UID)
  const f = await fixture({
    settings: installed,
    profileManifest: { dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } },
  })
  f.deps.runDsh = async (args) => {
    f.calls.push([...args])
    if (args[0] === '--version') return { code: 0, stdout: '0.1.5', stderr: '' }
    return { code: 31, stdout: f.root, stderr: TOKEN }
  }
  assert.equal(await main(['uninstall'], f.deps), 1)
  assert.equal(await readFile(f.settingsPath, 'utf8'), installed)
  assert.match(allOutput(f), /plugin remove failed/i)
  assertPrivateOutput(f)
})

test('uninstall fails closed when profile manifest is malformed', async () => {
  const f = await fixture()
  await writeFile(f.profilePath, '{ malformed', 'utf8')
  assert.equal(await main(['uninstall'], f.deps), 1)
  assert.equal(f.calls.some((args) => args.includes('remove')), false)
  assert.equal(f.output.some((text) => text.includes('already-uninstalled')), false)
  assertPrivateOutput(f)
})

test('second uninstall is an already-uninstalled no-op without backup or remove', async () => {
  const installed = settingsEditor.setManagedProvider(BASE_SETTINGS, UID)
  const f = await fixture({
    settings: installed,
    profileManifest: { dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } },
  })
  assert.equal(await main(['uninstall'], f.deps), 0)
  const backupCallsAfterFirst = f.deps.fs.backupSettingsCalls ?? 0
  assert.equal(await main(['uninstall'], f.deps), 0)
  assert.equal(f.calls.filter((args) => args.includes('remove')).length, 1)
  assert.equal(f.deps.fs.backupSettingsCalls ?? 0, backupCallsAfterFirst)
  assert.match(f.output.at(-1), /already-uninstalled/i)
})

test('uninstall with no owned provider still invokes plugin remove without changing settings', async () => {
  const f = await fixture({
    profileManifest: { dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } },
  })
  assert.equal(await main(['uninstall'], f.deps), 0)
  assert.equal(await readFile(f.settingsPath, 'utf8'), BASE_SETTINGS)
  assert.equal(f.calls.filter((args) => args.includes('remove')).length, 1)
})

test('uninstall without a plugin still rejects unmarked or malformed provider ownership', async () => {
  const cases = [
    'llm-pi-ai:\n  providers:\n    workbuddy:\n      displayName: Manual\n',
    LEGACY_SETTINGS.replace('    # END dsh-workbuddy-auth managed provider\r\n', ''),
    `${LEGACY_SETTINGS}    # BEGIN dsh-workbuddy-auth managed provider\r\n    # END dsh-workbuddy-auth managed provider\r\n`,
  ]
  for (const settings of cases) {
    const f = await fixture({ settings })
    await rm(f.profileDir, { recursive: true, force: true })
    const before = await readFile(f.settingsPath, 'utf8')
    assert.equal(await main(['uninstall'], f.deps), 1)
    assert.equal(await readFile(f.settingsPath, 'utf8'), before)
    assert.match(allOutput(f), /not owned by dsh-workbuddy-auth/i)
    assert.equal(f.deps.fs.backupSettingsCalls ?? 0, 0)
  }
})

test('doctor is read-only and reports DSH, login, provider and bundle status without private output', async () => {
  const installed = settingsEditor.setManagedProvider(BASE_SETTINGS, UID)
  const manifest = { dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } }
  const f = await fixture({ settings: installed, profileManifest: manifest })
  const settingsBefore = await readFile(f.settingsPath, 'utf8')
  const profileBefore = await readFile(f.profilePath, 'utf8')
  assert.equal(await main(['doctor'], f.deps), 0)
  assert.deepEqual(f.calls, [['--version']])
  assert.equal(await readFile(f.settingsPath, 'utf8'), settingsBefore)
  assert.equal(await readFile(f.profilePath, 'utf8'), profileBefore)
  const report = JSON.parse(f.output.join('').trim())
  assert.deepEqual(report, { dsh: true, codebuddyLogin: true, provider: true, plugin: true, profile: 'web' })
  assertPrivateOutput(f)
})

test('doctor reports plugin false instead of throwing when the profile is missing', async () => {
  const f = await fixture({ settings: settingsEditor.setManagedProvider(BASE_SETTINGS, UID) })
  await rm(f.profileDir, { recursive: true, force: true })

  assert.equal(await main(['doctor'], f.deps), 1)
  assert.deepEqual(JSON.parse(f.output.join('').trim()), { dsh: true, codebuddyLogin: true, provider: true, plugin: false, profile: 'web' })
  assert.equal(f.errors.length, 0)
  assertPrivateOutput(f)
})

test('uninstall is already-uninstalled when both profile manifest and patch are missing', async () => {
  const f = await fixture()
  await rm(f.profileDir, { recursive: true, force: true })

  assert.equal(await main(['uninstall'], f.deps), 0)
  assert.deepEqual(f.calls, [['--version']])
  assert.equal(f.deps.fs.backupSettingsCalls ?? 0, 0)
  assert.match(f.output.join(''), /already-uninstalled/i)
  assert.equal(f.errors.length, 0)
  assertPrivateOutput(f)
})

test('dry-run validates install without invoking add, backups or settings writes', async () => {
  const f = await fixture()
  const before = await readFile(f.settingsPath, 'utf8')
  assert.equal(await main(['install', '--dry-run'], f.deps), 0)
  assert.deepEqual(f.calls, [['--version']])
  assert.equal(await readFile(f.settingsPath, 'utf8'), before)
  assert.match(f.output.join(''), /dry-run/i)
  assertPrivateOutput(f)
})

test('dry-run uninstall validates removal without invoking remove or changing settings', async () => {
  const installed = settingsEditor.setManagedProvider(BASE_SETTINGS, UID)
  const f = await fixture({
    settings: installed,
    profileManifest: { dependencies: { 'dsh-workbuddy-auth': '0.1.0' }, dsh: { profile: { bundles: ['dsh-workbuddy-auth'] } } },
  })
  assert.equal(await main(['uninstall', '--dry-run'], f.deps), 0)
  assert.deepEqual(f.calls, [['--version']])
  assert.equal(await readFile(f.settingsPath, 'utf8'), installed)
  assertPrivateOutput(f)
})

test('custom profile is forwarded to add and used for doctor inspection', async () => {
  const f = await fixture()
  const customDir = join(f.dshHome, 'profiles', 'custom')
  await mkdir(customDir, { recursive: true })
  await writeFile(join(customDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')
  await writeFile(join(customDir, 'cordis.patch.yml'), '- keep: custom\n', 'utf8')
  assert.equal(await main(['install', '--profile', 'custom'], f.deps), 0)
  assert.deepEqual(f.calls.at(-1), ['plugin', '--profile', 'custom', 'add', 'dsh-workbuddy-auth@0.1.0'])
})

test('profile rejects cmd metacharacters and dot segments before filesystem or dsh access', async () => {
  const f = await fixture()
  for (const profile of ['web&echo injected', '.', '..']) {
    assert.equal(await main(['install', '--profile', profile], f.deps), 1)
  }
  assert.deepEqual(f.calls, [])
  assert.match(allOutput(f), /Invalid command arguments/i)
  assertPrivateOutput(f)
})

test('package spec rejects quote and line breaks before filesystem or dsh access', async () => {
  const f = await fixture()
  for (const packageSpec of ['file:C:/fixture/pkg"&echo injected', 'file:C:/fixture/pkg\r\necho injected']) {
    assert.equal(await main(['install', '--package-spec', packageSpec], f.deps), 1)
  }
  assert.deepEqual(f.calls, [])
  assertPrivateOutput(f)
})

test('uid must be a non-empty string and error output never includes credential values', async () => {
  const f = await fixture({ uid: 123456 })
  assert.equal(await main(['install'], f.deps), 1)
  assert.equal(f.calls.some((args) => args.includes('add')), false)
  assert.match(allOutput(f), /Operation failed; no credential or path details were printed/i)
  assertPrivateOutput(f)
})
