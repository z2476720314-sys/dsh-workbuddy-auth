# Changelog

本文件记录 dsh-workbuddy-auth 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
