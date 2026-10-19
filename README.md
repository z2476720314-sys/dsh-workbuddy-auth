# dsh-workbuddy-auth

Windows 上的 DSH npm bundle：提供两个订阅点——把本机 WorkBuddy（腾讯 CodeBuddy）登录态桥接给 DSH 的 `workbuddy` 供应商，以及使用智谱清言（chatglm.cn）账号的 `agentmore` 供应商，各带模型管理面板与账号设置卡。两者共用**一个设置入口**（「订阅服务」总览卡），点进去分别管理。

## 0.5.4 错误原因与未知余额

WorkBuddy 模型限额（上游 `6004`）现在显示实际原因和上游提供的重置时间；不会再只显示 `PROVIDER_ERROR / UNKNOWN`，也不会自动重复请求已用尽的额度。清言已登录但尚未取得余额时保持“未知”，真实余额 0 仍显示 0。

## 0.5.3 积分不再显示 0、上下文窗口改回 1M

**积分显示 0。** 上游 `member_info.left_score` 是字符串（实测 `"8784.58"`），`parseCreditBalance` 解析没问题，但下游三处各自把它抹掉：服务层读了不存在的 `result.value`（`parseCreditBalance` 返回的是 `remaining`），客户端把 `null` 交给 `finiteNumber()` 而 `Number(null) === 0`，登录成功时又没顺手落一次余额、冷启动只能读缓存。现在余额按上游原值透出，取不到就是「未取到」，不再是 0。

**上下文窗口是 1M，不是 128K。** 旧值把官方文档里的「最大输出 Tokens 128K」当成了上下文窗口，于是 1M 上下文的 GLM-5.3 被标成 128K，用户手填覆盖值也会被 `size > maxContextWindow` 挡回来。现在按官方文档：GLM-5.3 与 GLM-5.3-Flash 都是 **1M 上下文 / 128K 最大输出**。目录缓存版本升到 2，旧缓存整份失效，升级后立刻显示正确数值。

**思考深度恢复三档。** 上游 `reasoning_efforts` 是对象数组，档位 id 在 `am_effort`（`low` 快速 / `high` 深度 / `max` 极致）。旧实现读错字段、还把所有档位压成单个 `default`。实测 `/stream` 认的就是 `low`/`high`/`max`（发 `thinking`、`deep_thinking` 直接返回 error 帧），现在三档原样透出、默认 `max`。

**目录活取恒为空。** `am_switch` 不是「已下架」，而是「该模型在 Agent 模式下可用」的能力位——实测两项真实模型都是 `true`。旧代码把它当剔除条件，于是每次活取都返回空数组，只能退回内置列表，账号真实可用的模型永远看不到。现在只有显式 `false` 才剔除；实测 `catalogSource` 从 `fallback` 变为 `live`，缓存按 version 2 正常落盘。

## 0.5.2 游客态不再中断登录、官方图标、详情页去重标题

三条都是实测反馈的问题。

**还没登录就被踢回插件。** `agentmore.chatglm.cn` 打开后 3 秒内就会在**自己的子域**上写入一对游客 `chatglm_token` / `chatglm_refresh_token`（用户正式登录后，令牌写在 apex `chatglm.cn` 上）。旧实现一轮询到「两枚 cookie 齐了」就去验证身份，拿到 `is_guest=true` 立刻把流程判成失败并关窗——用户刚看到登录框、还没来得及输验证码，窗口就没了。现在游客只是 `guestPending` 标记：流程保持 `running`、窗口不关、继续轮询，卡片同时提示「当前仍是游客身份，请在已打开的窗口里完成登录」。

**同名 cookie 跨域混配。** `Storage.getCookies` 的返回顺序不是契约（实测子域游客令牌排在 apex 真令牌之前），旧实现只取第一个匹配，还从两个域各取一枚当一对，既可能选中游客令牌，也可能拼出「apex access + 子域 refresh」这种必然 401 的组合。新增 `cookieCandidates()`：apex 域优先、逐枚候选按**域**配对，被拒就换下一枚。

