import { spawn } from 'node:child_process'

const scripts = {
  protect: [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Security',
    '$plaintext = [Console]::In.ReadToEnd()',
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes($plaintext)',
    '$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($protected))',
  ].join('; '),
  unprotect: [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.Security',
    '$ciphertext = [Console]::In.ReadToEnd()',
    '$protected = [Convert]::FromBase64String($ciphertext)',
    '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))',
  ].join('; '),
}

const encodedScripts = Object.fromEntries(
  Object.entries(scripts).map(([operation, script]) => [operation, Buffer.from(script, 'utf16le').toString('base64')]),
)

function runPowerShell(operation, input) {
  const encodedCommand = encodedScripts[operation]
  if (encodedCommand === undefined) return Promise.reject(new Error('DPAPI_POWER_SHELL_FAILED'))

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.once('error', () => reject(new Error('DPAPI_POWER_SHELL_FAILED')))
    child.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error('DPAPI_POWER_SHELL_FAILED'))
    })
    child.stdin.end(input, 'utf8')
  })
}

function dpapiError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function createDpapiProtector({ runPowerShell: run = runPowerShell } = {}) {
  async function transform(operation, input) {
    try {
      return await run(operation, input)
    } catch {
      throw dpapiError(`DPAPI_${operation.toUpperCase()}_FAILED`)
    }
  }

  return {
    protect: (plaintext) => transform('protect', plaintext),
    unprotect: (ciphertext) => transform('unprotect', ciphertext),
  }
}
