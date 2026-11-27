import assert from 'node:assert/strict'
import test from 'node:test'
import { decideReply, hasMarkdownTable, hasTable, markdownMarkers, replyCard, splitTables } from '../lib/index.js'

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


test('a reply with a table splits into prose and table segments', () => {
  const reply = [
    '核对结果如下：',
    '',
    '| 分支 | 提交 |',
    '| --- | --- |',
    '| master | ce8e3536 |',
    '| release-v10.0.2 | e96c9e36 |',
    '',
    '结论：可以合。',
  ].join('\n')
  const segments = splitTables(reply)
  assert.equal(segments.length, 3)
  assert.deepEqual(segments[0], { kind: 'text', text: '核对结果如下：' })
  assert.deepEqual(segments[1], {
    kind: 'table',
    table: { headers: ['分支', '提交'], rows: [['master', 'ce8e3536'], ['release-v10.0.2', 'e96c9e36']] },
  })
  assert.deepEqual(segments[2], { kind: 'text', text: '结论：可以合。' })
  assert.equal(hasTable(reply), true)
})

test('a pipe block without a divider stays prose', () => {
  const reply = '| a | b |\n| 1 | 2 |'
  assert.equal(hasTable(reply), false)
  assert.deepEqual(splitTables(reply), [{ kind: 'text', text: reply }])
})

test('cells lose inline Markdown decoration', () => {
  const segments = splitTables('| a | b |\n| --- | --- |\n| **粗** | `code` |')
  assert.deepEqual(segments[0].table.rows[0], ['粗', 'code'])
})

test('ragged rows are padded to the header width', () => {
  const segments = splitTables('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |')
  assert.deepEqual(segments[0].table.rows[0], ['1', '2', ''])
})

test('the card carries a table element per table', () => {
  const card = replyCard(splitTables('说明\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'))
  assert.equal(card.body.elements.length, 2)
  assert.equal(card.body.elements[0].tag, 'markdown')
  assert.equal(card.body.elements[1].tag, 'table')
  assert.equal(card.body.elements[1].columns?.length, 2)
  assert.equal(card.body.elements[1].rows?.length, 1)
})
