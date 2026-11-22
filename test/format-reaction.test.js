import assert from 'node:assert/strict'
import test from 'node:test'
import { ACK_POOL, pickAckReaction } from '../lib/index.js'

test('pickAckReaction keeps an explicit emoji verbatim', () => {
  assert.equal(pickAckReaction('OnIt', 'om_1'), 'OnIt')
  assert.equal(pickAckReaction('Eyes', 'om_1'), 'Eyes')
})

test('pickAckReaction disables on none or empty', () => {
  assert.equal(pickAckReaction('none', 'om_1'), '')
  assert.equal(pickAckReaction('', 'om_1'), '')
})

test('pickAckReaction rotates inside the pool for auto', () => {
  const picked = new Set()
  for (let index = 0; index < 40; index += 1) picked.add(pickAckReaction('auto', `om_${index}`))
  assert.ok(picked.size > 1, 'auto should not always return the same emoji')
  for (const emoji of picked) assert.ok(ACK_POOL.includes(emoji))
})

test('pickAckReaction is stable for the same message', () => {
  assert.equal(pickAckReaction('auto', 'om_stable'), pickAckReaction('auto', 'om_stable'))
})

test('pickAckReaction falls back to the first pool entry without an id', () => {
  assert.equal(pickAckReaction('auto', ''), ACK_POOL[0])
})
