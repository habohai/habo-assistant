# Habo-Assistant

一个 DSH bundle，合并了原来的 **飞书群机器人** 与 **会话产物/会话信息** 两块能力：

- **右侧「任务」页**：飞书群里正在处理、待审批、最近完成的会话；连接状态灯；点击跳到对应 session；
- **私聊**：owner 直接私聊机器人即可自动启用（不需要 @），与群共用绑定/会话/审批；
- **右侧「会话信息」页**：当前 Session 绑定的飞书群（绑定/解绑/群历史）、本 Session 产出的文件与飞书云文档；
- **Host**：飞书长连接、群→Session 路由、显式/自动绑定、绑定 API、任务 projection、会话产物 projection。

## 路由规则

- 一个 Conversation（群或话题）同一时间只属于一个 Session；
- 一个 Session 可以绑定多个群/话题；
- 从已绑定 Session 向群/话题发消息，会立即认领该 Conversation，替换原 Session；
- Bot 是 Conversation 内的懒授权身份，只有实际用到的 bot 才授予该 Session；
- 小 Session 直接复用；大会话会新建 Session 并注入最近几轮的上下文摘要；
- 解绑会删除绑定、取消该群 pending turn/审批，并抑制自动回绑；下一条消息新建，重新绑定清除抑制；
- 一个 Session 可以绑定多个群，审批按触发群路由。

## 两个右侧页

- **任务**：全局飞书任务列表，显示 Session 名、最后问题、状态（思考中/待审批/思考完成）、连接状态；
- **会话信息**：当前 Session 的飞书群绑定/解绑、群绑定历史，以及本 Session 的产物树。

## 工具链

仓库根目录的 `.mise.toml` 固定了 node / pnpm / python / uv；`package.json` 的 `packageManager` 也固定为 `pnpm@12.6.0`。

```bash
mise install
pnpm install
```

## 安装 / 配置

本地 build 后把目录作为 bundle 安装：

```bash
pnpm install
pnpm run build
```

profile 配置示例（沿用原 `dsh-feishu-bot` 的配置）：

```yaml
- id: habo-assistant
  name: 'habo-assistant'
  config:
    larkProfile: cli_xxxxxxxx  # 可选：lark-cli profile，一个 profile = 一个 bot app
    cwd: /Users/me/work/repo
    workspaceId: 00000000-0000-0000-0000-000000000000
    allowChats:
      - oc_xxxxxxxxxxxxxxxx
    botOpenId: ou_xxxxxxxxxxxxxxxx
    # 稳定用户标识；用于校验 owner 是否在群/话题中
    ownerUnionId: on_xxxxxxxxxxxxxxxx
    # chat：群主会话；topic：话题独立 session
    routing: topic
    permissionPreset: workspace-write
    approveUsers:
      - ou_xxxxxxxxxxxxxxxx
    autoEnableApproverChats: true
```

群名/私聊 peer 名和 bot 列表都来自缓存或 p2p 消息解析，不在源码里写死任何 open_id/chat_id。

`routing: topic` 时，带 `thread_id` 的消息按话题建独立 session，回复自动在话题内；`root_id` 回复线程仍回退到群主会话。

从 session 用 `+messages-reply --reply-in-thread` 往话题发消息，也会按 `(chatId, threadId)` 认领话题；话题内的审批提示和审批结果也会回复在原话题里。

`ownerUnionId` 用于发消息认领时校验 owner 是否在群内；群成员接口无权限时会降级为“bot 在群”的校验并记录 warning。

群名缓存默认 5 分钟，可用 `chatListTtlMs` 调整。

回复默认要求中文、简洁、有条理；可用 `replyGuidelines` 覆盖，设为空字符串可关闭。

私聊 session 默认 **30 天**过期，过期后下一条私聊自动新建会话；可用 `p2pSessionTtlMs` 调整，群聊不受影响。

`stateDir` 默认仍是 `~/.dsh/feishu-bot`。绑定状态现在统一为 append-only 的 `binding-state.v2.jsonl`：

- 首次加载会把旧的 `bindings.json` / `binding-history.json` / `chat-affinity.json` / `suppressed-chats.json` 自动迁移；
- 旧文件保留但不删除，作为回滚/审计依据；
- 绑定、历史、出站亲和、解绑抑制都从同一份 journal 推导，不再各写一个文件；
- 每条记录带 `botId`，它是这次认领/授权使用的 bot；active 唯一键是 `(chatId, threadId)`；grants 按 Conversation 懒授予 bot。

去重日志 `seen.jsonl` 到上限后自动压缩；运行时群准入统一在 `chats.json`（旧的 `dynamic-chats.json` 首次加载时自动迁移）。

## 多 bot

`bots` 数组可选；不写就是一个主 bot。每个 bot 用独立 lark-cli profile，共享绑定/准入状态：

```yaml
bots:
  - id: bot-a
    name: 飞书机器人 A
    profile: cli_xxx
    openId: ou_xxx
  - id: bot-b
    name: 飞书机器人 B
    profile: cli_yyy
    openId: ou_yyy
```

- 每个 bot 独立 consumer、LarkCli、队列、审批上下文；
- Conversation 按 `(chatId, threadId)` 唯一绑定，bot 作为会话内 lazy grant；
- 会话信息页有 bot 选择器，API 支持 `botId`，`feishu_bind_chat` 支持 `bot` 参数；
- 多 bot 时每个 bot 必须有不同 `profile`，否则启动前校验失败；
- 当前默认仍是单 bot，未配置 `bots` 不改变行为。

## API

`/feishu-bot/api` 路径保持不变（会话信息页在用）：

- `GET ?action=status&refresh=1`
- `GET ?action=chats&refresh=1`
- `GET ?action=group&chatId=oc_...`
- `POST {"action":"bind","chatId":"oc_...","sessionId":"..."}`
- `POST {"action":"unbind","chatId":"oc_..."}`

## 开发

```bash
pnpm run typecheck
pnpm run build
pnpm test
```

原 `dsh-feishu-bot` 与 `dsh-session-artifacts` 仓库保留；本包是合并后的新实现。
