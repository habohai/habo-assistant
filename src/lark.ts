/**
 * Thin `lark-cli` wrapper.
 *
 * The plugin talks to Feishu through the already-authenticated CLI, which
 * means every call costs one process spawn (a few hundred milliseconds) plus
 * the HTTP round trip. Two rules follow from that:
 *
 * 1. the executable is resolved once and cached;
 * 2. every call has a deadline, so a hung CLI can never wedge the queue.
 *
 * Replies carry an idempotency key derived from the triggering message, so a
 * retried send is collapsed by Feishu instead of duplicating the answer.
 */

import type { Logger, SubprocessLike, SubprocessOutcome } from './types.js'

const OUTPUT_LIMIT_BYTES = 64 * 1024
const CHAT_LIST_TTL_MS = 30_000

export interface ChatSummary {
  chatId: string
  name: string
  botMember: boolean
}

export interface LarkContext {
  subprocess: SubprocessLike
}

export interface LarkOptions {
  name?: string
  profile?: string
  cwd: string
  timeoutMs?: number
  dryRun?: boolean
  logger?: Pick<Logger, 'info' | 'debug' | 'warn'>
}

/**
 * Pull the created message id out of a `lark-cli` success envelope.
 * @param {string} stdout
 * @returns {string | undefined}
 */
export function parseMessageId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { data?: { message_id?: unknown }; message_id?: unknown }
    const id = parsed?.data?.message_id ?? parsed?.message_id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

export class LarkCli {
  private readonly ctx: LarkContext
  private readonly name: string
  private readonly profile?: string
  private readonly cwd: string
  private readonly timeoutMs: number
  private readonly dryRun: boolean
  private readonly logger?: Pick<Logger, 'info' | 'debug' | 'warn'>
  private executable: string | undefined
  private resolving: Promise<string> | undefined
  private editSupport: boolean | undefined
  private readonly chatNames: Map<string, string>
  private chatList: ChatSummary[] | undefined
  private chatListAt: number

  constructor(ctx: LarkContext, { name = 'lark-cli', profile, cwd, timeoutMs = 15_000, dryRun = false, logger }: LarkOptions) {
    this.ctx = ctx
    this.name = name
    this.profile = profile
    this.cwd = cwd
    this.timeoutMs = timeoutMs
    this.dryRun = dryRun
    this.logger = logger
    this.executable = undefined
    this.resolving = undefined
    this.editSupport = undefined
    this.chatNames = new Map()
    this.chatList = undefined
    this.chatListAt = 0
  }

  /** Resolve the executable once; a failure clears the cache for the next try. */
  async resolve(): Promise<string> {
    if (this.executable !== undefined) return this.executable
    if (this.resolving !== undefined) return this.resolving
    this.resolving = this.ctx.subprocess.resolveExecutable(this.name)
      .then(executable => {
        this.executable = executable
        return executable
      })
      .finally(() => {
        this.resolving = undefined
      })
    return this.resolving
  }

