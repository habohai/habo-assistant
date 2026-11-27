import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenTables, normalizeMentions, sanitizeForPost } from '../lib/index.js'

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

test('a Markdown table becomes one bullet per row', () => {
  const input = [
    '结论：',
    '',
    '| 分支 | 提交 | 说明 |',
    '| --- | --- | --- |',
    '| master | ce8e3536 | 领先 33 个提交 |',
    '| release-v10.0.2 | e96c9e36 | master 包含它 |',
    '',
    '以上。',
  ].join('\n')
  const output = flattenTables(input)
  assert.equal(output.includes('|'), false, 'no pipe should survive')
  assert.match(output, /- 分支：master · 提交：ce8e3536 · 说明：领先 33 个提交/)
  assert.match(output, /- 分支：release-v10\.0\.2 · 提交：e96c9e36 · 说明：master 包含它/)
  assert.match(output, /^结论：/m)
  assert.match(output, /以上。/)
})

test('an empty table cell does not produce a dangling label', () => {
  const output = flattenTables('| a | b |\n| --- | --- |\n| 1 | |')
  assert.equal(output, '- a：1')
})

test('prose without tables is untouched', () => {
  const text = '普通一行\n\n- 列表项'
  assert.equal(flattenTables(text), text)
})
