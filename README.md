# dsh-workbuddy-auth

Windows 上的 DSH npm bundle：把本机 WorkBuddy（腾讯 CodeBuddy）登录态桥接给 DSH，并提供原生 `workbuddy` 模型供应商、模型管理面板与现有账号设置卡。

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

本项目不提供聊天页脚的单次积分估算；余额仅采用 WorkBuddy 服务端返回的权威值。

## 数据保留

运行时会在 `$DSH_HOME/storages/` 下创建以下四类文件，卸载时**不自动删除**：

| 文件 | 内容 | 加密 |
| --- | --- | --- |
| `workbuddy-accounts.dpapi` | 浏览器登录添加的托管账号池 | Windows 当前用户 DPAPI（整库加密） |
| `workbuddy-auth-checkin.json` | 签到开关、每账号的本地日期/次数/结果时间戳 | 明文，**不含任何令牌或路径** |
| `workbuddy-auth-rejected.json` | 被上游 401/403 拒绝过的账号 id 摘要 | 明文，只存 id 摘要 |
| `workbuddy-auth-models.json` | 供应商开关、已选 ID、默认思考深度与上下文覆盖 | 明文，不含凭据 |

确认不再需要并停止相关宿主后，可删除对应文件；删除 `workbuddy-auth-models.json` 后模型偏好在下次加载恢复默认零勾选。`workbuddy-accounts.dpapi` 删除后登录添加的账号会消失（桌面 CodeBuddy 凭据不受影响），签到状态删除后会在下一轮重新统计当日状态。DPAPI 不可用（例如非 Windows）时不会回退明文存储——托管账号库与浏览器登录整块缺席，桌面凭据文件照常工作。

签到状态文件刻意用 `workbuddy-auth-checkin.json` 这个独立名字：`@eddyskywalker/dsh-chatgpt-subscription` 用的是 `workbuddy-checkin.json`，两者格式不同，同名会互相覆盖。

## 开发与测试

测试完全离线，CLI 用临时 `DSH_HOME` 与 fake dsh runner，不修改真实 DSH、不访问网络：

```powershell
npm test
npm pack --dry-run
```

真实上游冒烟脚本不属于默认测试，可能读取真实本机凭据并访问网络；普通开发、CI 和发布检查不要运行它。

## 安全

运行时需要读取并可能续期 CodeBuddy 明文凭据。不要提交、上传或粘贴凭据、token、UID、手机号、邮箱、真实余额、DSH 配置或备份。详细信任边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
