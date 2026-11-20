# Habo-Assistant

一个 DSH bundle，合并了原来的 **飞书群机器人** 与 **会话产物/会话信息** 两块能力：

- **右侧「任务」页**：飞书群里正在处理、待审批、最近完成的会话；连接状态灯；点击跳到对应 session；
- **右侧「会话信息」页**：当前 Session 绑定的飞书群（绑定/解绑/群历史）、本 Session 产出的文件与飞书云文档；
- **Host**：飞书长连接、群→Session 路由、显式/自动绑定、绑定 API、任务 projection、会话产物 projection。

## 路由规则

- 显式绑定（session 信息页 / `feishu_bind_chat` / 绑定 API）优先，存在时绝不自动新建；
- 同一个群多个显式绑定：latest `boundAt` wins，旧绑定保留在历史但不再接收消息；
- 自动绑定可以被“最近处理过该群的 Session”替换；
- 小 Session 直接复用；大会话会新建 Session 并注入最近几轮的上下文摘要；
- 解绑会删除绑定、取消该群 pending turn/审批，并抑制自动回绑；下一条消息新建，重新绑定清除抑制；
- 一个 Session 可以绑定多个群，审批按触发群路由。

## 两个右侧页

- **任务**：全局飞书任务列表，显示 Session 名、最后问题、状态（思考中/待审批/思考完成）、连接状态；
- **会话信息**：当前 Session 的飞书群绑定/解绑、群绑定历史，以及本 Session 的产物树。

## 安装 / 配置

本地 build 后把目录作为 bundle 安装：

```bash
npm install
npm run build
```

profile 配置示例（沿用原 `dsh-feishu-bot` 的配置）：

```yaml
- id: habo-assistant
  name: 'habo-assistant'
  config:
    cwd: /Users/me/work/repo
    workspaceId: 00000000-0000-0000-0000-000000000000
    allowChats:
      - oc_xxxxxxxxxxxxxxxx
    botOpenId: ou_xxxxxxxxxxxxxxxx
    permissionPreset: workspace-write
    approveUsers:
      - ou_xxxxxxxxxxxxxxxx
    autoEnableApproverChats: true
```

`stateDir` 默认仍是 `~/.dsh/feishu-bot`，绑定、去重日志、亲和性、抑制标记都沿用，不需要迁移。

## API

`/feishu-bot/api` 路径保持不变（会话信息页在用）：

- `GET ?action=status&refresh=1`
- `GET ?action=chats&refresh=1`
- `GET ?action=group&chatId=oc_...`
- `POST {"action":"bind","chatId":"oc_...","sessionId":"..."}`
- `POST {"action":"unbind","chatId":"oc_..."}`

## 开发

```bash
npm run typecheck
npm run build
npm test
```

原 `dsh-feishu-bot` 与 `dsh-session-artifacts` 仓库保留；本包是合并后的新实现。
