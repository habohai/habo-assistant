/**
 * Plugin configuration: defaults, normalization, and the "can we start?" check.
 *
 * Every value is validated here so the runtime never has to second-guess a
 * number. Out-of-range integers clamp to the nearest bound; missing or
 * non-positive ones fall back to the documented default.
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface BotConfig {
  id: string
  name: string
  profile?: string
  openId?: string
  allowChats: string[]
  approveUsers: string[]
  permissionPreset: string
}

/** Normalized plugin configuration. */
export interface Config {
  larkCli: string
  /** lark-cli configuration profile; one profile = one bot app. */
  larkProfile?: string
  cwd: string
  workspaceId?: string
  allowChats: string[]
  botId: string
  botOpenId?: string
  /** Stable tenant-wide owner identity used to verify the owner is in a group. */
  ownerUnionId?: string
  botName: string
  /** One entry per Feishu bot app; empty input becomes a single inherited bot. */
  bots: BotConfig[]
  agentPreset?: string
  routing: 'chat' | 'topic' | 'thread'
  /** New topics inherit a compact digest of the group's main session. */
  topicContext: 'summary' | 'none'
  replyInThread: boolean
  progress: boolean
  ackReaction: string
  /** Delegate long tasks to a task subagent instead of growing the main Session. */
  taskSubagentEnabled: boolean
  /** Context pressure (surface tokens) above which a task is delegated. */
  taskSubagentContextThreshold: number
  /** Turn count above which a task is delegated. */
  taskSubagentTurnThreshold: number
  /** How long one conversation's task summary stays reusable. */
  taskSubagentTtlMs: number
  /** Registered subagent backend name on `ctx.subagents` (spawn provider default). */
  taskSubagentProvider: string
  /**
   * Send approvals as interactive cards with buttons.
   *
   * Off by default: card buttons need the app's card callback configured in the
   * Feishu console, which is an organization-level change. Text approval works
   * with only the message events the bot already consumes.
   */
  approvalCards: boolean
  /** Where a bot-session approval is asked: the chat group (default) or DSH. */
  approvalChannel: 'feishu' | 'dsh'
  /**
   * Which incoming requests need an owner decision before the bot acts.
   *
   * `non-owner` (default) asks the owner whenever someone else addresses the
   * bot — the request itself is the unit of approval, not the risk of whatever
   * command the agent may later choose. `off` trusts the chat; `all` also asks
   * for the owner's own messages.
   */
  requestApproval: 'off' | 'non-owner' | 'all'
  /**
   * How long one approval keeps working for the same person in the same chat.
   *
   * Without it every single message needs a decision; with it a normal working
   * session asks once. 0 disables trust entirely.
   */
  requestTrustMs: number
  /**
   * Which bot answers when one message mentions several of ours.
   *
   * `all` is the historical behaviour; `first` keeps only the first mentioned
   * bot answering, so a group with two bots does not get two replies.
   */
  mentionPolicy: 'all' | 'first'
  /**
   * Where approval happens: on the request, on the risky action, or never.
   *
   * `request` (default) asks before the bot works on someone else's message.
   * `action` lets it answer and asks only before it executes a mutating tool.
   * Never enable both: one operation would be approved twice.
   */
  approvalMode: 'request' | 'action' | 'off'
  /** Tools treated as "acting" in action mode; empty uses the built-in list. */
  actionApprovalTools: string[]
  /** Ask again for a dangerous command even inside a trust window. */
  alwaysAskDangerous: boolean
  timeoutMs: number
  maxReplyChars: number
  /** Prompt-level style constraints for every Feishu reply. */
  replyGuidelines: string
  /** Chat-name cache TTL for lark-cli chat lists. */
  chatListTtlMs: number
  maxConcurrent: number
  maxQueue: number
  cliTimeoutMs: number
  readyTimeoutMs: number
  statsIntervalMs: number
  permissionPreset: string
  autoEnableApproverChats: boolean
  approvalTimeoutMs: number
  /** A direct (p2p) binding older than this starts a fresh Session. */
  p2pSessionTtlMs: number
  approveUsers: string[]
  stateDir: string
  dryRun: boolean
}

