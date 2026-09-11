import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { createSettingsEditor, loadDshYaml, resolveDshInstallRoot } from '../bin/config.mjs'

const UID = 'fixture-workbuddy-user-id-not-real'
const dshCommandPath = join(process.env.APPDATA, 'npm', 'dsh.cmd')
const yaml = await loadDshYaml(resolveDshInstallRoot(dshCommandPath))
const editor = createSettingsEditor(yaml)

function parse(text) {
  return yaml.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
}

const LEGACY_PROVIDER_LINES = (await readFile(new URL('./fixtures/legacy-settings-provider.yml', import.meta.url), 'utf8'))
  .trimEnd()
  .replace('__WORKBUDDY_UID__', 'legacy-fixture-uid-not-real')
  .split(/\r?\n/u)

function legacySettings({ bom = false, crlf = false, quoted = false, before = [], after = [] } = {}) {
  const lines = [
    'locale: zh',
    quoted ? "'llm-pi-ai':" : 'llm-pi-ai:',
    quoted ? "  'providers':" : '  providers:',
    ...before,
    ...LEGACY_PROVIDER_LINES,
    ...after,
    'tail: keep',
    '',
  ]
  const text = lines.join(crlf ? '\r\n' : '\n')
  return bom ? `\uFEFF${text}` : text
}

for (const [name, source] of [
  ['BOM and CRLF', '\uFEFFlocale: zh\r\n"llm-pi-ai":\r\n  providers:\r\n    existing: { displayName: Existing }\r\nafter: keep\r\n'],
  ['single-quoted namespace and providers keys', "locale: zh\n'llm-pi-ai':\n  'providers':\n    existing: { displayName: Existing }\nafter: keep\n"],
  ['flow namespace mapping', 'locale: zh\n"llm-pi-ai": { providers: { existing: { displayName: Existing } } }\nafter: keep\n'],
]) {
  test(`settings editor supports ${name} and preserves unrelated semantics`, () => {
    const next = editor.setManagedProvider(source, UID)
    const root = parse(next)
    assert.equal(root.locale, 'zh')
    assert.equal(root.after, 'keep')
    assert.equal(root['llm-pi-ai'].providers.existing.displayName, 'Existing')
    assert.equal(root['llm-pi-ai'].providers.workbuddy.headers['X-User-Id'], UID)
    assert.equal(next.startsWith('\uFEFF'), source.startsWith('\uFEFF'))
    assert.equal(next.includes('\r\n'), source.includes('\r\n'))
    assert.equal(editor.hasManagedProvider(next), true)
    const removed = editor.removeManagedProvider(next)
    assert.equal(parse(removed)['llm-pi-ai'].providers.workbuddy, undefined)
    assert.equal(parse(removed)['llm-pi-ai'].providers.existing.displayName, 'Existing')
  })
}

test('legacy patch detector rejects quoted and flow semantic package conflicts', async () => {
  const { createLegacyPatchEditor } = await import('../bin/config.mjs')
  const removeLegacyPatchBlock = createLegacyPatchEditor(yaml)
  for (const source of [
    '- insert:\n    - id: "dsh-workbuddy-auth"\n      name: other\n',
    '- insert: [{ id: other, name: \'dsh-workbuddy-auth\' }]\n',
  ]) {
    assert.throws(() => removeLegacyPatchBlock(source), /unmarked dsh-workbuddy-auth conflict/i)
  }
})

test('legacy patch detector rejects an unmarked conflict left beside an owned block', async () => {
  const { createLegacyPatchEditor } = await import('../bin/config.mjs')
  const editLegacyPatch = createLegacyPatchEditor(yaml)
  const source = [
    '# BEGIN dsh-workbuddy-auth managed block',
    '- insert:',
    '    - id: dsh-workbuddy-auth',
    '      name: dsh-workbuddy-auth',
    '# END dsh-workbuddy-auth managed block',
    '- insert: [{ id: "dsh-workbuddy-auth", name: manual }]',
    '',
  ].join('\n')
  assert.throws(() => editLegacyPatch(source), /unmarked dsh-workbuddy-auth conflict/i)
})

test('settings editor rejects an unmarked semantic workbuddy conflict', () => {
  const source = '"llm-pi-ai": { providers: { workbuddy: { displayName: Manual } } }\n'
  assert.throws(() => editor.setManagedProvider(source, UID), /unmarked workbuddy provider/i)
})

test('settings editor updates an owned marker node without duplicating ownership', () => {
  const once = editor.setManagedProvider('llm-pi-ai:\n  providers: {}\n', 'old-uid')
  const twice = editor.setManagedProvider(once, UID)
  assert.equal((twice.match(/BEGIN dsh-workbuddy-auth managed provider/g) ?? []).length, 1)
  assert.equal(parse(twice)['llm-pi-ai'].providers.workbuddy.headers['X-User-Id'], UID)
})

