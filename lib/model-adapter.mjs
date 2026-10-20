import { credentialScope } from './model-catalog.mjs'
import { modelError, validateModelPatch } from './model-settings.mjs'

export function effectiveReasoning(model, settings, explicit) {
  if (explicit !== undefined && !model.reasoningEfforts.includes(String(explicit))) throw modelError('WORKBUDDY_REASONING_INVALID')
  return explicit !== undefined ? String(explicit) : [settings.defaultReasoningEffort, model.defaultReasoningEffort].find((value) => model.reasoningEfforts.includes(value)) ?? null
}
const contextFor = (model, settings) => {
  const size = settings.contextWindowOverrides[model.id] ?? model.contextWindow
  if (!Number.isSafeInteger(size) || size <= 0 || (model.maxContextWindow !== null && size > model.maxContextWindow)) throw modelError('WORKBUDDY_CONTEXT_INVALID')
  return size
}
const outputFor = (model, size) => Math.max(1, Math.min(model.maxTokens ?? 8192, Math.floor(size / 2) || 1))
const textOf = (content) => typeof content === 'string' ? content : (Array.isArray(content) ? content : []).map((block) => block.type === 'text' ? block.text : block.type === 'tool-result' ? textOf(block.content) : '').join('')

function requestImageTarget(ref) {
  const byWidth = ref.width >= ref.height, sourceLong = byWidth ? ref.width : ref.height, sourceShort = byWidth ? ref.height : ref.width
  const scale = Math.min(1, Math.sqrt(4194304 / (ref.width * ref.height)))
  let long = Math.max(1, Math.floor(sourceLong * scale)), short = Math.max(1, Math.round(long * sourceShort / sourceLong))
  while (long * short > 4194304 && long > 1) { long--; short = Math.max(1, Math.round(long * sourceShort / sourceLong)) }
  return { width: byWidth ? long : short, height: byWidth ? short : long, maxBytes: 1048576 }
}

