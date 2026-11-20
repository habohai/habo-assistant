import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BindingRegistry } from '../lib/index.js'

test('binding registry migrates active, history, candidates, and suppression', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'habo-binding-'))
  try {
    await writeFile(join(dir, 'bindings.json'), JSON.stringify({
      oc_1: { sessionId: 'ses_active', source: 'manual', boundAt: 10 },
    }))
    await writeFile(join(dir, 'binding-history.json'), JSON.stringify({
      oc_1: [{ sessionId: 'ses_old', at: 5, source: 'auto' }],
    }))
    await writeFile(join(dir, 'chat-affinity.json'), JSON.stringify({
      oc_2: { sessionId: 'ses_candidate', at: 20 },
    }))
    await writeFile(join(dir, 'suppressed-chats.json'), JSON.stringify(['oc_3']))
    const registry = new BindingRegistry(dir)
    await registry.ready
    assert.deepEqual(registry.resolve('oc_1', '', 'chat'), { kind: 'explicit', sessionId: 'ses_active', source: 'manual', at: 10, key: 'oc_1' })
    assert.equal(registry.listByChat('oc_1')[0].sessionId, 'ses_active')
    assert.equal(registry.listByChat('oc_1')[0].botId, 'default')
    assert.equal(registry.resolve('oc_2', '', 'chat').kind, 'candidate')
    assert.equal(registry.resolve('oc_2', '', 'chat').sessionId, 'ses_candidate')
    assert.equal(registry.resolve('oc_3', '', 'chat').kind, 'unbound')
    const journal = await readFile(join(dir, 'binding-state.v2.jsonl'), 'utf8')
    assert.match(journal, /"op":"bind"/)
    assert.match(journal, /"op":"candidate"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('binding registry resolves explicit, auto, unbound, and thread scopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'habo-binding-'))
  try {
    const registry = new BindingRegistry(dir)
    await registry.ready
    await registry.bind('oc_1', '', 'ses_a', 'manual', 10)
    assert.equal(registry.resolve('oc_1', '', 'chat').kind, 'explicit')
    await registry.bind('oc_1', '', 'ses_b', 'auto', 20)
    assert.equal(registry.resolve('oc_1', '', 'chat').sessionId, 'ses_b')
    await registry.bind('oc_1', 't1', 'ses_thread', 'manual', 30)
    assert.equal(registry.resolve('oc_1', 't1', 'thread').sessionId, 'ses_thread')
    assert.equal(registry.resolve('oc_1', '', 'chat').sessionId, 'ses_b')
    await registry.unbind('oc_1', '')
    assert.equal(registry.resolve('oc_1', '', 'chat').kind, 'unbound')
    await registry.bind('oc_1', '', 'ses_new', 'auto', 40)
    assert.equal(registry.resolve('oc_1', '', 'chat').kind, 'auto')
    assert.equal(registry.resolve('oc_1', '', 'chat').sessionId, 'ses_new')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('binding registry isolates the same chat for different bots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'habo-binding-'))
  try {
    const registry = new BindingRegistry(dir, 'bot_a')
    await registry.ready
    await registry.bind('oc_1', '', 'ses_a', 'manual', 10, 'bot_a')
    await registry.bind('oc_1', '', 'ses_b', 'manual', 20, 'bot_b')
    assert.equal(registry.resolve('oc_1', '', 'chat', 'bot_a').sessionId, 'ses_a')
    assert.equal(registry.resolve('oc_1', '', 'chat', 'bot_b').sessionId, 'ses_b')
    assert.equal(registry.entries().length, 2)
    await registry.unbind('oc_1', '', 30, 'bot_a')
    assert.equal(registry.resolve('oc_1', '', 'chat', 'bot_a').kind, 'unbound')
    assert.equal(registry.resolve('oc_1', '', 'chat', 'bot_b').kind, 'explicit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
