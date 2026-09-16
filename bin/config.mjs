import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANAGED_PROVIDER_BEGIN = '# BEGIN dsh-workbuddy-auth managed provider'
export const MANAGED_PROVIDER_END = '# END dsh-workbuddy-auth managed provider'
export const LEGACY_PATCH_BEGIN = '# BEGIN dsh-workbuddy-auth managed block'
export const LEGACY_PATCH_END = '# END dsh-workbuddy-auth managed block'
const MANAGED_PROVIDER_COMMENT_BEGIN = 'BEGIN dsh-workbuddy-auth managed provider'
const MANAGED_PROVIDER_COMMENT_END = 'END dsh-workbuddy-auth managed provider'

const MODEL_CATALOG = [
  ['deepseek-v4-pro', 'DeepSeek-V4-Pro', 1000000, 50000, true],
  ['deepseek-v4-flash', 'DeepSeek-V4-Flash', 1000000, 50000, true],
  ['deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', 1000000, 128000, true],
  ['deepseek-v3-2-volc', 'DeepSeek-V3.2', 96000, 32000, false],
  ['glm-5.3', 'GLM-5.3', 1000000, 48000, true],
  ['glm-5.3-flash', 'GLM-5.3-Flash', 1000000, 32000, true],
  ['glm-5.2', 'GLM-5.2', 1000000, 48000, true],
  ['glm-5.1', 'GLM-5.1', 200000, 48000, true],
  ['glm-5.0', 'GLM-5.0', 200000, 48000, false],
  ['glm-5.0-turbo', 'GLM-5.0-Turbo', 200000, 48000, false],
  ['glm-5v-turbo', 'GLM-5V-Turbo', 200000, 64000, true],
  ['glm-4.7', 'GLM-4.7', 200000, 48000, false],
  ['glm-4.6', 'GLM-4.6', 168000, 32000, false],
  ['glm-4.6v', 'GLM-4.6V', 128000, 32000, true],
  ['minimax-m3', 'MiniMax-M3', 512000, 128000, true],
  ['minimax-m2.7', 'MiniMax-M2.7', 200000, 48000, true],
  ['minimax-m2.5', 'MiniMax-M2.5', 200000, 48000, false],
  ['kimi-k3-1', 'Kimi-K3-1', 1000000, 32000, true],
  ['kimi-k2.7', 'Kimi-K2.7', 256000, 32000, true],
  ['kimi-k2.6', 'Kimi-K2.6', 256000, 32000, true],
  ['kimi-k2.5', 'Kimi-K2.5', 164000, 32000, true],
  ['kimi-k2-thinking', 'Kimi-K2-Thinking', 164000, 32000, false],
  ['hy4-preview', 'Hy4-Preview', 1000000, 64000, true],
  ['hy4-preview-x', 'Hy4-Preview-X', 1000000, 64000, true],
  ['hy3', 'Hy3', 192000, 64000, true],
  ['hy3-x', 'Hy3-X', 192000, 64000, true],
  ['hunyuan-chat', 'Hunyuan-Chat', 200000, 8192, false],
  ['default', 'Default', 200000, 24000, false],
]

function providerValue(uid) {
  if (typeof uid !== 'string' || uid.trim() === '') throw new Error('CodeBuddy account.uid must be a non-empty string.')
  return {
    displayName: 'WorkBuddy',
    api: 'openai-completions',
    baseURL: 'https://copilot.tencent.com/v2',
    apiKeyEnv: 'WORKBUDDY_ACCESS_TOKEN',
    // 静态 X-User-Id：仅作为包装层失效时的回退值。运行时 Host 插件会在
    // globalThis.fetch 包装层里按当前激活账号动态覆盖该头（见 lib/user-agent.mjs 的 uidProvider），
    // 因此切换账号后这里写入的旧 uid 不会真正发上游。
    headers: { 'X-User-Id': uid },
    compat: { supportsDeveloperRole: false },
    models: MODEL_CATALOG.map(([id, name, contextWindow, maxTokens, image]) => ({
      id,
      name,
      contextWindow,
      maxTokens,
      ...(image ? { input: ['text', 'image'] } : {}),
    })),
  }
}

function parseSettingsDocument(yaml, text) {
  const hadBom = text.startsWith('\uFEFF')
  const hadCrlf = text.includes('\r\n')
  const source = hadBom ? text.slice(1) : text
  const document = yaml.parseDocument(source, { keepSourceTokens: true, prettyErrors: true })
  if (document.errors.length > 0) throw new Error('DSH YAML validation failed.')
  const root = document.toJS() ?? {}
  if (typeof root !== 'object' || Array.isArray(root)) throw new Error('DSH settings root must be a mapping.')
  return { document, hadBom, hadCrlf, source }
}

