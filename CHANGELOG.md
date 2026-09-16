# Changelog

本文件记录 dsh-workbuddy-auth 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.2] - 2026-09-16

### 修复

- **去重保留策略改为 mtime 最新优先**：备份文件里的 xpiresAt 可能是伪造的远期值
  （真实回归：一份 7 月备份写着 2027 年到期，token 实际早已被服务端作废——旧策略按
  「expiresAt 最大者保留」恰好选中它，切换后推理持续 401）。mtime 相差 2 秒内视为同分，
  回退到 expiresAt 比较。mtime 在 DTO 中不输出。
- **已过期账号从可切换列表剔除**：唯一一份凭据且已过期的账号不再出现（点了必 401）。
  xpiresAt=0（上游未提供）保守保留。
## [0.2.1] - 2026-09-16

### 修复

- **「当前」徽章标错账号**：切换账号后，状态卡的 ctiveId 仍停留在初始账号（激活路径存在
  外层 current 与 selector 内部 ctiveFile 两个状态源，切换只更新了前者）。现在 selector
  内部状态是唯一真值，徽章始终跟随真实激活的凭据文件。
- **同一账号出现重复按钮**：桌面端的时间戳备份（如 workbuddy-desktop.<时间戳>.info）与正式
  凭据文件是同一账号且可能已过期，此前会并列出现两个一模一样的切换按钮，点进过期备份必然 401。
  现在列表按账号（uid + 手机号 + 昵称）去重，保留未过期、ccessExpiresAt 最新的一份。
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
