# Changelog

本文件记录 dsh-workbuddy-auth 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.5.7] - 2026-10-20

### Fixed

- WorkBuddy 图片请求复用宿主附件服务的请求版本与缓存，按宿主默认的单图 1 MiB、4M 像素和合计 20 MiB base64 预算处理图片。超出总预算时在发送前返回宿主 `IMAGE_OFFLOAD_REQUIRED` 契约，由宿主标记最早的图片并续跑；已标记图片发送原始附件引用与重读路径，不删除附件或会话历史，避免长会话不断重发原图而遭遇 HTTP 400。
- 并行工具返回图片时，先连续发送完整的工具结果，再发送对应图片消息，保持工具调用与结果的上游消息顺序。

## [0.5.6] - 2026-10-19

### Fixed

- WorkBuddy 同账号凭据同步或 token 续期打断在途模型目录读取时，在推理请求发送前重新读取一次完整目录与当前凭据，修复空作用域被误判为 `WORKBUDDY_ACCOUNT_CHANGED`。重读有次数上限，不重放已发送的推理请求；真正切号、切地区、退出及请求发送前的身份校验保持生效。

## [0.5.5] - 2026-10-15

### Fixed

- **智谱清言对话必然失败，报 `AGENTMORE_STREAM_TRUNCATED` / `UNKNOWN`**（用户截图实测）。根因：凭据里的 `conversationId` 是空串（`lib/agentmore-store.mjs` 允许空值，登录流程也不写入），适配器把 `conversation_id: ""` 原样发给 `/chatglm/agent-api/stream`，而上游对这种请求回的是 **HTTP 200 + `application/json` `{"status":500,"message":"internal server error"}`**，不是 SSE。流消费层读到 EOF 却从未见到 `finish` 帧，于是抛 `AGENTMORE_STREAM_TRUNCATED`（502），界面显示「处理失败 / 本轮运行失败 / UNKNOWN」。逐字段验证：`conversation_id` 为空串、缺字段、`null` 三种写法上游行为完全一致（都 200+JSON 500），所以不能靠省略字段绕过，必须由插件先建会话。现在 `conversationId` 为空时先调 `POST /chatglm/agent-api/conversation` 取真实 id，再用它发起对话；建会话失败的原始错误直接透传（不再被误报成流截断）。历史已由 `flattenPrompt` 拍平进 prompt，换新会话不丢上下文（实测新会话仍能正确引用上一轮内容）。

## [0.5.4] - 2026-10-18

### Fixed

- WorkBuddy 推理端点返回 `6004` 时，保留使用量限制与重置时间，按宿主 `QUOTA` 分类结束；不再丢失原因而显示 `PROVIDER_ERROR / UNKNOWN`，也不再为该限额自动重试。HTTP 与 SSE 错误使用同一映射；其余认证、限流、服务端错误保留分类和 HTTP 状态，原始错误正文不回显。
- 清言账号已登录但尚无余额缓存时，`status()` 保持 `remaining: null`，复用已有可空数字转换；真实零余额仍显示 0。补齐 `null`、`undefined`、空字符串及真实零值回归。

## [0.5.3] - 2026-10-18

### Fixed

