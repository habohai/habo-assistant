import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULTS } from '../lib/index.js'
import { Metrics, configProblem, normalizeConfig, parseMessageId, percentile } from '../lib/index.js'

test('normalizeConfig keeps documented defaults', () => {
  const config = normalizeConfig({})
  assert.equal(config.timeoutMs, DEFAULTS.timeoutMs)
  assert.equal(config.maxConcurrent, 4)
  assert.equal(config.maxQueue, 20)
  assert.equal(config.cliTimeoutMs, 15_000)
  assert.equal(config.readyTimeoutMs, 30_000)
  assert.equal(config.progress, true)
  assert.equal(config.workspaceId, undefined)
  assert.equal(config.larkProfile, undefined)
  assert.equal(config.p2pSessionTtlMs, 30 * 24 * 60 * 60 * 1000)
  assert.match(config.replyGuidelines, /使用中文/)
  assert.equal(config.chatListTtlMs, 5 * 60 * 1000)
  assert.equal(normalizeConfig({ chatListTtlMs: 60_000 }).chatListTtlMs, 60_000)
  assert.equal(normalizeConfig({ replyGuidelines: '' }).replyGuidelines, '')
  assert.equal(normalizeConfig({ p2pSessionTtlMs: 7 * 24 * 60 * 60 * 1000 }).p2pSessionTtlMs, 7 * 24 * 60 * 60 * 1000)
  assert.equal(normalizeConfig({ larkProfile: ' bot-a ' }).larkProfile, 'bot-a')
  const multi = normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'], bots: [
    { id: 'a', name: 'A', profile: 'p1' },
    { id: 'b', name: 'B', profile: 'p2', allowChats: ['oc_2'] },
  ] })
  assert.equal(multi.bots.length, 2)
  assert.equal(multi.bots[0].id, 'a')
  assert.equal(multi.bots[0].profile, 'p1')
  assert.deepEqual(multi.bots[0].allowChats, ['oc_1'])
  assert.deepEqual(multi.bots[1].allowChats, ['oc_2'])
  const noProfile = normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'], bots: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] })
  assert.match(configProblem(noProfile) ?? '', /larkProfile/)
  const noOpenId = normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'], bots: [{ id: 'a', name: 'A', profile: 'p1' }, { id: 'b', name: 'B', profile: 'p2' }] })
  assert.match(configProblem(noOpenId) ?? '', /openId/)
  const duplicate = normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'], bots: [{ id: 'a', name: 'A', profile: 'p', openId: 'ou_a' }, { id: 'b', name: 'B', profile: 'p', openId: 'ou_b' }] })
  assert.match(configProblem(duplicate) ?? '', /duplicate larkProfile/)
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
