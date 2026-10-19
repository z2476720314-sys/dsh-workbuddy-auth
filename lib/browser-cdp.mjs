/**
 * 最小 CDP 客户端：只为"登录后读 cookie"服务。
 *
 * 为什么不用 Playwright：插件发布物是纯 ESM + 零依赖（`package.json` 里没有
 * dependencies），引入 Playwright 会让安装体积与供应链面都炸掉。而我们需要的能力
 * 极小 —— 起一个带独立 user-data-dir 的 Chromium，开一个页面，等用户登录，然后
 * `Storage.getCookies` 一次性取回。裸 CDP over WebSocket 足够，且 Node 22+
 * 自带 `WebSocket` 全局对象（DSH 侧 Node 26）。
 *
 * 关键安全约束：
 *   * 只连 127.0.0.1
 *   * remote-debugging 端口由我们自己起，端口号随机（port 0 让内核分配）
 *   * 只读 cookie，不注入脚本、不读页面内容
 *   * 用完一定杀掉进程并删临时 profile（用户登出后不该留下第三个 chrome profile）
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'

/** 常见 Chromium 系浏览器安装位置（Windows 优先，其它平台给出通行名）。 */
const CANDIDATE_EXECUTABLES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/**
 * 找一个可用的 Chromium 系可执行文件。
 * @returns {string|null}
 */
export function findBrowserExecutable(env = process.env) {
  const explicit = env?.DSH_AGENTMORE_BROWSER
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
  for (const candidate of CANDIDATE_EXECUTABLES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 探测一个 TCP 端口是否已被占用（用来给 Chromium 挑一个空闲调试端口）。 */
function portAvailable(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(true))
    socket.setTimeout(500, () => { socket.destroy(); resolve(true) })
  })
}

async function pickPort() {
  // 9222 是常见默认值，容易被用户自己开着的浏览器占用；从 9333 起找一个空的。
  for (let port = 9333; port < 9400; port += 1) {
    if (await portAvailable(port)) return port
  }
  throw Object.assign(new Error('AGENTMORE_BROWSER_NO_PORT'), { code: 'AGENTMORE_BROWSER_NO_PORT' })
}

/** 轮询 `/json/version` 直到 Chromium 的调试端口就绪。 */
async function waitForDebugger(port, { timeoutMs = 15_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // 还没起来。
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw Object.assign(new Error('AGENTMORE_BROWSER_TIMEOUT'), { code: 'AGENTMORE_BROWSER_TIMEOUT' })
}

/**
 * 把 CDP 的协议错误对象变成带 code 的 Error。
 *
 * 为什么要包一层：协议错误的原文是 `{ code: -32601, message: "'X' wasn't found" }`。
 * 直接 reject 这个普通对象，调用方 `.catch` 里既拿不到 `instanceof Error`，
 * 也区分不出「方法不存在」（-32601，编码/协议 bug，重试一万次也不会好）和
 * 「临时抖动」（socket 断了、浏览器正在导航）。而登录轮询恰好会把所有异常当抖动
 * 吞掉 —— 于是编码错误的表现就是「界面永远停在等待登录」。
 *
 * 这里把 -32601/-32602 标成 `CDP_METHOD_UNAVAILABLE` / `CDP_INVALID_PARAMS`，
 * 让调用方能对永久性错误做出不同于抖动的处理。
 */
function toProtocolError(raw) {
  const code = typeof raw?.code === 'number' ? raw.code : null
  const message = typeof raw?.message === 'string' ? raw.message : String(raw)
  const permanent = code === -32601 || code === -32602
  const error = new Error(`AGENTMORE_CDP_PROTOCOL(${code ?? '?'}): ${message}`)
  error.code = permanent
    ? (code === -32601 ? 'CDP_METHOD_UNAVAILABLE' : 'CDP_INVALID_PARAMS')
    : 'CDP_PROTOCOL_ERROR'
  error.cdpCode = code
  // 永久性错误不该被轮询当成抖动重试；调用方据此决定是继续等还是立刻报错。
  error.permanent = permanent
  return error
}

export { toProtocolError }

/**
 * 极简 CDP 会话：一条 WebSocket + 自增 id + 一次性 promise 表。
 * 只实现我们需要的 `send`；事件通过 `on(method, handler)` 订阅。
 */
function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl)
    let nextId = 1
    const pending = new Map()
    const listeners = new Map()
    let closed = false

    const settle = (id, ok, value) => {
      const entry = pending.get(id)
      if (entry === undefined) return
      pending.delete(id)
      if (ok) entry.resolve(value)
      else entry.reject(toProtocolError(value))
    }

    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (typeof message.id === 'number') {
        settle(message.id, message.error === undefined, message.error ?? message.result)
        return
      }
      if (typeof message.method === 'string') {
        for (const handler of listeners.get(message.method) ?? []) {
          try { handler(message.params) } catch { /* 监听器异常不影响协议循环 */ }
        }
      }
    })
    socket.addEventListener('error', () => {
      closed = true
      for (const [, entry] of pending) entry.reject(Object.assign(new Error('AGENTMORE_CDP_SOCKET'), { code: 'AGENTMORE_CDP_SOCKET' }))
      pending.clear()
      reject(Object.assign(new Error('AGENTMORE_CDP_SOCKET'), { code: 'AGENTMORE_CDP_SOCKET' }))
    })
    socket.addEventListener('close', () => {
      closed = true
      for (const [, entry] of pending) entry.reject(Object.assign(new Error('AGENTMORE_CDP_CLOSED'), { code: 'AGENTMORE_CDP_CLOSED' }))
      pending.clear()
    })
    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}, sessionId) {
          if (closed) return Promise.reject(Object.assign(new Error('AGENTMORE_CDP_CLOSED'), { code: 'AGENTMORE_CDP_CLOSED' }))
          const id = nextId
          nextId += 1
          const payload = { id, method, params }
          if (sessionId !== undefined) payload.sessionId = sessionId
          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend })
            socket.send(JSON.stringify(payload))
          })
        },
        on(method, handler) {
          if (!listeners.has(method)) listeners.set(method, new Set())
          listeners.get(method).add(handler)
          return () => listeners.get(method)?.delete(handler)
        },
        close() {
          closed = true
          try { socket.close() } catch { /* 已关 */ }
        },
      })
    })
  })
}

