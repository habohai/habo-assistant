import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeishuBot, normalizeConfig, idempotencyKey, BotHost } from '../lib/index.js'

/** Minimal DSH surface: only what the bridge touches. */
function createHarness({ failEdit = false, echoReplyId = false } = {}) {
  const spawned = []
  const prompts = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    subprocess: {
      async resolveExecutable() {
        return '/fake/lark-cli'
      },
      spawn(request) {
        spawned.push(request)
        const isReply = request.argv.includes('+messages-reply')
        const isEdit = request.argv.includes('+messages-edit')
        const exitCode = isEdit && failEdit ? 1 : 0
        return {
          done: Promise.resolve({ exitCode, signal: null }),
          collected: {
            stdout: {
              readFrom: () => ({
                text: isReply && exitCode === 0
                  ? JSON.stringify({ ok: true, data: { message_id: echoReplyId ? 'om_1' : `om_sent_${spawned.length}` } })
                  : '',
              }),
            },
            stderr: { readFrom: () => ({ text: exitCode === 0 ? '' : '{"ok":false}' }) },
          },
          terminate() {},
        }
      },
    },
    sessionController: {
      async create() {
        return { sessionId: 'ses_1' }
      },
      async rename() {
        return {}
      },
      async prompt(request) {
        prompts.push(request)
      },
      cancel() {},
    },
    get() {
      return undefined
    },
    on() {},
    effect() {},
  }
  return { ctx, spawned, prompts }
}

async function createBot(options = {}, config = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'feishu-bot-test-'))
  const harness = createHarness(options)
  const bot = new FeishuBot(harness.ctx, normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'], stateDir, ...config }))
  // The capability probe normally fills this in `start()`, which the harness skips.
  bot.canEdit = options.canEdit ?? true
  await bot.registry.ready
  await bot.seen.load()
  return { bot, stateDir, ...harness }
}

const eventLine = JSON.stringify({
  chat_id: 'oc_1',
  chat_type: 'group',
  message_id: 'om_1',
  sender_type: 'user',
  sender_id: 'ou_1',
  message_type: 'text',
  content: '@_user_1 帮我看下构建为什么失败',
  mentions: [{ id: 'ou_bot' }],
})

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

function finishTurn(bot, text) {
  bot.onSessionEvent({ id: 'ses_1' }, { type: 'turn/start', data: { turn: 1 } })
  bot.onSessionEvent({ id: 'ses_1' }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } })
  bot.onSessionEvent({ id: 'ses_1' }, { type: 'turn/end', data: { turn: 1 } })
}

