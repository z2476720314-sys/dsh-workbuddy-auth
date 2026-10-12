// Settings-editor tests need the yaml parser that ships with the installed DSH.
// A DSH install is not always an npm-style root: the desktop app bundles its
// dependencies while the profile directory keeps its own copy, so search the
// profile roots too instead of assuming `%APPDATA%\npm`.
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defaultDshCommandPath } from '../../bin/cli.mjs'
import { loadDshYaml, profileDependencyRoots, resolveDshInstallRoot } from '../../bin/config.mjs'

function profileRoots(dshHome) {
  const roots = []
  try {
    for (const entry of readdirSync(join(dshHome, 'profiles'))) roots.push(join(dshHome, 'profiles', entry))
  } catch {
    // A missing profiles directory only means there is nothing to add here.
  }
  return roots
}

export function testDependencyRoots(env = process.env) {
  const dshHome = env.DSH_HOME || join(env.USERPROFILE || homedir(), '.dsh')
  return [...profileDependencyRoots(dshHome, env.DSH_TEST_PROFILE || 'desktop'), ...profileRoots(dshHome)]
}

export async function loadTestYaml(env = process.env) {
  const extraRoots = testDependencyRoots(env)
  const roots = ['']
  try {
    roots.push(resolveDshInstallRoot(await defaultDshCommandPath({ env })))
  } catch {
    // No dsh on PATH: the profile roots below are the only candidates.
  }
  let lastError
  for (const root of roots) {
    try {
      return await loadDshYaml(root, extraRoots)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('DSH YAML dependency is unavailable for tests.')
}
