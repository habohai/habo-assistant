import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalCard, approvalResultCard, readCardAction } from '../lib/index.js'

test('approvalCard carries chat and decision in each button', () => {
  const card = approvalCard('执行命令：pnpm test', 'oc_1', 120)
  const actions = card.elements.find(element => element.tag === 'action').actions
  assert.equal(actions.length, 2)
  assert.deepEqual(actions[0].value, { kind: 'feishu-approval', chatId: 'oc_1', decision: 'allow' })
  assert.deepEqual(actions[1].value, { kind: 'feishu-approval', chatId: 'oc_1', decision: 'reject' })
})

test('approvalResultCard drops the buttons', () => {
  const card = approvalResultCard('allowed-once', '✅ 已批准')
  assert.equal(card.elements.some(element => element.tag === 'action'), false)
  assert.equal(card.header.template, 'green')
})

test('readCardAction reads the flat CLI shape', () => {
  const action = readCardAction({
    chat_id: 'oc_1',
    operator: { open_id: 'ou_owner' },
    action: { value: { kind: 'feishu-approval', chatId: 'oc_1', decision: 'allow' } },
  })
  assert.deepEqual(action, { chatId: 'oc_1', decision: 'allow', operatorId: 'ou_owner' })
})

test('readCardAction reads the envelope and ignores unrelated cards', () => {
  const wrapped = readCardAction({
    header: { event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_owner' },
      action: { value: { kind: 'feishu-approval', chatId: 'oc_2', decision: 'reject' } },
    },
  })
  assert.deepEqual(wrapped, { chatId: 'oc_2', decision: 'reject', operatorId: 'ou_owner' })
  assert.equal(readCardAction({ action: { value: { kind: 'other' } } }), undefined)
  assert.equal(readCardAction({ action: { value: { kind: 'feishu-approval', decision: 'maybe' } } }), undefined)
  assert.equal(readCardAction(null), undefined)
})

test('readCardAction keeps the update token when present', () => {
  const action = readCardAction({
    token: 'tok-1',
    chat_id: 'oc_1',
    operator: { open_id: 'ou_owner' },
    action: { value: { kind: 'feishu-approval', chatId: 'oc_1', decision: 'allow' } },
  })
  assert.equal(action.token, 'tok-1')
  const without = readCardAction({
    chat_id: 'oc_1',
    action: { value: { kind: 'feishu-approval', chatId: 'oc_1', decision: 'allow' } },
  })
  assert.equal('token' in without, false)
})
