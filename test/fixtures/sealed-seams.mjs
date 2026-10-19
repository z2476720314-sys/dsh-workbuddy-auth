// apply 级测试的托管库隔离夹具。
//
// 为什么必须有：`apply()` 在 Windows 上会按生产路径新建托管账号库
// （`<DSH_HOME>/storages/workbuddy-accounts.dpapi`）。测试若不注入，就会**读本机真实账号池**：
// 账号数断言随开发者本机状态漂移，最糟的情况是把真实 token 解密进测试进程。
// 与既有约定一致（测试一律显式钉死 credentialFile），这里把托管库钉进临时目录。
//
// 第二订阅点（智谱清言）另有**三个**同样的真实路径（账号库 / 模型偏好 / 目录缓存），
// 且它不依赖任何注入的服务就会装配，因此同样必须在这里全部钉死：
// 不隔离就会读到本机真实的 agentmore 账号库，保存偏好的用例还会覆盖真实的模型选择。
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createAgentmoreStore } from '../../lib/agentmore-store.mjs'

let sequence = 0

/** 确定性假 protector：密文不含明文子串；真实 DPAPI 往返由 dpapi.test.mjs 覆盖。 */
export function fakeProtector() {
  return {
    async protect(plaintext) { return `ENC1:${Buffer.from(plaintext, 'utf8').toString('base64')}` },
    async unprotect(ciphertext) {
      if (!ciphertext.startsWith('ENC1:')) throw new Error('not ciphertext')
      return Buffer.from(ciphertext.slice(5), 'base64').toString('utf8')
    },
  }
}

/**
 * 把托管账号库与签到状态文件都钉到**保证不存在**的临时路径上（空库/空状态语义），
 * 除非调用方自己指定了对应 seam。
 *
 * 签到状态同样必须隔离：自动签到默认开启，`apply()` 会立即跑一轮并把状态写回
 * `<DSH_HOME>/storages/workbuddy-auth-checkin.json`；不隔离就会污染开发者本机的真实状态
 * （测试的「今日已签到」断言也会随之漂移）。
 *
 * @param {{managedStore?:object,managedAccountsFile?:string,protector?:object,checkinStore?:object,checkinStateFile?:string,agentmoreStore?:object,agentmoreAccountsFile?:string,agentmoreProtector?:object,agentmoreModelSettingsFile?:string,agentmoreCatalogFile?:string}} [seams]
 * @returns {object}
 */
export function sealedSeams(seams = {}) {
  const dir = join(tmpdir(), `wb-auth-sealed-${process.pid}-${sequence++}`)
  const isolated = { ...seams }
  if (seams.managedStore === undefined && seams.managedAccountsFile === undefined) {
    isolated.managedAccountsFile = join(dir, 'storages', 'workbuddy-accounts.dpapi')
    isolated.protector = seams.protector ?? fakeProtector()
  }
  if (seams.checkinStore === undefined && seams.checkinStateFile === undefined) {
    // 默认隔离成**已关闭**，而不是空状态：签到默认开启且会真的发上游请求，
    // 无关用例既不该被它的请求计数污染，也不该在没注入假 fetch 的情况下打到真实网络。
    // 要测签到本身的用例显式传 checkinStateFile（见 apply.test.mjs / apply-multi-account.test.mjs）。
    const filePath = join(dir, 'storages', 'workbuddy-auth-checkin.json')
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify({ version: 1, enabled: false, lastRunAt: 0, accounts: {} }))
    isolated.checkinStateFile = filePath
  }
  // 第二订阅点：**显式注入**隔离的空账号库，而不是让它自己按 `process.platform === 'win32'`
  // 造一个真实路径上的库。这样既永不触碰真实路径，也让非 Windows 上照样装配这一区，
  // 用例不随平台分支（否则 effect 计数断言会在非 win32 上变成另一套数字）。
  if (seams.agentmoreStore === undefined && seams.agentmoreAccountsFile === undefined) {
    isolated.agentmoreProtector = seams.agentmoreProtector ?? fakeProtector()
    isolated.agentmoreAccountsFile = join(dir, 'storages', 'agentmore-accounts.dpapi')
    isolated.agentmoreStore = createAgentmoreStore({
      filePath: isolated.agentmoreAccountsFile,
      protector: isolated.agentmoreProtector,
    })
  }
  isolated.agentmoreModelSettingsFile ??= join(dir, 'storages', 'agentmore-models.json')
  isolated.agentmoreCatalogFile ??= join(dir, 'storages', 'agentmore-catalog.json')
  return isolated
}
