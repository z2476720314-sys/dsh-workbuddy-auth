import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createManagedAccountStore } from '../lib/managed-store.mjs'
import { writeCredentialAtomically } from '../lib/writeback.mjs'

const CN_ORIGIN = 'https://copilot.tencent.com'
const INTL_ORIGIN = 'https://www.workbuddy.ai'

function createTestProtector() {
  return {
    async protect(value) {
      return `sealed:${Buffer.from(value, 'utf8').toString('base64')}`
    },
    async unprotect(value) {
      if (!value.startsWith('sealed:')) throw new Error('invalid ciphertext')
      return Buffer.from(value.slice('sealed:'.length), 'base64').toString('utf8')
    },
  }
}

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'workbuddy-accounts.dpapi')
  const options = {
    filePath,
    protector: createTestProtector(),
    readFile: (file, encoding) => readFile(file, encoding),
    writeAtomic: writeCredentialAtomically,
    ...overrides,
  }
  return { filePath, store: createManagedAccountStore(options) }
}

function record(overrides = {}) {
  return {
    id: 'managed-a',
    region: 'cn',
    uid: 'uid-a',
    uin: '',
    displayName: 'Fixture User',
    phoneMasked: '***1234',
    accessToken: 'sec-a',
    refreshToken: 'refresh-secret-a',
    expiresAt: 2_000_000_000_000,
    refreshExpiresAt: 2_100_000_000_000,
    apiOrigin: CN_ORIGIN,
    ...overrides,
  }
}

test('managed store loads an empty document when the vault file is absent', async (t) => {
  const { filePath, store } = await setup(t)

  assert.deepEqual(await store.list(), [])
  assert.equal(await store.getActiveId(), null)
  await assert.rejects(readFile(filePath), { code: 'ENOENT' })
})

test('managed store creates its parent directory before the first write', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'missing', 'workbuddy-accounts.dpapi')
  const store = createManagedAccountStore({ filePath, protector: createTestProtector() })

  await store.upsert(record())

  assert.deepEqual(await store.list(), [record()])
  assert.match(await readFile(filePath, 'utf8'), /^sealed:[A-Za-z0-9+/=]+$/u)
})

test('managed store persists only ciphertext and reloads encrypted records', async (t) => {
  const { filePath, store } = await setup(t)
  await store.upsert(record())

  const persisted = await readFile(filePath, 'utf8')
  assert.match(persisted, /^sealed:[A-Za-z0-9+/=]+$/u)
  assert.doesNotMatch(persisted, /sec-a|Fixture User|uid-a|"version"/u)

  const reloaded = createManagedAccountStore({
    filePath,
    protector: createTestProtector(),
    readFile: (file, encoding) => readFile(file, encoding),
    writeAtomic: writeCredentialAtomically,
  })
  assert.deepEqual(await reloaded.list(), [record()])
})

test('managed store rejects persisted accounts with missing or null schema fields', async (t) => {
  const { filePath, store } = await setup(t)
  const protector = createTestProtector()
  const malformed = record()
  delete malformed.uid
  const documents = [
    { version: 1, activeId: null, accounts: [malformed] },
    { version: 1, activeId: null, accounts: [record({ refreshToken: null })] },
  ]

  for (const document of documents) {
    await writeCredentialAtomically(filePath, await protector.protect(JSON.stringify(document)))
    await assert.rejects(store.list(), { code: 'MANAGED_STORE_INVALID' })
  }
})

test('managed store rejects identity conflicts that match different records', async (t) => {
  const { filePath, store } = await setup(t)
  await store.upsert(record({ id: 'account-a', uid: 'uid-a', uin: 'uin-a' }))
  await store.upsert(record({ id: 'account-b', uid: 'uid-b', uin: 'uin-b' }))
  const before = await readFile(filePath, 'utf8')

  await assert.rejects(store.upsert(record({ id: 'incoming', uid: 'uid-a', uin: 'uin-b' })), {
    code: 'MANAGED_ACCOUNT_IDENTITY_CONFLICT',
  })
  assert.equal(await readFile(filePath, 'utf8'), before)
  assert.deepEqual((await store.list()).map(({ id, uid, uin }) => ({ id, uid, uin })), [
    { id: 'account-a', uid: 'uid-a', uin: 'uin-a' },
    { id: 'account-b', uid: 'uid-b', uin: 'uin-b' },
  ])
})

