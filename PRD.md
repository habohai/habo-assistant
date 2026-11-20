# 飞书群 @ 机器人接 DSH Agent · 产品需求文档（PRD）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1（草案，待评审） |
| 状态 | Draft |
| 日期 | 2026-11-20 |
| 目标插件 | `dsh-feishu-bot`（暂定包名） |
| 关联 | DSH 0.2.x / `lark-cli` / 现有 `dsh-session-artifacts` 二开经验 |

---

## 1. 背景与问题

团队日常在飞书群里讨论问题、贴日志、问构建/环境/代码。现在这些问题需要人打开 DSH、复制上下文、再问 agent，回答还要手动贴回群。

目标是把「群里 @ 机器人提问」直接变成「DSH Agent 在该群里回答」，并且**不同群的上下文互相隔离**，长期使用也不会串。

飞书侧已经有 `lark-cli event consume`（长连接收事件）和 `im +messages-reply`（回消息）；DSH 侧 Host 插件可以注入 `sessionController` 创建/驱动会话。技术链路已经验证，缺的是产品化和安全边界。

## 2. 目标与非目标

### 2.1 目标

1. 机器人在多个群被 @ 时，按群（或话题）路由到各自的 DSH session，回答回到原消息/话题。
2. 零运维启动：机器人进程由 DSH Host 托管，断线自动重连，重启后映射不丢。
3. 可控权限：只有 allowlist 内的群/人能触发；工作目录、agent preset、可用工具由管理员固定。
4. 失败可见：超时、审批阻塞、服务重启都有明确回复，不静默。

### 2.2 非目标（本期不做）

- 多租户 SaaS、对外发布应用、应用商店上架。
- 语音/视频/文件理解的完整多模态输入（P2）。
- 每个群独立模型/工具策略的富管理后台（P1 配置项，P2 管理页）。
- 替代 DSH Web 的会话 UI；群聊只是入口。

## 3. 用户与场景

| 角色 | 诉求 |
|---|---|
| 提问者（群成员） | @bot 问问题，几秒到几分钟内拿到回答；能追问；不希望答案跑到别的群 |
| 管理员 | 决定哪些群能用、用哪个工作区/preset、agent 能做什么；能审计 |
| 机器人主人 | 配置一次，长期稳定运行；出问题能看到原因 |

典型场景：

1. **排障**：群里贴一段报错 @bot，bot 在固定 repo 工作区里分析并回复。
2. **构建/环境查询**：@bot "看下 xxx 服务最近一次构建为什么失败"。
3. **追问**：对 bot 的回复继续 @ 追问，沿用该群 session 的上下文。
4. **多群并行**：A 群问代码、B 群问发布，两个 session 并行处理，上下文不混。

## 4. 核心概念

| 概念 | 定义 |
|---|---|
| Bot | 一个飞书自建应用的机器人身份（app_id 绑定一份 profile 配置） |
| Chat | 飞书群或单聊，`chat_id` 标识 |
| Thread | 话题群/回复串，`thread_id`/`root_id` 标识；普通群为空 |
| Binding | 路由绑定：`(app_id, chat_id[, thread_id]) → session_id` |
| Job | 一次 @ 提问的处理单元，持有 `chat_id/thread_id/message_id`、状态、结果 |
| Session | DSH 会话，承载该群/话题的上下文与 agent |

映射粒度由配置决定：

- `per-chat`（默认）：一个群一个 session；
- `per-thread`：话题群按 `chat_id + thread_id` 拆 session，适合话题群；
- `manual`：配置里显式绑定到已有 session。

## 5. 范围与优先级

### P0（MVP，必须先有）

