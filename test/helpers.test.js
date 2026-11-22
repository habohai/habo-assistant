import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptEvent,
  bindingKey,
  cleanMessageText,
  routeThreadKey,
  configProblem,
  normalizeConfig,
  readFeishuEvent,
  isStopCommand,
  privateSessionTitle,
  sessionTitle,
  splitReply,
} from '../lib/index.js'

test('normalizeConfig applies safe defaults', () => {
  const config = normalizeConfig({})
  assert.equal(config.larkCli, 'lark-cli')
  assert.equal(config.routing, 'chat')
  assert.equal(config.replyInThread, true)
  assert.equal(config.ackReaction, 'auto')
  assert.equal(config.docsEnabled, false)
  assert.equal(config.docThresholdChars, 4000)
  assert.equal(config.docThresholdLines, 60)
  assert.equal(config.timeoutMs, 600000)
  assert.equal(config.maxReplyChars, 3500)
  assert.deepEqual(config.allowChats, [])
  assert.equal(normalizeConfig({ routing: 'thread' }).routing, 'thread')
  assert.equal(normalizeConfig({ routing: 'topic' }).routing, 'topic')
  assert.equal(normalizeConfig({}).topicContext, 'summary')
  assert.equal(normalizeConfig({ topicContext: 'none' }).topicContext, 'none')
  assert.equal(normalizeConfig({ ownerUnionId: ' on_owner ' }).ownerUnionId, 'on_owner')
  assert.deepEqual(normalizeConfig({ allowChats: [' oc_1 ', '', 3] }).allowChats, ['oc_1'])
})

