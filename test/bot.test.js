import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FeishuBot, normalizeConfig } from '../lib/index.js'

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
    const acks = replies.filter(request => flagValue(request.argv, '--idempotency-key') === 'feishu-om_1-ack')
    assert.equal(acks.length, 1)
    assert.match(flagValue(acks[0].argv, '--text'), /收到/)

    const edits = findCalls(spawned, '+messages-edit')
    assert.equal(edits.length, 1)
    assert.equal(flagValue(edits[0].argv, '--text'), '构建失败是因为依赖下载超时。')
    // The answer replaced the placeholder instead of adding another message.
    assert.equal(replies.length, 1)

    assert.equal(prompts[0].content[0].text, '[飞书群:oc_1 | 机器人:飞书机器人 | 机器人ID:飞书机器人 | 群内已绑定机器人:飞书机器人 | 回复要求:使用中文回答。保持简洁、有条理：先给结论，再列必要要点；不要冗长客套，不要重复问题。 | 提问人:ou_1]\n帮我看下构建为什么失败')
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
      .filter(request => flagValue(request.argv, '--idempotency-key') !== 'feishu-om_1-ack')
    assert.deepEqual(
      replies.map(request => flagValue(request.argv, '--idempotency-key')),
      ['feishu-om_1-1', 'feishu-om_1-2'],
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

    const deletes = findCalls(spawned, 'delete')
    assert.equal(deletes.length, 1)
    assert.match(flagValue(deletes[0].argv, '--params'), /om_sent_1/)

    const replies = findCalls(spawned, '+messages-reply')
      .filter(request => flagValue(request.argv, '--idempotency-key') === 'feishu-om_1-0')
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