test('managed store upsert replaces the same regional UID while preserving its ID', async (t) => {
  const { store } = await setup(t)
  await store.upsert(record())

  const updated = await store.upsert(record({
    id: 'new-generated-id',
    displayName: 'Updated User',
    accessToken: 'rot-tok',
    refreshToken: 'rotated-refresh',
  }))

  assert.equal(updated.id, 'managed-a')
  assert.equal(updated.displayName, 'Updated User')
  assert.deepEqual(await store.list(), [record({
    displayName: 'Updated User',
    accessToken: 'rot-tok',
    refreshToken: 'rotated-refresh',
  })])
})

test('managed store deduplicates by regional UIN and does not merge records without stable identity', async (t) => {
  const { store } = await setup(t)
  await store.upsert(record({ uid: '', uin: 'uin-a' }))
  await store.upsert(record({ id: 'replacement', uid: '', uin: 'uin-a', accessToken: 'new-tok' }))
  await store.upsert(record({ id: 'anonymous-a', uid: '', uin: '' }))
  await store.upsert(record({ id: 'anonymous-b', uid: '', uin: '' }))

  const accounts = await store.list()
  assert.equal(accounts.length, 3)
  assert.equal(accounts[0].id, 'managed-a')
  assert.equal(accounts[0].accessToken, 'new-tok')
  assert.deepEqual(accounts.slice(1).map(({ id }) => id), ['anonymous-a', 'anonymous-b'])
})

test('managed store persists and validates the active account ID', async (t) => {
  const { filePath, store } = await setup(t)
  await store.upsert(record())
  await store.upsert(record({ id: 'managed-b', region: 'intl', uid: 'uid-b', apiOrigin: INTL_ORIGIN }))
  await store.setActiveId('managed-b')

  const reloaded = createManagedAccountStore({
    filePath,
    protector: createTestProtector(),
    readFile: (file, encoding) => readFile(file, encoding),
    writeAtomic: writeCredentialAtomically,
  })
  assert.equal(await reloaded.getActiveId(), 'managed-b')
  await assert.rejects(reloaded.setActiveId('missing-id'), { code: 'MANAGED_ACCOUNT_NOT_FOUND' })
})

test('managed store rejects an API origin that does not match the account region', async (t) => {
  const { filePath, store } = await setup(t)

  await assert.rejects(store.upsert(record({ apiOrigin: 'https://evil.example' })), {
    code: 'MANAGED_ACCOUNT_INVALID',
  })
  await assert.rejects(readFile(filePath), { code: 'ENOENT' })
})

test('managed store write failure preserves the previous ciphertext', async (t) => {
  let failWrite = false
  const { filePath, store } = await setup(t, {
    writeAtomic(file, value) {
      if (failWrite) throw new Error(`write failed: ${file}`)
      return writeCredentialAtomically(file, value)
    },
  })
  await store.upsert(record())
  const before = await readFile(filePath, 'utf8')
  failWrite = true

  await assert.rejects(store.upsert(record({ accessToken: 'no-land' })), {
    code: 'MANAGED_STORE_WRITE_FAILED',
    message: 'MANAGED_STORE_WRITE_FAILED',
  })
  assert.equal(await readFile(filePath, 'utf8'), before)
})

test('managed store encryption failure preserves ciphertext and never writes plaintext', async (t) => {
  let failProtect = false
  const protector = {
    ...createTestProtector(),
    async protect(value) {
      if (failProtect) throw new Error(`failed: ${value}`)
      return `sealed:${Buffer.from(value, 'utf8').toString('base64')}`
    },
  }
  const { filePath, store } = await setup(t, { protector })
  await store.upsert(record())
  const before = await readFile(filePath, 'utf8')
  failProtect = true

  await assert.rejects(store.upsert(record({ accessToken: 'no-land' })), {
    code: 'MANAGED_STORE_ENCRYPT_FAILED',
    message: 'MANAGED_STORE_ENCRYPT_FAILED',
  })
  assert.equal(await readFile(filePath, 'utf8'), before)
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /must-not-land|Fixture User/u)
})
