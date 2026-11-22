import assert from 'node:assert/strict'
import test from 'node:test'
import { LarkCli } from '../lib/index.js'

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
