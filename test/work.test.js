import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyedQueue, Semaphore } from '../lib/index.js'

test('Semaphore caps holders and hands a released slot to the oldest waiter', async () => {
  const semaphore = new Semaphore(2)
  await semaphore.acquire()
  await semaphore.acquire()
  assert.equal(semaphore.active, 2)

  let third = false
  const waiting = semaphore.acquire().then(() => {
    third = true
  })
  await Promise.resolve()
  assert.equal(third, false)
  assert.equal(semaphore.pending, 1)

  semaphore.release()
  await waiting
  assert.equal(third, true)
  assert.equal(semaphore.active, 2)

  semaphore.release()
  semaphore.release()
  assert.equal(semaphore.active, 0)
})

test('Semaphore rejects a non-positive limit', () => {
  assert.throws(() => new Semaphore(0), /limit/)
})

test('KeyedQueue keeps one key in order while different keys run in parallel', async () => {
  const log = []
  let active = 0
  let peak = 0
  const queue = new KeyedQueue({
    maxConcurrent: 2,
    maxQueue: 10,
    run: async (key, job) => {
      active += 1
      peak = Math.max(peak, active)
      log.push(`${key}:${job}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
    },
  })

  queue.push('a', 1)
  queue.push('a', 2)
  queue.push('b', 1)
  await queue.idle()

  assert.deepEqual(log, ['a:1', 'b:1', 'a:2'])
  assert.equal(peak, 2)
  assert.deepEqual(queue.stats(), { keys: 0, running: 0, queued: 0, active: 0, waiting: 0 })
})

test('KeyedQueue rejects work beyond maxQueue waiting jobs', async () => {
  const queue = new KeyedQueue({
    maxConcurrent: 1,
    maxQueue: 1,
    run: async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    },
  })
  assert.equal(queue.push('a', 1), true)
  assert.equal(queue.push('a', 2), true)
  assert.equal(queue.push('a', 3), false)
  await queue.idle()
})

test('KeyedQueue reports queued depth and goes idle when closed', async () => {
  const queue = new KeyedQueue({
    maxConcurrent: 1,
    maxQueue: 5,
    run: async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    },
  })
  assert.equal(queue.isIdle(), true)
  queue.push('a', 1)
  queue.push('a', 2)
  const stats = queue.stats()
  assert.equal(stats.running, 1)
  assert.equal(stats.queued, 1)
  assert.equal(queue.isIdle(), false)

  queue.close()
  await queue.idle()
  assert.equal(queue.push('a', 3), false)
})

test('KeyedQueue reports a throwing job instead of wedging the queue', async () => {
  const errors = []
  const queue = new KeyedQueue({
    maxConcurrent: 1,
    maxQueue: 5,
    run: async () => {
      throw new Error('boom')
    },
    onError: (key, error) => errors.push(`${key}:${error.message}`),
  })
  queue.push('a', 1)
  queue.push('a', 2)
  await queue.idle()
  assert.deepEqual(errors, ['a:boom', 'a:boom'])
})

test('KeyedQueue.clear drops waiting jobs but leaves the running one', async () => {
  let release
  const started = []
  const queue = new KeyedQueue({
    maxConcurrent: 1,
    maxQueue: 5,
    run: async (key, job) => {
      started.push(`${key}:${job}`)
      if (job === 1) await new Promise(resolve => { release = resolve })
    },
  })
  queue.push('a', 1)
  queue.push('a', 2)
  queue.push('a', 3)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(queue.clear('a'), 2)
  assert.deepEqual(started, ['a:1'])
  release()
  await queue.idle()
  assert.deepEqual(started, ['a:1'])
})
