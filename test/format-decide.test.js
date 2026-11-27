import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseTransport, decideReply, hasMarkdownTable, hasTable, markdownMarkers } from '../lib/index.js'

test('decideReply keeps plain text on the text transport', () => {
  const plan = decideReply('构建成功了。')
  assert.equal(plan.kind, 'text')
  assert.equal(plan.reason, 'plain')
  assert.equal(plan.content, '构建成功了。')
  assert.deepEqual(plan.markers, [])
})

test('decideReply routes supported Markdown to post', () => {
  const plan = decideReply('**结论**：依赖版本不一致\n\n- 第一项\n- 第二项')
  assert.equal(plan.kind, 'post')
  assert.equal(plan.reason, 'markdown')
  assert.deepEqual(plan.markers.sort(), ['bold', 'list'])
})

test('decideReply detects every documented marker', () => {
  const samples = {
    bold: '**a**',
    italic: '*a*',
    strike: '~~a~~',
    'inline-code': '`a`',
    'code-block': '```js\n1\n```',
    heading: '## 标题',
    list: '- a',
    quote: '> a',
    link: '[a](https://example.com)',
  }
  for (const [name, text] of Object.entries(samples)) {
    assert.ok(markdownMarkers(text).includes(name), `${name} should be detected in ${JSON.stringify(text)}`)
  }
})

test('decideReply treats empty replies as text', () => {
  assert.equal(decideReply('').reason, 'empty')
  assert.equal(decideReply('   ').kind, 'text')
})

test('decideReply does not treat log pipes as Markdown', () => {
  const plan = decideReply('a|b|c\n1|2|3')
  assert.equal(plan.kind, 'text')
})

test('hasMarkdownTable requires a delimiter row', () => {
  assert.equal(hasMarkdownTable('| a | b |\n|---|---|\n| 1 | 2 |'), true)
  assert.equal(hasMarkdownTable('a|b|c\n1|2|3'), false)
  assert.equal(hasMarkdownTable('执行命令：\nfoo | bar'), false)
})

test('decideReply keeps tables in the chat by default', () => {
  const plan = decideReply('| 任务 | 状态 |\n|---|---|\n| 构建 | 通过 |')
  assert.equal(plan.kind, 'post')
  assert.equal(plan.table, true)
})

test('decideReply keeps long plain replies on the text transport', () => {
  const long = Array.from({ length: 80 }, () => '这一行是报告内容').join('\n')
  // Length alone never creates a document; without Markdown it stays cheap text.
  assert.equal(decideReply(long).kind, 'text')
  const markdown = Array.from({ length: 80 }, () => '- 这一行是报告要点').join('\n')
  assert.equal(decideReply(markdown).kind, 'post')
})

test('a reply with a table is detected', () => {
  const reply = ['核对结果如下：', '', '| 分支 | 提交 |', '| --- | --- |', '| master | ce8e3536 |', '', '结论：可以合。'].join('\n')
  assert.equal(hasTable(reply), true)
})

test('a pipe block without a divider is not a table', () => {
  assert.equal(hasTable('| a | b |\n| 1 | 2 |'), false)
})

test('a header with no body row is not a table', () => {
  assert.equal(hasTable('| a | b |\n| --- | --- |'), false)
})

test('prose without pipes is not a table', () => {
  assert.equal(hasTable('普通回复\n\n- 列表'), false)
})

test('a table answer never reuses the placeholder', () => {
  assert.equal(chooseTransport({ hasTable: true, hasPlaceholder: true }), 'reply')
})

test('a plain answer edits the placeholder when one exists', () => {
  assert.equal(chooseTransport({ hasTable: false, hasPlaceholder: true }), 'edit')
})

test('no placeholder means a fresh reply', () => {
  assert.equal(chooseTransport({ hasTable: false, hasPlaceholder: false }), 'reply')
  assert.equal(chooseTransport({ hasTable: true, hasPlaceholder: false }), 'reply')
})
