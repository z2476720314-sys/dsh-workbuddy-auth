# Changelog

本文件记录 dsh-workbuddy-auth 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-12

### 新增

- **浏览器登录直接添加账号**：设置卡新增登录区，选 CN / Intl 后点「开始登录」，在浏览器里完成
  CodeBuddy 授权即可把该账号加入本插件的账号池。授权链接只放行受信任的 WorkBuddy 地区域
  （HTTPS + 域后缀白名单），登录流程单例、约 1.5 秒轮询、最长 300 秒；**登录只添加账号，
  绝不改变当前激活账号**。令牌只在 Host 侧落地，前端与 API 响应一律不含令牌、原始上游响应或本机路径。
- **独立加密账号池（Windows DPAPI）**：登录得到的账号存进 `${DSH_HOME}/storages/workbuddy-accounts.dpapi`，
  整库经当前用户 DPAPI 加密、原子替换写入，**DPAPI 不可用时不回退明文**（非 Windows 上登录区整块缺席，
  桌面凭据文件照常可用）。账号按地区 + 稳定 UID/UIN 去重，与桌面 `*.info` 账号合并展示。
- **地区感知的续期与推理路由**：CN 账号继续走 `copilot.tencent.com`；Intl 账号（`workbuddy.ai` /
  `codebuddy.ai`）按账号所属地区解析 origin，刷新带 `X-Auth-Refresh-Source: workbuddy`、`Origin`/`Referer`
  与 CLI 身份头，推理请求改写 origin 且 path/query 逐字保留。地区无法确定时 **fail-closed**：
  宁可拒绝也不把 CN 当作 Intl 的回退。Intl 账号的积分余额显示 `unavailable`（余额端点只在 CN 网关，
  拿 Intl 令牌去打 CN 端点既拿不到数据、又等于把令牌送到错误地区）。
- **自动签到**：默认开启，插件启动即跑一轮，之后每 10 分钟检查一次。先查
  `checkin-activity-status` 再打 `daily-checkin`（幂等，已签到不重复请求）；账号当日未开放则 1 小时后
  复查；自动失败每日最多 3 次；401 时先续期一次再重试一次；单请求 20 秒超时。设置卡提供开关与
  「立即签到」（手动排队执行，不受开关与次数上限约束，但已签到的账号仍会跳过）。
  签到只处理 CN 账号（跳过 Intl 与桌面端加密信封凭据），状态文件 `${DSH_HOME}/storages/workbuddy-auth-checkin.json`
  只记录开关、本地日期、次数与时间戳，不含任何令牌或路径。

### 变更

- **账号目录与激活上下文统一**：桌面明文凭据与托管（DPAPI）账号由同一份目录管理，激活状态、
  写回、刷新与签到都按**账号 id 定点**读写——切换账号后到达的在飞刷新结果只会写回它自己那份凭据，
  不会污染新激活的账号，也不会把 `WORKBUDDY_ACCESS_TOKEN` 指向旧账号。
- **新增同源路由**：`POST /accounts/login`、`GET /accounts/login/status`、`POST /checkin/settings`、
  `POST /checkin/now`；`/status` 增加 `checkin` 摘要与 `state.credentialEncrypted` / `state.credentialHint`。
- 设置卡新增「自动签到」区（开关 + 手动运行 + 当日成功/跳过/失败/可用账号计数）。

### 修复

- 并入 0.2.3 的全部修复（错误 hint、加密凭据可见、失效账号标注、patch 缩进与缺省路径、同步失败指引）。

## [0.2.3] - 2026-10-10

### 修复

- **设置卡只报 `HTTP 500：HTTP 401`，用户无从下手**：上游拒绝凭据（401/403）时，界面此前只显示
  一个状态码。现在错误封套额外带 `hint` 字段（路由层与客户端共用 `lib/errors.mjs` 的同一份措辞）：
  401/403 → 「登录态已失效，请切换账号或重新登录」；5xx/429 等非凭据故障**不给**登录指引，
  以免把人指向错误的病因。既有契约不变：仍 `500` + `{ok:false,error}`，`error` 仍只含
  错误码/状态码/白名单文案，不含令牌。
- **加密凭据文件被整份跳过，用户看不到自己正在用的账号**：2026-10-10 起 WorkBuddy 桌面端把
  `auth.accessToken`/`refreshToken` 与昵称/手机号写成 `{$wbEncrypted:1, envelope:"…"}` 信封
  （AES-GCM，DSH 侧无解封器）。此前这类文件在切换区与状态卡里完全不可见；现在它作为
  **账号条目保留**并标 `encrypted: true`（昵称/手机号留空，uid 仍从明文 `account.uid` 取），
  读取时给出固定文案「已被 WorkBuddy 桌面端加密」。加密与「未登录」是两种病因，指引不再混用。
- **失效账号没有标注**：被上游 401/403 拒绝过的账号现在记录在本插件自己的
  `${DSH_HOME}/storages/workbuddy-auth-rejected.json`（只存 id 摘要），切换区标「（已失效）」
  并给出「先在 CodeBuddy 里重新登录」的说明；成功一次即自动清除标记。
- **`/status` 的 `accounts.sources` 白名单吃掉了 `encrypted`/`stale`**：后端算出标注、前端
  永远显示不出来。两个布尔字段现在穿过白名单（`state` 同时新增 `credentialEncrypted`/`credentialHint`）。
