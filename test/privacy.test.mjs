import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const forbiddenAccountTimestamps = [
  ['1794', '2340', '99872'].join(''),
  ['1796', '8260', '99872'].join(''),
  ['1789', '0501', '00513'].join(''),
]

function releaseFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...releaseFiles(absolute))
    else if (entry.isFile()) files.push(absolute)
  }
  return files
}

test('发布文件不包含真实账户时间戳 fixture', () => {
  let findings = 0
  for (const file of releaseFiles(packageRoot)) {
    const text = readFileSync(file, 'utf8')
    for (const timestamp of forbiddenAccountTimestamps) {
      findings += text.split(timestamp).length - 1
    }
  }
  assert.equal(findings, 0, '发布文件中的真实账户时间戳命中数必须为 0')
})
