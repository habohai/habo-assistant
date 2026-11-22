<p align="center">
  <img src="icon.svg" width="72" height="72" alt="Habo-Assistant" />
</p>

<h1 align="center">Habo-Assistant</h1>

<p align="center">
  把飞书群聊 / 话题接入 DeepSeek Harness。<br/>
  群里 @ 机器人，消息进入对应的 DSH Session；任务、审批、产物都留在 DSH 里。
</p>

---

## 它解决什么问题

飞书群里的讨论很容易变成“机器人临时回一句”，上下文、文件和后续操作散落在聊天记录里。

Habo-Assistant 把 **飞书群 / 话题** 和 **DSH Session** 绑定起来：

- 群里 @ 一次，之后这个群或话题的对话就进入同一个 Session；
- 话题可以独立成 Session，也可以继承群主会话的摘要；
- 一个 Session 可以绑定多个群/话题，一个群/话题同一时间只属于一个 Session；
- 在 Session 里让 agent **读群消息、发消息或回复**，都会自动认领这个群/话题，后续回复回到当前 Session；
- 多个飞书机器人共享一套绑定，但每个 bot 独立连接、独立审批；
- 右侧栏提供「任务」和「会话信息」两个页面，随时看进度、绑定和产物。

## 功能

| 功能 | 说明 |
| --- | --- |
| 群 / 话题绑定 | `(chatId, threadId)` 唯一 Conversation；群主会话和话题互不串 |
| 话题路由 | `routing: topic` 时，带 `thread_id` 的消息进入独立 Session，回复自动留在话题内 |
| 多机器人 | 每个 bot 独立 lark-cli profile / consumer / 审批；共享绑定，bot 按需授权 |
| 读消息认领 | 从 Session 读取群/话题消息后，该 Conversation 自动绑定到当前 Session |
| 发消息认领 | 从 Session 发往群/话题后，该 Conversation 自动绑定到当前 Session |
| 发送前校验 | `lark-cli` 群发/话题回复先校验 owner 和 bot，再认领；未授权直接拒绝 |
| 话题选择 | 绑定弹窗选中群后，可直接选群主会话或该群的已有话题 |
| 回复格式 | 自动在纯文本 / 富文本 post 之间选择，Markdown 不再裸露 |
| 长文与表格 | 超过阈值或含表格时转飞书文档，群里只发摘要和链接 |
| 确认反馈 | `ackReaction: auto` 在 OnIt / Eyes / Typing 之间按消息稳定轮换 |
| 长任务委派 | 上下文过长时把任务交给 task subagent，主 Session 不再继续膨胀 |
| 审批卡片 | 审批用互动卡片，点「同意 / 拒绝」即可；文字回复仍然可用 |
| 命令审批 | 群里回复「同意 / 拒绝」即可处理审批，审批提示和结果留在原话题 |
| 会话信息 | 当前 Session 绑定的群/话题、bot 列表、行内解绑、会话产物 |
| 实时刷新 | 绑定或连接变化通过 SSE 推送，页面不需要手动刷新，也不轮询 |
| 任务看板 | 进行中、待审批、已完成任务；点击直接跳到对应 Session |
| 会话产物 | 本地文件、飞书文档 / 表格 / 幻灯片 / 画板等统一收集 |

## 工作方式

```mermaid
flowchart LR
  F[飞书群 / 话题] -->|@机器人| L[lark-cli 长连接]
  L --> A[Habo-Assistant Host]
  A --> R[Binding Registry]
  R --> S[DSH Session]
  S --> T[任务 / 审批 / 会话信息]
  S -->|发消息| C[Conversation claim]
  C --> R
```

- **Conversation**：`chatId + threadId`，`threadId=''` 是群主会话；
- **Binding**：一个 Conversation 只绑定一个 Session；
- **BotGrant**：bot 是 Conversation 内的懒授权身份，实际用到才授予；
- **Session**：可以绑定多个 Conversation；群聊和私聊共用 Session 机制；读消息、发消息、回复都能触发认领。

## 快速开始

### 1. 环境

