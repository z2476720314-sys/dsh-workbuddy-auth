// 离线客户端测试的 React 解析：插件自身**不打包** React（它由 DSH 浏览器模块加载器注入），
// 所以测试必须在本机找到一份可 require 的 react + react-dom。
//
// 为什么集中在这里：这段候选根枚举原先在 5 个测试文件里各抄了一遍，于是
// 「本机唯一的 React 在哪个目录」这种环境事实要改 5 处，且一处的修复不会惠及其它。
// 现在只有这一个实现，各测试只消费 `loadReact()`。
//
// 为什么需要这么多根：插件常年从 plain checkout 跑（CI / 发版机没有自己的 node_modules）；
// DSH 安装把依赖放在 profile 目录；而 `~/.dsh/profiles/node_modules` 里的条目是**指向 npm
// 全局 dsh 的 junction**——那份全局安装被移除或换位后它们全部悬空（本机就处于这种状态），
// 因此还要覆盖仓库内已构建的产物目录 `.release/<pkg>/node_modules`。
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 插件包根目录（`.../plugins/dsh-workbuddy-auth`），由本文件位置反推。 */
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 按优先级列出可能的依赖根。找到第一个能 require 出 react 的即用。
 * @param {string} [pkgRoot] 插件包根；缺省由本文件位置反推。
 */
export function candidateRoots(pkgRoot = pluginRoot) {
  const roots = []
  if (process.env.DSH_SMOKE_REACT_ROOT) roots.push(process.env.DSH_SMOKE_REACT_ROOT)
  roots.push(join(pkgRoot, 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'profiles', 'web', 'node_modules'))
  roots.push(resolve(pkgRoot, '..', '..', 'node_modules'))
  // 已发布产物的依赖根：打包后的真实依赖树。profile 里的 junction 悬空时，它是本机唯一可用的
  // React。只是候选之一，找不到就继续往下试，不影响任何打包或运行行为。
  roots.push(resolve(pkgRoot, '..', '..', '.release', 'dsh-workbuddy-auth', 'node_modules'))
  roots.push(...dshHomeRoots())

  const npxRoot = join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) roots.push(join(npxRoot, entry, 'node_modules'))
  }
  return roots
}

/**
 * 取一份可用的 react + react-dom/server。
 * @param {string} [pkgRoot] 插件包根；缺省由本文件位置反推。
 * @returns {{React: object, renderToStaticMarkup: Function}}
 */
export function loadReact(pkgRoot = pluginRoot) {
  const tried = []
  for (const root of candidateRoots(pkgRoot)) {
    try {
      const require = createRequire(join(root, 'resolve-baseline.cjs'))
      return { React: require('react'), renderToStaticMarkup: require('react-dom/server').renderToStaticMarkup }
    } catch {
      tried.push(root) // 换下一个本机依赖根
    }
  }
  throw new Error(
    `找不到可用的 react/react-dom；可用 DSH_SMOKE_REACT_ROOT 指定依赖目录。已尝试 ${tried.length} 个根：${tried.join(', ')}`,
  )
}