**详情页重复标题 + 文字方块图标。** 详情页页眉原本先画订阅点名的 `<h4>`，详情卡自己又画一个同名 `<h3>`；现在统一由页眉给图标、名称与一行说明，卡片在 hub 里跳过自己的页眉（独立挂载时仍保留，`aria-labelledby` 跟着分支走）。图标改为各家**官方**标识（WorkBuddy 的 `assets/logo.svg`、智谱清言的 `favicon.ico`），内联成 data URI：前端跑在 `dsh-app://` 与 loopback 下，外链图标要多一份域名许可，弱网或 CSP 收紧时还会变成破图。

## 0.5.1 单一入口与登录修复

设置页里本插件只占**一张**座位，标签「订阅服务」。进来先是总览卡（每张卡一个订阅点），点某一项进入该订阅点的详情页，详情页顶部有「返回订阅总览」。这与 `dsh-chatgpt-subscription` 的 hub 做法一致：多注册一张座位会在设置页导航里显示成两行、看起来像两个插件，而且多占一个全局排序槽位会把别家插件往后挤。

同时修复了登录流程的一个致命 bug：抓 cookie 用的是 `Network.getAllCookies`，但 `Network` 是 **page 域**方法，挂在浏览器级 CDP socket 上只会返回 `-32601 'Network.getAllCookies' wasn't found`。改用浏览器级可用的 `Storage.getCookies`。此前该错误又被登录轮询当成瞬时抖动吞掉，所以用户看到的表现是「浏览器里登录成功了，卡片却永远停在等待登录」。现在协议级永久错误会立刻收尾并显示原因，不再静默重试。

## 0.5.0 第二订阅点（智谱清言 Agent）

插件容纳**两个订阅点**：`workbuddy`（WorkBuddy / CodeBuddy）与 `agentmore`（智谱清言 Agent / chatglm.cn）。两者在同一个设置入口内各自拥有账号库、凭据续期、积分读取和模型偏好；一边登录或切换账号不会影响另一边，也不会把推理流量从一边搬到另一边。两边的模型都注册为各自的 DSH 原生供应商，由原生模型选择器决定单次对话用谁。

安装与更新方式不变（0.4.5 段落的 `dsh plugin add` 流程照旧），把包版本换成 0.5.3 即可。

### 登录方式

`agentmore` 不走 OAuth 回环，也不读取用户浏览器的 Cookie 数据库。流程是：

1. 在设置卡点“登录”，宿主进程启动一个 Chromium（Chrome / Edge）窗口打开 `https://agentmore.chatglm.cn`。
2. 用户在该窗口内正常登录 chatglm.cn（含扫码）。
3. 插件轮询 profile 内的 `chatglm_token` 与 `chatglm_refresh_token`，并按**域**配对成候选凭据（`chatglm.cn` 上的优先于子域上的）；设备标识优先取 cookie `chatglm-deid`，否则读页面 `localStorage['chatglm-deid']`，两者都没有时生成一个随机 32 位十六进制串。
4. 插件对每一枚候选请求 `/chatglm/user-api/user/info` 验证身份：命中真账号才写入本机加密账号库并关闭窗口。

**游客态是中间态，不是失败。** 实测该页面在用户点“登录”之前就会在自己的子域上写入一对游客令牌。早期实现把“发现游客”直接判成登录失败并关窗，用户刚看到登录框就被踢出来（`该账号是游客身份，请先在 chatglm.cn 完成正式登录`）。现在游客只标记为 `guestPending`，窗口保持打开、流程继续轮询，直到上游认出真账号；设置卡此时会提示“当前仍是游客身份，请在已打开的窗口里完成登录”。

轮询间隔 1.5 秒，30 秒后退避到 3 秒，整体上限 10 分钟。窗口开着时点“取消”会立刻停止轮询并关闭浏览器；**取消不受登录流程的忙碌态限制**，中途放弃随时可点。

### 上游协议

按 APK 反编译逐字实现，非公开接口，上游变更可能导致不可用：

- `X-Sign = md5(timestamp + '-' + nonce + '-' + salt)`，salt 为 APK 内常量。
- `X-Timestamp` 并非原始时间戳，倒数第二位被替换成“各位数字之和减该位再取模 10”的校验位。
- 签名用的时间戳需与服务器一致，故调用前请求一次 `/chatglm/operation-api/config/cur_ts` 并按半 RTT 补偿；校时失败只是不补偿、照常发请求，不会拒绝服务。
- 正文走 `POST /chatglm/agent-api/stream` 的 SSE，每帧 `content[].text` 是**到目前为止的全文**，由插件做差分转成增量。
- 凭据距过期不足 5 分钟、或无 `exp` 且距上次刷新超过 30 分钟时自动续期，续期失败仅告警、沿用旧令牌继续尝试。