- **已登录但积分显示 0**（用户实测）。三处缺陷叠加，任一处都足以让余额变成 0：① `lib/agentmore-service.mjs` 读 `result?.value`，而 `parseCreditBalance()` 返回的是 `{ remaining, display }`，取值恒为 `undefined` → `null`；② `lib/client.js` 用 `finiteNumber()` 投影该值，`Number(null) === 0` 把「取不到」画成「0 积分」（同文件早有 `nullableNumber()` 专为此写）；③ `lib/agentmore-login.mjs` 登录成功落盘时不含 `credits`，而 `service.status()` 刻意不探测上游、只读缓存，于是冷启动必然显示空。现在登录时顺手取一次余额落盘，服务层按 `remaining` 透出，客户端对 `null` 保持 `null`（界面显示「未取到」）。实测上游 `member_info.left_score` 是字符串 `"8784.58"`，解析链路本身没问题。
- **上下文窗口被写成 128K，用户改不回 1M**（对应提问「模型配置确定是只能默认的 128K?」）。旧代码把官方文档的「最大输出 Tokens 128K」误当上下文窗口，GLM-5.3 的 1M 窗口被标成 128K；客户端 `modelUpdate()` 又有 `size > model.maxContextWindow` 的闸门，手填 1M 会被自己的覆盖校验挡回来。按官方文档（`docs.bigmodel.cn` 的 GLM-5.3 与 GLM-5.3-Flash）改为**上下文 1M / 最大输出 128K**。目录缓存版本升到 2，旧缓存（含 128000 与单档 `default`）整份失效，升级后立即生效。
- **思考深度只剩一档**。上游 `reasoning_efforts` 是对象数组，档位 id 在 `am_effort`（`low` 快速 / `high` 深度 / `max` 极致，另有内部值 `effort: ''|'thinking'|'deep_thinking'`），旧实现读错字段并把三档压成单个 `default`，原生选择器因此只有一个选项。实测 `/stream` 的 `meta_data.reasoning_effort` 只认 `low` / `high` / `max`（发 `thinking`、`deep_thinking` 直接收到 error 帧、零回答），思考帧数随档位递增（0 / 10 / 14）证实生效。现在三档原样透出，默认 `max`。
- **`am_switch` 被当成「已下架」，活取目录恒为空**。该项是**能力位**（`true` = 该模型在 Agent 模式下可用），实测两项真实模型都是 `am_switch:true` + `chat_switch:true`；旧代码 `if (entry.am_switch === true) continue` 把它们全过滤掉，于是 `catalogSource` 永远停在 `fallback`、缓存从不写盘，界面上看到的一直是内置列表而不是账号真实可用模型。改为只有显式 `false` 才剔除（真下架时上游会整条移除）。实测修复后 `catalogSource=live`、两条模型、缓存以 version 2 落盘。

### Changed

- `normalizeReasoningEffort()` 改为映射到上游三档：`none`/`minimal`/`low` → `low`，`medium`/`high` → `high`，`xhigh`/`max` → `max`，`default` 与未知值不发字段（交给上游默认）。上游没有「关闭思考」，最低档就是 `low`。
- 删除适配器里 `maxTokens` 的死代码（只算不用，插件的 `/models` 契约从不透出 `defaultMaxTokens`）。

## [0.5.2] - 2026-10-18

### Fixed

- **还没登录就被踢回插件并报「该账号是游客身份」**（用户实测）。实测 `agentmore.chatglm.cn` 打开后 3 秒内就会在**自己的子域**上写入一对游客 `chatglm_token` / `chatglm_refresh_token`，而用户正式登录后令牌写在 apex `chatglm.cn` 上。旧实现一轮询到「已有两枚 cookie」就去验证身份，得到 `is_guest=true` 随即把流程判成 `error` 并关窗 —— 用户刚看到登录框、还没输验证码，窗口就没了。现在游客态只是 `guestPending` 标记：流程保持 `running`、窗口不关、继续轮询，直到上游认出真账号。
- **同名 cookie 跨域混配**。`Storage.getCookies` 的返回顺序不是契约：实测子域游客令牌排在 apex 真令牌之前，而旧实现只取第一个匹配（还从两个域各取一枚当一对），既可能选中游客令牌，也可能拼出「apex access + 子域 refresh」这种必然 401 的组合。新增 `cookieCandidates()`：apex 域优先、逐枚候选按**域**配对成完整凭据，取代原来的「各取一枚」。API 调用被拒（`INVALID_CREDENTIAL`）时换下一枚候选，而不是整轮重来。

### Changed

- **详情页不再重复标题**（用户实测反馈）。详情页页眉原本先画一个订阅点名的 `<h4>`，紧跟着详情卡自己又画一个同名 `<h3>`，同一名字连出两行。现在详情页统一给一个页眉（图标 + 名称 + 一行说明），卡片在 hub 里用 `inHub` 跳过自己的页眉；独立挂载时仍保留页眉，`aria-labelledby` 跟着分支指向真实存在的标题元素（否则读屏软件念不出标题）。
- **每个订阅点显示官方图标**，取代原来的 "WB" / "GLM" 文字方块。图形逐字节取自官方站点（WorkBuddy：`www.workbuddy.ai` 的 `assets/logo.svg`；智谱清言：`chatglm.cn/favicon.ico`，实为 64×64 PNG），内联为 data URI —— Web 前端跑在 `dsh-app://` 与 loopback 下，外链图标要多一份域名许可，弱网或 CSP 收紧时还会变成破图。
- 设置卡在游客态给出可执行的下一步（「请在已打开的窗口里点击『登录』…窗口会一直保留」），而不是让用户盯着「等待登录完成…」猜。