function renderSettingsDocument(document, hadBom, hadCrlf) {
  let text = document.toString()
  if (hadCrlf) text = text.replace(/\n/gu, '\r\n')
  return hadBom ? `\uFEFF${text}` : text
}

function commentHasMarkerLine(comment, marker) {
  return comment?.split('\n').some((line) => line.trim() === marker) ?? false
}

function isOwnedNode(node) {
  return commentHasMarkerLine(node?.commentBefore, MANAGED_PROVIDER_COMMENT_BEGIN) && commentHasMarkerLine(node?.comment, MANAGED_PROVIDER_COMMENT_END)
}

function exactMarkerMatches(source, marker) {
  const pattern = new RegExp(`^ {4}# ${marker}$`, 'gmu')
  return [...source.matchAll(pattern)]
}

function managedProviderMarkerComments(source) {
  return [...source.matchAll(/#[^\r\n]*dsh-workbuddy-auth managed provider[^\r\n]*/giu)].map((match) => match[0].trim())
}

function hasAnyManagedProviderMarker(source) {
  return managedProviderMarkerComments(source).length > 0
}

function hasExactlyOneManagedProviderMarkerPair(source) {
  const comments = managedProviderMarkerComments(source)
  return comments.length === 2 && comments[0] === MANAGED_PROVIDER_BEGIN && comments[1] === MANAGED_PROVIDER_END
}

function isLegacyOwnedProvider(parsed) {
  const providers = parsed.document.getIn(['llm-pi-ai', 'providers'], true)
  const workbuddy = parsed.document.getIn(['llm-pi-ai', 'providers', 'workbuddy'], true)
  if (providers === undefined || workbuddy === undefined || isOwnedNode(workbuddy) || !hasExactlyOneManagedProviderMarkerPair(parsed.source)) return false

  const begins = exactMarkerMatches(parsed.source, MANAGED_PROVIDER_COMMENT_BEGIN)
  const ends = exactMarkerMatches(parsed.source, MANAGED_PROVIDER_COMMENT_END)
  if (begins.length !== 1 || ends.length !== 1 || begins[0].index >= ends[0].index) return false

  const pair = providers.items?.find((item) => item?.key?.value === 'workbuddy')
  const keyStart = pair?.key?.range?.[0]
  const valueEnd = pair?.value?.range?.[1]
  if (!Number.isInteger(keyStart) || !Number.isInteger(valueEnd)) return false

  const beginEnd = begins[0].index + begins[0][0].length
  const endStart = ends[0].index
  const beforePair = parsed.source.slice(beginEnd, keyStart)
  const afterPair = parsed.source.slice(valueEnd, endStart)
  if (!/^\r?\n {4}$/u.test(beforePair) || afterPair !== '') return false

  return true
}

function isManagedProvider(parsed) {
  const current = parsed.document.getIn(['llm-pi-ai', 'providers', 'workbuddy'], true)
  const canonical = isOwnedNode(current)
  if (canonical) return hasExactlyOneManagedProviderMarkerPair(parsed.source)
  return isLegacyOwnedProvider(parsed)
}

function withoutMarkerLine(comment, marker) {
  if (comment === undefined) return undefined
  const lines = comment.split('\n').filter((line) => line.trim() !== marker)
  return lines.length > 0 ? lines.join('\n') : undefined
}

function clearLegacyProviderMarkers(parsed) {
  const providers = parsed.document.getIn(['llm-pi-ai', 'providers'], true)
  const pair = providers.items?.find((item) => item?.key?.value === 'workbuddy')
  const index = providers.items?.indexOf(pair) ?? -1
  const nextKey = index >= 0 ? providers.items?.[index + 1]?.key : undefined
  for (const node of [providers, pair?.key, pair?.value, nextKey]) {
    if (!node) continue
    node.commentBefore = withoutMarkerLine(node.commentBefore, MANAGED_PROVIDER_COMMENT_BEGIN)
    node.commentBefore = withoutMarkerLine(node.commentBefore, MANAGED_PROVIDER_COMMENT_END)
    node.comment = withoutMarkerLine(node.comment, MANAGED_PROVIDER_COMMENT_BEGIN)
    node.comment = withoutMarkerLine(node.comment, MANAGED_PROVIDER_COMMENT_END)
  }
}

export function createSettingsEditor(yaml) {
  return {
    setManagedProvider(text, uid) {
      const parsed = parseSettingsDocument(yaml, text)
      const current = parsed.document.getIn(['llm-pi-ai', 'providers', 'workbuddy'], true)
      const owned = isManagedProvider(parsed)
      if (current !== undefined && !owned) throw new Error('settings.yaml contains an unmarked workbuddy provider; refusing to overwrite it.')
      if (current === undefined && hasAnyManagedProviderMarker(parsed.source)) throw new Error('settings.yaml contains malformed workbuddy ownership markers; refusing to overwrite it.')
      if (current !== undefined && !isOwnedNode(current)) clearLegacyProviderMarkers(parsed)
      const node = parsed.document.createNode(providerValue(uid))
      node.commentBefore = ` ${MANAGED_PROVIDER_COMMENT_BEGIN}`
      node.comment = ` ${MANAGED_PROVIDER_COMMENT_END}`
      parsed.document.setIn(['llm-pi-ai', 'providers', 'workbuddy'], node)
      return renderSettingsDocument(parsed.document, parsed.hadBom, parsed.hadCrlf)
    },
    removeManagedProvider(text) {
      const parsed = parseSettingsDocument(yaml, text)
      const current = parsed.document.getIn(['llm-pi-ai', 'providers', 'workbuddy'], true)
      const owned = isManagedProvider(parsed)
      if (current !== undefined && !owned) throw new Error('settings.yaml contains an unmarked workbuddy provider; refusing to overwrite it.')
      if (current === undefined && hasAnyManagedProviderMarker(parsed.source)) throw new Error('settings.yaml contains malformed workbuddy ownership markers; refusing to overwrite it.')
      if (current !== undefined && !isOwnedNode(current)) clearLegacyProviderMarkers(parsed)
      if (current !== undefined) parsed.document.deleteIn(['llm-pi-ai', 'providers', 'workbuddy'])
      return renderSettingsDocument(parsed.document, parsed.hadBom, parsed.hadCrlf)
    },
    hasManagedProvider(text) {
      try {
        return isManagedProvider(parseSettingsDocument(yaml, text))
      } catch {
        return false
      }
    },
    hasProviderConflict(text) {
      try {
        const parsed = parseSettingsDocument(yaml, text)
        const current = parsed.document.getIn(['llm-pi-ai', 'providers', 'workbuddy'], true)
        return current !== undefined ? !isManagedProvider(parsed) : hasAnyManagedProviderMarker(parsed.source)
      } catch {
        return true
      }
    },
  }
}

export function readCodeBuddyIdentity(text) {
  let record
  try {
    record = JSON.parse(text)
  } catch {
    throw new Error('CodeBuddy credential file is not valid JSON. Sign in to CodeBuddy first.')
  }
  const uid = record?.account?.uid
  if (typeof uid !== 'string' || uid.trim() === '') throw new Error('CodeBuddy account.uid must be a non-empty string.')
  if (typeof record?.auth?.accessToken !== 'string' || record.auth.accessToken === '') {
    throw new Error('CodeBuddy login is unavailable. Sign in to CodeBuddy first.')
  }
  return { uid }
}

export async function readSettings(path) {
  return readFile(path, 'utf8')
}

export function createLegacyPatchEditor(yaml) {
  return function removeLegacyPatch(text) {
  const begins = text.split(LEGACY_PATCH_BEGIN).length - 1
  const ends = text.split(LEGACY_PATCH_END).length - 1
  if (begins !== ends || begins > 1) throw new Error('Legacy profile patch ownership markers are malformed or duplicated.')
  if (begins === 1) {
    const start = text.indexOf(LEGACY_PATCH_BEGIN)
    const endMarker = text.indexOf(LEGACY_PATCH_END, start)
    const end = endMarker + LEGACY_PATCH_END.length
    const owned = text.slice(start, end)
    if (!/^# BEGIN dsh-workbuddy-auth managed block\r?\n- insert:\r?\n {4}- id: dsh-workbuddy-auth\r?\n {6}name: dsh-workbuddy-auth\r?\n# END dsh-workbuddy-auth managed block$/u.test(owned)) {
      throw new Error('Legacy profile patch ownership block is not recognized.')
    }
    const consumeEnd = text.slice(end).startsWith('\r\n') ? end + 2 : text.slice(end).startsWith('\n') ? end + 1 : end
    text = text.slice(0, start) + text.slice(consumeEnd)
  }
    const document = yaml.parseDocument(text, { prettyErrors: true })
    if (document.errors.length > 0) throw new Error('Profile patch YAML is invalid.')
    const containsConflict = (value) => {
      if (Array.isArray(value)) return value.some(containsConflict)
      if (!value || typeof value !== 'object') return false
      if (value.id === 'dsh-workbuddy-auth' || value.name === 'dsh-workbuddy-auth') return true
      return Object.values(value).some(containsConflict)
    }
    if (containsConflict(document.toJS())) throw new Error('Profile patch contains an unmarked dsh-workbuddy-auth conflict.')
    return { text, migrated: begins === 1 }
  }
}

export async function backupSettings(settingsPath, dshHome, stamp, profilePatchPath) {
  const backupRoot = join(dshHome, 'dsh-workbuddy-auth-backups')
  const backupDir = join(backupRoot, stamp)
  await mkdir(backupRoot, { recursive: true })
  await mkdir(backupDir)
  await copyFile(settingsPath, join(backupDir, 'settings.yaml'))
  if (profilePatchPath) await copyFile(profilePatchPath, join(backupDir, 'cordis.patch.yml'))
  return backupDir
}

export async function restoreSettings(settingsPath, backupDir) {
  await copyFile(join(backupDir, 'settings.yaml'), settingsPath)
}

export async function restoreProfilePatch(profilePatchPath, backupDir) {
  await copyFile(join(backupDir, 'cordis.patch.yml'), profilePatchPath)
}

export async function withValidatedTemp(settingsPath, content, validate, expectation, randomId) {
  const tempPath = `${settingsPath}.dsh-workbuddy-auth-${randomId}.tmp`
  try {
    await writeFile(tempPath, content, 'utf8')
    await validate(content, expectation, tempPath)
  } finally {
    await rm(tempPath, { force: true })
  }
}

export async function replaceTextAtomically(path, content, randomId) {
  const tempPath = `${path}.dsh-workbuddy-auth-${randomId}.tmp`
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, path)
  } finally {
    await rm(tempPath, { force: true })
  }
}

