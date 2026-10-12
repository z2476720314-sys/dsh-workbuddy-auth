import assert from 'node:assert/strict'
import test from 'node:test'
import { createDpapiProtector } from '../lib/dpapi.mjs'

function createFakeDpapi() {
  const ciphertexts = new Map()
  let nextId = 0

  return async (operation, input) => {
    if (operation === 'protect') {
      const ciphertext = `fixture-dpapi-${++nextId}`
      ciphertexts.set(ciphertext, input)
      return ciphertext
    }

    if (operation === 'unprotect' && ciphertexts.has(input)) return ciphertexts.get(input)
    throw new Error(`fixture subprocess output: ${input}`)
  }
}

test('DPAPI protector round-trips plaintext through the injected bridge', async () => {
  const protector = createDpapiProtector({ runPowerShell: createFakeDpapi() })
  const plaintext = '{"fixture":true}'

  const ciphertext = await protector.protect(plaintext)

  assert.notEqual(ciphertext, plaintext)
  assert.equal(await protector.unprotect(ciphertext), plaintext)
})

test('DPAPI protector reports tampered ciphertext with a fixed error', async () => {
  const protector = createDpapiProtector({ runPowerShell: createFakeDpapi() })
  const ciphertext = await protector.protect('{"fixture":true}')
  const tampered = `${ciphertext.slice(0, -1)}x`

  await assert.rejects(protector.unprotect(tampered), {
    code: 'DPAPI_UNPROTECT_FAILED',
    message: 'DPAPI_UNPROTECT_FAILED',
  })
})

test('DPAPI protector hides subprocess errors and input from callers', async () => {
  const plaintext = 'synthetic-secret-value'
  const protector = createDpapiProtector({
    runPowerShell: async () => {
      throw new Error(`stderr contained ${plaintext}`)
    },
  })

  await assert.rejects(protector.protect(plaintext), (error) => {
    assert.equal(error.code, 'DPAPI_PROTECT_FAILED')
    assert.equal(error.message, 'DPAPI_PROTECT_FAILED')
    assert.equal(String(error).includes(plaintext), false)
    return true
  })
})

test('Windows CurrentUser DPAPI adapter round-trips with the real PowerShell bridge', {
  skip: process.platform !== 'win32',
}, async () => {
  const protector = createDpapiProtector()
  const plaintext = '{"fixture":true}'

  const ciphertext = await protector.protect(plaintext)

  assert.notEqual(ciphertext, plaintext)
  assert.equal(await protector.unprotect(ciphertext), plaintext)
})