test('settings editor recognizes and canonicalizes the exact legacy installer provider block', () => {
  for (const source of [
    legacySettings(),
    legacySettings({ before: ['    existing: { displayName: Existing }'] }),
    legacySettings({ after: ['    following: { displayName: Following }'] }),
    legacySettings({ bom: true, crlf: true, quoted: true, before: ['    existing: { displayName: Existing }'] }),
  ]) {
    assert.equal(editor.hasManagedProvider(source), true)
    const next = editor.setManagedProvider(source, UID)
    const parsed = parse(next)
    assert.equal(parsed.locale, 'zh')
    assert.equal(parsed.tail, 'keep')
    assert.equal(parsed['llm-pi-ai'].providers.workbuddy.headers['X-User-Id'], UID)
    assert.equal((next.match(/BEGIN dsh-workbuddy-auth managed provider/g) ?? []).length, 1)
    assert.equal((next.match(/END dsh-workbuddy-auth managed provider/g) ?? []).length, 1)
    assert.equal(editor.hasManagedProvider(next), true)
    assert.equal(next.startsWith('\uFEFF'), source.startsWith('\uFEFF'))
    assert.equal(next.includes('\r\n'), source.includes('\r\n'))
  }
})

test('settings editor preserves ordinary comments immediately outside the exact legacy block', () => {
  const source = legacySettings({
    before: ['    # docs before legacy provider'],
    after: ['    # docs for following provider', '    following: { displayName: Following }'],
  })
  assert.equal(editor.hasManagedProvider(source), true)
  const next = editor.setManagedProvider(source, UID)
  assert.match(next, /# docs before legacy provider/u)
  assert.match(next, /# docs for following provider/u)
  assert.equal(editor.hasManagedProvider(next), true)
  assert.equal(parse(next)['llm-pi-ai'].providers.following.displayName, 'Following')
})

test('settings editor removes every exact legacy marker attachment without deleting sibling providers', () => {
  const source = legacySettings({
    before: ['    existing: { displayName: Existing }'],
    after: ['    following: { displayName: Following }'],
  })
  const removed = editor.removeManagedProvider(source)
  const parsed = parse(removed)
  assert.equal(parsed['llm-pi-ai'].providers.workbuddy, undefined)
  assert.equal(parsed['llm-pi-ai'].providers.existing.displayName, 'Existing')
  assert.equal(parsed['llm-pi-ai'].providers.following.displayName, 'Following')
  assert.doesNotMatch(removed, /dsh-workbuddy-auth managed provider/i)
})

test('settings editor rejects malformed duplicate mixed and unmarked legacy ownership', () => {
  const exact = legacySettings()
  const cases = [
    exact.replace('    # END dsh-workbuddy-auth managed provider\n', ''),
    exact.replace('    # BEGIN dsh-workbuddy-auth managed provider\n', ''),
    exact.replace('    # END dsh-workbuddy-auth managed provider\n', '    # END dsh-workbuddy-auth managed provider\n    # END dsh-workbuddy-auth managed provider\n'),
    exact.replace('managed provider\n    workbuddy:', 'managed Provider\n    workbuddy:'),
    exact.replace('managed provider\n    workbuddy:', 'managed provider extra\n    workbuddy:'),
    exact.replace('    # BEGIN dsh-workbuddy-auth managed provider\n', '    # BEGIN dsh-workbuddy-auth managed provider\n    # unrelated mixed comment\n'),
    exact.replace('    # END dsh-workbuddy-auth managed provider\n', '    # unrelated mixed comment\n    # END dsh-workbuddy-auth managed provider\n'),
    exact.replace('    # BEGIN dsh-workbuddy-auth managed provider\n', ''),
    'llm-pi-ai:\n  providers:\n    workbuddy:\n      displayName: Manual\n',
  ]
  for (const source of cases) {
    assert.equal(editor.hasManagedProvider(source), false)
    assert.throws(() => editor.setManagedProvider(source, UID), /unmarked workbuddy provider/i)
  }
})

test('settings editor rejects exact legacy markers that do not tightly wrap workbuddy', () => {
  const cases = [
    legacySettings().replace('    workbuddy:', '    other: {}\n    workbuddy:'),
    legacySettings().replace('    # END dsh-workbuddy-auth managed provider\n', '    other: {}\n    # END dsh-workbuddy-auth managed provider\n'),
  ]
  for (const source of cases) {
    assert.equal(editor.hasManagedProvider(source), false)
    assert.throws(() => editor.setManagedProvider(source, UID), /unmarked workbuddy provider/i)
  }
})

test('settings editor rejects standalone legacy markers mixed with a canonical owned node', () => {
  const canonical = editor.setManagedProvider('llm-pi-ai:\n  providers: {}\n', UID)
  const mixed = `${canonical}    # BEGIN dsh-workbuddy-auth managed provider\n    # END dsh-workbuddy-auth managed provider\n`
  assert.equal(editor.hasManagedProvider(mixed), false)
  assert.throws(() => editor.setManagedProvider(mixed, UID), /unmarked workbuddy provider/i)
})