async function userContent(content, model, attachments, signal, requestImages) {
  if (typeof content === 'string') return content
  const parts = []
  for (const block of content ?? []) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    if (block.type !== 'image') continue
    if (block.offloaded === true) {
      const ref = block.attachment, path = attachments?.imageHostPath?.(ref)
      parts.push({ type: 'text', text: `[Image ${ref?.attachmentId ?? 'attachment'} omitted to fit request image limits; original retained${path ? `; read-only copy at ${JSON.stringify(path)}; use read_image to inspect it again and copy before editing` : ''}.]` })
      continue
    }
    if (!model.inputModalities.includes('image')) throw modelError('WORKBUDDY_IMAGE_UNSUPPORTED')
    let data = block.data ?? block.base64 ?? block.source?.data ?? block.source?.base64
    let mediaType = block.mediaType ?? block.mimeType ?? block.source?.mediaType ?? block.source?.mimeType ?? 'image/png'
    if (block.attachment && !data) {
      if (!attachments?.readImage && !attachments?.readImageRequest) throw modelError('WORKBUDDY_IMAGE_UNAVAILABLE')
      try {
        const ref = block.attachment, key = ref.attachmentId ?? ref
        if (!requestImages.has(key)) requestImages.set(key, (async () => {
          const versioned = typeof attachments.readImageRequest === 'function' && Number.isSafeInteger(ref.width) && ref.width > 0 && Number.isSafeInteger(ref.height) && ref.height > 0
          const image = versioned ? await attachments.readImageRequest(ref, requestImageTarget(ref), signal) : await attachments.readImage(ref, signal)
          return { data: Buffer.from(image.data).toString('base64'), mediaType: image.mediaType ?? image.ref.mediaType, ...(versioned ? { width: image.width, height: image.height } : {}) }
        })())
        const image = await requestImages.get(key)
        data = image.data; mediaType = image.mediaType
        if (image.width && image.height) parts.push({ type: 'text', text: `[Image ${ref.attachmentId}; source ${ref.width}x${ref.height}px; request preview ${image.width}x${image.height}px.]` })
      } catch { throw modelError(signal?.aborted ? 'ABORTED' : 'WORKBUDDY_IMAGE_UNAVAILABLE') }
    }
    const match = typeof data === 'string' ? data.match(/^data:([^;,]+);base64,(.*)$/s) : null
    if (match) { mediaType = match[1]; data = match[2] }
    if (!data || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) throw modelError('WORKBUDDY_IMAGE_UNAVAILABLE')
    parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } })
  }
  return parts.some((part) => part.type === 'image_url') ? parts : parts.map((part) => part.text).join('')
}
async function requestBody(options, model, settings, attachments) {
  const size = contextFor(model, settings)
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) throw modelError('WORKBUDDY_OUTPUT_INVALID')
  const requestImages = new Map(), imageLengths = []
  for (const message of options.messages ?? []) {
    const blocks = Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'tool-result' ? block.content ?? [] : [block]) : []
    for (const block of blocks.filter(block => block.type === 'image' && block.offloaded !== true)) {
      const parts = await userContent([block], model, attachments, options.signal, requestImages)
      const url = parts.find(part => part.type === 'image_url').image_url.url
      imageLengths.push(url.length - url.indexOf(',') - 1)
    }
  }
  // Match the Host's default base64 image budget; the Host records omissions and retries before dispatch.
  let remaining = imageLengths.reduce((sum, bytes) => sum + bytes, 0), offloadImages = 0
  while (remaining > 20971520) remaining -= imageLengths[offloadImages++]
  if (offloadImages > 0) {
    const failure = Object.freeze({ code: 'IMAGE_OFFLOAD_REQUIRED', message: 'WorkBuddy request images exceed the 20 MiB base64 budget.', offloadImages })
    throw Object.assign(modelError(failure.code, 413), { message: failure.message, failure })
  }
  const messages = [], systems = [options.system, ...(options.messages ?? []).filter((message) => message.role === 'system').map((message) => textOf(message.content))].filter((text) => typeof text === 'string' && text !== '')
  if (systems.length) messages.push({ role: 'system', content: systems.join('\n\n') })
  const toolImages = []
  for (const message of options.messages ?? []) {
    if (message.role === 'system') continue
    if (message.source?.kind !== 'tool') messages.push(...toolImages.splice(0))
    if (message.source?.kind === 'tool') {
      const result = message.content?.[0]
      messages.push({ role: 'tool', tool_call_id: message.source.callId ?? result?.toolCallId ?? '', content: textOf(message.content) })
      const imageBlocks = (message.content ?? []).flatMap((block) => block.type === 'tool-result' ? block.content ?? [] : [block]).filter((block) => block.type === 'image')
      if (imageBlocks.length) toolImages.push({ role: 'user', content: await userContent(imageBlocks, model, attachments, options.signal, requestImages) })
    } else if (message.role === 'assistant') {
      const calls = (Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool-call').map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) } }))
      messages.push({ role: 'assistant', content: textOf(message.content), ...(calls.length ? { tool_calls: calls } : {}) })
    } else messages.push({ role: 'user', content: await userContent(message.content, model, attachments, options.signal, requestImages) })
  }
  messages.push(...toolImages)
  const effort = effectiveReasoning(model, settings, options.reasoningEffort)
  return { model: model.id, messages, stream: true, stream_options: { include_usage: true }, max_tokens: Math.min(options.maxTokens ?? outputFor(model, size), model.maxTokens ?? size, size), ...(effort === null ? {} : { reasoning_effort: effort }), ...(options.temperature === undefined ? {} : { temperature: options.temperature }), ...(options.stop?.length ? { stop: options.stop } : {}), ...(options.tools?.length ? { tools: options.tools.map((tool) => { const { $schema, ...parameters } = tool.parameters ?? { type: 'object', properties: {} }; return { type: 'function', function: { name: tool.name, description: tool.description, parameters } } }), tool_choice: 'auto' } : {}) }
}

function upstreamError(status, payload = null) {
  const quota = [6004, '6004'].includes(payload?.code ?? payload?.error?.code)
  const code = quota ? 'QUOTA' : [401, 403].includes(status) ? 'INVALID_CREDENTIAL' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' : 'PROVIDER_ERROR'
  const reset = quota && String(payload?.msg ?? payload?.error?.message ?? '').match(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{1,2}\b/)?.[0]
  const message = quota ? `WorkBuddy 当前模型使用量已达上限${reset ? `，将在 ${reset} 重置` : ''}；可切换其他模型继续使用。` : `WorkBuddy 请求失败（HTTP ${status}，${code}）。`
  const httpStatus = quota ? 429 : status
  return Object.assign(modelError(code, httpStatus), { message, failure: Object.freeze({ code, message, status: httpStatus }) })
}