- 长连接事件接入 + 断线重连 + 健康状态。
- 只处理「@ 了本 bot」的文本消息；忽略自己/其他 bot、重复事件。
- 路由：自动建 session 并按 chat（或 thread）持久化绑定；支持手动绑定覆盖。
- 串行队列：同一 session 一次只跑一个 job；不同 session 并行；全局并发上限。
- 回复：回到触发消息（话题内回复），幂等键防重；长文分段。
- 处理反馈：收到后先加表情/回执，完成后回复；超时/失败有说明。
- 安全：默认拒绝，必须配置 allowlist；固定 cwd / preset；不自动放宽审批。
- 配置：bot 凭据、allowlist、cwd、preset、并发/超时；凭据走 DSH credentials。
- 观测：结构化日志、job 历史、失败分类。

### P1（可用性增强）

- 处理中卡片 + 最终卡片（可更新），流式/阶段进度。
- 审批与反问转发成飞书卡片（按钮回调 allow/reject/answer）。
- 群内命令：`/new`（新 session）、`/bind <sessionId>`、`/stop`、`/status`。
- 按群覆盖 preset / model / cwd。
- 管理设置卡片（连接测试、群列表、绑定管理）。

### P2（远期）

- 附件/图片输入、语音转文字。
- 多 bot 身份、多租户隔离。
- 回答引用工作区文件/构建链接的富卡片。
- 用量统计与配额。

## 6. 用户流程

### 6.1 首次配置（管理员）

1. 飞书开放平台创建企业自建应用，开启机器人能力。
2. 申请并开通群 @ 消息事件所需 scope；开启**长连接**事件订阅。
3. 把机器人拉进目标群。
4. 在 DSH 插件配置中填 app_id/secret（secret 存 credentials）、allowlist、cwd、preset。
5. 插件启动长连接，日志显示 ready；在群里 @bot 发一条测试消息，收到回答。

> 飞书侧具体 scope 名称、事件字段以 `lark-cli event schema im.message.receive_v1 --json` 与应用后台为准，本节只定义产品要求。

### 6.2 群内提问（主流程）

```
群成员 @bot 提问
   → 插件收到事件（event_id 去重）
   → 校验：allowlist / 是否 @bot / 是否 bot 自己
   → 解析 chat/thread → binding
        ├─ 有绑定：取 session
        └─ 无绑定：create + rename("飞书·<群名>") + 落库
   → job 入该 session 队列（全局并发上限内）
   → 回执：给原消息加表情（P0）/ 发“处理中”卡片（P1）
   → agent.followup([飞书群|提问人] + 问题文本)
   → 等待 turn 结束 / 超时
        ├─ 成功：回复原消息（thread），长文分段
        ├─ 超时：取消 agent，回复“超时已中断”
        ├─ 审批阻塞/无权限：回复原因
        └─ 服务重启/异常：回复失败原因，job 标记 failed
```

### 6.3 追问

同一群（或话题）再次 @bot，沿用同一 session；历史上下文在 DSH 会话日志里，agent 自动可见。回复仍挂在各自消息的 thread 下。

### 6.4 手动绑定（可选）

管理员在配置或 `/bind` 中把群绑定到指定 session（例如已经调好 preset 的会话）。手动绑定优先于自动创建；session 被删除时下一次消息自动重建并提示。

## 7. 功能需求

### FR-1 事件接入

- 通过 `ctx.subprocess` 启动 `lark-cli event consume im.message.receive_v1 --as bot`。
- 以 stderr 的 `[event] ready event_key=...` 判定就绪，不依赖 sleep。
- stdout 按 NDJSON 逐行解析；非法行记录并跳过。
- 子进程退出/崩溃：指数退避重启（1s→30s 上限），连续失败 N 次进入 degraded 状态并记录。
- 插件卸载/DSH 退出时优雅终止子进程。
- 健康状态暴露在日志与（P1）设置卡片中。

### FR-2 消息识别与过滤

- 仅处理 `message.chat_type` 为 group/p2p 且 `mentions` 包含本 bot `open_id` 的消息。
- 忽略 `sender_type=app`（含自己），忽略非文本/非 post 消息（P0 记录并跳过，P2 支持）。
- 文本把 `@_user_N` 占位符清洗为可读内容，去掉开头对 bot 的 @。
- `event_id` 去重：持久化最近 24h（容量上限），重复事件直接 ack 不重复执行。
- 空白问题（仅 @）回复使用提示，不调用 agent。

