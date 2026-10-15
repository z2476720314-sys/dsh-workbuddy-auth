import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, inject } from '../lib/index.mjs'

let Context
try {
  ;({ Context } = await import(process.env.DSH_CORDIS_TEST_MODULE || '@deepseek-ai/cordis'))
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}

for (const state of ['absent', 'present', 'late', 'removed']) {
  test(`optional attachments ${state} keeps full Cordis apply and native routes active without credential or network calls`, { skip: !Context }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-optional-services-'))
    const calls = { resolve: 0, set: 0, image: 0, fetch: 0, registered: 0, disposed: 0 }
    /** @type {{ path: string }[]} */
    const routes = []
    const root = new Context().extend({ logger: { info() {}, warn() {}, error() {} } })
    root.provide('credentials', {
      async resolve() { calls.resolve++; throw new Error('CREDENTIAL_READ_FORBIDDEN') },
      async set() { calls.set++; throw new Error('CREDENTIAL_WRITE_FORBIDDEN') },
    })
    root.provide('llm', { registerAdapter(providers) {
      assert.deepEqual(providers, ['workbuddy'])
      calls.registered++
      return () => { calls.disposed++ }
    } })
    root.provide('webServer', { register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    } })
    const provideAttachments = () => root.plugin({ name: `fixture-attachments-${state}`, apply(ctx) {
      ctx.provide('attachments', { async readImage() { calls.image++; throw new Error('IMAGE_READ_FORBIDDEN') } })
    } })
    let service, fiber, startupError
    t.after(async () => {
      await fiber?.dispose()
      await service?.dispose()
      await rm(dir, { recursive: true, force: true })
    })
    if (state === 'present' || state === 'removed') {
      service = provideAttachments()
      await service
      assert.equal(typeof root.get('attachments')?.readImage, 'function', 'fixture service must be ACTIVE before loading WorkBuddy')
    }
    fiber = root.plugin({ name: `fixture-workbuddy-${state}`, inject, apply(ctx) {
      try {
        apply(ctx, { authDir: '', rejectedFile: '', credentialFile: join(dir, 'missing.info'), tickMs: 86400000 }, {
          modelSettingsFile: join(dir, 'models.json'),
          async fetchImpl() { calls.fetch++; throw new Error('NETWORK_FORBIDDEN') },
        })
      } catch (error) { startupError = error }
    } })
    await fiber
    assert.equal(startupError, undefined, 'optional attachment absence must not throw during full apply')
    if (state === 'late') {
      service = provideAttachments()
      await service
    }
    if (state === 'removed') await service.dispose()
    assert.ok(routes.some((route) => route.path === '/api/dsh-workbuddy-auth/status'))
    assert.ok(routes.some((route) => route.path === '/api/dsh-workbuddy-auth/models'))
    assert.ok(routes.some((route) => route.path === '/api/dsh-workbuddy-auth/models/refresh'))
    assert.equal(calls.registered, 1, 'attachment transitions must not replace the text-model adapter')
    assert.deepEqual({ resolve: calls.resolve, set: calls.set, image: calls.image, fetch: calls.fetch }, { resolve: 0, set: 0, image: 0, fetch: 0 })
    await fiber.dispose()
    assert.equal(calls.disposed, 1)
    assert.equal(routes.length, 0)
  })
}