async function* streamEvents(response, signal, idleTimeoutMs) {
  if (!response.body) throw upstreamError(response.status)
  const reader = response.body.getReader(), decoder = new TextDecoder(), calls = new Map()
  let pending = '', index = 0, current = null, finish = null, done = false, usage = null, sawTool = false
  const closeText = () => { if (!current) return []; const event = { type: 'block-end', index: current.index, block: { type: current.type, text: current.text } }; current = null; return [event] }
  const closeCalls = () => { const events = [...calls.values()].map((call) => ({ type: 'block-end', index: call.index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments || '{}' } })); calls.clear(); return events }
  const process = (line) => {
    if (!line.startsWith('data:')) return []
    const raw = line.slice(5).trim(), events = []
    if (raw === '[DONE]') { done = true; return events }
    if (!raw) return events
    let chunk
    try { chunk = JSON.parse(raw) } catch { throw modelError('WORKBUDDY_STREAM_INVALID', 502) }
    if (chunk.error || (chunk.code !== undefined && ![0, '0'].includes(chunk.code))) throw upstreamError(response.status, chunk)
    if (chunk.usage) {
      const u = chunk.usage, number = (n) => Number.isFinite(n) && n > 0 ? n : 0
      const cached = number(u.prompt_tokens_details?.cached_tokens), written = number(u.prompt_tokens_details?.cache_write_tokens), reasoning = number(u.completion_tokens_details?.reasoning_tokens)
      usage = { inputTokens: Math.max(0, number(u.prompt_tokens) - cached - written), outputTokens: number(u.completion_tokens), ...(cached ? { cacheReadTokens: cached } : {}), ...(written ? { cacheWriteTokens: written } : {}), ...(reasoning ? { reasoningTokens: reasoning } : {}) }
    }
    const choice = chunk.choices?.[0], delta = choice?.delta
    for (const [type, text] of [['reasoning', delta?.reasoning_content ?? delta?.reasoning], ['text', delta?.content]]) {
      if (typeof text !== 'string' || text === '') continue
      events.push(...closeCalls())
      if (current?.type !== type) { events.push(...closeText()); current = { index: index++, type, text: '' }; events.push({ type: 'block-start', index: current.index, blockType: type }) }
      current.text += text; events.push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: current.index, text })
    }
    for (const deltaCall of delta?.tool_calls ?? []) {
      events.push(...closeText())
      const wire = deltaCall.index ?? 0, fn = deltaCall.function ?? {}
      let call = calls.get(wire)
      if (!call) { call = { index: index++, id: deltaCall.id ?? `call_${wire}`, name: fn.name ?? '', arguments: '' }; calls.set(wire, call); events.push({ type: 'block-start', index: call.index, blockType: 'tool-call' }); sawTool = true }
      if (deltaCall.id) call.id = deltaCall.id
      if (fn.name) call.name = fn.name
      call.arguments += fn.arguments ?? ''
      events.push({ type: 'tool-call-delta', index: call.index, id: call.id, ...(call.name ? { name: call.name } : {}), argumentsDelta: fn.arguments ?? '' })
    }
    if (choice?.finish_reason) { finish = choice.finish_reason; events.push(...closeText(), ...closeCalls()) }
    return events
  }
  const aborted = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    while (!done) {
      if (signal?.aborted) throw modelError('ABORTED', 499)
      let timer, timeoutError
      // Reject before cancellation can resolve the pending read.
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timeoutError = modelError('TIMEOUT', 504); reject(timeoutError); void reader.cancel().catch(() => {}) }, idleTimeoutMs) })
      let part
      try { part = await Promise.race([reader.read(), timeout]) }
      catch (error) {
        if (signal?.aborted) throw modelError('ABORTED', 499)
        if (timeoutError && error === timeoutError) throw timeoutError
        throw Object.assign(modelError('TRANSPORT', 502), { failure: Object.freeze({ code: 'TRANSPORT', message: 'TRANSPORT', status: 502 }) })
      } finally { clearTimeout(timer) }
      if (signal?.aborted) throw modelError('ABORTED', 499)
      pending += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true })
      if (pending.length > 2 * 1024 * 1024) throw modelError('WORKBUDDY_STREAM_INVALID', 502)
      if (!response.ok) {
        if (!part.done) continue
        let payload
        try { payload = JSON.parse(pending) } catch {}
        throw upstreamError(response.status, payload)
      }
      let newline
      while ((newline = pending.indexOf('\n')) !== -1) { const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); for (const event of process(line)) yield event; if (done) break }
      if (part.done) { if (pending && !done) for (const event of process(pending)) yield event; break }
    }
    if (!done && !finish) throw modelError('WORKBUDDY_STREAM_TRUNCATED', 502)
    yield* closeText(); yield* closeCalls()
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: ['length', 'max_tokens'].includes(finish) ? 'max-tokens' : sawTool || finish === 'tool_calls' ? 'tool-calls' : 'stop' } }
  } finally { signal?.removeEventListener('abort', aborted); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function createWorkBuddyAdapter({ settings, catalog, readCredential, fetchImpl = fetch, attachments, beforeCall = async () => {}, idleTimeoutMs = 180000 }) {
  const activeStreams = new Set()
  async function waitFor(operation, signal) {
    if (!signal) return operation()
    if (signal.aborted) throw modelError('ABORTED', 499)
    let onAbort
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(modelError('ABORTED', 499))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw modelError('ABORTED', 499); return operation() }), cancelled])
      if (signal.aborted) throw modelError('ABORTED', 499)
      return result
    } finally { signal.removeEventListener('abort', onAbort) }
  }
  async function snapshot(signal) {
    const preferences = await waitFor(() => settings.read(), signal)
    const scopeKey = credentialScope(await waitFor(readCredential, signal))
    if (scopeKey === null) throw modelError('WORKBUDDY_ACCOUNT_REQUIRED', 401)
    let listing = await waitFor(() => catalog.load({ signal }), signal), credential = await waitFor(readCredential, signal)
    if (!credential) throw modelError('WORKBUDDY_ACCOUNT_REQUIRED', 401)
    // Invalidated catalog reads return no scope; reacquire metadata once before dispatching chat.
    if (listing.scopeKey === null && scopeKey === credentialScope(credential)) {
      listing = await waitFor(() => catalog.load({ signal }), signal)
      credential = await waitFor(readCredential, signal)
      if (!credential) throw modelError('WORKBUDDY_ACCOUNT_REQUIRED', 401)
    }
    if (listing.scopeKey !== scopeKey || credentialScope(credential) !== scopeKey) throw modelError('WORKBUDDY_ACCOUNT_CHANGED', 409)
    return { preferences, listing, credential }
  }
  async function selected(id, signal) {
    const value = await snapshot(signal)
    const model = value.listing.models.find((entry) => entry.id === id)
    if (value.preferences.enabled && value.preferences.enabledModelIds.includes(id) && !model && value.listing.catalogError) throw modelError(value.listing.catalogError, value.listing.catalogError === 'WORKBUDDY_CATALOG_TIMEOUT' ? 504 : 502)
    if (!value.preferences.enabled || !value.preferences.enabledModelIds.includes(id) || !model) throw modelError('WORKBUDDY_MODEL_DISABLED', 409)
    return { ...value, model }
  }
  const adapter = {
    dispose() { for (const controller of activeStreams) controller.abort() },
    providerInfo: (provider = 'workbuddy') => ({ id: provider, name: 'WorkBuddy' }),
    imageRequestTarget: (_provider, _model, ref) => requestImageTarget(ref),
    // Let the Host apply its default retry policy.
    providerRetryPolicy: () => undefined,
    async listModels(provider = 'workbuddy') {
      let value
      try { value = await snapshot() } catch (error) { if (['WORKBUDDY_ACCOUNT_REQUIRED', 'WORKBUDDY_ACCOUNT_CHANGED'].includes(error.code)) return []; throw error }
      return value.preferences.enabled ? value.listing.models.filter((model) => value.preferences.enabledModelIds.includes(model.id)).map((model) => ({ provider, id: model.id, name: model.name, inputModalities: model.inputModalities })) : []
    },
    async resolveModel(provider, id, signal) {
      const { model, preferences } = await selected(id, signal), size = contextFor(model, preferences), maxTokens = outputFor(model, size), effort = effectiveReasoning(model, preferences)
      const budget = size - maxTokens, threshold = Math.floor(Math.min(size * 0.8, budget - 65536))
      return { provider, id, name: model.name, inputModalities: model.inputModalities, context: { contextWindow: size }, ...(threshold > 0 && Math.floor(budget * 0.16) < threshold ? { defaultMaxTokens: maxTokens } : {}), ...(model.reasoningEfforts.length ? { reasoning: { efforts: model.reasoningEfforts.map((id) => ({ id, name: id })), ...(effort === null ? {} : { defaultEffort: effort }) } } : {}) }
    },
    async prepareCall(provider, id, signal) { return { model: await adapter.resolveModel(provider, id, signal), stream: (options) => adapter.stream(options) } },
    async *stream(options) {
      if (options.signal?.aborted) throw modelError('ABORTED', 499)
      const controller = new AbortController(), onAbort = () => controller.abort()
      activeStreams.add(controller)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      let timer, response
      try {
        await waitFor(() => beforeCall(controller.signal), controller.signal)
        const { model, preferences, credential } = await waitFor(() => selected(options.model, controller.signal), controller.signal)
        const body = await waitFor(() => requestBody({ ...options, signal: controller.signal }, model, preferences, attachments), controller.signal)
        if (credentialScope(await waitFor(readCredential, controller.signal)) !== credentialScope(credential)) throw modelError('WORKBUDDY_ACCOUNT_CHANGED', 409)
        const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason?.code === 'TIMEOUT' ? controller.signal.reason : modelError('ABORTED', 499)), { once: true }))
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => { const error = modelError('TIMEOUT', 504); controller.abort(error); reject(error) }, idleTimeoutMs) })
        try {
          response = await Promise.race([fetchImpl(credential.backend + '/v2/chat/completions', { method: 'POST', headers: { ...credential.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }), timeout, cancelled])
        } catch (error) {
          const code = error.code === 'TIMEOUT' ? 'TIMEOUT' : controller.signal.aborted ? 'ABORTED' : 'TRANSPORT'
          throw modelError(code, code === 'ABORTED' ? 499 : code === 'TIMEOUT' ? 504 : 502)
        } finally { clearTimeout(timer) }
        yield* streamEvents(response, controller.signal, idleTimeoutMs)
      } finally { clearTimeout(timer); controller.abort(); activeStreams.delete(controller); options.signal?.removeEventListener('abort', onAbort) }
    },
  }
  return adapter
}