### FR-3 路由与会话

- 绑定表持久化：`(app_id, chat_id, thread_key) → session_id`，`thread_key` 为空表示群级。
- 粒度由 `routing: 'chat' | 'thread'` 配置，默认 `chat`。
- 无绑定时通过 `sessionController.create({ cwd, agentPreset })` 建会话，并 `rename` 为 `飞书·<群名>`。
- 手动绑定：`bindings: [{ chatId, threadId?, sessionId }]`，优先级最高。
- 会话被删除/归档：下一次消息重建绑定，并在群里提示"原会话已不可用，已开启新会话"。
- 绑定与 job 记录都在插件 storage，不放 session 元数据。

### FR-4 执行与并发

- 每个 session 一个 FIFO 队列，同一 session 同时最多 1 个 job。
- 不同 session 可并行；全局并发上限 `maxConcurrent`（默认 4）。
- 注入给 agent 的文本格式：
  `[飞书群:<群名> | 提问人:<姓名>]\n<问题原文>`
  仅作上下文，不参与路由。
- 超时 `jobTimeoutMs`（默认 10 分钟）：取消 agent 当前 turn，回复超时说明。
- 队列积压超过 `maxQueue`（默认 20）时拒绝新消息并提示稍后再试。
- 同一 session 的新问题排队，不打断进行中的回答（`/stop` 为 P1）。

### FR-5 回复

- 默认回复到触发消息的 thread（`+messages-reply --reply-in-thread`）；普通群也保持"答复挂在原消息下"。
- 带 `idempotency-key`（job id），网络重试不重复发。
- 超过飞书单条长度上限时分段发送（阈值可配置，按字符截断，保留代码块围栏完整）。
- 纯文本优先；P1 支持卡片与 Markdown。
- 失败分类：超时、审批拒绝、provider 错误、工具错误、内部异常，分别有可读文案。
- agent 无输出（空回复）时回复"没有生成有效回答"。

### FR-6 处理反馈

- P0：收到即给原消息加"处理中"表情（若 bot 权限不支持则发一条短文本回执）。
- P1：发"处理中"卡片，完成后 patch 为最终结果；长任务每 N 秒更新阶段。

### FR-7 安全与权限

- 默认拒绝：`allowlist.enabled=true` 且 `chats` 为空时，不处理任何群。
- allowlist 支持群与用户两个维度（`chats[]`、`users[]`）；不在名单内：忽略或回一句"未授权"（可配置）。
- `cwd` 固定为配置值，禁止由消息内容指定路径。
- `agentPreset` 由管理员指定，建议专用 preset（只读工具或受限沙箱）。
- 插件**不自动放宽审批**：需要审批的工具在无人应答时按 DSH 策略失败，回复原因；P1 才做审批转发。
- secret 存 DSH credentials，配置里只出现引用名；日志不打印 token。
- 审计：记录 `chat_id/chat_name/sender/message_id/job_id/session_id/耗时/结果`，保留 N 天。

### FR-8 配置

P0 用插件 config（`cordis.patch.yml`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `app.credentialRef` | — | 凭据引用（app_id/secret） |
| `allowlist.enabled` | true | 总开关 |
| `allowlist.chats` | [] | 允许的 chat_id |
| `allowlist.users` | [] | 允许的 sender open_id（可选） |
| `routing` | chat | chat / thread |
| `bindings` | [] | 手动绑定 |
| `cwd` | 必填 | agent 工作目录 |
| `agentPreset` | 默认 preset | 专用 preset |
| `maxConcurrent` | 4 | 全局并发 |
| `maxQueue` | 20 | 单 session 队列上限 |
| `jobTimeoutMs` | 600000 | 任务超时 |
| `reply.replyInThread` | true | 是否 thread 回复 |
| `reply.maxChars` | 3500 | 单段长度 |
| `audit.retentionDays` | 30 | 审计保留 |

