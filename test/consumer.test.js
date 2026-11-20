import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { FeishuBot, normalizeConfig } from '../lib/index.js'

/**
 * End-to-end wiring test: a fake `lark-cli` that speaks the same long-connection
 * protocol (NDJSON on stdout, ready marker on stderr) so `start()` itself is
 * exercised — the watchdog, the readline plumbing, and the event hot path.
 */
function createStreamingHarness() {
  /** @type {Array<{ argv: string[], handle: Record<string, unknown> }>} */
  const spawned = []
  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    subprocess: {
      async resolveExecutable() {
        return '/fake/lark-cli'
      },
      spawn(request) {
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        // Only `event consume` is long-lived; every other CLI call finishes at once.
        const longLived = request.argv[1] === 'event'
        let settle
        const done = new Promise(resolve => {
          settle = resolve
        })
        if (!longLived) queueMicrotask(() => settle({ exitCode: 0, signal: null }))
        const handle = {
          stdout,
          stderr,
          stdin: new PassThrough(),
          done,
          collected: { stdout: { readFrom: () => ({ text: JSON.stringify({ ok: true, data: { message_id: 'om_sent' } }) }) } },
          terminate() {
            stdout.end()
            stderr.end()
            settle({ exitCode: 0, signal: null })
          },
        }
        spawned.push({ argv: request.argv, handle })
        return handle
      },
    },
    sessionController: {
      async create() {
        return { sessionId: 'ses_1' }
      },
      async rename() {
        return {}
      },
      async prompt(request) {
        this.lastPrompt = request
      },
      cancel() {},
    },
    get() {
      return undefined
    },
    on() {},
    effect() {},
  }
  return { ctx, spawned }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

test('start() consumes NDJSON events over the long connection and answers', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'feishu-bot-consumer-'))
  const { ctx, spawned } = createStreamingHarness()
  const bot = new FeishuBot(ctx, normalizeConfig({ cwd: '/tmp', allowChats: ['oc_1'], stateDir }))
  try {
    const started = bot.start()
    await waitFor(() => bot.consumer !== undefined)
    const consumer = spawned.find(entry => entry.argv[1] === 'event').handle
    consumer.stderr.write('[event] ready event_key=im.message.receive_v1\n')
    await waitFor(() => bot.ready)
    await started

    consumer.stdout.write(`${JSON.stringify({
      chat_id: 'oc_1',
      chat_type: 'group',
      message_id: 'om_1',
      sender_type: 'user',
      sender_id: 'ou_1',
      message_type: 'text',
      content: '@_user_1 你好',
      mentions: [{ id: 'ou_bot' }],
    })}\n`)

    await waitFor(() => ctx.sessionController.lastPrompt !== undefined)
    bot.onSessionEvent({ id: 'ses_1' }, { type: 'turn/start', data: { turn: 1 } })
    bot.onSessionEvent({ id: 'ses_1' }, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '你好呀' }] } } })
    bot.onSessionEvent({ id: 'ses_1' }, { type: 'turn/end', data: { turn: 1 } })
    await bot.queue.idle()

    const reply = spawned.find(entry => entry.argv.includes('+messages-reply'))
    assert.ok(reply, 'a reply should have been sent')
    assert.equal(reply.argv[reply.argv.indexOf('--text') + 1], '你好呀')
    assert.equal(bot.metrics.snapshot().counts.jobsSucceeded, 1)
  } finally {
    await bot.dispose()
    await rm(stateDir, { recursive: true, force: true })
  }
})
