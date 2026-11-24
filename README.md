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
| 多机器人 | 每个 bot 独立 lark-cli profile / consumer / 审批人；共享绑定，bot 按需授权 |
| 读消息认领 | 从 Session 读取群/话题消息后，该 Conversation 自动绑定到当前 Session |
| 发消息认领 | 从 Session 发往群/话题后，该 Conversation 自动绑定到当前 Session |
| 发送前校验 | `lark-cli` 群发/话题回复先校验 owner 和 bot，再认领；未授权直接拒绝 |
| 话题选择 | 绑定弹窗选中群后，可直接选群主会话或该群的已有话题 |
| 回复格式 | 自动在纯文本 / 富文本 post 之间选择，Markdown 不再裸露 |
| 确认反馈 | `ackReaction: auto` 在 OnIt / Eyes / Typing 之间按消息稳定轮换 |
| 长任务委派 | 上下文过长时把任务交给 task subagent，主 Session 不再继续膨胀 |
| 审批 | 群里 @ 机器人回复「同意 / 拒绝」，不需要任何应用额外配置 |
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
| `ackReaction` | `auto` | `auto` 在 `OnIt` / `GLANCE` / `Typing` 间轮换；`none` 关闭；也可写死 emoji |
| `requestApproval` | `non-owner` | 谁的请求需要你批准：`non-owner` / `all` / `off` |
| `requestTrustMs` | 30 分钟 | 一次同意后该人在该群的免审时长；`0` 关闭 |
| `delegateGuidance` | 内置一句 | 指导模型何时用 `subagent` 委派；空 = 不提示 |
| `mentionPolicy` | `all` | 一条消息 @ 多个机器人时：`all` 都答，`first` 只让第一个答 |
| `approvalMode` | `request` | 审批发生在 `request`（消息）/ `action`（动作）/ `off` |
| `actionApprovalTools` | `[]` | 动作模式下算"动手"的工具；空 = 内置清单 |
| `alwaysAskDangerous` | `true` | 危险命令即使有信任窗口也再问一次 |
| `approvalQueueWaitMs` | 30000 | 同群第二条审批最多排队多久 |
| `approvalCards` | `false` | 是否用互动卡片审批（需要应用配置卡片回调） |
| `approvalChannel` | `feishu` | 审批渠道：`feishu`（发群里）或 `dsh`（交给桌面端） |
| `stateDir` | `~/.dsh/feishu-bot` | 绑定与去重状态目录 |

## 回复格式

回复统一经过一层格式决策，业务代码只产出 Markdown：

| 内容 | 发送方式 |
| --- | --- |
| 纯文本 | `text` |
| 含加粗 / 列表 / 代码 / 链接 | `post` 富文本 |
| Markdown 表格 | `post` 富文本 |
| post 被飞书拒绝 | 自动降级重发纯文本，回答不会丢 |
| 超长内容 | 按 `maxReplyChars` 分段 `post` |

- **不会创建飞书文档**：文档需要明确的位置、权限和归属，格式化不产生文档；
- 表格识别要求表头 + 分隔行，日志里的 `a|b` 不会误判；

## 长任务委派

委派走 **DSH 内置的 `subagent` 工具**，由模型自己决定，桥接层只给建议：

```text
[飞书群:… | 回复要求:… | 委派指引:需要多步工具调用、长时间检索或大范围分析时，
 用 subagent 工具委派；它看不到本群上下文，prompt 要写全任务 | 提问人:海振国(ou_…)]
```

为什么不用自己实现：

| | 自己实现 | DSH 内置 |
| --- | --- | --- |
| 记录 | 主会话看不到委派内容 | 是普通工具调用，历史和任务页都有 |
| 复用 | 只能传摘要 | `send_message` 续聊同一个子代理 |
| 中断 | 自己 dispose + abort | `interrupt_agent` |
| 枚举 | 自己维护表 | `list_agents` |
| 升级 | 依赖内部接口 | 天然兼容 |

配套能力（DSH 已提供，无需配置）：

- `subagent`：派活，结果回到当前会话；
- `send_message` / `interrupt_agent` / `list_agents` / `wait_agent`：续聊、中断、列举；
- `spawn` / `fork` 两种后端：`spawn` 是干净的新上下文，`fork` 继承对话历史。

提示词可通过 `delegateGuidance` 改：

```yaml
delegateGuidance: ''   # 空 = 不提示；默认给一句「多步工具/长检索/大范围分析时用 subagent」
```

注意：委派是**模型判断**，不是阈值触发。想更保守就把条件写进 `delegateGuidance`。

## 确认表情

