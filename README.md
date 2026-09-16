# dsh-workbuddy-auth

Windows 上的 DSH npm bundle：把本机 WorkBuddy（腾讯 CodeBuddy）登录态安全地桥接给 DSH，并在 DSH Web 中提供 WorkBuddy 模型路由与设置卡。

## 一键安装

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
dsh plugin --profile web add dsh-workbuddy-auth@0.1.0
```

默认 package spec 从本包自己的 `package.json` 读取，固定为 `dsh-workbuddy-auth@0.1.0`，避免安装时漂移到未审计版本。DSH 根据本包的 `dsh.bundle.patch` 自动加入 Host 插件行；同一 package row 的 `dsh.client` 元数据会加载 Client 设置卡。

从旧 PowerShell 安装器一键升级时，直接运行同一条 `npx dsh-workbuddy-auth install` 即可同时迁移两处旧 ownership：CLI 会识别 `settings.yaml` 中精确、完整且唯一的四空格 `BEGIN/END dsh-workbuddy-auth managed provider` 旧块，把其 `workbuddy:` pair 更新成新的 canonical own node；并在 `plugin add` 前备份、移除 profile `cordis.patch.yml` 中精确的旧 `BEGIN/END dsh-workbuddy-auth managed block`，让 npm bundle patch 接管。BOM、CRLF、quoted top-level keys 以及其他合法 provider 会保留语义；无标记的 `workbuddy`、未知/畸形/重复/混合 marker 或无标记同 ID patch 行均会拒绝安装，不覆盖未知配置。plugin add 或后续 settings 阶段失败时会恢复旧 patch/settings。

npm 包是公开发布物，所以即使 GitHub 源码仓库保持 Private，用户仍可从 npm registry 正常安装；GitHub 可见性不参与 `npx` 安装流程。

安装成功后，CLI 输出中的 `credentialPersistence: "DSH_HOME/.credentials.yaml"` 明确提示持久化位置（只显示安全相对路径，不显示用户名或 token）。重启正在运行的 `dsh web` 进程；`settings.yaml` 中的模型 provider 通常可热加载，但 Host/Client bundle 生命周期以 profile 重启为准。

## 更新

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

## 卸载

```powershell
npx dsh-workbuddy-auth uninstall
```

卸载器先从 `settings.yaml` 删除本插件拥有的 provider 块，再调用：

```powershell
dsh plugin --profile web remove dsh-workbuddy-auth
```

若 plugin remove 失败，`settings.yaml` 会恢复。provider 存在但 plugin 不存在时只删除 provider；plugin 存在但 provider 不存在时直接调用官方 remove，且不备份、验证或重写 `settings.yaml`；两者都不存在时返回 `already-uninstalled`，不备份、不写文件、不调用 remove，因此重复卸载幂等。卸载不删除或修改 CodeBuddy 凭据，也不处理已迁移后的用户 profile patch，因为 bundle patch 由 DSH 自动管理。

成功卸载输出包含 `credentialCleanupRequired: true`。运行期间调用 `ctx.credentials.set` 会在 `$DSH_HOME/.credentials.yaml` 创建或更新 `WORKBUDDY_ACCESS_TOKEN` 的**持久副本**；卸载默认不自动删除它，因为 CLI 无法安全证明该 key 的 ownership，也无法判断是否应恢复安装前的旧值。若不再需要该凭据，请使用 DSH 的凭据设置界面/凭据管理命令删除 `WORKBUDDY_ACCESS_TOKEN`；如果当前 DSH 版本没有相应入口，可在停止 DSH 后明确编辑 `$DSH_HOME/.credentials.yaml`，只删除 `WORKBUDDY_ACCESS_TOKEN` 对应项并保留其他凭据。CLI 不会读取或输出该值。

## 诊断

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

## 选项

```text
--profile <name>       目标 profile，默认 web
--dry-run              只验证将执行的配置变更，不调用 plugin add/remove，也不写文件
--package-spec <spec>  仅 install 测试覆盖；只接受绝对本地路径或指向绝对本地路径的 file: spec
```

本地 checkout 测试示例（不要用于普通 npm 安装）：

```powershell
node .\bin\cli.mjs install --package-spec C:\absolute\path\to\dsh-workbuddy-auth --dry-run
```

## 配置与事务边界

CLI 从 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\Tencent-Cloud.coding-copilot.info` 读取登录记录：

- `account.uid` 必须是非空字符串，只写入 `headers.X-User-Id`；
- 只检查 `auth.accessToken` 是否存在，绝不打印、复制或写入 `settings.yaml`；
- 运行时 Host 插件把当前 token 写入 DSH 凭据引用 `WORKBUDDY_ACCESS_TOKEN`；`ctx.credentials.set` 会创建或更新 `$DSH_HOME/.credentials.yaml` 中的持久副本，但不会把 token 存进仓库；
- CLI 不读取或打印 `$DSH_HOME/.credentials.yaml` 中的 token 值，卸载也不会因无法安全证明 ownership 而自动删除或恢复该 key。

provider 固定包含 28 个模型，其中 19 个声明 `input: [text, image]`。写入流程为：

1. 从当前 DSH 安装根动态加载其 `yaml`，用 Document AST/CST 语义编辑并用 `@deepseek-ai/dsh-llm-pi-ai.Config` 验证；支持 BOM、CRLF、quoted keys 和 flow mapping，同时保留其他 top-level/provider 与可保留的 comments；
2. 若检测到旧 ownership patch，先把 `settings.yaml` 与 `cordis.patch.yml` 备份到 `$DSH_HOME\dsh-workbuddy-auth-backups\<timestamp>\`，再事务迁移；否则在 plugin add 成功后备份 settings；
3. 写同目录临时文件并 rename；
4. 重新读取并验证结果；
5. 若 settings 阶段失败，恢复备份；仅当 add 前 manifest 的 `dependencies` 中完全没有本包名时才自动执行 plugin remove，已有 dependency（即使未在 bundles 中）一律保留供人工复核。

CLI 对底层 fs/Node/YAML 错误只输出封闭错误码对应的固定文案；不会回显底层 message、绝对路径、Windows 用户名、UID 或 token。

卸载读取 profile manifest 后分支处理：只在 provider 存在时备份并删 own block，只在 plugin/dependency 存在时调用 remove；plugin-only 分支不触碰 settings，两者都不存在则直接 no-op。已修改 settings 的失败路径会恢复 settings。

## 功能摘要

- 28 个对话模型，19 个图片输入模型；
- Host 凭据桥、临近过期自动续期与 CodeBuddy 凭据原子写回；
- 只对 WorkBuddy 上游 hostname 生效的 User-Agent workaround；
- Web 设置卡：脱敏账号状态、余额、连接测试、刷新和重新读取；
- **多账号切换**：安装后设置卡会出现「切换账号」区，可随时在多个已登录的 WorkBuddy/CodeBuddy 账号间切换，推理与积分随之切换；`X-User-Id` 会跟随当前账号动态发送，无需手工改配置；
- 浏览器响应不包含 token、refresh token、上游响应体或本地路径。

本项目不提供聊天页脚的单次积分估算；余额仅采用 WorkBuddy 服务端返回的权威值。

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