### 配置与落盘

模型偏好与账号库位于 `DSH_HOME/storages/`，按订阅点分文件，互不读写对方：`agentmore-accounts.dpapi`（加密账号，与 WorkBuddy 的 `workbuddy-accounts.dpapi` 并列）、`agentmore-models.json`（模型偏好，含 `enabled` / `enabledModelIds` / `defaultReasoningEffort` / `contextWindowOverrides`）与 `agentmore-models.cache`（仅模型元数据、时间与账号作用域摘要，不含令牌）。

偏好语义与 WorkBuddy 侧一致：总开关开启不等于启用全部模型，**默认零勾选**；只有手动勾选并保存的模型才进入原生选择器；清空上下文输入框表示删除该模型覆盖值，不是填零；窗口参数必须是正安全整数，负值不会进入上游。

### 与本机环境的边界

- 上游是未公开接口，**没有真实账号令牌时无法端到端验收**；本仓库的测试全部基于夹具，覆盖协议签名、SSE 差分、工具桥、账号库、目录缓存、适配器行为、登录轮询与 HTTP 路由，但不代表某次真实调用已成功。
- 需要可用的 Chrome 或 Edge。找不到浏览器时报告“未找到可用的 Chromium 浏览器”，不会静默失败。
- 积分余额来自上游返回；上游未给出该字段时显示“未取到”，不显示成 0。

## 0.4.5 安装与更新

0.4.5 修复弱网时模型目录消失及误报禁用的问题：同账号续期保留成功目录，重启后的目录请求失败也可使用同账号磁盘缓存；没有可用目录时明确报告目录失败或超时。保留既有工具续轮、原生供应商注册修复；现有账号、模型勾选和参数设置保持不变。

前置条件：Windows、可用的 DSH 和 Node.js，以及已经登录的 WorkBuddy/CodeBuddy 桌面账号或本插件托管账号。使用已审核的本地 tgz，通过 DSH 自身包管理安装到目标 profile；Desktop 用 `desktop`，Web 用实际运行的 profile 名。

```powershell
dsh plugin --profile desktop add E:\packages\dsh-workbuddy-auth-0.4.5.tgz
```

示例路径应对应实际打包产物。本地打包、安装不会发布 npm 版本；未发布到 registry 的版本使用本地 tgz。DSH 按 `dsh.bundle.patch` 挂载 Host，按同一包的 `dsh.client` 元数据加载设置卡，无需单独复制文件。

更新已有包按同一方式安装新版 tgz。**安装成功只证明磁盘包更新；运行中的 Host/Client 是否加载新版另行确认。** 宿主对已有包更新的生命周期是 `restart-required`：在合适时机由用户重启目标宿主，再检查模型面板与原生供应商。不要把目录刷新或配置 HMR 当作新版 JavaScript 已加载的证据。

回退同样通过正常包管理安装已保留的旧版本 tgz，然后按宿主生命周期重启；不要手工替换 `node_modules` 中的单个文件。卸载 bundle 可使用 `dsh plugin --profile desktop remove dsh-workbuddy-auth`；偏好、账号和持久凭据保留规则见下文。

## 0.4.4 模型设置布局

模型采用紧凑勾选列表，展示名称、上下文和输入/推理能力；顶部显示已选数量，可全选或全不选。列表下的“增强功能”只保留一个默认思考设置，并仅为已勾选模型显示上下文编辑；未选择时显示引导，可一次恢复全部上下文默认值。原有用量与配额显示位于增强功能之后，不增加请求或调用。

## 0.4.1 修复范围

附件服务为可选依赖。图片读取器在实际图片请求时取得当前附件服务，不再在插件启动时直接读取；服务缺席时，认证、模型目录与文本模型仍可初始化。附件服务已存在、迟到或撤销时跟随当前实例，保留图片方法的接收者和中止信号。

