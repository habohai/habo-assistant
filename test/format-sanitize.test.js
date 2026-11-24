import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeMentions, sanitizeForPost } from '../lib/index.js'

test('smart quotes inside a mention become straight quotes', () => {
  const text = '<at user_id=“ou_abc”>刘城</at> 收到'
  assert.equal(normalizeMentions(text, 'text'), '<at user_id="ou_abc">刘城</at> 收到')
})

test('a post turns mentions into plain text, because post cannot carry them', () => {
  const text = '<at user_id="ou_abc">刘城</at> 收到'
  assert.equal(normalizeMentions(text, 'post'), '@刘城 收到')
})

test('a tag without a body still gets straight quotes', () => {
  const text = '<at user_id=“ou_abc”> 收到'
  assert.equal(normalizeMentions(text, 'text'), '<at user_id="ou_abc"> 收到')
})

test('control characters are stripped for post payloads', () => {
  assert.equal(sanitizeForPost('a\u0000b\u0007c\nd\te'), 'abc\nd\te')
  assert.equal(sanitizeForPost('normal text'), 'normal text')
})

test('ordinary text is untouched', () => {
  assert.equal(normalizeMentions('没有提mention', 'text'), '没有提mention')
  assert.equal(normalizeMentions('', 'text'), '')
})

test('an empty mention label stays empty in text messages', () => {
  // The approval prompt mentions the approver without a label so Feishu shows
  // the real name instead of an open_id.
  assert.equal(normalizeMentions('<at user_id="ou_1"></at> 请回复', 'text'), '<at user_id="ou_1"></at> 请回复')
})