P1 增加设置卡片与连接测试。

### FR-9 可观测性

- 结构化日志：`event.received` / `job.enqueued` / `job.started` / `job.finished` / `job.failed` / `consumer.restarted`。
- 关键计数：收到事件、去重丢弃、非 @ 忽略、未授权、成功、超时、失败、平均/分位耗时。
- P1 提供 `/status` 命令与设置卡片健康区。

### FR-10 群内命令（P1）

| 命令 | 行为 |
|---|---|
| `/new` | 为当前群/话题新建 session 并绑定 |
| `/bind <sessionId>` | 绑定到指定 session（需权限） |
| `/stop` | 取消当前 job（仅发起人或管理员） |
| `/status` | 返回当前绑定、队列、并发、最近一次结果 |

## 8. 数据模型

```text
BindingRecord {
  appId: string
  chatId: string
  threadKey?: string        // 空 = 群级
  sessionId: string
  chatName?: string
  createdAt: number
  source: 'auto' | 'manual'
}

JobRecord {
  id: string                // 幂等键
  eventId: string
  chatId: string
  threadKey?: string
  messageId: string
  senderId: string
  sessionId: string
  question: string
  status: 'queued'|'running'|'succeeded'|'failed'|'timeout'|'rejected'
  enqueuedAt/runningAt/finishedAt
  durationMs
  errorCode?: string
  replyMessageId?: string
}

DedupRecord { eventId, at }            // TTL 24h
Config 见 FR-8，secret 不入 storage
```

存储：插件 storage（`ctx.storage`/`storageDomain`），重启后可恢复；绑定表与去重表都要能冷启动读取。

## 9. 集成与实现备忘

| 能力 | 接口 | 备注 |
|---|---|---|
| 收事件 | `ctx.subprocess.spawn` + `lark-cli event consume im.message.receive_v1 --as bot` | stdin 保持打开；stderr 就绪标记；NDJSON |
| 建会话 | `ctx.sessionController.create({ cwd, agentPreset })` | 返回 `sessionId` |
| 改名 | `ctx.sessionController.rename({ sessionId, title })` | 便于在 DSH UI 里识别 |
| 驱动 | `ctx.sessionController.resolveAgent(sessionId)` → `agent.followup(message)` | 与 Web 发送同一条准入路径 |
| 收结果 | `ctx.on('session/event', ...)` 的 `assistant/message` / `turn/end`，或 `agent.whenIdle()` | 注意只取本 turn |
| 回复 | `lark-cli im +messages-reply --message-id ... --reply-in-thread` | 带幂等键 |
| 凭据 | `ctx.credentials` | app_id/secret 引用 |
| 持久化 | 插件 storage | 绑定/去重/审计 |

> 该链路与 `dsh-schedule` 驱动会话的方式一致；实现前用 `lark-cli event schema im.message.receive_v1 --json` 再核对一次字段。

## 10. 非功能需求

- **部署**：桌面端可跑，但 7×24 建议 `dsh web --profile <profile>` 常驻；插件随 Host 启停。
- **并发**：全局默认 4，可配；单 session 串行；事件处理不阻塞 UI 线程。
- **恢复**：进程重启后 5s 内恢复消费；in-flight job 标记失败并回复"服务重启，请重发"。
- **安全**：默认不处理任何群；secret 不落日志；不因消息内容改变 cwd/权限；不自动批准工具。
- **隐私**：群消息进入 DSH 会话日志并发往模型 provider；README 与配置说明中明示。
- **兼容**：以安装的 DSH 版本锁定 `engines.dsh`；`lark-cli` 需在 Host PATH 中。

## 11. 错误与边界

