/**
 * Host-only Feishu group bot bridge for DeepSeek Harness.
 *
 * One `lark-cli event consume` long connection feeds this plugin; every
 * accepted @-message is routed to the DSH session bound to its chat (or
 * chat+thread), driven through `ctx.sessionController`, and answered back on
 * the triggering message.
 *
 * The design keeps ingress latency and agent throughput independent:
 *
 * - the event loop only parses, filters, de-duplicates, and enqueues — it never
 *   awaits an agent turn, so a slow answer cannot stall message intake;
 * - a placeholder reply goes out immediately (and is later edited into the real
 *   answer) so the group sees feedback in about one CLI round trip, while the
 *   turn itself may take minutes;
 * - `KeyedQueue` bounds concurrency and per-chat backlog, so a burst degrades
 *   into an explicit "queue is full" reply instead of exhausting the host.
 *
 * Everything here is dependency-free: DSH services are injected by Cordis and
 * the only imports are Node builtins plus this package's `src/` modules.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { ExecLike } from './src/approval.js'
import type { Config } from './src/config.js'
import type { FeishuEvent } from './src/event.js'
import type { HostContext, Job, SessionEventLike, SessionLike, SubprocessHandle, WorkspaceLike } from './src/types.js'
import { parseApprovalReply } from './src/approval.js'
import { BindingRegistry, BotBindings } from './src/binding-registry.js'
import { configProblem, normalizeConfig } from './src/config.js'
import { SeenStore } from './src/dedup.js'
import { acceptEvent, bindingKey, cleanMessageText, readFeishuEvent } from './src/event.js'
import { LarkCli } from './src/lark.js'
import { Metrics } from './src/metrics.js'
import { ChatDirectory } from './src/chat-directory.js'
import { artifactsProjection } from './src/artifacts-projection.js'
import { taskProjection } from './src/task-projection.js'
import { isStopCommand, privateSessionTitle, sessionTitle, splitReply } from './src/text.js'
import { KeyedQueue } from './src/work.js'

/** Feishu event key consumed by the bot. */
export const EVENT_KEY = 'im.message.receive_v1'
/** Ready marker lark-cli writes to stderr once the subscription is live. */
const READY_MARKER = '[event] ready'
/** Shown while the agent works; replaced by the real answer when it lands. */
const PLACEHOLDER_TEXT = '🤔 收到，正在处理…'
const MAX_BACKOFF_MS = 15_000
const BACKOFF_JITTER = 0.2

export { DEFAULT_DENY_PATTERNS, approvalDecision, compileDenyPatterns, isDangerousCommand, parseApprovalReply, summarizeCommand } from './src/approval.js'
export { BindingRegistry } from './src/binding-registry.js'
export { ChatDirectory } from './src/chat-directory.js'
export { DEFAULTS, configProblem, normalizeConfig } from './src/config.js'
export { SeenStore } from './src/dedup.js'
export { acceptEvent, bindingKey, cleanMessageText, readFeishuEvent } from './src/event.js'
export { LarkCli, parseMessageId } from './src/lark.js'
export { Metrics, percentile } from './src/metrics.js'
export { isStopCommand, privateSessionTitle, sessionTitle, splitReply } from './src/text.js'
export { KeyedQueue, Semaphore } from './src/work.js'
export { taskProjection } from './src/task-projection.js'
export { artifactsProjection } from './src/artifacts-projection.js'

/** First non-empty string of the candidates. */
function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface BotServices {
  registry?: BindingRegistry
  seen?: SeenStore
  chats?: ChatDirectory
  botNames?: ReadonlyMap<string, string>
}

interface PendingTurn {
  chatId: string
  turn?: number
  parts: string[]
  resolve(value: string): void
  reject(error: unknown): void
  timer?: NodeJS.Timeout
}

interface ApprovalRequest {
  agent?: { session?: { id?: string } }
  reason?: string
  displayReason?: unknown
  signal?: AbortSignal
}

interface ApprovalEntry {
  chatId: string
  sessionId: string
  resolve(outcome: ApprovalOutcome): void
  timer?: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

/** One Feishu bridge instance owned by the plugin fiber. */
export class FeishuBot {
  readonly ctx: HostContext
  readonly config: Config
  private readonly routing: 'chat' | 'thread'
  readonly registry: BotBindings
  readonly seen: SeenStore
  readonly metrics: Metrics
  private readonly cli: LarkCli
  readonly queue: KeyedQueue<Job>
  readonly pending: Map<string, PendingTurn>
  private consumer: SubprocessHandle | undefined
  private readyTimer: NodeJS.Timeout | undefined
  private statsTimer: NodeJS.Timeout | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private restartDelay: number
  private ready: boolean
  private stopping: boolean
  private lastStatsSignature: string
  /** Dangerous-command patterns, compiled once at mount. */
  /** Sessions this plugin owns: only these get command approval. */
  private readonly botSessions: Set<string>
  /** sessionId -> chatId, so an approval can be asked in the right chat. */
  private readonly sessionChats: Map<string, Set<string>>
  /** chatId -> pending approval entry (at most one per chat). */
  readonly approvals: Map<string, ApprovalEntry>
  /** Filled by the startup probe: only newer lark-cli builds can edit a sent message. */
  private canEdit: boolean
  private reactionFailures: number
  private reactionOff: boolean
  private lastEventAt: number
  private readonly sessionLookup: Map<string, { at: number; sessionId?: string }>
  private readonly digestCache: Map<string, { at: number; summary: string; large: boolean }>
  private readonly privateTitles: Map<string, string>
  private readonly manualPrivateTitles: Set<string>
  private readonly botNames: ReadonlyMap<string, string>
  /** Runtime chat admission; profile allowChats stays in config. */
  private readonly chats: ChatDirectory

  constructor(ctx: HostContext, config: Config, services: BotServices = {}) {
    this.ctx = ctx
    this.config = config
    this.routing = config.routing
    const botId = config.botId ?? config.botOpenId ?? config.botName ?? 'default'
    this.registry = new BotBindings(services.registry ?? new BindingRegistry(config.stateDir, botId), botId)
    this.seen = services.seen ?? new SeenStore(join(config.stateDir, 'seen.jsonl'), { logger: ctx.logger })
    this.metrics = new Metrics()
    this.cli = new LarkCli(ctx, {
      name: config.larkCli,
      ...(config.larkProfile === undefined ? {} : { profile: config.larkProfile }),
      cwd: config.cwd,
      timeoutMs: config.cliTimeoutMs,
      chatListTtlMs: config.chatListTtlMs,
      dryRun: config.dryRun,
      logger: ctx.logger,
    })
    this.queue = new KeyedQueue<Job>({
      maxConcurrent: config.maxConcurrent,
      maxQueue: config.maxQueue,
      run: (key, job) => this.runJob(key, job),
      onError: (key, error) => this.ctx.logger.error(`feishu-bot: job for ${key} crashed: ${String(error)}`),
    })
    this.pending = new Map()
    this.consumer = undefined
    this.readyTimer = undefined
    this.statsTimer = undefined
    this.restartTimer = undefined
    this.restartDelay = 1000
    this.ready = false
    this.stopping = false
    this.lastStatsSignature = ''
    this.botSessions = new Set()
    this.sessionChats = new Map()
    this.approvals = new Map()
    this.canEdit = false
    this.reactionFailures = 0
    this.reactionOff = false
    this.lastEventAt = 0
    this.sessionLookup = new Map()
    this.digestCache = new Map()
    this.privateTitles = new Map()
    this.manualPrivateTitles = new Set()
    this.botNames = services.botNames ?? new Map([[botId, config.botName]])
    this.chats = services.chats ?? new ChatDirectory(config.stateDir)
  }