该修复已通过真实公开 Cordis 模块的受控四态夹具验证，不代表某次 Desktop 异常的现场根因已经证实。图片仍取决于模型声明和可用附件服务；磁盘安装、运行组件加载与真实上游调用分别验收。

## 模型管理（0.4.0）

在插件设置卡打开模型管理区。首次模型偏好为：

```json
{
  "enabled": true,
  "enabledModelIds": [],
  "defaultReasoningEffort": null,
  "contextWindowOverrides": {}
}
```

总开关开启不等于启用全部模型：**默认已选数量为 0**。目录展示候选项，只有当前账号/地区可用且已手动勾选并保存的模型才出现在 DSH 原生模型选择器。

1. 确认当前活动账号已有可读凭据，查看面板的地区、目录来源和供应商状态；需要时刷新模型目录。目录获取不是推理请求，官方空目录保持为空；获取失败时明确显示同账号缓存或本地候选来源。
2. 勾选需要的模型，或主动全选当前可用项；清空选择可恢复零勾选。关闭供应商总开关会隐藏全部 WorkBuddy 模型，保存的选择仍保留。
3. 在“增强功能”统一设置默认思考深度。选择“使用模型默认值”保存 `null`；可选档位来自模型目录，不发送 `off`。某模型不支持所选档位时仍采用其官方默认；单次调用的有效显式档位优先。
4. 在独立上下文区编辑已勾选模型的覆盖值：正整数且不超过已知官方最大值。未勾选时不显示输入，取消勾选不丢弃草稿；**清空输入表示删除该模型覆盖**，不是填零。点击“全部恢复默认”清空所有已保存覆盖，点击保存后生效，不改变模型选择或思考设置。
5. 保存偏好后在原生模型选择器手动选择 `workbuddy` 模型并发起聊天。页面加载、保存与目录刷新不发推理请求，也不自动切换当前聊天模型；保存/刷新失败时保留待编辑内容。

原生模型调用复用当前活动托管账号、凭据续期与原账号写回，不建立第二个账号池。账号切换或退出会使旧目录失效；当前地区不可用的已保存 ID 保留在偏好中，但不进入原生列表。模型声明的文本、图片输入、工具调用、思考和输出上限仍以实际目录及原生调用能力为准；连接测试不等于原生聊天验收。

模型偏好位于 `DSH_HOME/storages/workbuddy-auth-models.json`，仅记录上述四个字段，不含 token、Cookie 或账号凭据；不读写参考插件的 `workbuddy-models.json`，也不靠修改全局供应商 YAML 登记模型。已有其它适配器占用 `workbuddy` 时，面板显示 `conflict`；插件不会接管或删除其配置。正常 tgz 安装不负责自动迁移旧 CLI 的全局供应商配置。

成功目录另存到偏好文件旁的 `workbuddy-auth-models.json.catalog-cache`，只含模型元数据、时间和账号/地区/后端的作用域摘要。目录请求失败或超时可回退到同账号缓存；没有缓存时需联网成功获取一次目录。缓存不保证推理服务可达，目录接口恢复后可点击刷新获取最新能力，成功的空目录会覆盖旧目录。

## 旧版 CLI 管理入口

以下入口为兼容既有全局 YAML 安装/迁移流程而保留。**旧 CLI `install` 仍写入固定完整模型目录，不是 0.4.0 的手动勾选入口**；它与新的原生 `workbuddy` 注册可能产生冲突。使用新面板时采用上面的正常 tgz 安装，不运行旧 CLI 安装器来自动启用目录。旧流程的凭据持久化、ownership 迁移和卸载行为如下。

### 旧版一键安装

前置条件：

- Windows；
- 已安装 DSH，且 `dsh` 命令在 `PATH`；
- 已运行 CodeBuddy 并完成登录；
- Node.js / npm 可用。

```powershell
npx dsh-workbuddy-auth install
```

默认安装到 `web` profile。CLI 会先调用官方命令：

```powershell
dsh plugin --profile web add dsh-workbuddy-auth@<当前版本>
```

默认 package spec 从本包自己的 `package.json` 读取（0.4.5 中形如 `dsh-workbuddy-auth@0.4.5`，须先有对应发布物），避免安装时漂移到未审计版本。DSH 根据本包的 `dsh.bundle.patch` 自动加入 Host 插件行；同一 package row 的 `dsh.client` 元数据会加载 Client 设置卡。