export async function replaceSettingsAtomically(settingsPath, content, randomId) {
  return replaceTextAtomically(settingsPath, content, randomId)
}

export async function loadDshYaml(dshInstallRoot) {
  const yamlCandidates = [
    join(dshInstallRoot, 'node_modules', 'yaml', 'dist', 'index.js'),
    join(dshInstallRoot, 'node_modules', 'yaml', 'dist', 'index.mjs'),
  ]
  let lastError
  for (const yamlPath of yamlCandidates) {
    try {
      return await import(pathToFileURL(yamlPath).href)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('Installed DSH YAML dependency is unavailable.')
}

export async function createDshValidator(dshInstallRoot, yamlOverride) {
  const piPath = join(dshInstallRoot, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js')
  let yaml
  let pi
  try {
    yaml = yamlOverride ?? await loadDshYaml(dshInstallRoot)
    pi = await import(pathToFileURL(piPath).href)
  } catch {
    throw new Error('Installed DSH validation dependencies are unavailable.')
  }
  return async (text, expectation) => {
    let root
    try {
      root = yaml.parse(text)
    } catch {
      throw new Error('DSH YAML validation failed.')
    }
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('DSH settings root must be a mapping.')
    const section = root['llm-pi-ai']
    if (section === undefined) {
      if (expectation === 'present') throw new Error('WorkBuddy provider is missing.')
      return { modelCount: 0, imageModelCount: 0 }
    }
    const validation = pi.Config['~standard'].validate(section)
    if (validation && typeof validation.then === 'function') throw new Error('Async DSH Config validation is unsupported.')
    if (validation.issues) throw new Error('DSH Config schema rejected settings.')
    const provider = validation.value?.providers?.workbuddy
    if (expectation === 'absent') {
      if (provider !== undefined) throw new Error('WorkBuddy provider remains after removal.')
      return { modelCount: 0, imageModelCount: 0 }
    }
    if (provider === undefined) throw new Error('WorkBuddy provider is missing.')
    const models = provider.models ?? []
    const imageModels = models.filter((model) => Array.isArray(model.input) && model.input[0] === 'text' && model.input[1] === 'image')
    const uid = provider.headers?.['X-User-Id']
    if (models.length !== 28 || imageModels.length !== 19) throw new Error('WorkBuddy model catalog must contain 28 models and 19 image models.')
    if (typeof uid !== 'string' || uid.trim() === '') throw new Error('WorkBuddy X-User-Id must be a non-empty string.')
    if (provider.baseURL !== 'https://copilot.tencent.com/v2' || provider.api !== 'openai-completions' || provider.apiKeyEnv !== 'WORKBUDDY_ACCESS_TOKEN') {
      throw new Error('WorkBuddy provider routing fields are invalid.')
    }
    if (provider.compat?.supportsDeveloperRole !== false) throw new Error('WorkBuddy compatibility settings are invalid.')
    return { modelCount: models.length, imageModelCount: imageModels.length }
  }
}

export function resolveDshInstallRoot(dshCommandPath) {
  const npmPrefix = dirname(dshCommandPath)
  return join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh')
}

export async function loadProfileManifest(profilePath) {
  let text
  try {
    text = await readFile(profilePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text)
}

export function hasPluginDependency(manifest) {
  return Boolean(manifest?.dependencies && Object.hasOwn(manifest.dependencies, 'dsh-workbuddy-auth'))
}

export function isPluginInstalled(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  return hasPluginDependency(manifest) && Array.isArray(bundles) && bundles.includes('dsh-workbuddy-auth')
}

