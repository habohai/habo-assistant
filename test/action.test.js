import assert from 'node:assert/strict'
import test from 'node:test'
import { MUTATING_TOOLS, describeToolCall, isMutatingTool } from '../lib/index.js'

test('isMutatingTool separates acting from reading', () => {
  for (const name of ['bash', 'pwsh', 'write', 'edit', 'apply_patch', 'str_replace_editor']) {
    assert.equal(isMutatingTool(name), true, `${name} should need approval`)
  }
  for (const name of ['read', 'glob', 'grep', 'web_fetch', 'job_output']) {
    assert.equal(isMutatingTool(name), false, `${name} must stay free`)
  }
  assert.equal(isMutatingTool(''), false)
  assert.equal(MUTATING_TOOLS.includes('bash'), true)
})

test('isMutatingTool honours an explicit extra list', () => {
  assert.equal(isMutatingTool('my_tool'), false)
  assert.equal(isMutatingTool('my_tool', ['my_tool']), true)
})

test('describeToolCall surfaces the command or the path', () => {
  assert.equal(describeToolCall('bash', { command: 'ls -la' }), 'bash: ls -la')
  assert.equal(describeToolCall('write', { path: '/tmp/a.txt' }), 'write: /tmp/a.txt')
  assert.equal(describeToolCall('bash', {}), 'bash')
  assert.equal(describeToolCall('bash', null), 'bash')
  assert.ok(describeToolCall('bash', { command: 'x'.repeat(400) }).length < 200)
})