## [0.5.1] - 2026-10-17

### Changed

- 两个订阅点合并为**单一入口**：设置页只占一张座位（标签「订阅服务」），进来先是总览卡，点某一项进入该订阅点的详情页，详情页顶部有「返回订阅总览」。与 `dsh-chatgpt-subscription` 的 hub 做法一致。此前注册了两个 `settings.section` 座位，导航里会显示两行，像是两个插件，并且多占一个全局排序槽位。

### Fixed

- **登录成功后界面永久停在「等待登录」**。`allCookies()` 发的是 `Network.getAllCookies`，但 `Network` 是 page 域方法，挂在浏览器级 CDP socket 上只会返回 `-32601 'Network.getAllCookies' wasn't found`；改用浏览器级可用的 `Storage.getCookies`。实测：`Storage.getCookies` 在浏览器级可用且能读回 `setCookies` 写入的值，`Network.getAllCookies` 只在 attach 出来的 session 内可用。
- 同一故障的放大器：登录轮询把**所有**探测异常都当瞬时抖动 `.catch(() => false)` 吞掉，于是协议级编码错误的表现是界面永久卡死且没有任何线索。现在 CDP 协议错误被包成带 `code` 的 `Error`，`-32601` / `-32602` 标为 `permanent`，轮询遇到即收尾并显示「登录链路故障（原因）」，不再静默重试。
- 新增 `test/browser-cdp.test.mjs`：锁住「浏览器级只能用 Storage 域」「永久错误必须立刻收尾」两条，防止同一 bug 复现。

## [0.5.0] - 2026-10-16

### Added

- 新增第二订阅点 `agentmore`（智谱清言 Agent / chatglm.cn），与既有 WorkBuddy 订阅点并列：各自独立的账号库、凭据续期、积分读取与模型偏好，互不影响推理使用哪一边。
- 登录走宿主自起浏览器 + cookie 轮询：宿主打开 `https://agentmore.chatglm.cn`，用户在窗口内登录 chatglm.cn，插件轮询 `chatglm_token` / `chatglm_refresh_token` 两枚 cookie 与 `chatglm-deid` 设备标识，成功后写入本机加密账号库。不依赖 OAuth 回环，也不读取用户浏览器的 Cookie 数据库。
- 上游协议按 APK 反编译逐字实现：`md5(timestamp-nonce-salt)` 的 `X-Sign`、带校验位的 `X-Timestamp`、校时接口 `cur_ts` 的半 RTT 补偿，以及 `/chatglm/agent-api/stream` 的 SSE 增量差分。
- 新增 `agentmore` 命名空间下 10 条 exact 路由（`/api/dsh-workbuddy-auth/agentmore/*`），覆盖状态、登录开始/查询/取消、账号列表/切换/移除、积分、模型读取/保存/刷新。

### Fixed

- `finiteNumber` / `numberOr` 把 `null` 折成 `0`，导致「服务端未返回余额」被显示成「余额确实是 0」。新增可空数字路径，未取到时显示「未取到」。
- 模型窗口参数统一要求正安全整数；此前负数上下文覆盖会被原样透传给客户端，被当作「无限上下文」渲染。
- `/agentmore/status` 的 `credits` 与 `models` 改为恒定存在，客户端无需临时判断块是否存在。
- 目录请求超时先 `reject` 再 `abort`，避免 `abort` 让在飞 fetch 先以自身错误码失败、超时被误报成 `AGENTMORE_CATALOG_FAILED`。
- 登录轮询期间「取消」按钮曾被 `busy` 恒真禁用到流程结束，用户中途放弃时点不动；取消与登录轮询改用独立锁，「本次登录已取消」为粘性标记，轮询下一次唤醒即退出，不再续请求。

## [0.4.5] - 2026-10-15

### Fixed

