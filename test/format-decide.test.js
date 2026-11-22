import assert from 'node:assert/strict'
import test from 'node:test'
import { decideReply, docSummary, hasMarkdownTable, markdownMarkers } from '../lib/index.js'

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

test('decideReply sends tables to documents', () => {
  const plan = decideReply('| 任务 | 状态 |\n|---|---|\n| 构建 | 通过 |')
  assert.equal(plan.kind, 'doc')
  assert.equal(plan.reason, 'table')
  assert.equal(plan.table, true)
})

test('decideReply sends long replies to documents', () => {
  const long = Array.from({ length: 80 }, () => '这一行是报告内容').join('\n')
  const plan = decideReply(long)
  assert.equal(plan.kind, 'doc')
  assert.equal(plan.reason, 'long')
})

test('decideReply respects doc thresholds and the docs switch', () => {
  const long = 'x'.repeat(5000)
  assert.equal(decideReply(long, { docsEnabled: false, docThresholdChars: 100, docThresholdLines: 0 }).kind, 'text')
  assert.equal(decideReply(long, { docsEnabled: true, docThresholdChars: 9999, docThresholdLines: 0 }).kind, 'text')
  assert.equal(decideReply(long, { docsEnabled: true, docThresholdChars: 100, docThresholdLines: 0 }).kind, 'doc')
})

test('docSummary flattens Markdown into one line', () => {
  const summary = docSummary('## 结论\n\n- **构建**失败\n- 依赖冲突')
  assert.equal(summary.includes('*'), false)
  assert.equal(summary.includes('#'), false)
  assert.ok(summary.includes('构建'))
})
