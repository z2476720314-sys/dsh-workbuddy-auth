import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, TOKEN_REF } from '../lib/index.mjs'

const model = { id: 'fixture-model', name: 'Fixture', contextWindow: { defaultLength: 32000 }, maxAllowedSize: 128000, maxOutputTokens: 8192, supportsImages: true, reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'low' } }
const headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
/**
 * @typedef {{ readImage(ref: { attachmentId: string, mediaType: string }, signal: AbortSignal): Promise<{ data: Uint8Array, ref: { mediaType: string } }> }} FixtureAttachments
 * @param {{ after(handler: () => void | Promise<void>): void }} t
 * @param {{ conflict?: boolean, noLlm?: boolean, hangingStream?: boolean, attachments?: FixtureAttachments }} options
 */
async function harness(t, { conflict = false, noLlm = false, hangingStream = false, attachments } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-model-integrated-'))
  const credentialFile = join(dir, 'synthetic.info'), filePath = join(dir, 'models.json')
  await writeFile(credentialFile, JSON.stringify({ account: { uid: 'synthetic-uid' }, auth: { ['accessToken']: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 604800000 } }))
  const routes = [], effects = [], hooks = [], notices = [], requests = [], values = new Map(), listeners = new Map()
  let adapter, registered = 0, removed = 0, catalogOffline = false
  const ctx = {
    attachments,
    credentials: { resolve: async (ref) => values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined, set: async (ref, value) => { const previous = values.get(ref); values.set(ref, value); if (previous !== value) ctx.emit('credentials/reference-updated', ref) } },
    logger: { info() {}, warn() {} },
    emit: (event, ...args) => { notices.push(event); for (const listener of listeners.get(event) ?? []) listener(...args) },
    on(event, listener) { const callbacks = listeners.get(event) ?? new Set(); callbacks.add(listener); listeners.set(event, callbacks); return () => callbacks.delete(listener) },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
    inject(names, callback) { if (names.includes('llm')) hooks.push(callback); if (names.every((name) => ctx[name])) callback(ctx) },
    webServer: { register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) } } },
    get: (name) => ctx[name],
  }
  if (!noLlm) ctx.llm = { registerAdapter(providers, value) { assert.deepEqual(providers, ['workbuddy']); registered++; if (conflict) throw new Error('existing-provider synthetic-access'); adapter = value; return () => { removed++ } } }
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, ...init })
    if (url.endsWith('/v3/config')) {
      if (catalogOffline) throw new Error('offline')
      return new Response(JSON.stringify({ code: 0, data: { models: [model] } }))
    }
    if (url.endsWith('/v2/chat/completions')) {
      if (hangingStream) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"pending"}}]}\n\n')) } }))
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }
    throw new Error('unexpected synthetic URL')
  }
  apply(ctx, { authDir: '', credentialFile, rejectedFile: '', tickMs: 86400000 }, { fetchImpl, modelSettingsFile: filePath })
  const dispose = () => { for (const stop of effects.splice(0).reverse()) stop() }
  t.after(async () => { dispose(); await rm(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 50 && !values.has(TOKEN_REF); i++) await new Promise((resolve) => setTimeout(resolve, 1))
  const call = async (path, method = 'GET', body) => {
    const route = routes.find((route) => route.path === '/api/dsh-workbuddy-auth' + path)
    assert.ok(route, 'production model route must exist even when no model selected')
    let output, status
    await route.handler({ method, headers, resume() {}, setEncoding() {}, on(event, handler) { if (event === 'data') queueMicrotask(() => handler(JSON.stringify(body))); if (event === 'end') queueMicrotask(handler); return this } }, { writeHead(code) { status = code }, end(text) { output = JSON.parse(text) } })
    return { status, output }
  }
  return { ctx, values, routes, requests, notices, hooks, listeners, call, dispose, adapter: () => adapter, registered: () => registered, removed: () => removed, offline: () => { catalogOffline = true } }
}

test('same-account credential notification during outage keeps selected models callable', async (t) => {
  const h = await harness(t)
  await h.call('/models', 'POST', { enabledModelIds: ['fixture-model'] })
  h.offline()
  h.ctx.emit('credentials/reference-updated', TOKEN_REF)
  const state = (await h.call('/models/refresh', 'POST')).output
  assert.equal(state.catalogSource, 'cache')
  assert.equal(state.serving, true)
  assert.deepEqual((await h.adapter().listModels()).map(({ id }) => id), ['fixture-model'])
  const events = []
  for await (const event of h.adapter().stream({ provider: 'workbuddy', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) events.push(event)
  assert.equal(events.find((event) => event.type === 'text-delta').text, 'ok')
})

test('production zero selection routes stay reachable; saved model lists and actual stream uses coherent seam snapshot', async (t) => {
  const h = await harness(t)
  assert.equal(h.registered(), 1)
  assert.deepEqual(await h.adapter().listModels(), [])
  assert.equal((await h.call('/models')).output.serving, false)
  assert.equal((await h.call('/models/refresh', 'POST')).output.models.length, 1)
  assert.ok(h.requests.every((request) => request.url.endsWith('/v3/config')))
  const saved = await h.call('/models', 'POST', { enabledModelIds: ['fixture-model'], defaultReasoningEffort: 'high' })
  assert.equal(saved.status, 200); assert.equal(saved.output.serving, true)
  assert.equal((await h.adapter().listModels())[0].id, 'fixture-model')
  const events = []
  for await (const event of h.adapter().stream({ provider: 'workbuddy', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) events.push(event)
  assert.equal(events.find((event) => event.type === 'text-delta').text, 'ok')
  const sent = h.requests.find((request) => request.url.endsWith('/v2/chat/completions'))
  assert.equal(new Headers(sent.headers).get('authorization'), 'Bearer ' + h.values.get(TOKEN_REF))
  assert.equal(new Headers(sent.headers).get('x-user-id'), 'synthetic-uid')
  assert.equal(JSON.parse(sent.body).reasoning_effort, 'high')
  assert.ok(h.notices.includes('llm/adapters-updated'))
  for (const hook of h.hooks) hook(h.ctx)
  assert.equal(h.registered(), 1, 'reentrant notification cannot replace or double-register active adapter')
  await h.call('/models', 'POST', { enabled: false })
  assert.deepEqual(await h.adapter().listModels(), [])
  h.dispose(); assert.equal(h.removed(), 1); assert.equal(h.routes.length, 0)
})

test('conflict is sanitized and never steals an existing provider', async (t) => {
  const h = await harness(t, { conflict: true })
  const state = (await h.call('/models')).output
  assert.equal(state.conflict, 'WORKBUDDY_ADAPTER_CONFLICT'); assert.equal(state.serving, false)
  assert.equal(JSON.stringify(state).includes('synthetic-access'), false)
  assert.equal(h.removed(), 0)
})

test('no llm service keeps authentication and model-management routes available', async (t) => {
  const h = await harness(t, { noLlm: true })
  assert.equal(h.registered(), 0)
  assert.ok(h.routes.some((route) => route.path.endsWith('/credential/reload')))
  assert.equal((await h.call('/models')).output.serving, false)
  assert.equal((await h.call('/models/refresh', 'POST')).output.models.length, 1)
})

test('credential reference updates invalidate native lists and listener is removed on unload', async (t) => {
  const h = await harness(t)
  await h.call('/models', 'POST', { enabledModelIds: ['fixture-model'] })
  const before = h.notices.filter((event) => event === 'llm/adapters-updated').length
  h.ctx.emit('credentials/reference-updated', 'OTHER_SYNTHETIC_REF')
  assert.equal(h.notices.filter((event) => event === 'llm/adapters-updated').length, before)
  h.values.delete(TOKEN_REF)
  h.ctx.emit('credentials/reference-updated', TOKEN_REF)
  assert.equal(h.notices.filter((event) => event === 'llm/adapters-updated').length, before + 1)
  assert.deepEqual(await h.adapter().listModels(), [])
  const state = (await h.call('/models')).output
  assert.equal(state.region, null); assert.deepEqual(state.models, []); assert.deepEqual(state.enabledModelIds, ['fixture-model'])
  h.dispose(); assert.equal(h.listeners.get('credentials/reference-updated').size, 0)
})

test('unload cancels a running chat stream as well as unregistering the provider', async (t) => {
  const h = await harness(t, { hangingStream: true })
  await h.call('/models', 'POST', { enabledModelIds: ['fixture-model'] })
  const stream = h.adapter().stream({ provider: 'workbuddy', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  assert.equal((await stream.next()).value.type, 'block-start')
  assert.equal((await stream.next()).value.type, 'text-delta')
  h.dispose()
  assert.equal(h.requests.find((request) => request.url.endsWith('/v2/chat/completions')).signal.aborted, true)
  await assert.rejects(stream.next(), { code: 'ABORTED' })
  assert.equal(h.removed(), 1)
})

for (const state of ['absent', 'present', 'late', 'removed']) {
  test(`optional attachment ${state} uses the current bound image service and keeps text requests available`, async (t) => {
    const ref = { attachmentId: 'fixture-image', mediaType: 'image/png' }
    const service = {
      /** @type {{ attachmentId: string, mediaType: string }[]} */
      reads: [], async readImage(value, signal) {
      assert.equal(this, service, 'image reader must retain its service receiver')
      assert.deepEqual(value, { attachmentId: 'fixture-image', mediaType: 'image/png' })
      assert.equal(signal.aborted, false)
      this.reads.push(value)
      return { data: new TextEncoder().encode('synthetic-image'), ref: { mediaType: 'image/png' } }
    } }
    const h = await harness(t, { attachments: state === 'present' || state === 'removed' ? service : undefined })
    await h.call('/models', 'POST', { enabledModelIds: ['fixture-model'] })
    const adapter = h.adapter()
    if (state === 'late') h.ctx.attachments = service
    if (state === 'removed') delete h.ctx.attachments
    const consume = async (content) => {
      /** @type {{ type: string, text?: string }[]} */
      const events = []
      for await (const event of adapter.stream({ provider: 'workbuddy', model: 'fixture-model', messages: [{ role: 'user', content }] })) events.push(event)
      return events
    }
    if (state === 'absent' || state === 'removed') {
      await assert.rejects(consume([{ type: 'image', attachment: ref }]), { code: 'WORKBUDDY_IMAGE_UNAVAILABLE', message: 'WORKBUDDY_IMAGE_UNAVAILABLE' })
      assert.equal(service.reads.length, 0, 'missing or revoked services must never receive an image read')
      assert.equal(h.requests.filter((request) => request.url.endsWith('/v2/chat/completions')).length, 0)
    } else {
      const imageEvents = await consume([{ type: 'image', attachment: ref }])
      assert.equal(imageEvents.find((event) => event.type === 'text-delta')?.text, 'ok')
      const imageRequest = h.requests.find((request) => request.url.endsWith('/v2/chat/completions'))
      assert.deepEqual(JSON.parse(imageRequest.body).messages, [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGljLWltYWdl' } }] }])
      assert.equal(service.reads.length, 1)
    }
    const textEvents = await consume([{ type: 'text', text: 'text remains available' }])
    assert.equal(textEvents.find((event) => event.type === 'text-delta')?.text, 'ok')
    assert.equal(service.reads.length, state === 'absent' || state === 'removed' ? 0 : 1)
    for (const hook of h.hooks) hook(h.ctx)
    assert.equal(h.adapter(), adapter)
    assert.equal(h.registered(), 1)
    h.dispose()
    assert.equal(h.removed(), 1)
  })
}