- DeepSeek Harness（桌面端或 Web 均可）
- `lark-cli`，并已用你的飞书应用完成 **bot 身份**登录
- 需要校验 owner 在群时，再登录 **user 身份**；`im:chat.members:read` 相关权限按飞书后台提示申请
- Node.js 20+、pnpm 12（仓库已用 mise 固定版本）

```bash
git clone https://github.com/habohai/habo-assistant.git
cd habo-assistant
mise install      # 可选；没有 mise 就确保 node/pnpm 版本满足
pnpm install
pnpm build
```

### 2. 安装到 DSH profile

```bash
# desktop 是桌面端 profile；Web 端按实际 profile 名替换
dsh plugin --profile desktop add "$PWD"
```

重启 DSH，在 **设置 → 插件** 中启用 **Habo-Assistant**。

### 3. 配置飞书应用

在飞书开发者后台创建企业自建应用，并：

1. 开启机器人能力；
2. 订阅 **接收消息 `im.message.receive_v1`**，使用长连接模式；
3. 申请发送消息、读取群信息 / 群成员、读取消息历史等权限（以飞书后台的权限提示为准）；
4. 把机器人拉进目标群；
5. 用 `lark-cli` 登录该应用的 bot；如需 owner 校验，再登录 user。

> 群聊需要 @ 机器人；私聊直接发消息即可。

### 4. 配置插件

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: habo-assistant
  name: 'Habo-Assistant'
  config:
    # lark-cli profile；一个 profile 对应一个飞书 bot app
    larkProfile: cli_xxxxxxxx

    # agent 工作目录
    cwd: /Users/me/work/repo
    # 可选：已有 DSH workspace id
    # workspaceId: 00000000-0000-0000-0000-000000000000

    # 允许的群；'*' 表示不限制。正式使用建议先显式列出群
    allowChats:
      - oc_xxxxxxxxxxxxxxxx

    # 主 bot 的 open_id；用于识别 @
    botOpenId: ou_xxxxxxxxxxxxxxxx

    # 稳定用户身份，用于发消息认领时校验 owner 是否在群；跨 bot app 请用 union_id
    ownerUnionId: on_xxxxxxxxxxxxxxxx

    # chat：群主会话；topic：话题独立 Session
    routing: topic

    # 新话题是否继承群主会话摘要：summary | none
    topicContext: summary

    # 命令审批人 open_id；留空表示不启用群内审批
    approveUsers:
      - ou_xxxxxxxxxxxxxxxx

    # DSH 权限预设：read-only / workspace-write / danger-full-access / auto
    permissionPreset: workspace-write

    # 新群首次由审批人 @ 时自动启用
    autoEnableApproverChats: true

    # 可选：回复风格
    # replyGuidelines: '使用中文回答。保持简洁、有条理。'
  disabled: false
```

保存后重启 DSH，或在插件设置里更新配置。

### 5. 开始使用

1. 在群里 @ 机器人问第一个问题；
2. 打开右侧栏「任务」，可以看到 Session；
3. 在「会话信息」里查看当前 Session 绑定的群 / 话题和产物；
4. 在群里继续回复，后续消息会进入同一个 Session。

## 多机器人

一个群里可以同时存在多个 bot。每个 bot 用独立 profile，但共享 Conversation 绑定：

```yaml
bots:
  - id: ou_xxx
    name: 飞书机器人 A
    profile: cli_xxx
    openId: ou_xxx
  - id: ou_yyy
    name: 飞书机器人 B
    profile: cli_yyy
    openId: ou_yyy