- **账号切换后 `credentialFile` 写回 patch 的缩进错误，写坏 `cordis.patch.yml`**：对
  `- insert:` 包裹形态，写入用 `entry.indent + '  '` 当键缩进，而 `config:` 的子键实际在更深一级，
  于是 `credentialFile` 被提到 `config` 同级、`config` 变 `null`，YAML 解析直接失败。
  现在缩进从现场推断（已有子键的实测缩进优先），已有 `credentialFile:` 时保留该行自身缩进原地替换。
- **`config.patchFile` 未配置时切换路径的写回静默失效**：`persistCredentialFileToPatch` 收到
  `undefined` 恒返回 `false`。现在 `resolvePatchFile(config)` 缺省回落到
  `${DSH_PROFILE_DIR}/cordis.patch.yml`（显式空串＝关闭）。
- **同步失败日志对 401 与加密凭据没有任何指引**：`credentialGuidanceParts` 此前只覆盖
  ENOENT 与 EPERM/EACCES 两类，其余返回空数组。

### 变更

- 仓库自带的 `cordis.patch.yml` 保持 `- insert:` 形态（首次安装用），但**用户 patch 侧应写成
  覆盖行**（`- id: dsh-workbuddy-auth` + `config:`）。两份 `insert` 同 id 会撞成
  `duplicate loader entry id "dsh-workbuddy-auth"`，市场试装校验失败并回滚。

## [0.2.2] - 2026-09-16

### 修复

- **去重保留策略改为 mtime 最新优先**：备份文件里的 expiresAt 可能是伪造的远期值
  （真实回归：一份 7 月备份写着 2027 年到期，token 实际早已被服务端作废——旧策略按
  「expiresAt 最大者保留」恰好选中它，切换后推理持续 401）。mtime 相差 2 秒内视为同分，
  回退到 expiresAt 比较。mtime 在 DTO 中不输出。
- **已过期账号从可切换列表剔除**：唯一一份凭据且已过期的账号不再出现（点了必 401）。
  expiresAt=0（上游未提供）保守保留。
## [0.2.1] - 2026-09-16

### 修复

- **「当前」徽章标错账号**：切换账号后，状态卡的 activeId 仍停留在初始账号（激活路径存在
  外层 current 与 selector 内部 activeFile 两个状态源，切换只更新了前者）。现在 selector
  内部状态是唯一真值，徽章始终跟随真实激活的凭据文件。
- **同一账号出现重复按钮**：桌面端的时间戳备份（如 workbuddy-desktop.<时间戳>.info）与正式
  凭据文件是同一账号且可能已过期，此前会并列出现两个一模一样的切换按钮，点进过期备份必然 401。
  现在列表按账号（uid + 手机号 + 昵称）去重，保留未过期、accessExpiresAt 最新的一份。
## [0.2.0] - 2026-09-16

### 新增

- **多账号切换**：设置卡新增「切换账号」区，列出本机 CodeBuddy 凭据目录下全部 `*.info` 登录态
  （含桌面端 `workbuddy-desktop.info`），点选即切，**无需重启** `dsh web`。推理请求与积分余额随切换后的账号走。
  - 新增路由 `GET /api/dsh-workbuddy-auth/credentials/sources` 与 `POST /api/dsh-workbuddy-auth/credentials/active`。
  - 账号 id 为凭据文件绝对路径的 SHA-256 前 16 位；路由只接受扫描列表中已存在的 id，不接受任意路径。
  - 切换后所选文件路径原子写回用户 patch 的插件行，重启后保持。
  - `/status` DTO 恒定包含 `accounts` 字段（未启用时为 `enabled: false`）。
- **X-User-Id 动态同步**：Host 侧的 `globalThis.fetch` 包装层按当前激活凭据的 `account.uid` 改写
  `x-user-id` 请求头，账号切换后路由 `headers` 里的静态旧 uid 不再发上游（仍保留为包装层失效时的回退值）。
  uid 取不到时保留原头照发，不因读文件抖动中断推理。
- `authDir` 支持默认值：未配置时默认取凭据文件所在目录，安装后即有多账号切换区；显式 `authDir: ''` 为关闭开关。

### 变更

- **上游 host 匹配改为精确 hostname 相等**（原实现用 URL 子串匹配，`copilot.tencent.com.evil.example`
  之类域名会误命中并被改写请求头）。
- 同步失败日志改用结构化错误描述（错误码 / HTTP 状态码），不再回显可能夹带上游响应体或凭据的原始 `error.message`。
- 凭据缺失/不可读的告警只输出固定的安全显示路径，不再输出解析后的本机绝对路径。
- 设置卡的「刷新凭证」与「重新读取」共用同一重入守卫：同步在飞时返回固定的 `SYNC_IN_FLIGHT`，
  不再叠加第二次不可逆的 refresh token 轮换。

### 修复

- `/status` 路由此前未把账号列表接入 DTO，导致客户端切换区不渲染。

## [0.1.0] - 2026-09-11

### 新增

- 首个发布版本：把本机 WorkBuddy（CodeBuddy）登录态桥接为 DSH 凭据引用 `WORKBUDDY_ACCESS_TOKEN`。
- 28 个对话模型路由（其中 19 个声明图片输入）、临期自动续期与凭据原子写回、上游 User-Agent 修复层。
- Web 设置卡：脱敏账号状态、权威积分余额、测试连接 / 刷新凭证 / 重新读取。
- `npx dsh-workbuddy-auth install | uninstall | doctor` CLI，含配置备份、ownership 标记、写后校验与失败回滚。