/**
 * 起一个受控 Chromium。
 *
 * @param {object} [options]
 * @param {string} [options.executable] 浏览器可执行文件
 * @param {string} [options.userDataDir] profile 目录（不传则建临时目录并在 close 时删）
 * @param {number} [options.width] 窗口宽度
 * @param {number} [options.height] 窗口高度
 * @returns {Promise<{browser:object}>}
 */
export async function launchBrowser({ executable, userDataDir, width = 1100, height = 820, headless = false, env = process.env } = {}) {
  const binary = executable ?? findBrowserExecutable(env)
  if (binary === null) throw Object.assign(new Error('AGENTMORE_BROWSER_MISSING'), { code: 'AGENTMORE_BROWSER_MISSING' })

  const ownedDir = userDataDir === undefined
  const profileDir = userDataDir ?? await mkdtemp(join(tmpdir(), 'dsh-agentmore-'))
  const port = await pickPort()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `--disable-features=Translate,MediaRouter,OptimizationHints`,
    `--window-size=${width},${height}`,
    // 登录流程只需要一个空白页；不自动打开任何站点（避免把用户的默认页塞进来）。
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')

  const child = spawn(binary, args, { stdio: 'ignore', windowsHide: false, detached: false })

  let exited = false
  child.once('exit', () => { exited = true })

  const version = await waitForDebugger(port, { timeoutMs: 15_000 }).catch(async (error) => {
    if (!exited) child.kill()
    if (ownedDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
    throw error
  })

  const cdp = await connectCdp(version.webSocketDebuggerUrl)

  return {
    port,
    profileDir,
    close: async () => {
      cdp.close()
      if (!exited) {
        child.kill()
        // 给进程 2s 优雅退出，超时强杀 —— 否则 profile 目录会被占住无法删除。
        await new Promise((resolve) => {
          const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退 */ } resolve() }, 2000)
          child.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
      if (ownedDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
    },
    /**
     * 开一个页面并导航到指定 URL，返回该页面的 CDP targetId。
     * 用 `Target.createTarget` 而不是 `Page.navigate`：我们要独立控制"哪个页面在登录"。
     */
    async openPage(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      return targetId
    },
    async attach(targetId) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      return {
        send: (method, params = {}) => cdp.send(method, params, sessionId),
        on: (method, handler) => cdp.on(method, handler),
        detach: () => cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}),
      }
    },
    /**
     * 一次性取回全部 cookie。
     *
     * 必须用 `Storage.getCookies`，不能用 `Network.getAllCookies`：
     * `Network` 是 **page 域**（只能在 attach 出来的 session 上发），而这条 `cdp`
     * 是**浏览器级** socket，发过去只会拿到 `-32601 'Network.getAllCookies' wasn't
     * found`。`Storage` 才是浏览器级可用的域，且 `Storage.getCookies` 返回的就是
     * 整个 profile 的 cookie —— 正是这里要的：登录发生在网页 origin，我们要按名字
     * 把 chatglm_token 挑出来，不想关心它挂在哪个 target 上。
     *
     * （实测：浏览器级 `Network.getAllCookies` → -32601；会话内两者都可用；
     *   浏览器级 `Storage.getCookies` 可用且能读回 setCookies 写入的值。）
     */
    async allCookies() {
      const { cookies } = await cdp.send('Storage.getCookies')
      return Array.isArray(cookies) ? cookies : []
    },
    /** 在页面里执行一段表达式并取回 JSON 值（只用于读 localStorage 的设备指纹）。 */
    async evaluate(targetId, expression) {
      const page = await this.attach(targetId)
      try {
        await page.send('Runtime.enable').catch(() => {})
        const result = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
        if (result?.exceptionDetails) return null
        return result?.result?.value ?? null
      } finally {
        await page.detach()
      }
    },
    navigate(targetId, url) {
      return this.attach(targetId).then(async (page) => {
        try {
          await page.send('Page.enable').catch(() => {})
          return await page.send('Page.navigate', { url })
        } finally {
          await page.detach()
        }
      })
    },
  }
}

