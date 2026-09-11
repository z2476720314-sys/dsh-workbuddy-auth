# Security Policy

## 凭据与数据边界

`dsh-workbuddy-auth` 在 Windows 当前用户权限下读取 WorkBuddy（腾讯 CodeBuddy）的本机登录态，并在需要续期时写回同一个凭据文件。该文件是**明文 JSON**，包含可用于访问账号的 access token 和 refresh token；它必须按密码对待。

请始终遵守：

- 不要把 CodeBuddy 凭据文件、其内容、token、UID、手机号、邮箱、真实余额、DSH 配置、日志或备份提交到仓库。
- 不要在 GitHub issue、discussion、pull request、commit message、CI 日志或截图中粘贴凭据、token 或未经脱敏的账号信息。
- 不要把 npm automation/access token 或 GitHub PAT 写进脚本、配置、命令历史或问题报告；发布 npm 包时使用 npm 官方认证与最小权限 token。
- 测试和复现只使用合成数据。可以提供脱敏 DTO 或虚构路径，但不能提供真实值。

## 私下报告安全问题

**不要为安全问题创建包含敏感细节的公开 issue。**

优先使用本仓库 **Security** 页中的 **Report a vulnerability** 创建私密 GitHub Security Advisory 草稿。若该入口不可用，请通过你与仓库所有者已经建立的私密渠道联系所有者，只发送最少必要信息；不要先在 issue 中留言“占位”并附带凭据。

一份安全报告可以包含：

- 受影响的 commit 或版本；
- 不含凭据的最小复现步骤；
- 预期行为、实际行为和影响；
- 只含虚构值的请求/响应结构；
- 已脱敏且不含本机用户路径的日志片段。

请不要发送真实凭据文件。若维护者确实需要额外证据，应先约定安全传输方式，并继续使用可撤销的合成凭据；默认仍不发送真实 token。

## 凭据暴露后的处置

一旦怀疑 CodeBuddy 凭据或 token 已暴露：

1. 立即停止继续分享相关文件、日志或截图，并限制泄露副本的访问。
2. 退出 CodeBuddy 登录态，并按 CodeBuddy 当前提供的方式撤销相关登录或会话。
3. **重新登录 CodeBuddy，让凭据完成轮换。** 仅删除 GitHub 文本、关闭 issue 或覆盖本地文件不能使已泄露的 token 失效。
4. 重启相关 DSH Web 进程，确认其重新读取轮换后的登录态。
5. 若敏感值曾进入 Git 历史、CI artifact、终端记录或聊天系统，分别按对应平台流程清理；在完成轮换前都应视为仍然泄露。

若 GitHub PAT 同时暴露，应在 GitHub 单独撤销/轮换该 PAT；CodeBuddy 重新登录不会轮换 GitHub 凭据。

## 已知安全限制

- 设置卡使用的四条精确 Host 路由只接受 loopback `Host`，且带 `Origin` 时要求其 host 与 `Host` 完全一致；但这些路由**没有 browser-session cookie**，同机进程仍可直接构造 loopback 请求。
- 浏览器响应经过字段白名单，不应包含 access token、refresh token、上游响应体或本地凭据路径；设置卡仍会显示脱敏账号信息。
- 插件只有本进程内刷新节流和重入保护，**没有跨进程刷新锁**。并发运行多个 DSH/CodeBuddy 刷新方可能造成 refresh token 相互作废。
- User-Agent workaround 是当前 DSH Host 进程内对 `globalThis.fetch` 的包装；它仅精确匹配 WorkBuddy 上游 hostname，但仍是进程级行为。
- WorkBuddy 推理、积分和续期接口不是稳定的公开 API，上游变更可能破坏当前假设。
- 原子写回失败时会尝试清理临时凭据文件；若写入和清理同时失败，仍可能留下含新凭据的临时文件。

安装器和卸载器只管理带 ownership 标记的 WorkBuddy provider；profile bundle 由官方 `dsh plugin` 命令管理。为兼容旧 PowerShell 安装，CLI 只会备份并迁移精确带旧 ownership markers 的 profile patch 块；无标记同 ID 或畸形标记一律拒绝。CLI 不覆盖未知 provider，不删除 CodeBuddy 登录态，也不清理来源不明的 DSH 凭据。详细边界见 [README.md](README.md)。