| 情况 | 行为 |
|---|---|
| 未 @ bot | 忽略 |
| bot 自己的消息 | 忽略 |
| 重复 event_id | 忽略并 ack |
| 未授权群/人 | 忽略或礼貌拒绝（配置） |
| 空问题 | 回"请描述你的问题" |
| 队列满 | 回"当前排队较多，请稍后再试" |
| 超时 | 取消 turn，回超时说明 |
| session 被删 | 重建并提示 |
| 长连接断开 | 退避重连，日志告警；恢复后继续 |
| 回复超长 | 分段 |
| 审批阻塞 | 回"需要人工审批，暂无法执行"，job 标记 rejected |
| Host 重启 | in-flight job 失败回复 |

## 12. 验收标准（MVP）

1. bot 在 A、B 两个群；A 群 @ 只回 A，B 群 session 历史看不到 A 的内容。
2. 非 @ 消息、bot 自己消息、重复事件均不触发 agent。
3. 首次 @ 自动建 session 并按群名命名；DSH 重启后映射仍在，追问沿用原 session。
4. A、B 两个群各问一个长任务可并行；同群连发两条按顺序执行。
5. 超过超时时间后 agent 被取消，群里收到超时说明。
6. 未授权群 @ 不执行 agent。
7. 回复挂在原消息 thread；长回答分段且顺序正确；重复投递不产生重复回复。
8. secret 不出现在日志与配置文件中。

## 13. 指标

- 成功率（成功 / 触发 job）
- P50 / P95 首响与总耗时
- 超时率、审批阻塞率、消费重连次数
- 活跃群数、日活提问人数
- 重复事件丢弃数、未授权请求数

## 14. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| M0 | POC：长连接收事件 + 固定单群 + 固定 session + 文本回复 | 0.5–1 天 |
| M1 | 绑定表/自动建 session/去重/队列/超时/allowlist | 2–3 天 |
| M2 | MVP 验收、配置与审计、错误文案、安装文档 | 1–2 天 |
| M3 | P1 卡片/审批转发/群命令/设置卡片 | 1–2 周 |

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 群里可触发高权限工具 | 数据/环境风险 | 专用只读 preset、allowlist、固定 cwd、审计；P1 审批转发 |
| 审批无人应答 | 任务卡住 | MVP 用不需要审批的工具集；超时与明确失败文案 |
| 长连接不稳/桌面休眠 | 漏消息 | 服务器常驻；重连与健康告警；飞书事件重试 + 幂等 |
| 群聊上下文串台 | 答非所问 | 绑定表 + 每群独立 session；回复地址随 job 走 |
| 消息过长/格式差 | 阅读体验 | 分段、纯文本兜底；P1 卡片 |
| 飞书应用审核/scope 限制 | 无法上线 | 先用测试企业/自建应用验证；提前确认权限清单 |

## 16. 开放问题

1. 机器人回复默认挂 thread 还是直接发群？（MVP 建议 thread）
2. 群消息是否允许不 @ 也触发（如 `/ask` 命令）？
3. 是否要求按话题隔离（话题群）？
4. 专用 preset 的工具边界：只读？允许 bash？是否允许写文件？
5. 部署在桌面还是服务器？谁负责常驻与升级？
6. 群消息保留/审计合规要求（是否允许进入模型 provider）？
7. 多 bot / 多租户是否在路线图内？

## 17. 附录：飞书事件关键字段（待用 schema 核对）

- `event.event_id`：去重
- `event.message.chat_id` / `chat_type` / `thread_id` / `root_id` / `message_id`
- `event.message.mentions[]`：`id.open_id` 判断是否 @bot
- `event.message.content`：文本占位符（`@_user_N`）需清洗
- `event.sender.sender_id.open_id` / `sender_type`

以上字段名以 `lark-cli event schema im.message.receive_v1 --json` 输出为准。

## 18. 实现进度（记录）

### 0.2.0（M1：实效性 + 背压）

已实现：