  async start(): Promise<void> {
    await Promise.all([this.registry.ready, this.chats.ready, this.seen.load()])
    if (this.stopping) return
    const problem = configProblem(this.config)
    if (problem !== undefined) {
      this.ctx.logger.warn(`feishu-bot: ${problem}; consumer not started`)
      return
    }
    void this.cli.listChats().catch(error => this.ctx.logger.debug(`feishu-bot: chat prefetch failed: ${String(error)}`))
    this.canEdit = await this.cli.supportsEdit()
    if (this.config.progress && !this.canEdit) {
      this.ctx.logger.warn('feishu-bot: lark-cli cannot edit messages (+messages-edit, needs >= 1.0.100); placeholder replies are disabled')
    }
    for (const [key, record] of this.registry.entries()) {
      if (record.sessionId === undefined) continue
      this.trackSession(record.sessionId, key.split('::')[0])
    }
    this.installApprovalGate()
    this.ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })
    this.statsTimer = setInterval(() => this.logStats(), this.config.statsIntervalMs)
    this.statsTimer.unref?.()
    this.startConsumer()
  }

  async dispose(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
    if (this.statsTimer !== undefined) clearInterval(this.statsTimer)
    this.restartTimer = undefined
    this.readyTimer = undefined
    this.statsTimer = undefined
    // A reload drops the approval listener; without cancelling, the turn keeps
    // running as a zombie and every later tool call fails closed for no reason.
    for (const sessionId of this.pending.keys()) {
      try {
        this.ctx.sessionController.cancel({ sessionId })
      } catch {
        // Cancellation is best-effort; rejecting the waiter still unblocks the job.
      }
    }
    for (const pending of this.pending.values()) pending.reject(new Error('feishu-bot disposed'))
    this.pending.clear()
    for (const chatId of [...this.approvals.keys()]) this.settleApproval(chatId, 'cancelled')
    this.queue.close()
    this.consumer?.terminate()
    this.consumer = undefined
    this.logStats()
    await this.seen.dispose()
  }

  async startConsumer(): Promise<void> {
    if (this.stopping) return
    let executable
    try {
      executable = await this.cli.resolve()
    } catch (error) {
      this.ctx.logger.error(`feishu-bot: cannot resolve ${this.config.larkCli}: ${String(error)}`)
      this.scheduleRestart()
      return
    }
    let handle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [executable, ...(this.config.larkProfile === undefined ? [] : ['--profile', this.config.larkProfile]), 'event', 'consume', EVENT_KEY, '--as', 'bot'],
        cwd: this.config.cwd,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
        graceMs: 5000,
      })
    } catch (error) {
      this.ctx.logger.error(`feishu-bot: spawn failed: ${String(error)}`)
      this.scheduleRestart()
      return
    }
    if (this.stopping) {
      handle.terminate()
      return
    }
    this.consumer = handle
    this.ready = false
    this.armReadyWatchdog(handle)
    createInterface({ input: handle.stdout }).on('line', line => {
      this.onEventLine(line)
    })
    createInterface({ input: handle.stderr }).on('line', line => {
      if (line.includes(READY_MARKER)) {
        this.ready = true
        this.restartDelay = 1000
        if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
        this.readyTimer = undefined
        this.ctx.logger.info('feishu-bot: event consumer ready')
        return
      }
      this.ctx.logger.debug(`feishu-bot consumer: ${line}`)
    })
    handle.done.then(outcome => {
      this.ctx.logger.warn(`feishu-bot: consumer exited code=${outcome.exitCode} signal=${outcome.signal}`)
      this.onConsumerGone()
    }).catch(error => {
      this.ctx.logger.error(`feishu-bot: consumer failed: ${String(error)}`)
      this.onConsumerGone()
    })
  }

  /** A connection that never reports ready is worse than none: recycle it. */
  armReadyWatchdog(handle: SubprocessHandle): void {
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined
      if (this.ready || this.consumer !== handle) return
      this.metrics.inc('consumerUnready')
      this.ctx.logger.warn(`feishu-bot: consumer not ready within ${this.config.readyTimeoutMs}ms; restarting`)
      try {
        handle.terminate()
      } catch (error) {
        this.ctx.logger.debug(`feishu-bot: terminate failed: ${String(error)}`)
      }
    }, this.config.readyTimeoutMs)
    this.readyTimer.unref?.()
  }

  onConsumerGone(): void {
    this.ready = false
    this.consumer = undefined
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
    this.readyTimer = undefined
    this.metrics.inc('consumerExits')
    this.scheduleRestart()
  }

  scheduleRestart(): void {
    if (this.stopping || this.restartTimer !== undefined) return
    const jitter = 1 - BACKOFF_JITTER + Math.random() * BACKOFF_JITTER * 2
    const delay = Math.round(this.restartDelay * jitter)
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_BACKOFF_MS)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.startConsumer()
    }, delay)
    this.restartTimer.unref?.()
    this.metrics.inc('consumerRestarts')
  }

  /** Hot path: parse, admit, de-duplicate, enqueue. Never awaits the agent. */
  onEventLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let raw
    try {
      raw = JSON.parse(trimmed)
    } catch {
      this.ctx.logger.debug('feishu-bot: non-JSON event line')
      return
    }
    const event = readFeishuEvent(raw)
    if (event === undefined) return
    this.lastEventAt = Date.now()
    this.metrics.inc('eventsReceived')
    if (!this.seen.claim(`${this.config.botId}:${event.messageId}`)) {
      this.metrics.inc('deduped')
      return
    }
    const text = cleanMessageText(event.content, event.mentions, this.config.botOpenId)
    if (isStopCommand(text) && this.canControl(event.chatId)) {
      this.stopChat(event)
      return
    }
    if (this.handleApprovalReply(event, text)) return
    if (!this.isAllowedChat(event.chatId)) {
      if (!this.canEnableChat(event)) {
        this.metrics.inc('ignored')
        this.ctx.logger.debug(`feishu-bot: ignore unknown chat=${event.chatId} sender=${event.senderType}`)
        return
      }
      // The owner's first @ enables the group without editing the profile.
      this.metrics.inc('chatEnabled')
      this.ctx.logger.info(`feishu-bot: owner enabled chat ${event.chatId}`)
      void this.allowChat(event.chatId, event.chatType === 'p2p' ? 'p2p' : 'group').catch(error => {
        this.ctx.logger.warn(`feishu-bot: cannot persist enabled chat ${event.chatId}: ${String(error)}`)
      })
    }
    if (!acceptEvent(event, this.config, this.routing, true)) {
      this.metrics.inc('ignored')
      this.ctx.logger.debug(`feishu-bot: ignore chat=${event.chatId} type=${event.messageType}`)
      return
    }
    if (event.chatType === 'p2p') {
      void this.chats.markKind(event.chatId, 'p2p').catch(error => {
        this.ctx.logger.warn(`feishu-bot: cannot remember p2p chat ${event.chatId}: ${String(error)}`)
      })
    }
    if (text === '') {
      this.metrics.inc('emptyQuestion')
      this.fireReply(event, '请描述你的问题。')
      return
    }
    const key = bindingKey(event.chatId, event.threadKey, this.routing)
    if (!this.queue.push(key, { event, text, enqueuedAt: Date.now() })) {
      this.metrics.inc('queueRejected')
      this.fireReply(event, '当前排队较多，请稍后再试。')
      return
    }
    this.metrics.inc('jobsQueued')
    this.acknowledge(event)
  }

  /**
   * Sub-second feedback on the question itself. Skipped when a placeholder
   * reply will show the same thing, and backed off if the bot lacks the
   * reaction scope.
   */
  acknowledge(event: FeishuEvent): void {
    if (this.config.ackReaction === '' || this.reactionOff) return
    if (this.shouldPlaceholder()) return
    const startedAt = Date.now()
    this.cli.react(event.messageId, this.config.ackReaction)
      .then(() => {
        this.reactionFailures = 0
        this.metrics.observe('ackMs', Date.now() - startedAt)
      })
      .catch(error => {
        this.reactionFailures += 1
        this.metrics.inc('ackFailed')
        if (this.reactionFailures >= 3 && !this.reactionOff) {
          this.reactionOff = true
          this.ctx.logger.warn(`feishu-bot: reaction acknowledgement disabled after repeated failures: ${String(error)}`)
        } else {
          this.ctx.logger.debug(`feishu-bot: reaction failed: ${String(error)}`)
        }
      })
  }

  shouldPlaceholder(): boolean {
    return this.config.progress && this.canEdit
  }

  /** Best-effort reply from the hot path; never blocks or throws. */
  fireReply(event: FeishuEvent, text: string): void {
    if (this.stopping) return
    this.cli.reply(event.messageId, text, { inThread: this.inThread(event), keySuffix: 'note' })
      .catch(error => this.ctx.logger.warn(`feishu-bot: note reply failed: ${String(error)}`))
  }

  inThread(event: FeishuEvent): boolean {
    return this.config.replyInThread && event.threadKey !== ''
  }

  /** Track one owned session so command approvals can be routed to its chat. */
  trackSession(sessionId: string, chatId: string): void {
    this.botSessions.add(sessionId)
    let chats = this.sessionChats.get(sessionId)
    if (chats === undefined) {
      chats = new Set()
      this.sessionChats.set(sessionId, chats)
    }
    chats.add(chatId)
  }

  untrackSession(sessionId: string, chatId?: string): void {
    const chats = this.sessionChats.get(sessionId)
    if (chats === undefined) {
      this.botSessions.delete(sessionId)
      return
    }
    if (chatId === undefined) {
      chats.clear()
    } else {
      chats.delete(chatId)
    }
    if (chats.size === 0) {
      this.sessionChats.delete(sessionId)
      this.botSessions.delete(sessionId)
    }
  }

  /**
   * Require a human decision before a command tool runs in one of our sessions.
   *
   * Installed only when the approval service is mounted: a gate without an
   * answerer fails every command closed, which looks like a broken bot.
   */
  installApprovalGate(): void {
    // Policy is DSH's permission preset (read-only / workspace-write /
    // danger-full-access / auto). This listener only answers when DSH has no
    // approval channel attached (unattended bot session), and only an
    // authorized group approver may answer it.
    this.ctx.on('approval/request', (request, next) => this.answerApproval(request, next), { prepend: true })
    this.ctx.logger.info(`feishu-bot: approval fallback on; DSH preset "${this.config.permissionPreset || 'deployment default'}"`)
  }

  /** Answer one approval request ourselves when it belongs to a bot session. */
  async answerApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (this.stopping || request?.signal?.aborted) return Promise.resolve('cancelled')
    const sessionId = request?.agent?.session?.id
    if (typeof sessionId !== 'string' || !this.botSessions.has(sessionId)) return next()
    const pendingChat = this.pending.get(sessionId)?.chatId
    const chatId = pendingChat ?? this.sessionChats.get(sessionId)?.values().next().value
    if (chatId === undefined) return next()
    // Fail closed without an authorized group approver: only the DSH-side
    // answerer may decide, and if nobody is there the tool is denied.
    // DSH owns approval whenever it has an answerer. The group is only a
    // fallback for an unattended bot session with no DSH approval UI open.
    let dsh: ApprovalOutcome = 'unavailable'
    try {
      dsh = await next()
    } catch {
      dsh = 'unavailable'
    }
    if (request?.signal?.aborted) return 'cancelled'
    if (dsh !== 'unavailable') {
      this.metrics.inc('approvalDsh')
      return dsh
    }
    if (this.config.approveUsers.length === 0) return 'unavailable'
    return this.askFeishuApproval({ chatId, sessionId, request })
  }

  askFeishuApproval({ chatId, sessionId, request }: { chatId: string; sessionId: string; request: ApprovalRequest }): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return Promise.resolve('cancelled')
    if (this.approvals.has(chatId)) {
      this.ctx.logger.warn(`feishu-bot: an approval is already pending in ${chatId}; refusing a second one`)
      return Promise.resolve('unavailable')
    }
    const reason = firstNonEmpty(request?.displayReason, request?.reason, '执行命令')
    const seconds = Math.round(this.config.approvalTimeoutMs / 1000)
    const prompt = `⚠️ 需要审批\n${reason}\n\n回复「@我 同意」执行，「@我 拒绝」取消（仅限指定审批人，${seconds} 秒内有效）`
    this.metrics.inc('approvalAsked')
    this.ctx.logger.info(`feishu-bot: approval requested chat=${chatId} session=${sessionId}`)
    return new Promise<ApprovalOutcome>(resolve => {
      const entry: ApprovalEntry = { chatId, sessionId, resolve, timer: undefined, signal: request?.signal, onAbort: undefined }
      this.approvals.set(chatId, entry)
      entry.timer = setTimeout(() => {
        this.settleApproval(chatId, 'unavailable', '⏰ 审批超时，该命令没有执行。')
      }, this.config.approvalTimeoutMs)
      entry.timer.unref?.()
      const signal = request?.signal
      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        const onAbort = () => this.settleApproval(chatId, 'cancelled')
        entry.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      void this.cli.send(chatId, prompt).catch(error => {
        this.ctx.logger.warn(`feishu-bot: cannot ask for approval in ${chatId}: ${String(error)}`)
        this.settleApproval(chatId, 'unavailable')
      })
    })
  }

  /** Close one pending approval with a pipeline outcome and optional note. */
  settleApproval(chatId: string, outcome: ApprovalOutcome, note?: string): boolean {
    const entry = this.approvals.get(chatId)
    if (entry === undefined) return false
    this.approvals.delete(chatId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.onAbort !== undefined) entry.signal?.removeEventListener?.('abort', entry.onAbort)
    entry.resolve(outcome)
    if (note !== undefined && !this.stopping) {
      this.cli.send(chatId, note).catch(error => {
        this.ctx.logger.warn(`feishu-bot: approval note failed: ${String(error)}`)
      })
    }
    return true
  }

  /** Remember sessions that sent a bot message to a group through lark-cli. */
  private observeOutboundChat(sessionId: string, event: SessionEventLike): void {
    if (event.type !== 'tool/call') return
    if (event.data?.name !== 'bash' && event.data?.name !== 'pwsh') return
    const raw = event.data.arguments
    let command = ''
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as { command?: unknown }
        if (typeof parsed.command === 'string') command = parsed.command
      } catch {
        return
      }
    } else if (raw !== null && typeof raw === 'object') {
      const value = raw as { command?: unknown }
      if (typeof value.command === 'string') command = value.command
    }
    if (command === '' || !command.includes('lark-cli') || !command.includes('+messages-send')) return
    const match = /--chat-id(?:\s+|=)(oc_[A-Za-z0-9]+)/.exec(command)
    if (match === null) return
    void this.recordChatAffinity(match[1] as string, sessionId, typeof event.time === 'number' ? event.time : Date.now())
  }

  private recordChatAffinity(chatId: string, sessionId: string, at: number): Promise<void> {
    this.sessionLookup.delete(chatId)
    return this.registry.recordCandidate(chatId, sessionId, at)
  }

  /** Safe health snapshot for the Client status poller. */
  status(): Record<string, unknown> {
    return {
      ready: this.ready,
      consumer: this.consumer !== undefined,
      stopping: this.stopping,
      lastEventAt: this.lastEventAt,
      approvals: this.approvals.size,
      bindings: this.registry.entries().length,
      dynamicChats: this.chats.size,
      permissionPreset: this.config.permissionPreset,
      queue: this.queue.stats(),
      bot: {
        name: this.config.botName,
        ...(this.config.botOpenId === undefined ? {} : { openId: this.config.botOpenId }),
      },
    }
  }

  /** Session-facing binding list with resolved group names. */
  async bindingSummaries(force = false): Promise<Array<{ chatId: string; chatType: 'group' | 'p2p'; botId: string; sessionId: string; source: string; boundAt: number; chatName?: string; botMember: boolean }>> {
    // Refresh the directory once per snapshot, then resolve every binding from it.
    const byId = new Map((await this.cli.listChats(force)).map(chat => [chat.chatId, chat]))
    const summaries = await Promise.all(this.registry.entries().map(async ([key, record]) => {
      if (record.sessionId === undefined) return []
      const chatId = key.split('::')[0]
      const info = byId.get(chatId)
      const p2p = info === undefined && this.chats.kind(chatId) === 'p2p'
      const peer = p2p ? await this.cli.peerName(chatId) : undefined
      return [{
        chatId,
        chatType: (this.chats.kind(chatId) === 'p2p' || p2p ? 'p2p' : 'group') as 'p2p' | 'group',
        botId: record.botId,
        sessionId: record.sessionId,
        source: record.source,
        boundAt: record.at,
        ...(info === undefined || info.name === '' ? peer === undefined ? {} : { chatName: peer } : { chatName: info.name }),
        botMember: info?.botMember === true || p2p,
      }]
    }))
    return summaries.flat()
  }

  /** Every chat the bot can see, annotated with allowlist/binding state. */
  async availableChats(force = false): Promise<Array<{ chatId: string; name: string; botMember: boolean; allowed: boolean; bound: boolean }>> {
    const bound = new Set(this.registry.entries().map(([key]) => key.split('::')[0]))
    const chats = await this.cli.listChats(force)
    return chats.map(chat => ({
      ...chat,
      allowed: this.isAllowedChat(chat.chatId),
      bound: bound.has(chat.chatId),
    }))
  }

  /** Bind a group to an existing Session from the Web UI. */
  async bindToSession(chatId: string, sessionId: string): Promise<void> {
    if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error('chat_id must be a Feishu group id (oc_...)')
    if (this.ctx.sessions.get(sessionId) === undefined) throw new Error('session not found')
    await this.bindChat(chatId, sessionId)
    await this.allowChat(chatId)
  }

  /** Remove every binding for one chat and suppress automatic re-discovery. */
  async unbindChat(chatId: string): Promise<boolean> {
    const records = this.registry.entries()
      .filter(([key]) => key === chatId || key.startsWith(`${chatId}::`))
    if (records.length === 0) return false
    if (this.approvals.has(chatId)) this.settleApproval(chatId, 'cancelled')
    for (const [, record] of records) {
      const sessionId = record.sessionId
      await this.registry.unbind(record.chatId, record.threadId ?? '')
      if (sessionId === undefined) continue
      const pending = this.pending.get(sessionId)
      if (pending?.chatId === chatId) {
        pending.reject(Object.assign(new Error('unbound'), { code: 'FEISHU_CANCELLED' }))
        try {
          this.ctx.sessionController.cancel({ sessionId })
        } catch {
          // Best effort; the binding is gone regardless.
        }
      }
      this.untrackSession(sessionId, chatId)
    }
    return true
  }

  /** Health plus group/bot bindings for the Web UI. */
  async bindingStatus(force = false): Promise<Record<string, unknown>> {
    return {
      ...this.status(),
      bindings: await this.bindingSummaries(force),
    }
  }

  /** Sessions that have pointed at one group, newest first, with the active one marked. */
  async groupDetail(chatId: string): Promise<{
    chatId: string
    chatType: 'group' | 'p2p'
    chatName?: string
    botMember: boolean
    sessions: Array<{ sessionId: string; at: number; source: string; current: boolean }>
  }> {
    const info = await this.cli.chatInfo(chatId)
    const p2p = this.chats.kind(chatId) === 'p2p'
    const peer = p2p ? await this.cli.peerName(chatId) : undefined
    const active = new Map<string, { source: string; at: number }>()
    for (const [key, record] of this.registry.entries()) {
      if (key !== chatId && !key.startsWith(`${chatId}::`)) continue
      if (record.sessionId !== undefined) active.set(record.sessionId, { source: record.source, at: record.at })
    }
    const merged = new Map<string, { sessionId: string; at: number; source: string; current: boolean }>()
    for (const entry of this.registry.listByChat(chatId)) {
      if (entry.sessionId === undefined) continue
      merged.set(entry.sessionId, { sessionId: entry.sessionId, at: entry.at, source: entry.source, current: active.has(entry.sessionId) })
    }
    for (const [sessionId, meta] of active) {
      const previous = merged.get(sessionId)
      merged.set(sessionId, {
        sessionId,
        at: previous?.at !== undefined && previous.at > 0 ? previous.at : meta.at,
        source: meta.source,
        current: true,
      })
    }
    const candidate = this.registry.candidateFor(chatId)
    if (candidate?.sessionId !== undefined && !merged.has(candidate.sessionId)) {
      merged.set(candidate.sessionId, { sessionId: candidate.sessionId, at: candidate.at, source: 'auto', current: false })
    }
    return {
      chatId,
      chatType: p2p ? 'p2p' : 'group',
      ...(info === undefined || info.name === '' ? peer === undefined ? {} : { chatName: peer } : { chatName: info.name }),
      botMember: info?.botMember === true || p2p,
      sessions: [...merged.values()].sort((left, right) => right.at - left.at),
    }
  }

  /** Static allowlist or a chat enabled at runtime. */
  private isAllowedChat(chatId: string): boolean {
    return this.config.allowChats.includes('*') || this.config.allowChats.includes(chatId) || this.chats.isAllowed(chatId)
  }

  /** Only the configured owner may enable an unknown group by @-ing the bot. */
  private canEnableChat(event: FeishuEvent): boolean {
    if (!this.config.autoEnableApproverChats) return false
    if (event.chatType !== 'group' && event.chatType !== 'p2p') return false
    if (event.senderType === 'app' || event.senderType === 'bot') return false
    if (event.messageType !== 'text' && event.messageType !== 'post') return false
    if (this.config.approveUsers.length === 0 || !this.config.approveUsers.includes(event.senderId)) return false
    if (event.chatType === 'p2p') return true
    if (this.config.botOpenId !== undefined) return event.mentions.some(mention => mention.id === this.config.botOpenId)
    return event.mentions.length > 0
  }

  /** Whether a chat is allowed to control (stop) work it may have started. */
  canControl(chatId: string): boolean {
    if (this.isAllowedChat(chatId)) return true
    if (this.approvals.has(chatId)) return true
    return this.registry.entries().some(([key]) => key === chatId || key.startsWith(`${chatId}::`))
  }

  /** Cancel the running turn and drop this chat's queued jobs. */
  stopChat(event: FeishuEvent): void {
    const key = bindingKey(event.chatId, event.threadKey, this.routing)
    const sessionId = this.registry.get(key)?.sessionId
    let stopped = false
    if (this.approvals.has(event.chatId)) {
      this.settleApproval(event.chatId, 'cancelled')
      stopped = true
    }
    if (sessionId !== undefined) {
      const pending = this.pending.get(sessionId)
      if (pending !== undefined) {
        pending.reject(Object.assign(new Error('cancelled'), { code: 'FEISHU_CANCELLED' }))
        stopped = true
      }
      try {
        this.ctx.sessionController.cancel({ sessionId })
      } catch {
        // Cancellation is best-effort; the reply and queue clear are the contract.
      }
    }
    if (this.queue.clear(key) > 0) stopped = true
    this.metrics.inc(stopped ? 'stopAccepted' : 'stopIdle')
    this.fireReply(event, stopped ? '已停止当前任务。' : '当前没有正在执行的任务。')
  }

  /** A chat reply that answers a pending approval — never a new question. */
  handleApprovalReply(event: FeishuEvent, cleaned?: string): boolean {
    if (event.senderType === 'app' || event.senderType === 'bot') return false
    if (!this.approvals.has(event.chatId)) return false
    const text = cleaned ?? cleanMessageText(event.content, event.mentions, this.config.botOpenId)
    const decision = parseApprovalReply(text)
    if (decision === undefined) return false
    if (this.config.approveUsers.length > 0 && !this.config.approveUsers.includes(event.senderId)) {
      this.metrics.inc('approvalIgnored')
      this.ctx.logger.warn(`feishu-bot: ${event.senderId} may not approve in ${event.chatId}`)
      return true
    }
    this.metrics.inc(decision === 'allow' ? 'approvalAllowed' : 'approvalRejected')
    this.settleApproval(
      event.chatId,
      decision === 'allow' ? 'allowed-once' : 'rejected',
      decision === 'allow' ? '✅ 已批准，继续执行。' : '已拒绝，该命令没有执行。',
    )
    return true
  }

  async runJob(key: string, job: Job): Promise<void> {
    const { event, text } = job
    const startedAt = Date.now()
    this.metrics.inc('jobsStarted')
    this.metrics.observe('queueWaitMs', startedAt - job.enqueuedAt)
    // Sent in parallel with session setup so feedback does not wait on it.
    const placeholder$ = this.shouldPlaceholder() ? this.openPlaceholder(event) : Promise.resolve(undefined)
    let sessionId
    try {
      sessionId = await this.ensureSession(key, event, text)
    } catch (error) {
      this.metrics.inc('jobsFailed')
      this.ctx.logger.error(`feishu-bot: cannot open session for ${key}: ${String(error)}`)
      await this.deliver(event, await placeholder$, ['无法创建会话，请稍后再试。'])
      return
    }
    let answer
    try {
      answer = await this.promptAndCollect(sessionId, text, event)
    } catch (error) {
      if (this.stopping) return
      if ((error as { code?: string }).code === 'FEISHU_CANCELLED') {
        this.metrics.inc('jobsCancelled')
        return
      }
      if ((error as { code?: string }).code === 'FEISHU_TIMEOUT') {
        this.metrics.inc('jobsTimeout')
        await this.deliver(event, await placeholder$, ['这个问题处理超时，已中断。可以缩小范围后再问一次。'])
      } else {
        this.metrics.inc('jobsFailed')
        this.ctx.logger.error(`feishu-bot: prompt failed session=${sessionId}: ${String(error)}`)
        const current = this.registry.get(key)
        if (current?.source === 'manual' || current?.source === 'external') {
          // An explicit binding must fail closed: keep it so the next message
          // cannot silently fall back to a new Session.
          await this.deliver(event, await placeholder$, ['该群绑定的会话已失效，请重新绑定或解绑；我不会自动新建会话。'])
        } else {
          if (current !== undefined) await this.registry.unbind(current.chatId, current.threadId ?? '')
          this.untrackSession(sessionId, event.chatId)
          await this.deliver(event, await placeholder$, ['会话已失效或处理失败，下一条消息会重新建立会话。'])
        }
      }
      return
    }
    const chunks = splitReply(answer, this.config.maxReplyChars)
    if (chunks.length === 0) {
      this.metrics.inc('jobsEmpty')
      await this.deliver(event, await placeholder$, ['（没有生成文本回答）'])
      return
    }
    const delivered = await this.deliver(event, await placeholder$, chunks)
    this.metrics.inc(delivered ? 'jobsSucceeded' : 'jobsFailed')
    this.metrics.observe('jobTotalMs', Date.now() - startedAt)
    this.ctx.logger.info(`feishu-bot: answered chat=${event.chatId} session=${sessionId} in ${Date.now() - startedAt}ms`)
  }

  /** Immediate acknowledgement: a reply the final answer later replaces. */
  async openPlaceholder(event: FeishuEvent): Promise<string | undefined> {
    const startedAt = Date.now()
    try {
      const messageId = await this.cli.reply(event.messageId, PLACEHOLDER_TEXT, {
        inThread: this.inThread(event),
        keySuffix: 'ack',
      })
      this.metrics.observe('ackMs', Date.now() - startedAt)
      // Defensive: never treat the triggering message as ours to edit/recall.
      return messageId === event.messageId ? undefined : messageId
    } catch (error) {
      this.metrics.inc('ackFailed')
      this.ctx.logger.warn(`feishu-bot: placeholder failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Send one answer: edit the placeholder in place when possible, otherwise
   * fall back to fresh replies (the placeholder is withdrawn so it cannot be
   * mistaken for a stalled job).
   */
  async deliver(event: FeishuEvent, placeholder: string | undefined, chunks: string[]): Promise<boolean> {
    if (this.stopping) return false
    const inThread = this.inThread(event)
    let index = 0
    // Only ever edit/recall a message that is not the question itself.
    const target = placeholder === event.messageId ? undefined : placeholder
    try {
      if (target !== undefined && chunks.length > 0) {
        try {
          await this.cli.edit(target, chunks[0])
          index = 1
        } catch (error) {
          this.metrics.inc('editFailed')
          this.ctx.logger.warn(`feishu-bot: cannot edit placeholder ${placeholder}: ${String(error)}`)
          await this.cli.withdraw(target).catch(cleanupError => {
            this.ctx.logger.debug(`feishu-bot: cannot withdraw placeholder: ${String(cleanupError)}`)
          })
        }
      }
      for (; index < chunks.length; index += 1) {
        await this.cli.reply(event.messageId, chunks[index], { inThread, keySuffix: String(index) })
      }
      return true
    } catch (error) {
      this.metrics.inc('replyFailed')
      this.ctx.logger.error(`feishu-bot: cannot deliver answer for ${event.messageId}: ${String(error)}`)
      return false
    }
  }

  /** Persist a runtime-enabled chat in the unified directory. */
  async allowChat(chatId: string, kind: 'group' | 'p2p' = 'group'): Promise<boolean> {
    const id = chatId.trim()
    if (!/^oc_[A-Za-z0-9]+$/.test(id)) throw new Error('chat_id must be a Feishu group id (oc_...)')
    await this.chats.allow(id, Date.now(), kind)
    this.ctx.logger.info(`feishu-bot: allowed ${kind} ${id} at runtime`)
    return true
  }

  /** A chat is bindable only when the bot itself is a member. */
  async assertBindableChat(chatId: string): Promise<void> {
    const info = await this.cli.chatInfo(chatId, true)
    if (this.chats.kind(chatId) === 'p2p' && (info === undefined || !info.botMember)) return
    if (info === undefined) throw new Error('找不到该群，或机器人没有访问权限')
    if (!info.botMember) throw new Error('机器人不在该群，请先把机器人拉进群再绑定')
  }

  /** Write the authoritative binding and its display history together. */
  private async setBinding(key: string, sessionId: string, source: 'auto' | 'manual' | 'external'): Promise<void> {
    const index = key.indexOf('::')
    const chatId = index === -1 ? key : key.slice(0, index)
    const threadId = index === -1 ? '' : key.slice(index + 2)
    await this.registry.bind(chatId, threadId, sessionId, source)
  }

  async bindChat(chatId: string, sessionId: string, source: 'manual' | 'external' = 'manual'): Promise<void> {
    await this.assertBindableChat(chatId)
    const key = bindingKey(chatId, '', this.routing)
    const previous = this.registry.get(key)?.sessionId
    await this.setBinding(key, sessionId, source)
    await this.recordChatAffinity(chatId, sessionId, Date.now())
    if (previous !== undefined && previous !== sessionId) this.untrackSession(previous, chatId)
    this.trackSession(sessionId, chatId)
    this.ctx.logger.info(`feishu-bot: bound chat ${chatId} -> ${sessionId}${previous === undefined || previous === sessionId ? '' : ` (replaced ${previous})`}`)
  }

  /** The bind tool must not run from inside a bot session. */
  isBotSession(sessionId: string): boolean {
    return this.botSessions.has(sessionId)
  }

  /** The configured workspace, when the registry can resolve it. */
  workspace(): WorkspaceLike | undefined {
    if (this.config.workspaceId === undefined) return undefined
    const registry = this.ctx.get('workspaceRegistry') as
      | { get(id: string): WorkspaceLike | undefined }
      | undefined
    return registry?.get(this.config.workspaceId)
  }

  /** Apply the configured DSH permission preset to a bot session. */
  applyPermissionPreset(sessionId: string): void {
    const name = this.config.permissionPreset
    if (name === '') return
    try {
      const session = this.ctx.sessions.get(sessionId)
      if (session !== undefined) this.ctx.permissionPresets.set(session, name)
    } catch (error) {
      this.ctx.logger.warn(`feishu-bot: cannot set permission preset "${name}" on ${sessionId}: ${String(error)}`)
    }
  }

  /** A blank Session is shown as "new session" by DSH; give a handoff one visible first turn. */
  seedHandoffSession(sessionId: string, title: string): void {
    void this.ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{
        type: 'text',
        text: `飞书群「${title}」已交接；请在此会话中作为该群的助手待命，后续群消息会直接进入这里。`,
      }],
    }, new AbortController().signal).catch(error => {
      this.ctx.logger.warn(`feishu-bot: cannot seed handoff ${sessionId}: ${String(error)}`)
    })
  }

  /** Resolve a group name through the CLI, cached inside LarkCli. */
  chatName(chatId: string): Promise<string | undefined> {
    return this.cli.chatName(chatId)
  }

  /**
   * Find the most recently active Session that already handled this chat.
   * Uses the summary of our `feishuBotTask` projection; a 10s cache keeps the
   * session list RPC off the hot path when a burst arrives.
   */
  private async findSessionForChat(chatId: string): Promise<string | undefined> {
    const cached = this.sessionLookup.get(chatId)
    if (cached !== undefined && Date.now() - cached.at < 10_000) return cached.sessionId
    const candidate = this.registry.candidateFor(chatId)
    const list = this.ctx.sessionController.list
    if (typeof list !== 'function') return candidate?.sessionId
    try {
      const signal = new AbortController().signal
      const result = await list.call(this.ctx.sessionController, {}, signal)
      let best: { sessionId: string; at: number } | undefined
      for (const item of result.items) {
        const raw = item.projectionValues?.feishuBotTask
        if (raw === null || typeof raw !== 'object') continue
        const task = raw as { bot?: unknown; chatId?: unknown; updatedAt?: unknown }
        if (task.bot !== true || task.chatId !== chatId) continue
        const at = typeof task.updatedAt === 'number' ? task.updatedAt : (item.updatedAt ?? 0)
        if (best === undefined || at > best.at) best = { sessionId: item.id, at }
      }
      if (candidate?.sessionId !== undefined && (best === undefined || candidate.at > best.at)) best = { sessionId: candidate.sessionId, at: candidate.at }
      this.sessionLookup.set(chatId, { at: Date.now(), ...(best === undefined ? {} : { sessionId: best.sessionId }) })
      return best?.sessionId
    } catch (error) {
      this.ctx.logger.debug(`feishu-bot: cannot discover chat ${chatId}: ${String(error)}`)
      return candidate?.sessionId
    }
  }

  /** Read a bounded recent-turn digest and decide whether the source is too large to reuse. */
  private async sessionDigest(sessionId: string): Promise<{ summary: string; large: boolean } | undefined> {
    const cached = this.digestCache.get(sessionId)
    if (cached !== undefined && Date.now() - cached.at < 60_000) return cached
    const read = this.ctx.sessionController.projections
    if (typeof read !== 'function') return undefined
    try {
      const result = await read.call(this.ctx.sessionController, { sessionId }, new AbortController().signal) as
        | { kind?: string; values?: Record<string, unknown> }
        | null
      const values = result?.values
      if (values === undefined) return undefined
      const outline = values.turnOutline as { turns?: Array<{ prompt?: unknown; response?: unknown }> } | undefined
      const stats = values.sessionStats as { turns?: unknown } | undefined
      const pressure = values.contextPressure as { surfaceTokens?: unknown } | undefined
      const turns = Array.isArray(outline?.turns) ? outline.turns : []
      const surfaceTokens = typeof pressure?.surfaceTokens === 'number' ? pressure.surfaceTokens : 0
      const turnCount = typeof stats?.turns === 'number' ? stats.turns : turns.length
      const large = surfaceTokens > 120_000 || turnCount > 120
      const recent = turns.slice(-5)
      const parts: string[] = []
      for (const item of recent) {
        const prompt = typeof item.prompt === 'string' ? item.prompt.trim().slice(0, 500) : ''
        const response = typeof item.response === 'string' ? item.response.trim().slice(0, 500) : ''
        if (prompt !== '' || response !== '') parts.push(`问：${prompt}\n答：${response}`)
      }
      const summary = parts.length === 0
        ? ''
        : `以下是从既有会话接手的上下文摘要，用于继续处理这个飞书群的问题：\n\n${parts.join('\n\n')}\n\n请在此基础上回答新问题。`
      const value = { summary, large }
      this.digestCache.set(sessionId, { at: Date.now(), ...value })
      return value
    } catch (error) {
      this.ctx.logger.debug(`feishu-bot: cannot read digest for ${sessionId}: ${String(error)}`)
      return undefined
    }
  }

  /** Rename an existing p2p Session from its peer + bot identity. */
  private async refreshPrivateTitle(sessionId: string, chatId: string): Promise<void> {
    if (this.manualPrivateTitles.has(sessionId)) return
    const peer = await this.cli.peerName(chatId)
    const title = privateSessionTitle(peer ?? '', this.config.botName)
    if (this.privateTitles.get(sessionId) === title) return
    this.privateTitles.set(sessionId, title)
    await this.ctx.sessionController.rename({ sessionId, title }).catch(error => {
      this.ctx.logger.debug(`feishu-bot: cannot rename private session ${sessionId}: ${String(error)}`)
    })
  }

  /** Create a new session, optionally seeded with a compact digest, and bind it. */
  private async createSessionForChat(key: string, event: FeishuEvent, text: string, summary = ''): Promise<string> {
    const created = await this.ctx.sessionController.create({
      ...(this.config.workspaceId === undefined
        ? { cwd: this.config.cwd }
        : { workspaceId: this.config.workspaceId }),
      ...(this.config.agentPreset === undefined ? {} : { agentPreset: this.config.agentPreset }),
    })
    const sessionId = created.sessionId
    this.applyPermissionPreset(sessionId)
    await this.setBinding(key, sessionId, 'auto')
    await this.recordChatAffinity(event.chatId, sessionId, Date.now())
    this.sessionLookup.set(event.chatId, { at: Date.now(), sessionId })
    this.trackSession(sessionId, event.chatId)
    try {
      const groupName = await this.chatName(event.chatId)
      const title = event.chatType === 'p2p'
        ? privateSessionTitle((await this.cli.peerName(event.chatId)) ?? '', this.config.botName)
        : sessionTitle(event, text, groupName ?? '')
      this.privateTitles.set(sessionId, title)
      await this.ctx.sessionController.rename({ sessionId, title })
    } catch {
      // A title is cosmetic; the binding is what matters.
    }
    if (summary !== '') {
      try {
        const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
        resolved.agent?.inject({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: summary }],
          source: { kind: 'user' },
        })
      } catch (error) {
        this.ctx.logger.warn(`feishu-bot: cannot inject handoff digest into ${sessionId}: ${String(error)}`)
      }
    }
    this.ctx.logger.info(`feishu-bot: bound ${key} -> ${sessionId}${summary === '' ? '' : ' (with digest)'}`)
    return sessionId
  }

  async ensureSession(key: string, event: FeishuEvent, text: string): Promise<string> {
    const resolution = this.registry.resolve(event.chatId, event.threadKey, this.routing)
    const known = 'sessionId' in resolution ? resolution.sessionId : undefined
    const workspace = this.workspace()
    if (event.chatType === 'p2p'
      && (resolution.kind === 'explicit' || resolution.kind === 'auto')
      && resolution.at > 0
      && Date.now() - resolution.at >= this.config.p2pSessionTtlMs) {
      // Direct chats expire after the configured TTL; start a fresh Session.
      return this.createSessionForChat(key, event, text)
    }
    if (event.chatType === 'p2p' && known !== undefined
      && (resolution.kind === 'explicit' || resolution.kind === 'auto')) {
      void this.refreshPrivateTitle(known, event.chatId)
    }
    if (event.chatType === 'group') {
      const candidate = this.registry.candidateFor(event.chatId)
      const recent = candidate?.sessionId !== undefined && candidate.at > 0
        && Date.now() - candidate.at <= this.config.outboundReplyTtlMs
      const activeSession = resolution.kind === 'explicit' || resolution.kind === 'auto' ? known : undefined
      if (recent && candidate.sessionId !== undefined && candidate.sessionId !== activeSession) {
        // A group member is replying shortly after this session sent there;
        // the sender session takes over, replacing an older group binding.
        await this.setBinding(key, candidate.sessionId, 'auto')
        await this.recordChatAffinity(event.chatId, candidate.sessionId, Date.now())
        this.trackSession(candidate.sessionId, event.chatId)
        return candidate.sessionId
      }
    }
    if (known !== undefined && resolution.kind === 'explicit') {
      // Explicit/manual binding is authoritative: never discover, digest, or create.
      if (workspace !== undefined && !workspace.sessionIds.includes(known)) {
        try {
          await workspace.attachSession(known)
        } catch (error) {
          this.ctx.logger.warn(`feishu-bot: cannot attach explicit binding ${known}: ${String(error)}`)
        }
      }
      this.trackSession(known, event.chatId)
      return known
    }
    if (resolution.kind === 'unbound') {
      // Unbound explicitly: do not silently rebind the old Session.
      return this.createSessionForChat(key, event, text)
    }
    if (event.chatType === 'p2p' && resolution.kind === 'candidate') {
      // A direct chat should not inherit an unrelated session's outbound
      // affinity candidate; start a clean p2p session instead.
      return this.createSessionForChat(key, event, text)
    }
    const discovered = await this.findSessionForChat(event.chatId)
    if (discovered !== undefined && discovered !== known) {
      const digest = await this.sessionDigest(discovered)
      if (digest !== undefined && digest.large && digest.summary !== '') {
        this.ctx.logger.info(`feishu-bot: session ${discovered} is large; starting a digest session for ${event.chatId}`)
        return this.createSessionForChat(key, event, text, digest.summary)
      }
      if (discovered !== known) {
        // A small Session already handled this chat; follow it.
        await this.setBinding(key, discovered, 'auto')
        await this.recordChatAffinity(event.chatId, discovered, Date.now())
        this.trackSession(discovered, event.chatId)
        this.ctx.logger.info(`feishu-bot: reused recent session ${discovered} for ${event.chatId}`)
        return discovered
      }
    }
    if (known !== undefined) {
      if (workspace !== undefined && !workspace.sessionIds.includes(known)) {
        try {
          await workspace.attachSession(known)
          this.ctx.logger.info(`feishu-bot: attached ${known} to workspace ${this.config.workspaceId}`)
        } catch (error) {
          this.ctx.logger.warn(`feishu-bot: cannot attach ${known} to workspace: ${String(error)}`)
        }
      }
      return known
    }
    return this.createSessionForChat(key, event, text)
  }

  async promptAndCollect(sessionId: string, text: string, event: FeishuEvent): Promise<string> {
    const groupName = await this.chatName(event.chatId)
    return new Promise<string>((resolve, reject) => {
      const pending: PendingTurn = {
        chatId: event.chatId,
        turn: undefined,
        parts: [],
        resolve: value => {
          if (pending.timer !== undefined) clearTimeout(pending.timer)
          this.pending.delete(sessionId)
          resolve(value)
        },
        reject: error => {
          if (pending.timer !== undefined) clearTimeout(pending.timer)
          this.pending.delete(sessionId)
          reject(error)
        },
        timer: undefined,
      }
      pending.timer = setTimeout(() => {
        pending.reject(Object.assign(new Error('timeout'), { code: 'FEISHU_TIMEOUT' }))
        try {
          this.ctx.sessionController.cancel({ sessionId })
        } catch {
          // Cancellation is best-effort; the timeout reply is the contract.
        }
      }, this.config.timeoutMs)
      pending.timer.unref?.()
      this.pending.set(sessionId, pending)
      const peers = this.registry.peersForChat(event.chatId)
      const peerNames = peers.map(id => this.botNames.get(id) ?? id)
      const botTag = `机器人:${this.config.botName} | 机器人ID:${this.config.botId}${peers.length === 0 ? '' : ` | 群内已绑定机器人:${peerNames.join('、')}`}${this.config.replyGuidelines === '' ? '' : ` | 回复要求:${this.config.replyGuidelines}`}`
      const header = groupName === undefined || groupName === ''
        ? `[飞书群:${event.chatId} | ${botTag} | 提问人:${event.senderId || 'unknown'}]\n${text}`
        : `[飞书群:${groupName} | 群ID:${event.chatId} | ${botTag} | 提问人:${event.senderId || 'unknown'}]\n${text}`
      this.ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: header }],
      }, new AbortController().signal).catch(error => {
        pending.reject(error)
      })
    })
  }

  onSessionEvent(session: SessionLike, event: SessionEventLike): void {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      const auto = this.privateTitles.get(session.id)
      if (auto !== undefined && event.data.title !== auto) this.manualPrivateTitles.add(session.id)
      else if (auto !== undefined) this.manualPrivateTitles.delete(session.id)
    }
    this.observeOutboundChat(session.id, event)
    const pending = this.pending.get(session.id)
    if (pending === undefined) return
    if (event.type === 'turn/start' && pending.turn === undefined) {
      pending.turn = event.data.turn
      return
    }
    if (pending.turn === undefined) return
    if (event.type === 'assistant/message' && event.data.turn === pending.turn) {
      const message = event.data.message
      const content = Array.isArray(message?.content) ? message.content : []
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') {
          pending.parts.push(part.text)
        }
      }
      return
    }
    if (event.type === 'turn/end' && event.data.turn === pending.turn) {
      pending.resolve(pending.parts.join('\n\n').trim())
    }
  }

  /** Log counters/latencies only when something moved since the last snapshot. */
  logStats(): void {
    const { counts, timings } = this.metrics.snapshot()
    const signature = JSON.stringify(counts)
    if (signature === this.lastStatsSignature) return
    this.lastStatsSignature = signature
    this.ctx.logger.info(`feishu-bot: stats ${JSON.stringify({
      counts,
      timings,
      queue: this.queue.stats(),
      dedup: this.seen.size,
    })}`)
  }
}

/** Aggregate facade over one or more per-bot bridge instances. */
export class BotHost {
  readonly ctx: HostContext
  readonly config: Config
  readonly bots: FeishuBot[]

  constructor(ctx: HostContext, config: Config, bots: FeishuBot[]) {
    this.ctx = ctx
    this.config = config
    this.bots = bots
  }

  get primary(): FeishuBot {
    const bot = this.bots[0]
    if (bot === undefined) throw new Error('no bot configured')
    return bot
  }

  private pick(botId?: string): FeishuBot {
    if (botId === undefined || botId === '') return this.primary
    const found = this.bots.find(bot => bot.config.botId === botId || bot.config.botName === botId || bot.config.botOpenId === botId)
    if (found === undefined) throw new Error(`unknown bot: ${botId}`)
    return found
  }

  async start(): Promise<void> {
    await Promise.all(this.bots.map(bot => bot.start()))
  }

  async dispose(): Promise<void> {
    await Promise.all(this.bots.map(bot => bot.dispose()))
  }

  status(): Record<string, unknown> {
    const statuses = this.bots.map(bot => ({ bot, status: bot.status() }))
    const primary = statuses[0]
    return {
      ...(primary?.status ?? {}),
      ready: statuses.every(entry => entry.status.ready === true),
      consumer: statuses.every(entry => entry.status.consumer === true),
      stopping: statuses.some(entry => entry.status.stopping === true),
      bindings: this.bots.reduce((sum, bot) => sum + bot.registry.entries().length, 0),
      bots: statuses.map(({ bot, status }) => ({
        id: bot.config.botId,
        name: bot.config.botName,
        ready: status.ready,
        consumer: status.consumer,
        lastEventAt: status.lastEventAt,
      })),
    }
  }

  async bindingSummaries(force = false): Promise<Array<{ chatId: string; chatType: 'group' | 'p2p'; botId: string; sessionId: string; source: string; boundAt: number; chatName?: string; botMember: boolean }>> {
    const summaries = await Promise.all(this.bots.map(bot => bot.bindingSummaries(force)))
    return summaries.flat()
  }

  async bindingStatus(force = false): Promise<Record<string, unknown>> {
    return { ...this.status(), bindings: await this.bindingSummaries(force) }
  }

  async availableChats(force = false): Promise<Array<{ chatId: string; name: string; botMember: boolean; allowed: boolean; bound: boolean; bots: Array<{ id: string; name: string; openId?: string; member: boolean; bound: boolean }> }>> {
    const merged = new Map<string, { chatId: string; name: string; botMember: boolean; allowed: boolean; bound: boolean }>()
    const memberships = new Map<string, Map<string, boolean>>()
    const chatLists = await Promise.all(this.bots.map(bot => bot.availableChats(force)))
    for (const [index, bot] of this.bots.entries()) {
      for (const chat of chatLists[index] ?? []) {
        const previous = merged.get(chat.chatId)
        if (previous === undefined) merged.set(chat.chatId, { ...chat })
        else {
          previous.botMember = previous.botMember || chat.botMember
          previous.allowed = previous.allowed || chat.allowed
          previous.bound = previous.bound || chat.bound
          if (previous.name === '') previous.name = chat.name
        }
        const map = memberships.get(chat.chatId) ?? new Map<string, boolean>()
        map.set(bot.config.botId, chat.botMember)
        memberships.set(chat.chatId, map)
      }
    }
    return [...merged.values()].map(chat => {
      const bots = this.bots.map(bot => ({
        id: bot.config.botId,
        name: bot.config.botName,
        ...(bot.config.botOpenId === undefined ? {} : { openId: bot.config.botOpenId }),
        member: this.bots.length === 1 ? chat.botMember : memberships.get(chat.chatId)?.get(bot.config.botId) === true,
        bound: bot.registry.entries().some(([key]) => key === chat.chatId || key.startsWith(`${chat.chatId}::`)),
      }))
      return { ...chat, botMember: bots.some(bot => bot.member), bound: bots.some(bot => bot.bound), bots }
    })
  }

  async groupDetail(chatId: string): Promise<{
    chatId: string
    chatType: 'group' | 'p2p'
    chatName?: string
    botMember: boolean
    bots: Array<{ id: string; name: string; openId?: string; member: boolean; bound: boolean }>
    sessions: Array<{ sessionId: string; at: number; source: string; current: boolean }>
  }> {
    const merged = new Map<string, { sessionId: string; at: number; source: string; current: boolean }>()
    const chatRows = await this.availableChats(false)
    const chatRow = chatRows.find(chat => chat.chatId === chatId)
    let chatName = ''
    let chatType: 'group' | 'p2p' = 'group'
    let botMember = false
    const details = await Promise.all(this.bots.map(bot => bot.groupDetail(chatId).catch(() => undefined)))
    for (const detail of details) {
      if (detail === undefined) continue
      if (detail.chatType === 'p2p') chatType = 'p2p'
      if (chatName === '' && detail.chatName !== undefined) chatName = detail.chatName
      botMember = botMember || detail.botMember
      for (const session of detail.sessions) {
        const previous = merged.get(session.sessionId)
        if (previous === undefined || session.at > previous.at) merged.set(session.sessionId, session)
        else if (session.current) previous.current = true
      }
    }
    const bots = chatType === 'p2p'
      ? this.bots.flatMap(bot => {
        const bound = bot.registry.entries().some(([key]) => key === chatId || key.startsWith(`${chatId}::`))
        return bound
          ? [{
            id: bot.config.botId,
            name: bot.config.botName,
            ...(bot.config.botOpenId === undefined ? {} : { openId: bot.config.botOpenId }),
            member: true,
            bound: true,
          }]
          : []
      })
      : chatRow?.bots ?? []
    return {
      chatId,
      chatType,
      ...(chatName === '' ? {} : { chatName }),
      botMember,
      bots,
      sessions: [...merged.values()].sort((left, right) => right.at - left.at),
    }
  }

  bindingsForChat(chatId: string): Array<{ chatId: string; botId: string; botName: string; sessionId: string; source: string; at: number }> {
    return this.bots.flatMap(bot => bot.registry.entries()
      .filter(([key]) => key === chatId || key.startsWith(`${chatId}::`))
      .map(([, record]) => ({
        chatId,
        botId: record.botId,
        botName: bot.config.botName,
        sessionId: record.sessionId ?? '',
        source: record.source,
        at: record.at,
      })))
  }

  async bindToSession(chatId: string, sessionId: string, botId?: string): Promise<void> {
    await this.pick(botId).bindToSession(chatId, sessionId)
  }

  async unbindChat(chatId: string, botId?: string): Promise<boolean> {
    if (botId !== undefined && botId !== '') return this.pick(botId).unbindChat(chatId)
    const results = await Promise.all(this.bots.map(bot => bot.unbindChat(chatId)))
    return results.some(Boolean)
  }

  async bindChat(chatId: string, sessionId: string, botId?: string): Promise<void> {
    await this.pick(botId).bindChat(chatId, sessionId)
  }

  async assertBindableChat(chatId: string, botId?: string): Promise<void> {
    await this.pick(botId).assertBindableChat(chatId)
  }

  async allowChat(chatId: string, kind: 'group' | 'p2p' = 'group'): Promise<boolean> {
    return this.primary.allowChat(chatId)
  }

  isBotSession(sessionId: string): boolean {
    return this.bots.some(bot => bot.isBotSession(sessionId))
  }

  seedHandoffSession(sessionId: string, title: string, botId?: string): void {
    this.pick(botId).seedHandoffSession(sessionId, title)
  }

  applyPermissionPreset(sessionId: string, botId?: string): void {
    this.pick(botId).applyPermissionPreset(sessionId)
  }

  chatName(chatId: string, botId?: string): Promise<string | undefined> {
    return this.pick(botId).chatName(chatId)
  }
}

/** Services required by the bridge. */
export const inject = ['subprocess', 'sessionController', 'sessionProjections', 'tools', 'sessions', 'permissionPresets', 'webServer']

/**
 * Mount the bridge.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} config
 */
export async function apply(ctx: HostContext, config: unknown): Promise<void> {
  await ctx.sessionProjections.register(taskProjection)
  await ctx.sessionProjections.register(artifactsProjection)
  const base = normalizeConfig(config)
  const sharedRegistry = new BindingRegistry(base.stateDir, base.bots[0]?.id ?? base.botId)
  const sharedSeen = new SeenStore(join(base.stateDir, 'seen.jsonl'), { logger: ctx.logger })
  const sharedChats = new ChatDirectory(base.stateDir)
  const botNames = new Map(base.bots.map(bot => [bot.id, bot.name]))
  const bots = base.bots.map(bot => new FeishuBot(ctx, {
    ...base,
    botId: bot.id,
    botName: bot.name,
    ...(bot.openId === undefined ? { botOpenId: undefined } : { botOpenId: bot.openId }),
    ...(bot.profile === undefined ? { larkProfile: undefined } : { larkProfile: bot.profile }),
    allowChats: bot.allowChats,
    approveUsers: bot.approveUsers,
    permissionPreset: bot.permissionPreset,
  }, { registry: sharedRegistry, seen: sharedSeen, chats: sharedChats, botNames }))
  const host = new BotHost(ctx, base, bots)
  ctx.effect(() => () => { void host.dispose() }, 'habo-assistant: lifecycle')
  registerBindTool(ctx, host)
  registerBindingInfoTool(ctx, host)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/feishu-bot/api',
    handler: (req, res) => {
      void handleFeishuApi(req, res, host).catch(error => {
        sendJson(res, 500, { ok: false, error: String(error) })
      })
    },
  }), 'feishu-bot: api route')
  void host.start()
}

/** Let the current Session hand a group to itself, or to a fork of itself. */
function registerBindTool(ctx: HostContext, bot: BotHost): void {
  ctx.effect(() => ctx.tools.register({
    name: 'feishu_bind_chat',
    description: 'Bind a Feishu group chat to a DSH Session so future @bot messages continue there. Call when the user asks to talk with people in a Feishu group from here. mode=handoff (default) creates a small new Session with the provided summary; new creates an empty Session; current reuses this Session; fork copies the full history (slow when this Session is large).',
    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'Feishu group chat id (oc_...).',
      },
      mode: {
        type: 'string',
        required: false,
        enum: ['handoff', 'new', 'current', 'fork'],
        description: 'handoff (default) creates a new Session with the summary; new creates an empty Session; current keeps this Session; fork copies the full history.',
      },
      handoff: {
        type: 'string',
        required: false,
        description: 'Compact context summary for mode=handoff; a few sentences are enough.',
      },
      bot: {
        type: 'string',
        required: false,
        description: 'Bot id/name/open_id when multiple Feishu bots are configured; defaults to the primary bot.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chatId: { type: 'string' },
          sessionId: { type: 'string' },
          mode: { type: 'string' },
        },
        required: ['chatId', 'sessionId', 'mode'],
      },
      render: (_args: unknown, value: { chatId: string; sessionId: string; mode: string }) => [{
        type: 'text',
        text: `Feishu group ${value.chatId} is now bound to ${value.sessionId} (${value.mode}).`,
      }],
    },
    presentCall: (args: { chat_id?: string; mode?: string }) => ({
      card: 'generic',
      title: 'Bind Feishu group',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args: { chat_id?: unknown; mode?: unknown; handoff?: unknown; bot?: unknown }, exec: { agent?: { session?: { id?: string } } }) {
      const chatId = typeof args.chat_id === 'string' ? args.chat_id.trim() : ''
      if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error('chat_id must be a Feishu group id (oc_...)')
      const botId = typeof args.bot === 'string' ? args.bot.trim() : ''
      await bot.assertBindableChat(chatId, botId)
      const current = exec.agent?.session?.id
      if (typeof current !== 'string') throw new Error('feishu_bind_chat requires an owning Session')
      if (bot.isBotSession(current)) throw new Error('this Session is already a Feishu bot Session')
      const mode = args.mode === 'current' || args.mode === 'fork' || args.mode === 'new' ? args.mode : 'handoff'
      const handoff = typeof args.handoff === 'string' ? args.handoff.trim() : ''
      await bot.allowChat(chatId)
      let sessionId = current
      const groupTitle = await bot.chatName(chatId, botId)
      const title = groupTitle === undefined || groupTitle === '' ? `飞书·${chatId.slice(-8)}` : `飞书·${groupTitle}`
      if (mode === 'fork') {
        const forked = await bot.ctx.sessionController.fork({ sessionId: current })
        sessionId = forked.sessionId
        bot.applyPermissionPreset(sessionId, botId)
        await bot.ctx.sessionController.rename({ sessionId, title }).catch(() => {})
      } else if (mode === 'new' || mode === 'handoff') {
        const created = await bot.ctx.sessionController.create(
          bot.config.workspaceId === undefined
            ? { cwd: bot.config.cwd }
            : { workspaceId: bot.config.workspaceId },
        )
        sessionId = created.sessionId
        bot.applyPermissionPreset(sessionId, botId)
        await bot.ctx.sessionController.rename({ sessionId, title }).catch(() => {})
        if (mode === 'handoff' && handoff !== '') {
          const resolved = await bot.ctx.sessionController.resolveAgent(sessionId)
          resolved.agent?.inject({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: handoff }],
            source: { kind: 'user' },
          })
        }
      }
      await bot.bindChat(chatId, sessionId, botId)
      if (mode === 'handoff') bot.seedHandoffSession(sessionId, title, botId)
      return { chatId, sessionId, mode }
    },
  }), 'feishu-bot: bind tool')
}


/** Read-only tool: let a bound session answer which bots own a group. */
function registerBindingInfoTool(ctx: HostContext, host: BotHost): void {
  ctx.effect(() => ctx.tools.register({
    name: 'feishu_group_bindings',
    description: 'List the Feishu bots currently bound to one group chat, including the session each bot routes into. Use this when asked how many bots are in the group or which bot owns it.',
    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'Feishu group chat id (oc_...), usually the 群ID in the prompt header.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chatId: { type: 'string' },
          bindings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                chatId: { type: 'string' },
                botId: { type: 'string' },
                botName: { type: 'string' },
                sessionId: { type: 'string' },
                source: { type: 'string' },
                at: { type: 'number' },
              },
              required: ['chatId', 'botId', 'botName', 'sessionId', 'source', 'at'],
            },
          },
        },
        required: ['chatId', 'bindings'],
      },
      render: (_args: unknown, value: { bindings: Array<{ botName: string; sessionId: string }> }) => [{
        type: 'text',
        text: value.bindings.length === 0
          ? 'No Feishu bots are bound to this group.'
          : value.bindings.map(binding => `${binding.botName} -> ${binding.sessionId}`).join('\n'),
      }],
    },
    async execute(args: { chat_id?: unknown }) {
      const chatId = typeof args.chat_id === 'string' ? args.chat_id.trim() : ''
      if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error('chat_id must be a Feishu group id (oc_...)')
      return { chatId, bindings: host.bindingsForChat(chatId) }
    },
  }), 'habo-assistant: group bindings tool')
}

/** Read a small JSON request body. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > 64 * 1024) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

/** Web UI bridge for listing groups and binding the current Session. */
async function handleFeishuApi(req: IncomingMessage, res: ServerResponse, bot: BotHost): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const method = req.method ?? 'GET'
  const refresh = url.searchParams.get('refresh') === '1'
  if (method === 'GET') {
    if (url.searchParams.get('action') === 'health') {
      sendJson(res, 200, { ok: true, value: bot.status() })
      return
    }
    if (url.searchParams.get('action') === 'chats') {
      sendJson(res, 200, { ok: true, value: { chats: await bot.availableChats(refresh) } })
      return
    }
    if (url.searchParams.get('action') === 'group') {
      const chatId = url.searchParams.get('chatId') ?? ''
      if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) {
        sendJson(res, 400, { ok: false, error: 'chatId must be a Feishu group id (oc_...)' })
        return
      }
      sendJson(res, 200, { ok: true, value: await bot.groupDetail(chatId) })
      return
    }
    sendJson(res, 200, { ok: true, value: await bot.bindingStatus(refresh) })
    return
  }
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String(error) })
    return
  }
  const action = typeof body.action === 'string' ? body.action : ''
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : ''
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
  if (action === 'bind') {
    if (chatId === '' || sessionId === '') {
      sendJson(res, 400, { ok: false, error: 'chatId and sessionId are required' })
      return
    }
    await bot.bindToSession(chatId, sessionId, botId)
    sendJson(res, 200, { ok: true, value: await bot.bindingStatus(true) })
    return
  }
  if (action === 'unbind') {
    if (chatId === '') {
      sendJson(res, 400, { ok: false, error: 'chatId is required' })
      return
    }
    await bot.unbindChat(chatId, botId)
    sendJson(res, 200, { ok: true, value: await bot.bindingStatus(true) })
    return
  }
  sendJson(res, 400, { ok: false, error: 'unknown action' })
}