- 同账号凭据更新保留成功的模型目录缓存，目录获取失败时继续使用；切换账号或地区、退出后仍按当前凭据隔离目录。
- 成功目录仅持久化模型元数据和账号作用域摘要，重启后网络失败时可恢复同账号目录；官方成功返回空目录会替换旧缓存，不自动增加模型勾选。
- 已勾选模型因目录请求失败或超时不可解析时，返回 `WORKBUDDY_CATALOG_FAILED` / `WORKBUDDY_CATALOG_TIMEOUT`，不再误报 `WORKBUDDY_MODEL_DISABLED`。

## [0.4.4] - 2026-10-15

### Fixed

- 优先读取宿主工具结果消息的 `source.callId`，正确关联助手的工具调用，修复工具执行后续轮因空 `tool_call_id` 被上游拒绝的问题。
- 保留旧 `tool-result.toolCallId` 格式兼容，并增加多工具文本结果及新旧 ID 冲突时的回归测试；不改变账号、模型选择或推理参数。

## [0.4.3] - 2026-10-15

### Fixed

- 补齐原生适配器必需的 `providerRetryPolicy` 契约，复用宿主默认重试策略，修复供应商路由注册时报错、已勾选模型未进入原生目录的问题。
- 增加真实宿主注册、供应商/模型枚举、能力解析与注销回归；保持现有模型勾选、账号和调用行为。

## [0.4.2] - 2026-10-15

### 界面

- 按参考布局改为紧凑模型勾选列表，统一展示已选数量及全选、全不选操作，不再逐项展开参数表。
- 独立增强功能区只保留一个默认思考设置，上下文编辑仅展示已勾选模型，并支持保存前一次恢复全部上下文默认值。
- 将既有用量与配额显示移到增强功能之后；保持凭据、目录、保存、刷新和调用接口不变，首次仍为零勾选。

## [0.4.1] - 2026-10-15

### 修复

- 附件服务缺席时，延迟到实际图片请求才获取当前附件读取器，避免在插件初始化阶段触发直接属性访问异常；认证、模型目录和文本模型保持可加载。
- 图片路径跟随当前附件服务的存在、迟到和撤销，保留方法接收者与 AbortSignal；沿用既有图片缺失错误、文本处理和适配器注销语义。

### 验证与边界

- 补充真实公开 Cordis 模块的四态完整初始化测试，以及图片、文本、重入和卸载回归；仅证明受控条件性源码修复，不将其等同于实际 Desktop 异常的已证根因。
- 保持原有包白名单和依赖；使用正常本地 tgz 更新，磁盘安装、宿主加载与真实上游验收分层确认。

## [0.4.0] - 2026-10-14

### 新增

- 原生 `workbuddy` 供应商与插件模型管理区：复用当前已登录托管账号和现有凭据链路，按账号与 CN/Intl 地区获取官方目录，不引入另一套认证池。
- 首次默认 `enabled=true`、`enabledModelIds=[]`、`defaultReasoningEffort=null`、`contextWindowOverrides={}`；模型必须手动勾选并保存后才进入 DSH 原生选择器。供应商开关、官方目录刷新、逐项选择及显式全选均可在面板管理。
- 默认思考深度“自动”保存为 `null`，只传模型支持的档位；插件默认不适用时采用模型官方默认。每模型上下文覆盖校验正整数和已知官方最大值，清空输入删除覆盖。
- 独立非凭据偏好文件 `DSH_HOME/storages/workbuddy-auth-models.json`，提供同源模型状态、保存和目录刷新接口；刷新与保存不发推理请求，也不改变当前聊天模型。
- 原生流式适配器处理文本、模型声明的图片输入、工具调用、思考、用量、结束原因、中止及错误；账号切换使目录失效，卸载释放本插件适配器与资源。

### 变更

- 使用正常 DSH 包管理安装本地 tgz；文档区分新原生模型面板与兼容旧 CLI 的全目录 YAML 配置。更新已有包需按宿主生命周期重启，安装版本不等于正在运行的加载版本。
- 保留已有 `files` 白名单和认证入口，不增加发布依赖。该版本本地打包安装不等于 npm 发布；真实上游调用须另行验证。

## [0.3.3] - 2026-10-14

### Fixed

- Keep active credential reads, account identity and refresh writeback aligned with the managed representative after a same-identity browser login. Previously the current-account badge could show fresh managed credentials while reload and refresh still used a stale desktop file.
- Resolve managed representatives before filtering expired or duplicate desktop entries, so hidden historical files never override fresh credentials for the same identity.