export function createModelService({ settings, catalog, notify = () => {} }) {
  let registered = false, conflict = null
  async function status({ force = false } = {}) {
    const preferences = await settings.read(), listing = await catalog.load({ force })
    return { ok: true, ...preferences, region: listing.region, catalogSource: listing.catalogSource, catalogError: listing.catalogError, serving: registered && conflict === null && preferences.enabled && listing.models.some((model) => preferences.enabledModelIds.includes(model.id)), conflict, models: listing.models.map((model) => ({ ...model, enabled: preferences.enabledModelIds.includes(model.id), contextWindowOverride: preferences.contextWindowOverrides[model.id] ?? null, effectiveContextWindow: contextFor(model, preferences), effectiveReasoningEffort: effectiveReasoning(model, preferences) })) }
  }
  return {
    status,
    async patch(patch) {
      validateModelPatch(patch)
      if (patch.contextWindowOverrides) {
        const listing = await catalog.load()
        for (const [id, size] of Object.entries(patch.contextWindowOverrides)) {
          const model = listing.models.find((model) => model.id === id)
          if (size !== null && model?.maxContextWindow !== null && model?.maxContextWindow !== undefined && size > model.maxContextWindow) throw modelError('WORKBUDDY_CONTEXT_INVALID')
        }
      }
      await settings.patch(patch); notify(); return status()
    },
    async refresh() { const state = await status({ force: true }); notify(); return state },
    accountChanged() { catalog.invalidate({ keepCache: true }); notify() },
    registration(active, error = null) { registered = active; conflict = error; notify() },
  }
}