```

规则：

- 每个 bot 独立 consumer、LarkCli、队列和审批上下文；
- Conversation 唯一键是 `(chatId, threadId)`，bot 只是会话内 grant；
- 实际用到的 bot 才授权，其他 bot 不自动获得；
- 多 bot 必须使用不同 `profile`。

## 关键配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `larkProfile` | 无 | 单 bot 时的 lark-cli profile |
| `bots` | 无 | 多 bot 配置；不写就是单 bot |
| `allowChats` | `[]` | 允许的群；`'*'` 为全部 |
| `routing` | `chat` | `chat` 群主会话 / `topic` 话题独立 Session |
| `topicContext` | `summary` | 新话题继承群摘要；`none` 从空上下文开始 |
| `ownerUnionId` | 无 | 发消息认领时的 owner 稳定身份 |
| `approveUsers` | `[]` | 群内审批人 open_id |
| `permissionPreset` | 无 | DSH 权限预设 |
| `replyGuidelines` | 中文简洁 | 回复风格 |
| `p2pSessionTtlMs` | 30 天 | 私聊 Session 有效期 |
| `chatListTtlMs` | 5 分钟 | 群名 / 群列表缓存 |
| `ackReaction` | `auto` | `auto` 按消息稳定轮换确认表情；`none` 关闭；也可写死 emoji |
| `docsEnabled` | `true` | 长文 / 表格是否转飞书文档 |
| `docThresholdChars` | 4000 | 超过该字数转文档 |
| `docThresholdLines` | 60 | 超过该行数转文档 |
| `taskSubagentEnabled` | `false` | 是否把长任务委派给 subagent |
| `taskSubagentContextThreshold` | 120000 | 上下文 token 超过该值才委派 |
| `taskSubagentTurnThreshold` | 80 | 轮次超过该值才委派 |
| `taskSubagentTtlMs` | 30 分钟 | 任务摘要可复用的时长 |
| `approvalCards` | `true` | 审批是否使用互动卡片 |
| `stateDir` | `~/.dsh/feishu-bot` | 绑定与去重状态目录 |

## 回复格式

回复统一经过一层格式决策，业务代码只产出 Markdown：

| 内容 | 发送方式 |
| --- | --- |
| 纯文本 | `text` |
| 含加粗 / 列表 / 代码 / 链接 | `post` 富文本 |
| Markdown 表格 | 飞书文档 + 摘要链接 |
| 超过 `docThresholdChars` / `docThresholdLines` | 飞书文档 + 摘要链接 |
| 文档创建失败 | 回落 `post`，再回落 `text` |

- 表格识别要求表头 + 分隔行，日志里的 `a|b` 不会误判；
- 文档先用 bot 身份创建，缺 `docx:document:create` 权限时自动改用 user 身份；
- 两种身份都缺权限时记住该状态，后续不再重试，直接回落消息；
- 文档标题为「群名 · yyyy-mm-dd hh:mm」。

## 长任务委派

`taskSubagentEnabled: true` 时，若主 Session 的上下文 token 或轮次超过阈值，这一轮任务交给 task subagent 执行：

- 群 / 话题仍然只绑定主 Session；
- subagent 只拿到本轮问题，不复制主 Session 历史；
- 结果回到原群 / 话题，主 Session 不再被长任务撑大；
- 委派失败时自动回落到主 Session 执行；
- 需要 DSH 提供 `subagents` 服务，缺失时该功能自动关闭。

## 审批

- 默认发送互动卡片：`同意` / `拒绝` 两个按钮，点击即结算审批；
- 卡片按钮回调通过第二条 `lark-cli event consume card.action.trigger` 长连接接收；
- 只有 `approveUsers` 中的用户点击才生效，其他人点击被忽略并记日志；
- 文字回复「@我 同意」仍然可用，两条路径共享同一份审批状态；
- 点击后原卡片会更新为结果状态，按钮消失；
- 卡片发送失败会自动回落为文字审批提示；
- 设 `approvalCards: false` 可完全回到文字审批。

## 任务委派生命周期

- 每轮委派都记录 `taskId / childId / status / summary`；
- 同一会话在 `taskSubagentTtlMs` 内的下一次委派会带上上一轮摘要，保证追问不断线；
- `停止` 会取消正在运行的子任务，并标记为 `cancelled`，不影响群/话题绑定；
- 委派失败或子代理无输出时自动回落主 Session 执行。

## 安全模型

- **Conversation 单 owner**：一个群/话题同时只属于一个 Session；
- **发送前 gate**：`lark-cli` 的群发/话题回复会先校验 bot 在群、owner 在群，再认领；未授权直接 deny；
- **读消息也认领**：读取群/话题历史消息会按同一规则绑定，先解绑旧 Session；
- **手动绑定也会被认领覆盖**：从另一个 Session 往该群发消息，会按最新操作重新绑定；
- **bot 懒授权**：只授予实际使用的 bot，不授予其他用户的 bot；
- **审批**：只有 `approveUsers` 中的用户可以批准/拒绝；
- **群准入**：`allowChats` + `autoEnableApproverChats` 控制哪些群可以启用。

> `ownerUnionId` 的群成员校验依赖飞书权限；接口无权限时会降级为「bot 在群」并记录 warning。生产环境建议补齐成员读取权限。

## 实时刷新

绑定状态和连接状态都由 Host 通过 SSE 推送到浏览器：

```text
GET /feishu-bot/events
```

- `BindingRegistry` 发生 bind / unbind / grant 时推送 `bindings` 事件；
- consumer ready / 重连也会推送状态变化；
- 会话信息页和任务页收到事件后立即刷新；
- 不依赖 3 秒轮询。

## API（可选）

`/feishu-bot/api` 供右侧栏和自动化使用：

```text
GET  ?action=status&refresh=1
GET  ?action=chats&refresh=1
GET  ?action=group&chatId=oc_...
GET  ?action=topics&chatId=oc_...
POST {"action":"bind","chatId":"oc_...","sessionId":"...","threadId":"omt_..."}
POST {"action":"unbind","chatId":"oc_...","threadId":"omt_..."}
```

- `threadId` 省略表示整个群；传 `omt_...` 只操作该话题；
- 绑定弹窗的话题来自该群最近 50 条消息；飞书话题没有独立标题字段，标题由消息内容推导；
- 没有可读话题时，仍可绑定群主会话。

## 状态文件

默认目录：`~/.dsh/feishu-bot/`

| 文件 | 用途 |
| --- | --- |
| `binding-state.v2.jsonl` | append-only 绑定 journal：active / history / candidate / unbind |
| `chats.json` | 运行时群准入和 p2p/group 分类 |
| `seen.jsonl` | 消息去重日志，超限自动压缩 |

首次加载会自动迁移旧版 `bindings.json`、`binding-history.json`、`chat-affinity.json`、`suppressed-chats.json`。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

- Node / pnpm / Python / uv 版本见 `.mise.toml`；
- CI 使用 `pnpm install --frozen-lockfile` + typecheck + test；
- 测试覆盖绑定 registry、事件解析、话题路由、outbound claim、审批 gate 等。

## 常见问题

**群里 @ 了但没反应？**

- 机器人是否在群里；
- 群是否在 `allowChats`，或是否由审批人首次 @ 自动启用；
- 飞书应用是否订阅了 `im.message.receive_v1` 长连接；
- `larkProfile` 是否对应正确的 bot app。

**发消息被拒绝？**

- `ownerUnionId` 是否在群里；
- 群成员读取权限是否已申请；
- 当前 bot 是否在群；
- 查看 DSH 日志中的 `outbound claim rejected` / `cannot verify owner membership`。

**绑定弹窗里没有话题？**

- 飞书话题没有标题字段，标题由最近消息内容推导；
- 话题列表扫描该群最近 50 条消息，较早的话题可能不在列表；
- 群确实没有话题时，只能绑定群主会话；
- 话题读取会先试 bot，失败再试 user 身份。

**话题没有独立 Session？**

- 确认 `routing: topic`；
- 确认消息事件里带 `thread_id`；
- `root_id` 是消息回复线程，不会单独建 Conversation。

**任务页看不到某个 Session？**

- 只显示当前有 active binding 的 Conversation；
- 解绑或 orphan 的 Session 不会出现在任务页。

## 迁移说明

本仓库合并了旧的 `dsh-feishu-bot` 与 `dsh-session-artifacts` 两块能力；旧仓库保留作为历史，新的开发与发布以本仓库为准。

## License

[MIT](LICENSE)
