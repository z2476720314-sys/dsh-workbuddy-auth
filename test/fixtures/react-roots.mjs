// The offline client smoke tests render the settings card with React, which the
// plugin itself does not bundle. A DSH install keeps its dependencies under the
// profile directories, so those are valid dependency roots as well - the plugin
// may run from a plain checkout (CI, publish machine) with no profile of its own.
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHomeRoots(env = process.env) {
  const homes = []
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (explicit !== '') homes.push(explicit)
  const fallback = join(env.USERPROFILE || homedir(), '.dsh')
  if (!homes.includes(fallback)) homes.push(fallback)

  const roots = []
  for (const home of homes) {
    roots.push(join(home, 'profiles', 'node_modules'))
    try {
      for (const entry of readdirSync(join(home, 'profiles'))) roots.push(join(home, 'profiles', entry, 'node_modules'))
    } catch {
      // A missing profiles directory only means there is nothing to add here.
    }
  }
  return roots
}