function findCalls(spawned, token) {
  return spawned.filter(request => request.argv.includes(token))
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

test('an accepted message gets an immediate placeholder that becomes the answer', async () => {
  const { bot, stateDir, spawned, prompts } = await createBot()
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '构建失败是因为依赖下载超时。')
    await bot.queue.idle()

    const replies = findCalls(spawned, '+messages-reply')
    const acks = replies.filter(request => flagValue(request.argv, '--idempotency-key') === idempotencyKey('feishu-reply', 'om_1', 'ack'))
    assert.equal(acks.length, 1)
    assert.match(flagValue(acks[0].argv, '--text'), /收到/)

    const edits = findCalls(spawned, '+messages-edit')
    assert.equal(edits.length, 1)
    assert.equal(flagValue(edits[0].argv, '--text'), '构建失败是因为依赖下载超时。')
    // The answer replaced the placeholder instead of adding another message.
    assert.equal(replies.length, 1)

    assert.equal(prompts[0].content[0].text, '[飞书群:oc_1 | 机器人:飞书机器人 | 机器人ID:飞书机器人 | 群内已绑定机器人:飞书机器人 | 回复要求:使用中文回答。保持简洁、有条理：先给结论，再列必要要点；不要冗长客套，不要重复问题；不要把工具回执（message_id、时间戳、原始命令行输出）写进回答。 | 委派指引:需要多步工具调用、长时间检索或大范围分析时，用 subagent 工具委派；它看不到本群上下文，prompt 要写全任务 | 提问人:ou_1]\n帮我看下构建为什么失败')
    assert.equal(bot.metrics.snapshot().counts.jobsSucceeded, 1)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a long answer keeps the placeholder for the first chunk and replies with the rest', async () => {
  const { bot, stateDir, spawned, prompts } = await createBot({}, { maxReplyChars: 200 })
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, 'x'.repeat(450))
    await bot.queue.idle()

    const edits = findCalls(spawned, '+messages-edit')
    assert.equal(edits.length, 1)
    assert.equal(flagValue(edits[0].argv, '--text').length, 200)

    const replies = findCalls(spawned, '+messages-reply')
      .filter(request => flagValue(request.argv, '--idempotency-key') !== idempotencyKey('feishu-reply', 'om_1', 'ack'))
    assert.deepEqual(
      replies.map(request => flagValue(request.argv, '--idempotency-key')),
      [idempotencyKey('feishu-reply', 'om_1', '1'), idempotencyKey('feishu-reply', 'om_1', '2')],
    )
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an edit failure withdraws the placeholder and falls back to a reply', async () => {
  const { bot, stateDir, spawned, prompts } = await createBot({ failEdit: true })
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '最终答案')
    await bot.queue.idle()

    // The placeholder is whichever message the placeholder reply returned; the
    // reaction call now shares the same fake source of ids.
    const placeholder = findCalls(spawned, '+messages-reply')
      .find(request => flagValue(request.argv, '--idempotency-key') === idempotencyKey('feishu-reply', 'om_1', 'ack'))
    assert.ok(placeholder, 'the placeholder reply must have been sent')
    const deletes = findCalls(spawned, 'delete')
    assert.equal(deletes.length, 1)
    assert.match(flagValue(deletes[0].argv, '--params'), /om_sent_\d+/)

    const replies = findCalls(spawned, '+messages-reply')
      .filter(request => flagValue(request.argv, '--idempotency-key') === idempotencyKey('feishu-reply', 'om_1', '0'))
    assert.equal(replies.length, 1)
    assert.equal(flagValue(replies[0].argv, '--text'), '最终答案')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a duplicate delivery never reaches the agent twice', async () => {
  const { bot, stateDir, prompts } = await createBot()
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, 'ok')
    await bot.queue.idle()
    bot.onEventLine(eventLine)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(prompts.length, 1)
    assert.equal(bot.metrics.snapshot().counts.deduped, 1)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('without message editing the bot reacts instead of sending a placeholder', async () => {
  const { bot, stateDir, spawned, prompts } = await createBot({ canEdit: false })
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '答案')
    await bot.queue.idle()

    await waitFor(() => findCalls(spawned, 'reactions').length === 1)
    assert.equal(findCalls(spawned, '+messages-edit').length, 0)
    assert.equal(findCalls(spawned, '+messages-reply').length, 1)
    assert.equal(bot.metrics.snapshot().counts.jobsSucceeded, 1)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a reply object that echoes the question is never edited or withdrawn', async () => {
  const { bot, stateDir, spawned, prompts } = await createBot({ echoReplyId: true })
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '答案')
    await bot.queue.idle()

    assert.equal(findCalls(spawned, '+messages-edit').length, 0)
    assert.equal(findCalls(spawned, 'delete').length, 0)
    const replies = findCalls(spawned, '+messages-reply')
    // Placeholder first (its id is not trusted), then the answer as a fresh reply.
    assert.equal(replies.length, 2)
    assert.equal(flagValue(replies[1].argv, '--text'), '答案')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('progress: false replies without a placeholder', async () => {
  const { bot, stateDir, spawned, prompts } = await createBot({}, { progress: false })
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '直接回答')
    await bot.queue.idle()

    assert.equal(findCalls(spawned, '+messages-edit').length, 0)
    const replies = findCalls(spawned, '+messages-reply')
    assert.equal(replies.length, 1)
    assert.equal(flagValue(replies[0].argv, '--text'), '直接回答')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('allowChat persists a runtime-enabled group and bindChat points it at a session', async () => {
  const { bot, stateDir } = await createBot()
  try {
    assert.equal(await bot.allowChat('oc_runtime'), true)
    assert.equal(bot.chats.isAllowed('oc_runtime'), true)
    const persisted = JSON.parse(await readFile(join(stateDir, 'chats.json'), 'utf8'))
    assert.equal(typeof persisted.oc_runtime.allowedAt, 'number')

    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Runtime group', botMember: true })
    await bot.bindChat('oc_runtime', 'ses_branch')
    assert.equal(bot.registry.get('oc_runtime')?.sessionId, 'ses_branch')
    assert.equal(bot.isBotSession('ses_branch'), true)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('bindChat refuses a group the bot is not in', async () => {
  const { bot, stateDir } = await createBot()
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'User-only group', botMember: false })
    await assert.rejects(bot.bindChat('oc_user_only', 'ses_branch'), /机器人不在该群/)
    assert.equal(bot.registry.get('oc_user_only'), undefined)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('ensureSession reuses the most recent session that handled the chat', async () => {
  const { bot, stateDir } = await createBot()
  try {
    bot.ctx.sessionController.list = async () => ({
      items: [
        { id: 'ses_old', updatedAt: 100, projectionValues: { feishuBotTask: { bot: true, chatId: 'oc_1', updatedAt: 100 } } },
        { id: 'ses_new', updatedAt: 200, projectionValues: { feishuBotTask: { bot: true, chatId: 'oc_1', updatedAt: 200 } } },
        { id: 'ses_other', updatedAt: 300, projectionValues: { feishuBotTask: { bot: true, chatId: 'oc_2', updatedAt: 300 } } },
      ],
    })
    const event = {
      chatId: 'oc_1', chatType: 'group', messageId: 'om_new', threadKey: '',
      senderType: 'user', senderId: 'ou_1', messageType: 'text', mentions: [{ id: 'ou_bot' }], content: 'hi',
    }
    const sessionId = await bot.ensureSession('oc_1', event, 'hi')
    assert.equal(sessionId, 'ses_new')
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_new')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('ensureSession creates only when the chat has no session history', async () => {
  const { bot, stateDir } = await createBot()
  try {
    bot.ctx.sessionController.list = async () => ({ items: [] })
    const event = {
      chatId: 'oc_1', chatType: 'group', messageId: 'om_new', threadKey: '',
      senderType: 'user', senderId: 'ou_1', messageType: 'text', mentions: [{ id: 'ou_bot' }], content: 'hi',
    }
    const sessionId = await bot.ensureSession('oc_1', event, 'hi')
    assert.equal(sessionId, 'ses_1')
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_1')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an explicit binding wins even when another session is more recent and large', async () => {
  const { bot, stateDir } = await createBot()
  try {
    await bot.registry.bind('oc_1', '', 'ses_explicit', 'manual', 1)
    bot.trackSession('ses_explicit', 'oc_1')
    bot.ctx.sessionController.list = async () => ({
      items: [{ id: 'ses_recent', updatedAt: 200, projectionValues: { feishuBotTask: { bot: true, chatId: 'oc_1', updatedAt: 200 } } }],
    })
    const event = {
      chatId: 'oc_1', chatType: 'group', messageId: 'om_new', threadKey: '',
      senderType: 'user', senderId: 'ou_1', messageType: 'text', mentions: [{ id: 'ou_bot' }], content: 'hi',
    }
    const sessionId = await bot.ensureSession('oc_1', event, 'hi')
    assert.equal(sessionId, 'ses_explicit')
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_explicit')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a later explicit bind replaces the previous owner for the chat', async () => {
  const { bot, stateDir } = await createBot()
  try {
    await bot.registry.bind('oc_1', '', 'ses_a', 'manual', 10)
    await bot.registry.bind('oc_1', '', 'ses_b', 'manual', 20)
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_b')
    assert.equal(bot.registry.get('oc_1')?.source, 'manual')
    assert.equal(bot.registry.get('oc_1')?.at, 20)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('unbind suppresses discovery and the next message starts a fresh session', async () => {
  const { bot, stateDir } = await createBot()
  try {
    await bot.registry.bind('oc_1', '', 'ses_old', 'manual')
    bot.trackSession('ses_old', 'oc_1')
    let listed = false
    bot.ctx.sessionController.list = async () => {
      listed = true
      return { items: [{ id: 'ses_old', updatedAt: 1, projectionValues: { feishuBotTask: { bot: true, chatId: 'oc_1', updatedAt: 1 } } }] }
    }
    assert.equal(await bot.unbindChat('oc_1'), true)
    assert.equal(bot.registry.get('oc_1'), undefined)
    const event = {
      chatId: 'oc_1', chatType: 'group', messageId: 'om_new', threadKey: '',
      senderType: 'user', senderId: 'ou_1', messageType: 'text', mentions: [{ id: 'ou_bot' }], content: 'hi',
    }
    const sessionId = await bot.ensureSession('oc_1', event, 'hi')
    assert.equal(sessionId, 'ses_1')
    assert.equal(listed, false)
    assert.equal(bot.registry.get('oc_1')?.source, 'auto')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an expired p2p binding starts a fresh Session', async () => {
  const { bot, stateDir } = await createBot()
  try {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000
    await bot.registry.bind('oc_1', '', 'ses_old', 'manual', old)
    const event = {
      chatId: 'oc_1', chatType: 'p2p', messageId: 'om_p2p', threadKey: '',
      senderType: 'user', senderId: 'ou_1', messageType: 'text', mentions: [], content: 'hi',
    }
    const sessionId = await bot.ensureSession('oc_1', event, 'hi')
    assert.equal(sessionId, 'ses_1')
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_1')
    assert.equal(bot.registry.get('oc_1')?.source, 'auto')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an outbound send claims the conversation and grants the sending bot', async () => {
  const { bot, stateDir } = await createBot()
  try {
    await bot.registry.bind('oc_1', '', 'ses_old', 'manual', Date.now())
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Test group', botMember: true })
    bot.observeOutboundChat('ses_sender', {
      type: 'tool/call',
      data: {
        name: 'bash',
        arguments: JSON.stringify({ command: 'lark-cli im +messages-send --as bot --chat-id oc_1 --text hi' }),
      },
    })
    await waitFor(() => bot.registry.get('oc_1')?.sessionId === 'ses_sender')
    assert.equal(bot.registry.get('oc_1')?.source, 'outbound')
    assert.equal(bot.registry.hasGrant('oc_1'), true)
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})



test('a topic creates its own session instead of reusing the group session', async () => {
  const { bot, stateDir } = await createBot({}, { routing: 'topic' })
  try {
    const event = {
      chatId: 'oc_1', chatType: 'group', messageId: 'om_topic', threadId: 'omt_topic', rootId: '',
      threadKey: 'omt_topic', senderType: 'user', senderId: 'ou_1', messageType: 'text',
      mentions: [{ id: 'ou_bot' }], content: 'topic question',
    }
    const sessionId = await bot.ensureSession('oc_1::omt_topic', event, 'topic question')
    assert.equal(sessionId, 'ses_1')
    assert.equal(bot.registry.get('oc_1::omt_topic')?.sessionId, 'ses_1')
    assert.equal(bot.registry.get('oc_1'), undefined)
    assert.equal(bot.inThread(event), true)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('outbound claim requires the owner in the group when ownerUnionId is set', async () => {
  const { bot, stateDir } = await createBot({}, { ownerUnionId: 'on_owner' })
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Test group', botMember: true })
    bot.cli.chatMemberUnionIds = async () => new Set(['on_other'])
    bot.observeOutboundChat('ses_sender', {
      type: 'tool/call',
      data: { name: 'bash', arguments: JSON.stringify({ command: 'lark-cli im +messages-send --as bot --chat-id oc_1 --text hi' }) },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(bot.registry.get('oc_1'), undefined)
    bot.cli.chatMemberUnionIds = async () => new Set(['on_owner'])
    bot.observeOutboundChat('ses_sender', {
      type: 'tool/call',
      data: { name: 'bash', arguments: JSON.stringify({ command: 'lark-cli im +messages-send --as bot --chat-id oc_1 --text hi' }) },
    })
    await waitFor(() => bot.registry.get('oc_1')?.sessionId === 'ses_sender')
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})


test('outbound reply-in-thread claims the topic, not the group main session', async () => {
  const { bot, stateDir } = await createBot({}, { routing: 'topic' })
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Test group', botMember: true })
    bot.cli.messageContext = async () => ({ chatId: 'oc_1', threadId: 'omt_topic' })
    bot.observeOutboundChat('ses_topic', {
      type: 'tool/call',
      data: {
        name: 'bash',
        arguments: JSON.stringify({ command: 'lark-cli im +messages-reply --message-id om_root --reply-in-thread --as bot --text hi' }),
      },
    })
    await waitFor(() => bot.registry.get('oc_1::omt_topic')?.sessionId === 'ses_topic')
    assert.equal(bot.registry.get('oc_1'), undefined)
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('approval prompt and note reply inside the triggering topic', async () => {
  // Text prompts keep the topic reply path; cards only apply when enabled.
  const { bot, stateDir } = await createBot({}, { routing: 'topic', approvalCards: false })
  try {
    const calls = []
    bot.cli.reply = async (messageId, text, options) => {
      calls.push({ messageId, text, inThread: options?.inThread })
      return 'om_sent'
    }
    bot.sessionContexts.set('ses_1', { chatId: 'oc_1', threadId: 'omt_topic', messageId: 'om_1' })
    const pending = bot.askFeishuApproval({ chatId: 'oc_1', sessionId: 'ses_1', request: { reason: 'test' } })
    await waitFor(() => calls.length === 1)
    assert.equal(calls[0].messageId, 'om_1')
    assert.equal(calls[0].inThread, true)
    bot.settleApproval('oc_1', 'cancelled', 'cancelled')
    const outcome = await pending
    assert.equal(outcome, 'cancelled')
    await waitFor(() => calls.length === 2)
    assert.equal(calls[1].inThread, true)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('manual binding can target one topic without touching the group main conversation', async () => {
  const { bot, stateDir } = await createBot({}, { routing: 'topic' })
  try {
    bot.cli.listChats = async () => [{ chatId: 'oc_1', name: 'Test group', botMember: true }]
    await bot.bindChat('oc_1', 'ses_topic', 'manual', 'omt_topic')
    assert.equal(bot.registry.get('oc_1::omt_topic')?.sessionId, 'ses_topic')
    assert.equal(bot.registry.get('oc_1'), undefined)
    assert.deepEqual(bot.registry.botIdsFor('oc_1::omt_topic'), [bot.config.botId])
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('pre-send gate claims a group and denies an owner outside it', async () => {
  const { bot, stateDir } = await createBot({}, { ownerUnionId: 'on_owner' })
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Test group', botMember: true })
    bot.cli.chatMemberUnionIds = async () => new Set(['on_other'])
    const denied = await bot.outboundGate({
      name: 'bash',
      arguments: JSON.stringify({ command: 'lark-cli im +messages-send --as bot --chat-id oc_1 --text hi' }),
      agent: { session: { id: 'ses_sender' } },
    })
    assert.equal(denied.kind, 'deny')
    assert.equal(bot.registry.get('oc_1'), undefined)
    bot.cli.chatMemberUnionIds = async () => new Set(['on_owner'])
    const allowed = await bot.outboundGate({
      name: 'bash',
      arguments: JSON.stringify({ command: 'lark-cli im +messages-send --as bot --chat-id oc_1 --text hi' }),
      agent: { session: { id: 'ses_sender' } },
    })
    assert.equal(allowed.kind, 'allow')
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_sender')
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('pre-execute continues the waterfall for non-lark tools', async () => {
  const { bot, stateDir } = await createBot()
  try {
    let continued = false
    const decision = await bot.preExecute({ name: 'read', arguments: '{}' }, async () => {
      continued = true
      return { kind: 'allow' }
    })
    assert.equal(continued, true)
    assert.equal(decision.kind, 'allow')
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a plain reply claims the group main conversation', async () => {
  const { bot, stateDir } = await createBot()
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Test group', botMember: true })
    bot.cli.messageContext = async () => ({ chatId: 'oc_1', threadId: 'omt_topic' })
    bot.observeOutboundChat('ses_reply', {
      type: 'tool/call',
      data: {
        name: 'bash',
        arguments: JSON.stringify({ command: 'lark-cli im +messages-reply --message-id om_root --as bot --text hi' }),
      },
    })
    await waitFor(() => bot.registry.get('oc_1')?.sessionId === 'ses_reply')
    assert.equal(bot.registry.get('oc_1::omt_topic'), undefined)
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('reading group messages claims the conversation', async () => {
  const { bot, stateDir } = await createBot()
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Test group', botMember: true })
    const decision = await bot.outboundGate({
      name: 'bash',
      arguments: JSON.stringify({ command: 'lark-cli im +chat-messages-list --chat-id oc_1 --as user' }),
      agent: { session: { id: 'ses_reader' } },
    })
    assert.equal(decision.kind, 'allow')
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_reader')
    assert.equal(bot.registry.get('oc_1')?.source, 'read')
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('reading a thread claims its topic conversation', async () => {
  const { bot, stateDir } = await createBot({}, { routing: 'topic' })
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Test group', botMember: true })
    bot.cli.threadContext = async () => ({ chatId: 'oc_1', threadId: 'omt_topic' })
    const decision = await bot.outboundGate({
      name: 'bash',
      arguments: JSON.stringify({ command: 'lark-cli im +threads-messages-list --thread omt_topic --as user' }),
      agent: { session: { id: 'ses_topic_reader' } },
    })
    assert.equal(decision.kind, 'allow')
    assert.equal(bot.registry.get('oc_1::omt_topic')?.sessionId, 'ses_topic_reader')
    assert.equal(bot.registry.get('oc_1::omt_topic')?.source, 'read')
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('an accepted acknowledgement reacts on the question', async () => {
  const { bot, stateDir, spawned } = await createBot()
  try {
    // Without message editing there is no placeholder, so the reaction is the
    // only immediate feedback; production lark-cli 1.0.80 takes this path.
    bot.canEdit = false
    const event = {
      chatId: 'oc_1', chatType: 'group', messageId: 'om_ack', threadKey: '',
      senderType: 'user', senderId: 'ou_1', messageType: 'text',
      mentions: [{ id: 'ou_bot' }], content: '帮我看看',
    }
    bot.acknowledge(event)
    await waitFor(() => spawned.some(request => request.argv.includes('reactions')))
    const reaction = spawned.find(request => request.argv.includes('reactions'))
    const emoji = JSON.parse(reaction.argv[reaction.argv.indexOf('--data') + 1]).reaction_type.emoji_type
    assert.ok(['OnIt', 'GLANCE', 'Typing'].includes(emoji), `unexpected emoji ${emoji}`)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('the prompt names the asker instead of only their id', async () => {
  const { bot, stateDir, prompts } = await createBot()
  try {
    bot.cli.senderName = async () => '海振国'
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '好的')
    await bot.queue.idle()
    const header = prompts[0].content[0].text
    assert.match(header, /提问人:海振国\(ou_1\)/)
    // The name is cached so later questions do not pay for the lookup.
    let lookups = 0
    bot.cli.senderName = async () => { lookups += 1; return '海振国' }
    await bot.senderLabel({ chatId: 'oc_1', senderId: 'ou_1', messageId: 'om_2' })
    assert.equal(lookups, 0)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('mentionPolicy first keeps only the earliest bot answering', async () => {
  const first = await createBot({}, { mentionPolicy: 'first' })
  const all = await createBot({}, { mentionPolicy: 'all' })
  try {
    const event = (mentions) => ({ chatId: 'oc_1', chatType: 'group', messageId: 'om_m', threadKey: '', senderType: 'user', senderId: 'ou_1', messageType: 'text', mentions, content: 'hi' })
    // botOpenId in the harness is '飞书机器人'
    const onlyMe = event([{ id: '飞书机器人' }])
    const meFirst = event([{ id: '飞书机器人' }, { id: 'ou_other_bot' }])
    const meLater = event([{ id: 'ou_other_bot' }, { id: '飞书机器人' }])
    assert.equal(first.bot.isFirstMentioned(onlyMe), true)
    assert.equal(first.bot.isFirstMentioned(meLater), true, 'other bots are not ours')
    assert.equal(first.bot.config.mentionPolicy, 'first')
    assert.equal(all.bot.config.mentionPolicy, 'all')
    // A single mention of ours is always "first".
    assert.equal(first.bot.isFirstMentioned(meFirst), true)
  } finally {
    await first.bot.dispose()
    await all.bot.dispose()
    await rm(first.stateDir, { recursive: true, force: true })
    await rm(all.stateDir, { recursive: true, force: true })
  }
})

test('the stats endpoint summarises approval counters across bots', async () => {
  const { bot, stateDir } = await createBot()
  try {
    bot.metrics.inc('requestGated')
    bot.metrics.inc('requestGated')
    bot.metrics.inc('actionGated')
    const host = new BotHost(bot.ctx, bot.config, [bot])
    const stats = host.stats()
    const counts = stats.counts
    assert.equal(counts.requestGated, 2)
    assert.equal(counts.actionGated, 1)
    assert.equal(stats.approvals, 0)
    assert.equal(stats.trusted, 0)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})


test('the prompt tells the agent to delegate heavy work to a subagent', async () => {
  const { bot, stateDir, prompts } = await createBot()
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '好的')
    await bot.queue.idle()
    const header = prompts[0].content[0].text
    assert.match(header, /委派指引:/)
    assert.match(header, /subagent/)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('the delegation hint can be turned off', async () => {
  const { bot, stateDir, prompts } = await createBot({}, { delegateGuidance: '' })
  try {
    bot.onEventLine(eventLine)
    await waitFor(() => prompts.length === 1)
    finishTurn(bot, '好的')
    await bot.queue.idle()
    assert.equal(prompts[0].content[0].text.includes('委派指引'), false)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a child session is mapped to its tree root for action approval', async () => {
  const { bot, stateDir } = await createBot({}, { approveUsers: ['ou_owner'], approvalMode: 'action' })
  try {
    bot.trackSession('ses_root', 'oc_1')
    bot.sessionContexts.set('ses_root', { chatId: 'oc_1', threadId: '', messageId: 'om_1', senderId: 'ou_guest' })
    bot.ctx.sessionController.resolveAgent = async () => ({ agent: 'agent_child' })
    let seen
    bot.subagents.current = {
      async startActivation() { throw new Error('unused') },
      rootOf(agent) { seen = agent; return { session: { id: 'ses_root' } } },
    }
    assert.equal(await bot.ownerSession('ses_child'), 'ses_root')
    assert.equal(seen, 'agent_child')
    const asked = await bot.actionGate({ name: 'bash', arguments: { command: 'ls' }, agent: { session: { id: 'ses_child' } } })
    assert.equal(asked?.kind, 'ask', 'a child action must still be approved')
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a session can post into a group it already owns', async () => {
  const { bot, stateDir, spawned } = await createBot()
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Runtime group', botMember: true })
    await bot.bindChat('oc_1', 'ses_1')
    assert.equal(bot.registry.get('oc_1')?.sessionId, 'ses_1')
    bot.config.senderLabel = '海振国'
    const result = await bot.sendManual({ chatId: 'oc_1', threadId: '', text: '这个功能点确认了吗' })
    assert.ok(result !== undefined)
    const sent = spawned.filter(request => request.argv.includes('+messages-send')).pop()
    assert.ok(sent, 'a message must be sent')
    const body = sent.argv[sent.argv.indexOf('--text') + 1]
    assert.match(body, /来自 海振国 的问询/)
    assert.match(body, /这个功能点确认了吗/)
    assert.equal(bot.metrics.snapshot().counts.manualSend, 1)
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a manual send without a known name adds no prefix', async () => {
  const { bot, stateDir, spawned } = await createBot()
  try {
    bot.trackSession('ses_1', 'oc_1')
    await bot.sendManual({ chatId: 'oc_1', threadId: '', text: '纯文本内容' })
    const sent = spawned.filter(request => request.argv.includes('+messages-send')).pop()
    assert.equal(sent.argv[sent.argv.indexOf('--text') + 1], '纯文本内容')
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a double click does not post the same text twice', async () => {
  const { bot, stateDir, spawned } = await createBot()
  try {
    await bot.sendManual({ chatId: 'oc_1', threadId: '', text: '重复点击' })
    await bot.sendManual({ chatId: 'oc_1', threadId: '', text: '重复点击' })
    const sends = spawned.filter(request => request.argv.includes('+messages-send'))
    assert.equal(sends.length, 1, 'the second click must be absorbed')
    assert.equal(bot.metrics.snapshot().counts.manualSendRepeated, 1)
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('sendToChat refuses a conversation the session does not own', async () => {
  const { bot, stateDir } = await createBot()
  try {
    const host = new BotHost(bot.ctx, bot.config, [bot])
    await assert.rejects(
      () => host.sendToChat({ sessionId: 'ses_other', chatId: 'oc_1', text: '你好' }),
      /does not own/,
    )
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('sendToChat posts when the session owns the conversation', async () => {
  const { bot, stateDir, spawned } = await createBot()
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Runtime group', botMember: true })
    await bot.bindChat('oc_1', 'ses_1')
    const host = new BotHost(bot.ctx, bot.config, [bot])
    const value = await host.sendToChat({ sessionId: 'ses_1', chatId: 'oc_1', text: '确认一下' })
    assert.ok(value.messageId !== undefined || spawned.some(r => r.argv.includes('+messages-send')))
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('a table answer skips the placeholder edit and goes out as a fresh reply', async () => {
  const { bot, stateDir, spawned } = await createBot()
  try {
    const answer = ['结论如下：', '', '| 节点 | 应显存 |', '| --- | --- |', '| 10.3.208.12 | 83% |'].join('\n')
    const ok = await bot.deliver(
      { chatId: 'oc_1', messageId: 'om_q1', senderId: 'ou_1', text: '', threadId: '', eventType: 'message' },
      'om_placeholder',
      [answer],
    )
    assert.equal(ok, true)
    // `+messages-edit` mangles Markdown tables, so the placeholder is withdrawn
    // and the answer is sent as its own message.
    const edit = spawned.find(request => request.argv.includes('+messages-edit'))
    assert.equal(edit, undefined, 'the placeholder must not be edited with a table')
    const reply = spawned.find(request => request.argv.includes('+messages-reply') && request.argv.includes('--markdown'))
    assert.ok(reply, 'the answer goes out as a markdown reply')
    // Withdrawal goes through the delete endpoint, the same call an edit failure uses.
    assert.equal(findCalls(spawned, 'delete').length, 1, 'the placeholder is withdrawn')
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('sendToChat refuses a conversation the session does not own', async () => {
  const { bot, stateDir } = await createBot()
  try {
    const host = new BotHost(bot.ctx, bot.config, [bot])
    await assert.rejects(
      () => host.sendToChat({ sessionId: 'ses_other', chatId: 'oc_1', text: '你好' }),
      /does not own/,
    )
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('sendToChat posts when the session owns the conversation', async () => {
  const { bot, stateDir, spawned } = await createBot()
  try {
    bot.cli.chatInfo = async chatId => ({ chatId, name: 'Runtime group', botMember: true })
    await bot.bindChat('oc_1', 'ses_1')
    const host = new BotHost(bot.ctx, bot.config, [bot])
    const value = await host.sendToChat({ sessionId: 'ses_1', chatId: 'oc_1', text: '确认一下' })
    assert.ok(value.messageId !== undefined || spawned.some(r => r.argv.includes('+messages-send')))
    await new Promise(resolve => setTimeout(resolve, 40))
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})

