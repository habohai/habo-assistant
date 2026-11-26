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

import { decideReply } from './format/decide.js'
import { normalizeMentions, sanitizeForPost } from './format/sanitize.js'
import type { Logger, SubprocessLike, SubprocessOutcome } from './types.js'

const OUTPUT_LIMIT_BYTES = 256 * 1024
const DEFAULT_CHAT_LIST_TTL_MS = 5 * 60_000

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
  chatListTtlMs?: number
  dryRun?: boolean
  logger?: Pick<Logger, 'info' | 'debug' | 'warn'>
}

/** Parse the first complete JSON object, ignoring CLI progress/log lines around it. */
function parseCliJson<T>(stdout: string): T {
  const text = stdout.trim()
  try {
    return JSON.parse(text) as T
  } catch {
    const start = text.indexOf('{')
    if (start === -1) throw new Error(`lark-cli did not return JSON: ${text.slice(0, 120)}`)
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) return JSON.parse(text.slice(start, index + 1)) as T
      }
    }
    throw new Error(`lark-cli returned incomplete JSON: ${text.slice(0, 120)}`)
  }
}

/**
 * Pull the created message id out of a `lark-cli` success envelope.
 * @param {string} stdout
 * @returns {string | undefined}
 */
export function parseMessageId(stdout: string): string | undefined {
  try {
    const parsed = parseCliJson(stdout) as { data?: { message_id?: unknown }; message_id?: unknown }
    const id = parsed?.data?.message_id ?? parsed?.message_id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Stable idempotency key for one logical send.
 *
 * Feishu caps `uuid` at 50 characters, so the key is a hash of the identifying
 * parts: retries of the same send reuse it (no duplicate message), while two
 * different sends never collide.
 */
export function idempotencyKey(prefix: string, ...parts: string[]): string {
  const joined = parts.join('|')
  let hash = 0
  for (let index = 0; index < joined.length; index += 1) {
    hash = (hash * 31 + joined.charCodeAt(index)) % 2_147_483_647
  }
  return `${prefix}-${hash.toString(36)}`
}

export class LarkCli {
  private readonly ctx: LarkContext
  private readonly name: string
  private readonly profile?: string
  private readonly cwd: string
  private readonly timeoutMs: number
  private readonly chatListTtlMs: number
  private readonly dryRun: boolean
  private readonly logger?: Pick<Logger, 'info' | 'debug' | 'warn'>
  private executable: string | undefined
  private resolving: Promise<string> | undefined
  private editSupport: boolean | undefined
  private readonly chatNames: Map<string, string>
  private chatList: ChatSummary[] | undefined
  private chatListAt: number
  private readonly peerNames: Map<string, string>
  /** Scopes this app is missing, learned from real failures. */
  private readonly missingScopes: Map<string, { at: number; command: string }>

  constructor(ctx: LarkContext, { name = 'lark-cli', profile, cwd, timeoutMs = 15_000, chatListTtlMs = DEFAULT_CHAT_LIST_TTL_MS, dryRun = false, logger }: LarkOptions) {
    this.ctx = ctx
    this.name = name
    this.profile = profile
    this.cwd = cwd
    this.timeoutMs = timeoutMs
    this.chatListTtlMs = chatListTtlMs
    this.dryRun = dryRun
    this.logger = logger
    this.executable = undefined
    this.resolving = undefined
    this.editSupport = undefined
    this.chatNames = new Map()
    this.chatList = undefined
    this.chatListAt = 0
    this.peerNames = new Map()
    this.missingScopes = new Map()
  }

  /** Resolve the executable once; a failure clears the cache for the next try. */
  /** Remember which scopes this app lacks, so the UI can say so instead of guessing. */
  private recordScopeError(payload: string, args: string[]): void {
    const scopes = [...payload.matchAll(/"([a-z][a-z0-9_.]*:[a-z0-9_.:]+)"/g)]
      .map(match => match[1] as string)
      .filter(scope => scope.includes(':'))
    if (scopes.length === 0 && !payload.includes('99991672')) return
    const command = args.slice(0, 3).join(' ')
    for (const scope of new Set(scopes)) {
      if (this.missingScopes.has(scope)) continue
      this.missingScopes.set(scope, { at: Date.now(), command })
      this.logger?.warn?.(`feishu-bot: app is missing scope "${scope}" (needed by ${command})`)
    }
  }

  /** Scopes this app is known to be missing, from actual failures. */
  scopeReport(): Array<{ scope: string; command: string; at: number }> {
    return [...this.missingScopes.entries()]
      .map(([scope, value]) => ({ scope, command: value.command, at: value.at }))
      .sort((a, b) => a.scope.localeCompare(b.scope))
  }

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
        this.recordScopeError(stderr, args)
        throw Object.assign(
          new Error(`lark-cli ${args.slice(0, 3).join(' ')} failed (${outcome.exitCode}): ${stderr.slice(0, 500)}`),
          { code: 'CLI_FAILED', stderr },
        )
      }
      // lark-cli exits 0 for some API-level failures; the payload names the scope.
      if (stdout.includes('99991672') || stdout.includes('has not applied for the required scope')) {
        this.recordScopeError(stdout, args)
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
    if (!force && this.chatList !== undefined && now - this.chatListAt < this.chatListTtlMs) return this.chatList
    const merged = new Map<string, ChatSummary>()
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run(['im', '+chat-list', '--as', identity, '--page-size', '100', '--json'])
        const parsed = parseCliJson(stdout) as { data?: { chats?: Array<{ chat_id?: unknown; name?: unknown }> } }
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

  /** Resolve the human peer name of a p2p chat from its recent messages. */
  async peerName(chatId: string): Promise<string | undefined> {
    const cached = this.peerNames.get(chatId)
    if (cached !== undefined) return cached
    try {
      const { stdout } = await this.run([
        'im', '+chat-messages-list',
        '--as', 'bot',
        '--chat-id', chatId,
        '--order', 'desc',
        '--page-size', '20',
        '--json',
      ])
      const parsed = parseCliJson(stdout) as { data?: { messages?: Array<{ sender?: { sender_type?: unknown; name?: unknown } }> } }
      for (const message of parsed.data?.messages ?? []) {
        const sender = message.sender
        if (sender?.sender_type !== 'user') continue
        if (typeof sender.name !== 'string' || sender.name.trim() === '') continue
        this.peerNames.set(chatId, sender.name.trim())
        return sender.name.trim()
      }
    } catch (error) {
      this.logger?.debug?.(`feishu-bot: cannot resolve peer name for ${chatId}: ${String(error)}`)
    }
    return undefined
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

  /** Resolve a thread's parent chat; thread ids alone do not carry a chat id. */
  /**
   * Newest message id in one topic, used as the reply anchor.
   *
   * `+messages-send` cannot target a thread, so posting into a topic means
   * replying to a message that already lives there.
   */
  async threadLatestMessage(threadId: string): Promise<string | undefined> {
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run([
          'im', '+threads-messages-list',
          '--thread', threadId,
          '--page-size', '1',
          '--order', 'desc',
          '--no-reactions',
          '--as', identity,
          '--json',
        ])
        const parsed = parseCliJson(stdout) as { data?: { messages?: Array<{ message_id?: unknown }> } }
        const id = parsed.data?.messages?.[0]?.message_id
        if (typeof id === 'string' && id !== '') return id
      } catch {
        // Try the next identity; the caller falls back to a plain send.
      }
    }
    return undefined
  }

  async threadContext(threadId: string): Promise<{ chatId: string; threadId: string } | undefined> {
    let lastError: unknown
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run([
          'im', '+threads-messages-list',
          '--thread', threadId,
          '--page-size', '1',
          '--no-reactions',
          '--as', identity,
          '--json',
        ])
        const parsed = parseCliJson(stdout) as { data?: { messages?: Array<{ chat_id?: unknown; thread_id?: unknown }> } }
        const message = parsed.data?.messages?.[0]
        if (message === undefined || typeof message.chat_id !== 'string' || message.chat_id === '') return undefined
        return {
          chatId: message.chat_id,
          threadId: typeof message.thread_id === 'string' && message.thread_id !== '' ? message.thread_id : threadId,
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('cannot read thread context')
  }

  /** Recent topics visible in a chat, keyed by omt_ thread id. */
  async listTopics(chatId: string): Promise<Array<{ threadId: string; title: string; updatedAt: number }>> {
    let lastError: unknown
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run([
          'im', '+chat-messages-list',
          '--chat-id', chatId,
          '--as', identity,
          '--order', 'desc',
          '--page-size', '50',
          '--no-reactions',
          '--json',
        ])
        const parsed = parseCliJson(stdout) as { data?: { messages?: Array<{ thread_id?: unknown; content?: unknown; create_time?: unknown }> } }
        const topics = new Map<string, { threadId: string; title: string; updatedAt: number }>()
        for (const message of parsed.data?.messages ?? []) {
          if (typeof message.thread_id !== 'string' || !message.thread_id.startsWith('omt_')) continue
          if (topics.has(message.thread_id)) continue
          const raw = typeof message.content === 'string' ? message.content : ''
          const title = raw.replace(/@_user_\d+/g, ' ').replace(/[#*`>\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30)
          const updatedAt = typeof message.create_time === 'string' ? Date.parse(message.create_time.replace(' ', 'T')) || 0 : 0
          topics.set(message.thread_id, { threadId: message.thread_id, title: title === '' ? '话题' : title, updatedAt })
        }
        const list = [...topics.values()].sort((left, right) => right.updatedAt - left.updatedAt)
        if (list.length > 0 || identity === 'user') return list
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('cannot list topics')
  }

  /** Resolve the chat/topic context of one message (used for reply-to-topic claims). */
  /**
   * Display name of the person who sent a message.
   *
   * Feishu returns `sender_name` on read APIs, so this needs no contact scope —
   * which matters because these apps do not have one.
   */
  async senderName(messageId: string): Promise<string | undefined> {
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run([
          'im', '+messages-mget',
          '--message-ids', messageId,
          '--as', identity,
          '--json',
        ])
        const parsed = parseCliJson(stdout) as {
          data?: { messages?: Array<{ sender?: { name?: unknown; sender_name?: unknown } }> }
        }
        const sender = parsed.data?.messages?.[0]?.sender
        const name = typeof sender?.name === 'string' ? sender.name.trim() : ''
        if (name !== '') return name
        const raw = typeof sender?.sender_name === 'string' ? sender.sender_name.trim() : ''
        if (raw !== '') return raw
      } catch {
        // Fall through to the next identity; a name is cosmetic, never fatal.
      }
    }
    return undefined
  }

  async messageContext(messageId: string): Promise<{ chatId: string; threadId: string } | undefined> {
    let lastError: unknown
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run([
          'im', '+messages-mget',
          '--message-ids', messageId,
          '--as', identity,
          '--json',
        ])
        const parsed = parseCliJson(stdout) as { data?: { messages?: Array<{ chat_id?: unknown; thread_id?: unknown }> } }
        const message = parsed.data?.messages?.[0]
        if (message === undefined || typeof message.chat_id !== 'string' || message.chat_id === '') return undefined
        return {
          chatId: message.chat_id,
          threadId: typeof message.thread_id === 'string' ? message.thread_id : '',
        }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('cannot read message context')
  }

  /**
   * Check whether this app may read group members.
   *
   * Runs one cheap bot call so a missing scope is reported at startup instead of
   * surfacing later as "the bot ignored my approval".
   */
  async probeMemberScope(chatId: string): Promise<{ ok: boolean; identity?: 'bot' | 'user' }> {
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run([
          'im', '+chat-members-list',
          '--chat-id', chatId,
          '--as', identity,
          '--page-size', '1',
          '--json',
        ])
        // lark-cli exits 0 for API-level failures, so the payload decides.
        const parsed = parseCliJson(stdout) as { ok?: unknown }
        if (parsed.ok === false) continue
        return { ok: true, identity }
      } catch {
        // Try the next identity: a bot without member scope may still have a
        // signed-in user token, which is the normal case for this deployment.
      }
    }
    return { ok: false }
  }

  /** Union ids of the users in a group (stable across bot apps). */
  async chatMemberUnionIds(chatId: string): Promise<Set<string>> {
    let lastError: unknown
    for (const identity of ['bot', 'user'] as const) {
      try {
        const { stdout } = await this.run([
          'im', '+chat-members-list',
          '--chat-id', chatId,
          '--as', identity,
          '--member-id-type', 'union_id',
          '--page-all',
          '--json',
        ])
        const parsed = parseCliJson(stdout) as { data?: { users?: Array<{ member_id?: unknown }> } }
        return new Set((parsed.data?.users ?? [])
          .map(user => user.member_id)
          .filter((id): id is string => typeof id === 'string' && id !== ''))
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('cannot list group members')
  }

  /** Send a reply: post for supported Markdown, plain text otherwise. */
  async replyFormatted(messageId: string, text: string, { inThread = false, keySuffix = '0' }: { inThread?: boolean; keySuffix?: string } = {}): Promise<string | undefined> {
    const plan = decideReply(text)
    // Mentions and control characters must be fixed before the payload is built,
    // or Feishu rejects the post as invalid rich text.
    const body = plan.kind === 'post' ? sanitizeForPost(normalizeMentions(text, 'post')) : normalizeMentions(text, 'text')
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: reply ${plan.kind} to ${messageId}: ${body}`)
      return undefined
    }
    const args = (kind: 'text' | 'post'): string[] => [
      'im', '+messages-reply',
      '--message-id', messageId,
      ...(kind === 'post' ? ['--markdown', body] : ['--text', body]),
      '--as', 'bot',
      '--idempotency-key', idempotencyKey('feishu-reply', messageId, keySuffix),
      ...(inThread === true ? ['--reply-in-thread'] : []),
    ]
    const startedAt = Date.now()
    try {
      const { stdout } = await this.run(args(plan.kind))
      this.logSend('reply', plan.kind, text, false, startedAt)
      return parseMessageId(stdout)
    } catch (error) {
      // Feishu can reject a post payload this CLI produced; the answer still has
      // to arrive, so degrade to plain text before giving up.
      if (plan.kind !== 'post') throw error
      this.logger?.warn?.(`feishu-bot: post reply rejected, retrying as text: ${String(error)}`)
      const { stdout } = await this.run(args('text'))
      this.logSend('reply', 'text', text, true, startedAt)
      return parseMessageId(stdout)
    }
  }

  async reply(messageId: string, text: string, options: { inThread?: boolean; keySuffix?: string } = {}): Promise<string | undefined> {
    return this.replyFormatted(messageId, text, options)
  }

  /** Replace the text of a message the bot sent. */
  async edit(messageId: string, text: string): Promise<boolean> {
    // lark-cli >= 1.0.100 can edit into a rich-text message, so the placeholder
    // must use the same transport decision as a fresh reply; plain `--text`
    // would leave Markdown markers visible.
    const plan = decideReply(text)
    const body = plan.kind === 'post' ? sanitizeForPost(normalizeMentions(text, 'post')) : normalizeMentions(text, 'text')
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: edit ${messageId} as ${plan.kind}: ${body}`)
      return true
    }
    await this.run([
      'im', '+messages-edit',
      '--message-id', messageId,
      ...(plan.kind === 'post' ? ['--markdown', body] : ['--text', body]),
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

  /** Send a fresh message into a chat, choosing post for supported Markdown. */
  async send(chatId: string, text: string, keySuffix = '0'): Promise<string | undefined> {
    const plan = decideReply(text)
    const body = plan.kind === 'post' ? sanitizeForPost(normalizeMentions(text, 'post')) : normalizeMentions(text, 'text')
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: send ${plan.kind} to ${chatId}: ${body}`)
      return undefined
    }
    const args = (kind: 'text' | 'post'): string[] => [
      'im', '+messages-send',
      '--chat-id', chatId,
      ...(kind === 'post' ? ['--markdown', body] : ['--text', body]),
      '--as', 'bot',
      '--idempotency-key', idempotencyKey('feishu-send', chatId, keySuffix),
    ]
    const startedAt = Date.now()
    try {
      const { stdout } = await this.run(args(plan.kind))
      this.logSend('send', plan.kind, text, false, startedAt)
      return parseMessageId(stdout)
    } catch (error) {
      if (plan.kind !== 'post') throw error
      this.logger?.warn?.(`feishu-bot: post send rejected, retrying as text: ${String(error)}`)
      const { stdout } = await this.run(args('text'))
      this.logSend('send', 'text', text, true, startedAt)
      return parseMessageId(stdout)
    }
  }

  /** One structured line per outbound message, so routing is explainable. */
  private logSend(op: 'send' | 'reply', kind: 'text' | 'post', text: string, degraded: boolean, startedAt: number): void {
    this.logger?.debug?.(JSON.stringify({
      event: 'feishu.message',
      op,
      kind,
      degraded,
      chars: typeof text === 'string' ? text.length : 0,
      ms: Date.now() - startedAt,
    }))
  }

  /**
   * Send an interactive card into a chat.
   *
   * Used for approvals, where buttons replace the "reply 同意/拒绝" round trip.
   * A caller that cannot render a card keeps the text prompt as its fallback.
   */
  async sendCard(chatId: string, card: unknown, keySuffix = '0'): Promise<string | undefined> {
    if (this.dryRun) {
      this.logger?.info(`feishu-bot[dry-run]: send card to ${chatId}`)
      return undefined
    }
    const { stdout } = await this.run([
      'im', '+messages-send',
      '--chat-id', chatId,
      '--msg-type', 'interactive',
      '--content', JSON.stringify(card),
      '--as', 'bot',
      '--idempotency-key', idempotencyKey('feishu-card', chatId, keySuffix),
    ])
    return parseMessageId(stdout)
  }

  /**
   * Replace a clicked card in place.
   *
   * The callback token is short-lived and permits a bounded number of updates;
   * failure is logged by the caller and never affects the approval outcome.
   */
  async updateCard(token: string, card: unknown): Promise<boolean> {
    if (this.dryRun) {
      this.logger?.info('feishu-bot[dry-run]: update card')
      return true
    }
    await this.run([
      'api', 'POST', '/open-apis/interactive/v1/card/update',
      '--as', 'bot',
      '--data', JSON.stringify({ token, card: { type: 'raw', data: card } }),
    ])
    return true
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
