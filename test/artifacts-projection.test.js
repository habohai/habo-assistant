import assert from 'node:assert/strict'
import test from 'node:test'
import { artifactsProjection as projection } from '../lib/index.js'

function state() {
  return projection.init({}, 0)
}

function call(id, name, args, turn = 1) {
  return {
    type: 'tool/call',
    seq: 1,
    data: { callId: id, name, arguments: JSON.stringify(args), turn },
  }
}

function result(id, turn, message, meta) {
  return {
    type: 'tool/result',
    seq: 2,
    data: {
      turn,
      message: { source: { callId: id }, isError: false, content: message },
      ...(meta === undefined ? {} : { meta }),
    },
  }
}

test('a successful write is produced once and upgraded by present', () => {
  let current = state()
  current = projection.apply(current, call('c1', 'write', { file_path: '/w/report.md', content: 'x' }))
  current = projection.apply(current, result('c1', 1, [{ type: 'text', text: 'wrote' }], { path: '/w/report.md' }))
  current = projection.apply(current, {
    type: 'deliverables/presented',
    seq: 3,
    data: { turn: 1, files: [{ path: '/w/report.md', description: 'Report' }] },
  })
  assert.deepEqual(current.view.artifacts, [{
    path: '/w/report.md',
    kind: 'delivered',
    turn: 1,
    description: 'Report',
  }])
})

test('only lark-cli terminal results contribute Feishu links', () => {
  let current = state()
  current = projection.apply(current, call('c1', 'bash', { command: 'echo https://x.feishu.cn/docx/abc' }))
  current = projection.apply(current, result('c1', 1, [{ type: 'text', text: 'https://x.feishu.cn/docx/abc' }]))
  assert.equal(current.view.artifacts.length, 0)

  current = projection.apply(current, call('c2', 'bash', { command: 'lark-cli docs create' }))
  current = projection.apply(current, result('c2', 1, [{
    type: 'text',
    text: 'created https://acme.feishu.cn/docx/abc123 and https://acme.feishu.cn/wiki/space/4',
  }]))
  assert.deepEqual(current.view.artifacts, [{
    url: 'https://acme.feishu.cn/docx/abc123',
    resource: 'docx',
    kind: 'document',
    turn: 1,
  }])
})

test('the fork-inherited prefix is history, not work done here', () => {
  let current = projection.init({}, 10)
  current = projection.apply(current, { type: 'turn/start', seq: 9, data: { turn: 1 } })
  assert.equal(current.view.artifacts.length, 0)
  const next = projection.apply(current, {
    type: 'deliverables/presented',
    seq: 11,
    data: { turn: 1, files: [{ path: '/w/new.md' }] },
  })
  assert.deepEqual(next.view.artifacts, [{ path: '/w/new.md', kind: 'delivered', turn: 1 }])
})
