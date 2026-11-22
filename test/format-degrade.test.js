import assert from 'node:assert/strict'
import test from 'node:test'
import { LarkCli, idempotencyKey } from '../lib/index.js'

/** Minimal subprocess double that fails the first N invocations. */
function harness(failures) {
  const calls = []
  let remaining = failures
  const ctx = {
    subprocess: {
      async resolveExecutable() { return 'lark-cli' },
      spawn(request) {
        calls.push(request.argv)
        const fail = remaining > 0
        if (fail) remaining -= 1
        const stdout = fail ? '' : '{"ok":true,"data":{"message_id":"om_sent"}}'
        const stderr = fail ? 'post payload rejected' : ''
        return {
          done: Promise.resolve({ exitCode: fail ? 1 : 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout }) },
            stderr: { readFrom: () => ({ text: stderr }) },
          },
          terminate() {},
        }
      },
    },
  }
  return { cli: new LarkCli(ctx, { cwd: '/tmp' }), calls }
}

test('a rejected post reply is retried as plain text', async () => {
  const { cli, calls } = harness(1)
  const id = await cli.reply('om_q', '**结论**：通过')
  assert.equal(id, 'om_sent')
  assert.equal(calls.length, 2)
  assert.ok(calls[0].includes('--markdown'))
  assert.ok(calls[1].includes('--text'))
})

test('a plain text reply is not retried', async () => {
  const { cli, calls } = harness(1)
  await assert.rejects(() => cli.reply('om_q', '收到'))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].includes('--text'))
})

test('a rejected post send is retried as plain text', async () => {
  const { cli, calls } = harness(1)
  const id = await cli.send('oc_1', '**结论**：通过', 'ap_x')
  assert.equal(id, 'om_sent')
  assert.equal(calls.length, 2)
  assert.ok(calls[0].includes('--markdown'))
  assert.ok(calls[1].includes('--text'))
})

test('idempotency keys stay under the 50-character Feishu limit', () => {
  // A long suffix used to push the key past 50 chars, and Feishu rejected the
  // send; approvals then resolved as "unavailable" without ever being asked.
  const longSuffix = 'ap_lz3k9x2a1b7c4d'
  for (const key of [
    idempotencyKey('feishu-reply', 'om_x100b7f1cc6b38ca0b37d9b23dff6b29', longSuffix),
    idempotencyKey('feishu-send', 'oc_707a9555790cf543644c3896b708d8dc', longSuffix),
    idempotencyKey('feishu-card', 'oc_707a9555790cf543644c3896b708d8dc', longSuffix),
  ]) {
    assert.ok(key.length <= 50, `key too long: ${key} (${key.length})`)
    assert.ok(key.length > 3)
  }
})

test('idempotency keys are stable per send and distinct across sends', () => {
  const a = idempotencyKey('feishu-reply', 'om_1', 'ap_1')
  const b = idempotencyKey('feishu-reply', 'om_1', 'ap_1')
  const c = idempotencyKey('feishu-reply', 'om_1', 'ap_2')
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('missing app scopes are recorded from real failures', async () => {
  const payload = JSON.stringify({
    ok: false,
    error: {
      code: 99991672,
      message: 'access denied: app has not applied for the required scope(s): im:chat:readonly, im:chat.members:read',
      missing_scopes: ['im:chat:readonly', 'im:chat.members:read'],
    },
  })
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    subprocess: {
      async resolveExecutable() { return 'lark-cli' },
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: payload }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
          terminate() {},
        }
      },
    },
  }
  const cli = new LarkCli(ctx, { cwd: '/tmp' })
  await cli.run(['im', '+chat-members-list'])
  const scopes = cli.scopeReport().map(entry => entry.scope)
  assert.ok(scopes.includes('im:chat:readonly'), `scopes: ${scopes.join(',')}`)
  assert.ok(scopes.includes('im:chat.members:read'))
  assert.ok(cli.scopeReport().every(entry => entry.command.startsWith('im +chat-members-list')))
})