  /**
   * Run one CLI command and return its bounded output.
   * @param {string[]} args
   * @param {{ timeoutMs?: number }} [options]
   */
  async run(args: string[], { timeoutMs = this.timeoutMs }: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const executable = await this.resolve()
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...(this.profile === undefined ? [] : ['--profile', this.profile]), ...args],
      cwd: this.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
        stderr: { maxBytes: OUTPUT_LIMIT_BYTES },
      },
      graceMs: 5000,
    })
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timer = undefined
        try {
          handle.terminate()
        } catch {
          // Termination is best-effort; the rejection below is the contract.
        }
        reject(Object.assign(new Error(`lark-cli timed out after ${timeoutMs}ms`), { code: 'CLI_TIMEOUT' }))
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      const outcome = await Promise.race<SubprocessOutcome>([handle.done, deadline])
      const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
      if (outcome.exitCode !== 0) {
        throw Object.assign(
          new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed (${outcome.exitCode}): ${stderr.slice(0, 500)}`),
          { code: 'CLI_FAILED', stderr },
        )
      }
      return { stdout, stderr }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Reply to a message.
   * @param {string} messageId
   * @param {string} text
   * @param {{ inThread?: boolean, keySuffix?: string }} [options]
   * @returns {Promise<string | undefined>} the created message id, when known.
   */
  /**
   * Groups visible to the bot or the signed-in user, merged by chat id.
   * `botMember` is the binding gate: a bot-only chat cannot receive events.
   */
  async listChats(force = false): Promise<ChatSummary[]> {
    const now = Date.now()
    if (!force && this.chatList !== undefined && now - this.chatListAt < CHAT_LIST_TTL_MS) return this.chatList
    const merged = new Map<string, ChatSummary>()
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run(['im', '+chat-list', '--as', identity, '--page-size', '100', '--json'])
        const parsed = JSON.parse(stdout) as { data?: { chats?: Array<{ chat_id?: unknown; name?: unknown }> } }
        for (const chat of parsed.data?.chats ?? []) {
          if (typeof chat.chat_id !== 'string' || typeof chat.name !== 'string') continue
          const existing = merged.get(chat.chat_id)
          if (existing === undefined) {
            merged.set(chat.chat_id, { chatId: chat.chat_id, name: chat.name, botMember: identity === 'bot' })
          } else {
            if (identity === 'bot') existing.botMember = true
            if (existing.name === '') existing.name = chat.name
          }
          this.chatNames.set(chat.chat_id, chat.name)
        }
      } catch (error) {
        this.logger?.debug?.(`feishu-bot: cannot list chats as ${identity}: ${String(error)}`)
      }
    }
    this.chatList = [...merged.values()]
    this.chatListAt = now
    return this.chatList
  }

  /** Name plus whether the bot itself is a member. */
  async chatInfo(chatId: string, force = false): Promise<ChatSummary | undefined> {
    const chats = await this.listChats(force)
    const found = chats.find(chat => chat.chatId === chatId)
    if (found !== undefined) return found
    const name = this.chatNames.get(chatId)
    return name === undefined ? undefined : { chatId, name, botMember: false }
  }

  /** Resolve one group name through the short-lived chat list (renames show up after its TTL). */
  async chatName(chatId: string): Promise<string | undefined> {
    const chats = await this.listChats()
    return chats.find(chat => chat.chatId === chatId)?.name ?? this.chatNames.get(chatId)
  }

  async reply(messageId: string, text: string, { inThread = false, keySuffix = '0' }: { inThread?: boolean; keySuffix?: string } = {}): Promise<string | undefined> {
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: reply to ${messageId}: ${text}`)
      return undefined
    }
    const { stdout } = await this.run([
      'im', '+messages-reply',
      '--message-id', messageId,
      '--text', text,
      '--as', 'bot',
      '--idempotency-key', `feishu-${messageId.slice(0, 28)}-${keySuffix}`,
      ...(inThread === true ? ['--reply-in-thread'] : []),
    ])
    return parseMessageId(stdout)
  }

  /** Replace the text of a message the bot sent. */
  async edit(messageId: string, text: string): Promise<boolean> {
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: edit ${messageId}: ${text}`)
      return true
    }
    await this.run([
      'im', '+messages-edit',
      '--message-id', messageId,
      '--text', text,
      '--as', 'bot',
    ])
    return true
  }

  /**
   * Whether this CLI can edit a sent message (`+messages-edit`, lark-cli
   * >= 1.0.100). Older builds simply lack the subcommand, so the placeholder
   * feature degrades to a plain reply instead of failing per message.
   * @returns {Promise<boolean>}
   */
  async supportsEdit(): Promise<boolean> {
    if (this.editSupport !== undefined) return this.editSupport
    try {
      const { stdout } = await this.run(['im', '--help'])
      this.editSupport = stdout.includes('+messages-edit')
    } catch (error) {
      this.logger?.warn?.(`feishu-bot: cannot probe message editing: ${String(error)}`)
      this.editSupport = false
    }
    return this.editSupport ?? false
  }

  /** Send a fresh message into a chat (used for questions that have no parent). */
  async send(chatId: string, text: string): Promise<string | undefined> {
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: send to ${chatId}: ${text}`)
      return undefined
    }
    const { stdout } = await this.run([
      'im', '+messages-send',
      '--chat-id', chatId,
      '--text', text,
      '--as', 'bot',
    ])
    return parseMessageId(stdout)
  }

  /** React to a message (a sub-second acknowledgement that costs no message). */
  async react(messageId: string, emoji: string): Promise<boolean> {
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: react ${emoji} on ${messageId}`)
      return true
    }
    await this.run([
      'im', 'reactions', 'create',
      '--params', JSON.stringify({ message_id: messageId }),
      '--data', JSON.stringify({ reaction_type: { emoji_type: emoji } }),
      '--as', 'bot',
    ])
    return true
  }

  /** Recall a message the bot sent (used to clean up an unusable placeholder). */
  async withdraw(messageId: string): Promise<boolean> {
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: withdraw ${messageId}`)
      return true
    }
    await this.run([
      'im', 'messages', 'delete',
      '--params', JSON.stringify({ message_id: messageId }),
      '--yes',
      '--as', 'bot',
    ])
    return true
  }
}
