import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SeenStore } from '../lib/index.js'

async function withStore(options, run) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-seen-'))
  const file = join(dir, 'seen.jsonl')
  try {
    const store = new SeenStore(file, options)
    await store.load()
    await run(store, file)
    await store.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('claim accepts an id once and survives a reload', async () => {
  await withStore({ ttlMs: 60_000, max: 100 }, async (store, file) => {
    assert.equal(store.claim('om_1'), true)
    assert.equal(store.claim('om_1'), false)
    assert.equal(store.size, 1)
    await store.dispose()

    const reloaded = new SeenStore(file, { ttlMs: 60_000, max: 100 })
    await reloaded.load()
    assert.equal(reloaded.has('om_1'), true)
    assert.equal(reloaded.claim('om_1'), false)
    assert.equal(reloaded.claim('om_2'), true)
    await reloaded.dispose()

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[1]).id, 'om_2')
  })
})

test('expired ids are forgotten and can be claimed again', async () => {
  await withStore({ ttlMs: 5, max: 100 }, async store => {
    assert.equal(store.claim('om_old'), true)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(store.claim('om_old'), true)
  })
})

test('the store keeps only the newest max entries', async () => {
  await withStore({ ttlMs: 60_000, max: 2 }, async store => {
    store.claim('a')
    store.claim('b')
    store.claim('c')
    assert.equal(store.size, 2)
    assert.equal(store.has('a'), false)
    assert.equal(store.has('b'), true)
  })
})

test('load compacts a journal that no longer matches memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-seen-'))
  const file = join(dir, 'seen.jsonl')
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, [
      JSON.stringify({ id: 'om_dead', at: Date.now() - 48 * 60 * 60 * 1000 }),
      JSON.stringify({ id: 'om_live', at: Date.now() }),
      JSON.stringify({ id: 'om_live', at: Date.now() }),
      '{"id": "torn',
      '',
    ].join('\n'), 'utf8')

    const store = new SeenStore(file, { ttlMs: 60_000, max: 100 })
    await store.load()
    assert.equal(store.size, 1)
    await store.dispose()

    const compacted = (await readFile(file, 'utf8')).trim()
    assert.equal(JSON.parse(compacted).id, 'om_live')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