从旧 PowerShell 安装器一键升级时，直接运行同一条 `npx dsh-workbuddy-auth install` 即可同时迁移两处旧 ownership：CLI 会识别 `settings.yaml` 中精确、完整且唯一的四空格 `BEGIN/END dsh-workbuddy-auth managed provider` 旧块，把其 `workbuddy:` pair 更新成新的 canonical own node；并在 `plugin add` 前备份、移除 profile `cordis.patch.yml` 中精确的旧 `BEGIN/END dsh-workbuddy-auth managed block`，让 npm bundle patch 接管。BOM、CRLF、quoted top-level keys 以及其他合法 provider 会保留语义；无标记的 `workbuddy`、未知/畸形/重复/混合 marker 或无标记同 ID patch 行均会拒绝安装，不覆盖未知配置。plugin add 或后续 settings 阶段失败时会恢复旧 patch/settings。

npm 包是公开发布物，所以即使 GitHub 源码仓库保持 Private，用户仍可从 npm registry 正常安装；GitHub 可见性不参与 `npx` 安装流程。

安装成功后，CLI 输出中的 `credentialPersistence: "DSH_HOME/.credentials.yaml"` 明确提示持久化位置（只显示安全相对路径，不显示用户名或 token）。重启正在运行的 `dsh web` 进程；`settings.yaml` 中的模型 provider 通常可热加载，但 Host/Client bundle 生命周期以 profile 重启为准。

### 旧版 CLI 更新

重新运行同一命令即可让 DSH/pnpm 更新依赖，并幂等刷新本插件拥有的 provider 块：

```powershell
npx dsh-workbuddy-auth install
```

安装器只替换带以下 ownership markers 的块：

```yaml
# BEGIN dsh-workbuddy-auth managed provider
# ...
# END dsh-workbuddy-auth managed provider
```

如果已有未标记的 `workbuddy` provider，安装会拒绝覆盖。

### 旧版 CLI 卸载

```powershell
npx dsh-workbuddy-auth uninstall
```

卸载器先从 `settings.yaml` 删除本插件拥有的 provider 块，再调用：

```powershell
dsh plugin --profile web remove dsh-workbuddy-auth
```

若 plugin remove 失败，`settings.yaml` 会恢复。provider 存在但 plugin 不存在时只删除 provider；plugin 存在但 provider 不存在时直接调用官方 remove，且不备份、验证或重写 `settings.yaml`；两者都不存在时返回 `already-uninstalled`，不备份、不写文件、不调用 remove，因此重复卸载幂等。卸载不删除或修改 CodeBuddy 凭据，也不处理已迁移后的用户 profile patch，因为 bundle patch 由 DSH 自动管理。

成功卸载输出包含 `credentialCleanupRequired: true`。运行期间调用 `ctx.credentials.set` 会在 `$DSH_HOME/.credentials.yaml` 创建或更新 `WORKBUDDY_ACCESS_TOKEN` 的**持久副本**；卸载默认不自动删除它，因为 CLI 无法安全证明该 key 的 ownership，也无法判断是否应恢复安装前的旧值。若不再需要该凭据，请使用 DSH 的凭据设置界面/凭据管理命令删除 `WORKBUDDY_ACCESS_TOKEN`；如果当前 DSH 版本没有相应入口，可在停止 DSH 后明确编辑 `$DSH_HOME/.credentials.yaml`，只删除 `WORKBUDDY_ACCESS_TOKEN` 对应项并保留其他凭据。CLI 不会读取或输出该值。

### 旧版 CLI 诊断

```powershell
npx dsh-workbuddy-auth doctor
```

`doctor` 只读检查：

- DSH 命令是否可用；
- CodeBuddy 登录记录是否可解析；
- 本插件拥有的 WorkBuddy provider 是否存在；
- profile 是否同时安装并启用该 npm bundle；
- `credentialCleanupRequired: true`，提醒卸载后仍需由用户按上面的安全步骤处理 DSH 持久凭据副本。

输出只包含布尔状态、profile 名和固定清理提醒；不会读取或输出 UID、token、凭据路径、DSH 路径或 Windows 用户名。

### 旧版 CLI 选项