/**
 * 判断一枚 cookie 是否挂在**裸域**（apex host-only，如 `chatglm.cn`）。
 *
 * 为什么关心：网页正式登录写在 apex 域上（host-only，无前导点），而子域
 * （`agentmore.chatglm.cn`）会自己再发一套同名的**游客**令牌。两者同名不同域，
 * 只能靠域与上游身份校验区分。
 */
function isApexHostOnly(domain) {
  if (typeof domain !== 'string' || domain === '' || domain.startsWith('.')) return false
  return domain.split('.').length === 2
}

/**
 * 按名字取出**全部**候选 cookie（同名可能挂在多个域上），apex 域优先。
 *
 * 为什么不能只取第一个匹配（历史实现就是这么写的，于是踩了坑）：`Storage.getCookies`
 * 的返回顺序不是契约。实测打开 `agentmore.chatglm.cn` 后，返回里先出现的是该子域的
 * **游客** `chatglm_token`，而用户真正登录后写在 `chatglm.cn` 上的那枚排在后面 ——
 * 「取第一个」等于赌顺序，赌错的表现就是「明明登录了却一直是游客身份」。
 *
 * 同值只保留一次（多域同值很常见，重复验证纯属浪费上游配额）。
 *
 * @param {Array<{name?:string,value?:string,domain?:string}>} cookies
 * @param {string} name
 * @returns {Array<{value:string,domain:string}>}
 */
export function cookieCandidates(cookies, name) {
  const seen = new Set()
  const apex = []
  const rest = []
  for (const cookie of cookies ?? []) {
    if (cookie?.name !== name) continue
    const raw = typeof cookie.value === 'string' ? cookie.value : ''
    if (raw === '') continue
    const value = raw.includes('%') ? safeDecode(raw) : raw
    if (seen.has(value)) continue
    seen.add(value)
    const entry = { value, domain: typeof cookie.domain === 'string' ? cookie.domain : '' }
    if (isApexHostOnly(entry.domain)) apex.push(entry)
    else rest.push(entry)
  }
  return [...apex, ...rest]
}

/**
 * 从 cookie 列表里按名字取**首选**值（`AuthActivity.b(String)` 的等价物）。
 *
 * APK 里逐个 origin 调 `CookieManager.getCookie` 再 split `;`；
 * CDP 已给出结构化 cookie，直接按 name 匹配即可。值里含 `%` 才解码（与 APK 一致，
 * 因为未编码的 cookie 值里出现 `%` 是合法字符而非转义）。
 *
 * 需要「全部候选、逐个验证身份」的场景（登录）请用 `cookieCandidates`：
 * 这个函数只回答「首选值是什么」，回答不了「另一枚是不是真账号」。
 */
export function cookieValue(cookies, name) {
  return cookieCandidates(cookies, name)[0]?.value ?? null
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