## [0.3.2] - 2026-10-13

### 修复

- **登录失败只有一句「登录初始化或轮询失败」，看不出失败在哪一步**：失败态与等待态的登录 DTO 新增三个
  **脱敏诊断**字段——`reason`（七类原因：`network` / `http` / `upstream` / `region` / `payload` /
  `store` / `timeout`）、`detail`（该次失败的已知事实：阶段、域、HTTP 状态码、上游业务码）、
  `trace`（最近 24 次上游交互的轨迹）。展示值一律查固定白名单（`lib/diagnostic-display.mjs`，
  服务层 / 路由层 / 前端三处投影同源）：只有本插件自己写下的阶段字面量
  （`state` / `token` / `credential` / `store`）、已知域、有证据的业务码（`0` / `401` / `11128` /
  `11217` / `12403`）与 100–599 的 HTTP 状态码会进入文案，其余一律丢字段并显示「未知」——上游可控的
  字符串（手机号、伪造的域样串）不会成为回显通道；令牌、`state`、原始响应体与本地路径始终不进 DTO。
  成功态 DTO 形状不变，仍不带任何上游细节。设置卡的失败文案随之按原因分档（地区拒绝会点名被拒的域、
  上游拒绝会给出业务码），兜底文案保持原样（`test/login-diagnostics.test.mjs`、
  `test/client-login-hint.test.mjs`、`test/diagnostic-display.test.mjs`）。
- **轮询期间的一次网络抖动会把整条登录判死**：授权是「浏览器里人工操作 + 约 1.5 秒轮询」的组合，
  之前任何一次瞬时失败（连接重置 / 网关 5xx / HTTP 408 / 425 / 429）都直接终态失败，用户正在输
  验证码时就会看到「登录失败」。现在连续瞬时失败在 5 次以内保持 `pending` 继续轮询（每次都记进诊断
  轨迹），达到上限或 300 秒总时限才终态失败；`complete` 之后到达的迟到结果仍不改写终态。
- **余额查询失败一律显示「上游未提供余额」**：余额失败不再只有一个 `unavailable`，而是按失败阶段
  收敛为四个稳定值——`auth-rejected`（401/403 凭据被上游拒绝）、`request-failed`（网络 / 超时 /
  其它非 2xx）、`upstream-invalid`（2xx 但报文不可解析）、`unavailable`（地区不支持或凭据缺失，
  一次请求都不发）；同一个值域在 `lib/credits.mjs` → `lib/status.mjs` → `lib/routes.mjs` → 设置卡
  四道投影一致收敛。设置卡把前三类渲染成不同文案（重新登录该账号 / 稍后重试 / 反馈），不再把认证
  失败说成「上游没有余额」。

### 变更

- 诊断展示规则抽到 `lib/diagnostic-display.mjs`，服务层与路由层 import 同一份；前端受宿主经典脚本
  加载器限制只能保留同规则副本，两份的一致性由 `test/diagnostic-display.test.mjs` 与服务层规格测试
  锁定。

## [0.3.1] - 2026-10-13

### 修复

- **浏览器登录在 CN 地区误报 `WORKBUDDY_LOGIN_POLL_FAILED`**：CN 网关在浏览器授权成功后签发的令牌报文里
  `data.domain` 是 `www.codebuddy.cn`，而 `lib/origins.mjs` 的 CN 认证域白名单只认 `copilot.tencent.com`
  与 `*.tencent.com`，`regionForAuthHost()` 对它返回 `null`，于是 `lib/web-login.mjs` 的地区 fail-closed
  校验（`apiOrigin === null`）把**刚拿到的 CN 令牌**判死并丢弃。表现为「浏览器已经显示登录成功，
  插件里却是登录失败」，且错误码只有一句「登录初始化或轮询失败」，看不出真实原因。
  CN 白名单改为 `tencent.com` 与 `codebuddy.cn` 两个 apex（apex 自身与任意子域），与
  `lib/checkin.mjs` 的 `CHECKIN_DEFAULT_DOMAIN` 保持一致。新增回归测试，用生产实测报文逐字复现
  该场景（`test/origins.test.mjs`、`test/web-login.test.mjs`）。

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