test('configProblem names the blocking field', () => {
  assert.match(configProblem(normalizeConfig({})), /cwd/)
  assert.match(configProblem(normalizeConfig({ cwd: 'relative/path' })), /absolute/)
  assert.match(configProblem(normalizeConfig({ cwd: '/tmp' })), /allowChats/)
  assert.equal(configProblem(normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'] })), undefined)
})

test('cleanMessageText strips mentions and keeps lines', () => {
  assert.equal(cleanMessageText('@_user_1 帮我看下'), '帮我看下')
  assert.equal(cleanMessageText('log line 1\n  indented\n@_user_2'), 'log line 1\n  indented')
  assert.equal(cleanMessageText(undefined), '')
  const mentions = [{ id: 'ou_bot', name: '飞书 CLI' }, { id: 'ou_other', name: '同事' }]
  assert.equal(cleanMessageText('@飞书 CLI 回复我', mentions, 'ou_bot'), '回复我')
  assert.equal(cleanMessageText('@飞书 CLI 问下 @同事', mentions, 'ou_bot'), '问下 @同事')
})

test('readFeishuEvent flattens the CLI event', () => {
  const event = readFeishuEvent({
    chat_id: 'oc_1', chat_type: 'group', message_id: 'om_1', id: 'om_legacy',
    thread_id: '', root_id: 'om_root', sender_type: 'user', sender_id: 'ou_1',
    message_type: 'text', content: '@_user_1 hi', mentions: [{ id: 'ou_bot' }],
  })
  assert.equal(event.chatId, 'oc_1')
  assert.equal(event.messageId, 'om_1')
  assert.equal(event.threadKey, 'om_root')
  assert.equal(event.threadId, '')
  assert.equal(event.rootId, 'om_root')
  assert.equal(event.senderId, 'ou_1')
  assert.deepEqual(event.mentions, [{ id: 'ou_bot' }])
  assert.equal(readFeishuEvent({ chat_id: 'oc_1' }), undefined)
  assert.equal(readFeishuEvent(null), undefined)
  const wrapped = readFeishuEvent({
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
      message: {
        chat_id: 'oc_2', chat_type: 'group', message_id: 'om_2', message_type: 'text',
        content: '@_user_1 hi', mentions: [{ id: 'ou_bot', name: 'bot' }],
      },
    },
  })
  assert.equal(wrapped?.chatId, 'oc_2')
  assert.equal(wrapped?.senderId, 'ou_1')
  assert.deepEqual(wrapped?.mentions, [{ id: 'ou_bot', name: 'bot' }])
})

test('privateSessionTitle names the peer and bot', () => {
  assert.equal(privateSessionTitle('海振国', '海振国的智能助手'), '与 海振国 的私聊 · 海振国的智能助手')
  assert.equal(privateSessionTitle('', 'bot'), '私聊 · bot')
})

test('acceptEvent filters chats, senders, and types', () => {
  const config = normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'] })
  const base = {
    chatId: 'oc_1', chatType: 'group', messageId: 'om_1', threadKey: '',
    senderType: 'user', senderId: 'ou_1', messageType: 'text', mentions: [{ id: 'ou_bot' }], content: 'hi',
  }
  assert.equal(acceptEvent(base, config, 'chat'), true)
  assert.equal(acceptEvent({ ...base, chatType: 'p2p' }, config, 'chat'), true)
  assert.equal(acceptEvent({ ...base, chatType: 'p2p', mentions: [] }, config, 'chat'), true)
  assert.equal(acceptEvent({ ...base, chatType: 'p2p', chatId: 'oc_other' }, config, 'chat'), false)
  assert.equal(acceptEvent({ ...base, senderType: 'app' }, config, 'chat'), false)
  assert.equal(acceptEvent({ ...base, senderType: 'bot' }, config, 'chat'), false)
  assert.equal(acceptEvent({ ...base, messageType: 'image' }, config, 'chat'), false)
  assert.equal(acceptEvent({ ...base, chatId: 'oc_other' }, config, 'chat'), false)
  assert.equal(acceptEvent({ ...base, mentions: [] }, config, 'chat'), false)
  assert.equal(acceptEvent({ ...base, mentions: [{ id: 'ou_other' }] }, config, 'chat'), true)
  const pinned = normalizeConfig({ cwd: '/tmp', allowChats: ['*'], botOpenId: 'ou_bot' })
  assert.equal(acceptEvent({ ...base, mentions: [{ id: 'ou_other' }] }, pinned, 'chat'), false)
  assert.equal(acceptEvent(base, pinned, 'chat'), true)
})

test('bindingKey isolates threads in topic/thread routing', () => {
  assert.equal(bindingKey('oc_1', 'om_t', 'chat'), 'oc_1')
  assert.equal(bindingKey('oc_1', 'om_t', 'thread'), 'oc_1::om_t')
  assert.equal(bindingKey('oc_1', 'om_t', 'topic'), 'oc_1::om_t')
  assert.equal(bindingKey('oc_1', '', 'topic'), 'oc_1')
  assert.equal(routeThreadKey({ threadId: 'omt_t', threadKey: 'omr' }, 'topic'), 'omt_t')
  assert.equal(routeThreadKey({ threadId: 'omt_t', threadKey: 'omr' }, 'thread'), 'omr')
})

test('splitReply respects the limit and line boundaries', () => {
  assert.deepEqual(splitReply('', 10), [])
  assert.deepEqual(splitReply('  hi  ', 10), ['hi'])
  assert.deepEqual(splitReply('a\nb\nc', 3), ['a\nb', 'c'])
  assert.deepEqual(splitReply('123456', 3), ['123', '456'])
  const long = 'x'.repeat(25)
  assert.deepEqual(splitReply(long, 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
  const lines = splitReply('a\nbbbbb\ncc', 5)
  assert.equal(lines.every(line => line.length <= 5), true)
  assert.equal(lines.join('\n'), 'a\nbbbbb\ncc')
})

test('isStopCommand matches only explicit short commands', () => {
  for (const text of ['停', '停下', '停下吧', '停止！', '取消', 'stop', '/stop']) {
    assert.equal(isStopCommand(text), true, text)
  }
  for (const text of ['如何停止服务', '别停止构建', '帮我停下测试服务', '']) {
    assert.equal(isStopCommand(text), false, text)
  }
})

test('sessionTitle prefers the group name', () => {
  const event = { chatId: 'oc_707a9555790cf543644c3896b708d8dc' }
  assert.equal(sessionTitle(event, '写周报', '赵老师答疑'), '飞书·赵老师答疑')
  assert.equal(sessionTitle(event, '写周报'), '飞书·写周报')
  assert.equal(sessionTitle(event), '飞书·b708d8dc')
})

test('the delegation backend defaults to the registered provider name', () => {
  const config = normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'], stateDir: '/tmp/x' })
  // `subagent-spawn-in-process` is the package name; the provider registers as `spawn`.
  assert.equal(config.taskSubagentProvider, 'spawn')
})