/** Documented defaults, also used as the single source of truth in tests. */
export const DEFAULTS = {
  timeoutMs: 10 * 60 * 1000,
  maxReplyChars: 3500,
  replyGuidelines: '使用中文回答。保持简洁、有条理：先给结论，再列必要要点；不要冗长客套，不要重复问题。',
  maxConcurrent: 4,
  maxQueue: 20,
  cliTimeoutMs: 15_000,
  readyTimeoutMs: 30_000,
  statsIntervalMs: 5 * 60 * 1000,
  approvalTimeoutMs: 2 * 60 * 1000,
  p2pSessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  chatListTtlMs: 5 * 60 * 1000,
  topicContext: 'summary' as const,
}

/** `none`/`off` (any case) disables the acknowledgement reaction. */
export function normalizeAckReaction(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || /^(none|off)$/i.test(trimmed)) return ''
  return trimmed
}

/**
 * Normalize user configuration with safe defaults.
 * @param {unknown} raw
 */
export function normalizeConfig(raw: unknown): Config {
  const value: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const string = (key: string, fallback = ''): string => typeof value[key] === 'string' ? value[key].trim() : fallback
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const candidate = value[key]
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) return fallback
    return Math.min(Math.max(Math.floor(candidate), min), max)
  }
  const list = (key: string, fallback: string[] = []): string[] => Array.isArray(value[key])
    ? value[key].filter((item): item is string => typeof item === 'string' && item.trim() !== '').map(item => item.trim())
    : fallback
  const chats = list('allowChats')
  const base: Config = {
    larkCli: string('larkCli', 'lark-cli'),
    larkProfile: string('larkProfile') || undefined,
    cwd: string('cwd'),
    /** Existing DSH workspace to attach new sessions to; cwd is then only the CLI directory. */
    workspaceId: string('workspaceId') || undefined,
    allowChats: chats,
    botOpenId: string('botOpenId') || undefined,
    ownerUnionId: string('ownerUnionId') || undefined,
    botName: string('botName', '飞书机器人'),
    agentPreset: string('agentPreset') || undefined,
    routing: value.routing === 'topic' || value.routing === 'thread' ? value.routing : 'chat',
    topicContext: value.topicContext === 'none' ? 'none' : 'summary',
    replyInThread: value.replyInThread !== false,
    /** Send a placeholder reply immediately and edit it into the final answer. */
    progress: value.progress !== false,
    /** Emoji reacted onto the question while it is queued; '' disables. */
    ackReaction: normalizeAckReaction(string('ackReaction', 'auto')),
    taskSubagentEnabled: value.taskSubagentEnabled === true,
    taskSubagentContextThreshold: integer('taskSubagentContextThreshold', 120_000, 10_000, 2_000_000),
    taskSubagentTurnThreshold: integer('taskSubagentTurnThreshold', 80, 5, 10_000),
    taskSubagentTtlMs: integer('taskSubagentTtlMs', 30 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    // The provider registers under `providerName`, which defaults to `spawn`;
    // the package name `subagent-spawn-in-process` is NOT a registered backend.
    taskSubagentProvider: string('taskSubagentProvider', 'spawn'),
    approvalCards: value.approvalCards === true,
    approvalChannel: value.approvalChannel === 'dsh' ? 'dsh' : 'feishu',
    requestApproval: value.requestApproval === 'off' || value.requestApproval === 'all'
      ? value.requestApproval
      : 'non-owner',
    // 0 is a meaningful value here (trust disabled), so it bypasses integer().
    mentionPolicy: value.mentionPolicy === 'first' ? 'first' : 'all',
    approvalMode: value.approvalMode === 'action' || value.approvalMode === 'off'
      ? value.approvalMode
      : 'request',
    actionApprovalTools: list('actionApprovalTools'),
    alwaysAskDangerous: value.alwaysAskDangerous !== false,
    requestTrustMs: value.requestTrustMs === 0
      ? 0
      : integer('requestTrustMs', 30 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    timeoutMs: integer('timeoutMs', DEFAULTS.timeoutMs, 5_000, 60 * 60 * 1000),
    maxReplyChars: integer('maxReplyChars', DEFAULTS.maxReplyChars, 200, 50_000),
    replyGuidelines: string('replyGuidelines', DEFAULTS.replyGuidelines).slice(0, 500),
    maxConcurrent: integer('maxConcurrent', DEFAULTS.maxConcurrent, 1, 32),
    maxQueue: integer('maxQueue', DEFAULTS.maxQueue, 1, 500),
    cliTimeoutMs: integer('cliTimeoutMs', DEFAULTS.cliTimeoutMs, 1_000, 120_000),
    readyTimeoutMs: integer('readyTimeoutMs', DEFAULTS.readyTimeoutMs, 5_000, 300_000),
    statsIntervalMs: integer('statsIntervalMs', DEFAULTS.statsIntervalMs, 10_000, 24 * 60 * 60 * 1000),
    /** DSH permission preset applied to new bot sessions; empty keeps the deployment default. */
    permissionPreset: string('permissionPreset'),
    autoEnableApproverChats: value.autoEnableApproverChats !== false && value.autoEnableOwnerChats !== false,
    approvalTimeoutMs: integer('approvalTimeoutMs', DEFAULTS.approvalTimeoutMs, 10_000, 30 * 60 * 1000),
    p2pSessionTtlMs: integer('p2pSessionTtlMs', DEFAULTS.p2pSessionTtlMs, 60_000, 365 * 24 * 60 * 60 * 1000),
    chatListTtlMs: integer('chatListTtlMs', DEFAULTS.chatListTtlMs, 10_000, 24 * 60 * 60 * 1000),
    /** Approver open_ids; empty means any member of the chat may answer. */
    approveUsers: list('approveUsers'),
    stateDir: string('stateDir') || join(homedir(), '.dsh', 'feishu-bot'),
    dryRun: value.dryRun === true,
    botId: string('botId') || string('botOpenId') || string('botName', '飞书机器人'),
    bots: [],
  }
  const rawBots = Array.isArray(value.bots) ? value.bots : []
  base.bots = rawBots.length === 0
    ? [{
      id: base.botId,
      name: base.botName,
      ...(base.larkProfile === undefined ? {} : { profile: base.larkProfile }),
      ...(base.botOpenId === undefined ? {} : { openId: base.botOpenId }),
      allowChats: base.allowChats,
      approveUsers: base.approveUsers,
      permissionPreset: base.permissionPreset,
    }]
    : rawBots.map((item, index) => {
      const bot = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
      const name = typeof bot.name === 'string' && bot.name.trim() !== '' ? bot.name.trim() : `机器人 ${index + 1}`
      const openId = typeof bot.openId === 'string' ? bot.openId.trim() : typeof bot.botOpenId === 'string' ? bot.botOpenId.trim() : base.botOpenId
      const allowChats = Array.isArray(bot.allowChats)
        ? bot.allowChats.filter((chat): chat is string => typeof chat === 'string' && chat.trim() !== '').map(chat => chat.trim())
        : base.allowChats
      const approveUsers = Array.isArray(bot.approveUsers)
        ? bot.approveUsers.filter((user): user is string => typeof user === 'string' && user.trim() !== '').map(user => user.trim())
        : base.approveUsers
      return {
        id: typeof bot.id === 'string' && bot.id.trim() !== '' ? bot.id.trim() : openId ?? name,
        name,
        ...(typeof bot.profile === 'string' && bot.profile.trim() !== '' ? { profile: bot.profile.trim() } : base.larkProfile === undefined ? {} : { profile: base.larkProfile }),
        ...(openId === undefined ? {} : { openId }),
        allowChats,
        approveUsers,
        permissionPreset: typeof bot.permissionPreset === 'string' ? bot.permissionPreset.trim() : base.permissionPreset,
      }
    })
  return base
}

/**
 * Whether the configuration can start the consumer.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {string | undefined} a human-readable reason when unusable.
 */
export function configProblem(config: Config): string | undefined {
  if (config.cwd === '') return 'cwd is required'
  const ids = new Set<string>()
  const profiles = new Set<string>()
  for (const bot of config.bots) {
    if (ids.has(bot.id)) return `duplicate bot id: ${bot.id}`
    ids.add(bot.id)
    const profile = bot.profile ?? ''
    if (config.bots.length > 1 && profile === '') return `bot ${bot.id} needs a larkProfile when multiple bots are configured`
    if (config.bots.length > 1 && (bot.openId === undefined || bot.openId === '')) return `bot ${bot.id} needs an openId when multiple bots are configured`
    if (profile !== '') {
      if (profiles.has(profile)) return `duplicate larkProfile: ${profile}`
      profiles.add(profile)
    }
  }
  if (!isAbsolute(config.cwd)) return 'cwd must be an absolute path'
  if (config.allowChats.length === 0 && !(config.autoEnableApproverChats && config.approveUsers.length > 0)) {
    return 'allowChats is empty; the bot would refuse every chat'
  }
  return undefined
}
