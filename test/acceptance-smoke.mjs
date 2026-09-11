// plugins/dsh-workbuddy-auth/test/acceptance-smoke.mjs
// 真实只读冒烟：读凭据 -> 直接调推理端点 -> 断言 SSE。不打印任何机密。
import { readFile } from 'node:fs/promises'
import { DEFAULT_CREDENTIAL_FILE, parseCredentialRecord } from '../lib/credential.mjs'

const model = process.argv[2] ?? 'glm-5.3'
const record = parseCredentialRecord(await readFile(DEFAULT_CREDENTIAL_FILE, 'utf8'))
const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
  method: 'POST',
  headers: { Authorization: `${record.tokenType} ${record.accessToken}`, 'X-User-Id': record.uid, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], stream: true, max_tokens: 32 }),
})
const text = await res.text()
console.log('HTTP', res.status, res.headers.get('content-type'))
if (!res.ok) { console.error('upstream request failed', res.status); process.exit(1) }
if (!text.includes('chat.completion.chunk')) { console.error('no SSE chunks'); process.exit(1) }
console.log('smoke OK: streaming chunks received')