```text
--profile <name>       目标 profile，默认 web
--dry-run              只验证将执行的配置变更，不调用 plugin add/remove，也不写文件
--package-spec <spec>  仅 install 测试覆盖；只接受绝对本地路径或指向绝对本地路径的 file: spec
```

本地 checkout 测试示例（不要用于普通 npm 安装）：

```powershell
node .\bin\cli.mjs install --package-spec C:\absolute\path\to\dsh-workbuddy-auth --dry-run
```

### 旧版 CLI 配置与事务边界

CLI 从 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info` 读取登录记录：

- `account.uid` 必须是非空字符串，只写入 `headers.X-User-Id`；
- 只检查 `auth.accessToken` 是否存在，绝不打印、复制或写入 `settings.yaml`；
- 运行时 Host 插件把当前 token 写入 DSH 凭据引用 `WORKBUDDY_ACCESS_TOKEN`；`ctx.credentials.set` 会创建或更新 `$DSH_HOME/.credentials.yaml` 中的持久副本，但不会把 token 存进仓库；
- CLI 不读取或打印 `$DSH_HOME/.credentials.yaml` 中的 token 值，卸载也不会因无法安全证明 ownership 而自动删除或恢复该 key。

旧 CLI 的 YAML provider 固定包含 28 个模型，其中 19 个声明 `input: [text, image]`；新面板以当前账号的实际目录与已保存选择为准。旧 CLI 写入流程为：

1. 从当前 DSH 安装根动态加载其 `yaml`，用 Document AST/CST 语义编辑并用 `@deepseek-ai/dsh-llm-pi-ai.Config` 验证；支持 BOM、CRLF、quoted keys 和 flow mapping，同时保留其他 top-level/provider 与可保留的 comments；
2. 若检测到旧 ownership patch，先把 `settings.yaml` 与 `cordis.patch.yml` 备份到 `$DSH_HOME\dsh-workbuddy-auth-backups\<timestamp>\`，再事务迁移；否则在 plugin add 成功后备份 settings；
3. 写同目录临时文件并 rename；
4. 重新读取并验证结果；
5. 若 settings 阶段失败，恢复备份；仅当 add 前 manifest 的 `dependencies` 中完全没有本包名时才自动执行 plugin remove，已有 dependency（即使未在 bundles 中）一律保留供人工复核。

CLI 对底层 fs/Node/YAML 错误只输出封闭错误码对应的固定文案；不会回显底层 message、绝对路径、Windows 用户名、UID 或 token。

卸载读取 profile manifest 后分支处理：只在 provider 存在时备份并删 own block，只在 plugin/dependency 存在时调用 remove；plugin-only 分支不触碰 settings，两者都不存在则直接 no-op。已修改 settings 的失败路径会恢复 settings。

## 功能摘要

- 原生模型管理：默认零勾选、按账号/地区目录手动保存、供应商总开关、自动思考与上下文覆盖；
- Host 凭据桥、临近过期自动续期与 CodeBuddy 凭据原子写回；
- 只对 WorkBuddy 上游 hostname 生效的 User-Agent workaround；
- Web 设置卡：脱敏账号状态、余额、连接测试、刷新和重新读取；
- **多账号切换**：安装后设置卡会出现「切换账号」区，可随时在多个已登录的 WorkBuddy/CodeBuddy 账号间切换，推理与积分随之切换；`X-User-Id` 会跟随当前账号动态发送，无需手工改配置；
- **浏览器登录添加账号**：设置卡「添加账号」区选 CN / Intl 后点「开始登录」，在浏览器完成 CodeBuddy 授权即把账号加入本插件的账号池；登录只添加、不切换当前账号；
- **地区感知**：CN 账号走 `copilot.tencent.com`；Intl 账号（`workbuddy.ai` / `codebuddy.ai`）按账号所属地区解析上游 origin，刷新头随地区切换，推理请求改写 origin 但保留 path/query。地区无法确定时拒绝请求，绝不把 CN 当作 Intl 的回退；Intl 账号的余额显示 `unavailable`；
- **自动签到**：默认开启，启动即跑一轮、之后每 10 分钟检查一次，只处理 CN 账号；设置卡提供开关与「立即签到」；
- 浏览器响应不包含 token、refresh token、上游响应体或本地路径。

`agentmore`（智谱清言 Agent）是并列的第二订阅点，能力对等但不共享状态：

- 独立账号库与模型偏好，与 WorkBuddy 的账号/偏好互不读写；切换一边不影响另一边；
- 宿主自起 Chrome / Edge 完成登录，插件读该窗口的 cookie 与 `localStorage` 判定成功，不读取用户浏览器已有的 Cookie 数据库；
- 按 APK 反编译逐字实现的请求签名、校时补偿与 SSE 增量解析；凭据临近过期自动续期；
- 模型管理语义与 WorkBuddy 一致（默认零勾选、正安全整数窗口覆盖、`null` 表示删除覆盖）；
- 积分余额取自上游；上游未给该字段时显示「未取到」，不显示成 0。

本项目不提供聊天页脚的单次积分估算；余额仅采用上游服务端返回的权威值。

## 数据保留

运行时会在 `$DSH_HOME/storages/` 下创建以下文件，卸载时**不自动删除**：

| 文件 | 内容 | 加密 |
| --- | --- | --- |
| `workbuddy-accounts.dpapi` | 浏览器登录添加的托管账号池 | Windows 当前用户 DPAPI（整库加密） |
| `workbuddy-auth-checkin.json` | 签到开关、每账号的本地日期/次数/结果时间戳 | 明文，**不含任何令牌或路径** |
| `workbuddy-auth-rejected.json` | 被上游 401/403 拒绝过的账号 id 摘要 | 明文，只存 id 摘要 |
| `workbuddy-auth-models.json` | 供应商开关、已选 ID、默认思考深度与上下文覆盖 | 明文，不含凭据 |
| `agentmore-accounts.dpapi` | 智谱清言账号池（含 access / refresh token、deviceId） | Windows 当前用户 DPAPI（整库加密） |
| `agentmore-models.json` | 第二订阅点的开关、已选 ID、默认思考深度与上下文覆盖 | 明文，不含凭据 |
| `agentmore-models.cache` | 模型目录元数据、时间与账号作用域摘要 | 明文，**不含令牌** |

`workbuddy` 与 `agentmore` 的文件名刻意分开，两边的账号库与偏好互不读写；删除其中一边的文件只影响该订阅点。

确认不再需要并停止相关宿主后，可删除对应文件；删除 `workbuddy-auth-models.json` 或 `agentmore-models.json` 后模型偏好在下次加载恢复默认零勾选。`workbuddy-accounts.dpapi` / `agentmore-accounts.dpapi` 删除后对应订阅点已登录的账号会消失（桌面 CodeBuddy 凭据不受影响），签到状态删除后会在下一轮重新统计当日状态。DPAPI 不可用（例如非 Windows）时不会回退明文存储——托管账号库与浏览器登录整块缺席，桌面凭据文件照常工作。

签到状态文件刻意用 `workbuddy-auth-checkin.json` 这个独立名字：`@eddyskywalker/dsh-chatgpt-subscription` 用的是 `workbuddy-checkin.json`，两者格式不同，同名会互相覆盖。

## 开发与测试

测试完全离线，CLI 用临时 `DSH_HOME` 与 fake dsh runner，不修改真实 DSH、不访问网络：

```powershell
npm test
npm pack --dry-run
```

真实上游冒烟脚本不属于默认测试，可能读取真实本机凭据并访问网络；普通开发、CI 和发布检查不要运行它。

`npm test` 当前为 911 项（903 通过、8 跳过），其中 `agentmore` 分区 329 项。测试需要能解析到 `react` / `react-dom` 才能渲染设置卡，查找顺序见 `test/fixtures/react-roots.mjs`；本机 profile 的 junction 悬空时可用 `DSH_SMOKE_REACT_ROOT` 指定依赖目录。注意 `npm test` 的 `--import ./test/fixtures/isolated-profile.mjs` 不可省——它隔离 `DSH_PROFILE_DIR`，单跑某个 client 测试时若漏掉会因找不到 react 而误报失败。

## 安全

运行时需要读取并可能续期 CodeBuddy 明文凭据。不要提交、上传或粘贴凭据、token、UID、手机号、邮箱、真实余额、DSH 配置或备份。详细信任边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
