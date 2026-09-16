import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')

test('npm manifest publishes a public DSH bundle with CLI and exact files allowlist', () => {
  assert.equal(manifest.private, undefined)
  assert.deepEqual(manifest.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org' })
  assert.deepEqual(manifest.bin, { 'dsh-workbuddy-auth': 'bin/cli.mjs' })
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/z2476720314-sys/dsh-workbuddy-auth.git',
  })
  assert.equal(manifest.homepage, 'https://github.com/z2476720314-sys/dsh-workbuddy-auth#readme')
  assert.deepEqual(manifest.bugs, { url: 'https://github.com/z2476720314-sys/dsh-workbuddy-auth/issues' })
  assert.deepEqual(manifest.files, [
    'bin/*.mjs',
    'lib/*.mjs',
    'lib/client.js',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'SECURITY.md',
  ])
})

test('bundle patch inserts the dual-face package row exactly once', () => {
  assert.equal((patch.match(/id: dsh-workbuddy-auth/g) ?? []).length, 1)
  assert.equal((patch.match(/name: dsh-workbuddy-auth/g) ?? []).length, 1)
  assert.match(patch, /^- insert:/m)
})
