/**
 * Plugin configuration: defaults, normalization, and the "can we start?" check.
 *
 * Every value is validated here so the runtime never has to second-guess a
 * number. Out-of-range integers clamp to the nearest bound; missing or
 * non-positive ones fall back to the documented default.
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Normalized plugin configuration. */
export interface Config {
  larkCli: string
  cwd: string
  workspaceId?: string
  allowChats: string[]
  botOpenId?: string
  botName: string
  agentPreset?: string
  routing: 'chat' | 'thread'
  replyInThread: boolean
  progress: boolean
  ackReaction: string
  timeoutMs: number
  maxReplyChars: number
  maxConcurrent: number
  maxQueue: number
  cliTimeoutMs: number
  readyTimeoutMs: number
  statsIntervalMs: number
  permissionPreset: string
  autoEnableApproverChats: boolean
  approvalTimeoutMs: number
  approveUsers: string[]
  stateDir: string
  dryRun: boolean
}

/** Documented defaults, also used as the single source of truth in tests. */
export const DEFAULTS = {
  timeoutMs: 10 * 60 * 1000,
  maxReplyChars: 3500,
  maxConcurrent: 4,
  maxQueue: 20,
  cliTimeoutMs: 15_000,
  readyTimeoutMs: 30_000,
  statsIntervalMs: 5 * 60 * 1000,
  approvalTimeoutMs: 2 * 60 * 1000,
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
  return {
    larkCli: string('larkCli', 'lark-cli'),
    cwd: string('cwd'),
    /** Existing DSH workspace to attach new sessions to; cwd is then only the CLI directory. */
    workspaceId: string('workspaceId') || undefined,
    allowChats: chats,
    botOpenId: string('botOpenId') || undefined,
    botName: string('botName', '飞书机器人'),
    agentPreset: string('agentPreset') || undefined,
    routing: value.routing === 'thread' ? 'thread' : 'chat',
    replyInThread: value.replyInThread !== false,
    /** Send a placeholder reply immediately and edit it into the final answer. */
    progress: value.progress !== false,
    /** Emoji reacted onto the question while it is queued; '' disables. */
    ackReaction: normalizeAckReaction(string('ackReaction', 'OnIt')),
    timeoutMs: integer('timeoutMs', DEFAULTS.timeoutMs, 5_000, 60 * 60 * 1000),
    maxReplyChars: integer('maxReplyChars', DEFAULTS.maxReplyChars, 200, 50_000),
    maxConcurrent: integer('maxConcurrent', DEFAULTS.maxConcurrent, 1, 32),
    maxQueue: integer('maxQueue', DEFAULTS.maxQueue, 1, 500),
    cliTimeoutMs: integer('cliTimeoutMs', DEFAULTS.cliTimeoutMs, 1_000, 120_000),
    readyTimeoutMs: integer('readyTimeoutMs', DEFAULTS.readyTimeoutMs, 5_000, 300_000),
    statsIntervalMs: integer('statsIntervalMs', DEFAULTS.statsIntervalMs, 10_000, 24 * 60 * 60 * 1000),
    /** DSH permission preset applied to new bot sessions; empty keeps the deployment default. */
    permissionPreset: string('permissionPreset'),
    autoEnableApproverChats: value.autoEnableApproverChats !== false && value.autoEnableOwnerChats !== false,
    approvalTimeoutMs: integer('approvalTimeoutMs', DEFAULTS.approvalTimeoutMs, 10_000, 30 * 60 * 1000),
    /** Approver open_ids; empty means any member of the chat may answer. */
    approveUsers: list('approveUsers'),
    stateDir: string('stateDir') || join(homedir(), '.dsh', 'feishu-bot'),
    dryRun: value.dryRun === true,
  }
}

/**
 * Whether the configuration can start the consumer.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {string | undefined} a human-readable reason when unusable.
 */
export function configProblem(config: Config): string | undefined {
  if (config.cwd === '') return 'cwd is required'
  if (!isAbsolute(config.cwd)) return 'cwd must be an absolute path'
  if (config.allowChats.length === 0 && !(config.autoEnableApproverChats && config.approveUsers.length > 0)) {
    return 'allowChats is empty; the bot would refuse every chat'
  }
  return undefined
}