- **即时反馈**：`ackReaction`（默认 `OnIt`）收到即回执；CLI 支持编辑时改为「占位消息 → 原地编辑成答案」。
- **并发与背压**（FR-4 部分）：全局 `maxConcurrent`、单群 `maxQueue`，超限直接回复而不是无限堆积；单群仍严格 FIFO。
- **持久化去重**（FR-2）：`stateDir/seen.jsonl`，24h / 5000 条，重启后不重复跑同一问题。
- **健康与指标**（FR-9 部分）：`consumerRestarts` / `consumerUnready` / `ackFailed` / `replyFailed` 等计数，`ackMs` / `queueWaitMs` / `jobTotalMs` 的 P50/P95，按 `statsIntervalMs` 输出。
- **CLI 调用截止时间**：`cliTimeoutMs`，避免子进程卡死拖住队列。
- **长连接看门狗**：`readyTimeoutMs` 内未 ready 即回收重连；重启退避 1s→15s（带抖动）。

设计取舍：

1. **不做 token 级流式**：Host `session/event` 只有 `assistant/message` 粒度，token 增量在 Client follow 流里；为进度单独开 Client 通道收益不足。进度按「整条消息」更新。
2. **占位消息而非卡片**：P1 卡片（可 patch）能力更强，但需要 `messages.patch` 与卡片 JSON 维护；文本占位 + 编辑已能覆盖「先看到反馈、后看到答案」的核心诉求。
3. **能力探测 + 降级**：`+messages-edit` 需要 `lark-cli >= 1.0.100`。启动时探测一次 `im --help`，旧版本自动退回「表情回执 + 纯文本回答」，不逐条报错。
4. **撤回兜底需 `--yes`**：编辑失败时撤回自己发的占位消息，属于自我清理，不是用户数据操作；失败只记日志。

仍未做（按 PRD 优先级）：审批/反问转发（P1）、群内命令（P1）、处理中卡片与阶段进度（P1）、按群覆盖 preset（P1）、附件/多模态（P2）、审计表与配额（P2）。

### 0.3.0（安全：命令审批）

已实现：

- **命令审批闸门**：`tools/pre-execute` 拦截插件会话里的 `bash`/`pwsh`（`approvalTools` 可配），返回 `ask` 交给 `dsh-user-approval` 的审批通道；默认 `commandApproval: all`，`off` 可关。
- **危险命令直接拒绝**：`denyCommands`（默认 `DEFAULT_DENY_PATTERNS`）按命令段首匹配 `rm`/`dd of=`/`mkfs`/`sudo`/`shutdown`/`git push --force`/`curl | sh` 等，命中返回 `deny`，不进入审批；这类操作只能在 DSH 客户端里执行。
- **飞书侧审批**：插件注册 `approval/request` answerer，把「需要审批 + 命令摘要」发到对应群里，成员回「@我 同意 / 拒绝」；`approvalTimeoutMs`（默认 120s）超时按 `unavailable` 处理，命令不执行（fail-closed）。
- **审批人收敛**：`approveUsers` 限定 open_id，非审批人的「同意」被忽略并计数；为空时群里任何成员都可批（与当前信任模型一致）。
- **审批回答与提问分流**：待审批期间，命中「同意/拒绝」的回复先被审批逻辑消费，不会再入队变成一个 agent 问题。

已知边界：

- 子 agent 的子会话不在插件会话白名单内，可以绕过审批；因此 `approvalDenyTools`（默认 `subagent` / `subagent_fork` / `workflow`）在审批开启时直接禁用这些工具。清空该配置会重新暴露绕过路径，专用 preset 仍是更彻底的解法（PRD §7 FR-7 仍待落地）。
- 同一群同一时刻只允许一个待审批请求，第二个直接按「无人批准」处理。
- agent 反问（`user-questions`）尚未转发到飞书。
- 审批解决「能不能执行」，不解决「能读到什么」：沙箱仍允许读取 home 下文件；彻底收口需要更窄的沙箱策略/专用 preset。
- 危险命令匹配是词法的（段首锚定以减少误伤），编码/变形写法可绕过；它只是第一道闸。
