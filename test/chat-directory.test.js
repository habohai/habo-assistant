import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatDirectory } from '../lib/index.js'

test('chat directory migrates dynamic groups and persists runtime enables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'habo-chats-'))
  try {
    await writeFile(join(dir, 'dynamic-chats.json'), JSON.stringify(['oc_legacy']))
    const first = new ChatDirectory(dir)
    await first.ready
    assert.equal(first.isAllowed('oc_legacy'), true)
    await first.allow('oc_runtime', 42)
    await first.allow('oc_private', 43, 'p2p')
    const second = new ChatDirectory(dir)
    await second.ready
    assert.equal(second.isAllowed('oc_runtime'), true)
    assert.equal(second.size, 3)
    assert.equal(second.kind('oc_private'), 'p2p')
    assert.deepEqual(second.entries().find(([id]) => id === 'oc_runtime'), ['oc_runtime', 42])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
