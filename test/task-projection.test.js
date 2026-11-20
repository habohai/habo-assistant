import assert from 'node:assert/strict'
import test from 'node:test'
import { taskProjection } from '../lib/index.js'

const user = {
  type: 'user/message',
  seq: 3,
  time: 1000,
  data: {
    source: { kind: 'user' },
    content: [{ type: 'text', text: '[飞书群:oc_1 | 提问人:ou_1]\n给我写个简短的周报' }],
  },
}

test('taskProjection follows a Feishu turn', () => {
  const initial = taskProjection.init({}, 0)
  assert.equal(initial.view.bot, false)

  let state = taskProjection.apply(initial, user)
  assert.deepEqual(state.view, {
    bot: true,
    status: 'running',
    chatId: 'oc_1',
    chatName: '',
    question: '给我写个简短的周报',
    startedAt: 1000,
    updatedAt: 1000,
    approval: '',
  })

  state = taskProjection.apply(state, { type: 'approval/asked', seq: 4, time: 1100, data: { reason: '操作审批：git log' } })
  assert.equal(state.view.status, 'approval')
  assert.equal(state.view.approval, '操作审批：git log')

  state = taskProjection.apply(state, { type: 'approval/decided', seq: 5, time: 1200, data: {} })
  assert.equal(state.view.status, 'running')
  assert.equal(state.view.approval, '')

  state = taskProjection.apply(state, { type: 'turn/end', seq: 6, time: 1300, data: {} })
  assert.equal(state.view.status, 'idle')
  assert.equal(state.view.updatedAt, 1300)
  assert.equal(taskProjection.wire.view(state), state.view)
})

test('taskProjection ignores unrelated sessions and preserves state identity', () => {
  const initial = taskProjection.init({}, 0)
  const runtime = {
    type: 'user/message',
    seq: 1,
    time: 1000,
    data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'context' }] },
  }
  assert.equal(taskProjection.apply(initial, runtime), initial)
  assert.equal(taskProjection.apply(initial, { type: 'turn/start', seq: 2, time: 1000, data: {} }), initial)
})

test('taskProjection skips a fork inherited prefix', () => {
  const state = taskProjection.init({}, 10)
  assert.equal(taskProjection.apply(state, user), state)
  assert.equal(taskProjection.apply(state, { ...user, seq: 11 }).view.bot, true)
})

test('taskProjection keeps the human group name and the chat id', () => {
  const state = taskProjection.apply(taskProjection.init({}, 0), {
    type: 'user/message',
    seq: 1,
    time: 1000,
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '[飞书群:赵老师答疑 | 群ID:oc_1 | 提问人:ou_1]\n文件数多少' }],
    },
  })
  assert.equal(state.view.chatId, 'oc_1')
  assert.equal(state.view.chatName, '赵老师答疑')
  assert.equal(state.view.question, '文件数多少')
})
