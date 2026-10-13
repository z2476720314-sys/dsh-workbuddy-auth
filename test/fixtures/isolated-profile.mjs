// 测试隔离：把 DSH_PROFILE_DIR 钉到不存在的进程级临时路径。
// resolvePatchFile() 缺省从该变量推断 patch 路径；不隔离时，测试触发的 persist
// （credentials/active 激活）会把夹具里的临时凭据路径写回真实 profile 的
// cordis.patch.yml，历史上留下过 %TEMP%\wb-apply-* 死值。
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.DSH_PROFILE_DIR = join(tmpdir(), `wb-isolated-profile-${process.pid}`)
