import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS } from '../lib/index.js'
import { Metrics, normalizeConfig, parseMessageId, percentile } from '../lib/index.js'

test('normalizeConfig keeps documented defaults', () => {
  const config = normalizeConfig({})
  assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(config.maxConcurrent, 4)
  assert.equal(config.maxQueue, 20)
  assert.equal(config.cliTimeoutMs, 15_000)
  assert.equal(config.readyTimeoutMs, 30_000)
  assert.equal(config.progress, true)
  assert.equal(config.workspaceId, undefined)
  assert.equal(config.permissionPreset, '')
  assert.equal(normalizeConfig({ workspaceId: 'w1' }).workspaceId, 'w1')
  assert.equal(config.approvalTimeoutMs, 120_000)
  assert.deepEqual(config.approveUsers, [])
  assert.equal(normalizeConfig({ permissionPreset: 'read-only' }).permissionPreset, 'read-only')
  assert.match(config.stateDir, /\.dsh\/feishu-bot$/)
})

test('normalizeConfig clamps integers and ignores nonsense', () => {
  assert.equal(normalizeConfig({ maxConcurrent: 999 }).maxConcurrent, 32)
  assert.equal(normalizeConfig({ maxConcurrent: 0 }).maxConcurrent, 4)
  assert.equal(normalizeConfig({ maxConcurrent: '8' }).maxConcurrent, 4)
  assert.equal(normalizeConfig({ maxQueue: 2.9 }).maxQueue, 2)
  assert.equal(normalizeConfig({ timeoutMs: 1 }).timeoutMs, 5_000)
  assert.equal(normalizeConfig({ maxReplyChars: 1 }).maxReplyChars, 200)
})

test('normalizeConfig keeps the progress switch opt-out', () => {
  assert.equal(normalizeConfig({ progress: false }).progress, false)
  assert.equal(normalizeConfig({ progress: 'no' }).progress, true)
})

test('percentile uses nearest rank', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(values, 50), 5)
  assert.equal(percentile(values, 95), 10)
  assert.equal(percentile(values, 100), 10)
  assert.equal(percentile([], 50), 0)
  assert.equal(percentile([7], 50), 7)
})

test('Metrics snapshot separates counters from latency windows', () => {
  const metrics = new Metrics({ windowSize: 3 })
  metrics.inc('eventsReceived')
  metrics.inc('eventsReceived', 2)
  for (const value of [10, 20, 30, 40]) metrics.observe('jobTotalMs', value)
  const snapshot = metrics.snapshot()
  assert.equal(snapshot.counts.eventsReceived, 3)
  assert.deepEqual(snapshot.timings.jobTotalMs, { count: 3, p50: 30, p95: 40, max: 40 })
  assert.equal(metrics.isEmpty(), false)
})

test('parseMessageId reads the lark-cli success envelope', () => {
  assert.equal(parseMessageId('{"ok":true,"data":{"message_id":"om_1"}}'), 'om_1')
  assert.equal(parseMessageId('{"message_id":"om_2"}'), 'om_2')
  assert.equal(parseMessageId('not json'), undefined)
  assert.equal(parseMessageId('{"ok":true,"data":{}}'), undefined)
})