- 收到消息后立刻在提问上加一个 reaction，不占用消息；
- `auto` 在 `OnIt` / `GLANCE` / `Typing` 之间按消息稳定轮换，同一条消息重投不换；
- 只使用飞书认可的 `emoji_type`；配置了未知类型会自动回退 `OnIt`；
- 连续失败 3 次才关闭 reaction，避免一条错配置让反馈彻底消失。

## 提示词头

模型看到的每条消息都带一行上下文：

```text
[飞书群:赵老师答疑 | 机器人:… | 群内已绑定机器人:… | 提问人:海振国(ou_…)]
你好
```

- `提问人` 优先显示真实姓名（取自消息接口的 `sender_name`，不需要通讯录权限），查不到时退回 open_id；
- 姓名按人缓存，不会每条消息都查一次。

## 审批：谁能驱动机器人

规则：**别人 @ 机器人要你点头；你 @ 机器人直接执行。** 一次点头管一段工作，不是只管一句话。

| 谁发起 | 结果 |
| --- | --- |
| 你（`approveUsers`） | 直接执行，受 DSH 会话权限预设约束 |
| 群里的其他人，首次 | 机器人 @ 你请求确认 |
| 你回「同意」 | 该请求执行，并给「这个人 + 这个群」30 分钟通行证 |
| 通行证有效期内，他再 @ | 直接执行，不再打扰你 |
| 通行证过期 | 重新需要你批准 |
| 你回「拒绝」 | 请求作废，且不发放通行证 |
| 超时未回应 | 请求作废 |

要点：

- **审批单位是“人 + 群 + 一段时间”，不是“每条消息”**，所以正常协作不会被反复打断；
- 通行证按 `(chatId, senderId)` 隔离：换人、换群都要重新批准；
- 机器人 @ 你时是真实 `@` 提及，会触发飞书通知；
- 只有 `approveUsers` 里的人能批准；
- **你的同意是授权，DSH 权限预设是边界**：同意之后能做什么仍由 `permission-set` 决定；
- 超时与「审批请求没发出」是两种不同结果，提示文案分开，不会一次超时发两条消息；
- 没有挂起审批时回「同意」，直接回「当前没有待审批的命令」，不消耗模型回合；
- **一次审批只产生一条机器人消息**：请求级审批通过后直接给答案，不再补「已批准」；工具级审批因为后面没有答案，才会回一句确认；
- 「停止」会取消排队任务、正在执行的任务以及挂起的审批；
- 插件重载时若有挂起的审批，会先发一句「插件正在重启，挂起的审批已作废」，不再静默消失。

配置：

```yaml
approveUsers:
  - ou_xxxxxxxx            # 你本人；留空则该能力关闭
requestApproval: non-owner # non-owner（默认）| all（你 @ 也要批准）| off
requestTrustMs: 1800000    # 一次同意的有效期；0 = 每次都要批
approvalChannel: feishu    # feishu（群里问）| dsh（交给桌面端）
approvalTimeoutMs: 120000  # 单次审批超时
```

### 动作审批（可选）

`approvalMode: action` 把审批点从"消息"下移到"动作"：

```text
别人 @ → 直接回答（读文件、搜索、查资料都不打扰你）
       → 要执行 bash / 改文件时 → 群里 @ 你
```

```yaml
approvalMode: action        # request（默认）| action | off
actionApprovalTools: []     # 空 = 内置清单
alwaysAskDangerous: true    # 危险命令即使有信任也再问
```

内置"动手"清单：`bash`、`pwsh`、`write`、`edit`、`apply_patch`、`str_replace_editor`、`terminal_*`、`job_kill`、`schedule_create`、`subagent`、`workflow`。

**`request` 与 `action` 互斥**，代码层面已经保证：设成 `action` 后，消息入口那道审批自动失效，不会同一次操作问你两遍。

同一个群里同时只显示一条审批；后来的会排队等（`approvalQueueWaitMs`，默认 30 秒），等不到就明确告知放弃，不会静默失败。

### 关于互动卡片按钮

`approvalCards` 默认关闭：卡片按钮的回调需要在该飞书应用的开发者后台配置卡片回调，属于组织级改动，通常要走公司审批。文字审批只依赖机器人已经在消费的消息事件，**不需要任何额外配置**。若所在组织已配置好，可设 `approvalCards: true`。

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

| 端点 | 用途 |
| --- | --- |
| `GET /feishu-bot/api?action=health` | 就绪、消费者、审批数、能力（`memberListing`） |
| `GET /feishu-bot/api?action=stats` | 计数器：`requestGated`、`actionGated`、`approvalAllowed`、`trustGranted` 等 |
| `GET /feishu-bot/api?action=senders` | 每个 bot 视角下最近 @ 过它的人（用于填 `approveUsers`） |
| `GET /feishu-bot/api?action=bindings` | 绑定列表 |
| `GET /feishu-bot/events` | SSE 实时推送绑定变化 |


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
