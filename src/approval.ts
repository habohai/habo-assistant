import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

/**
 * Command approval policy.
 *
 * The bot runs on someone's machine with that person's permissions, and any
 * member of an allow-listed group can drive it. So command tools are gated: the
 * tool pipeline asks before dispatch, and the answer has to come from a human.
 *
 * This module is the pure half — which calls need a decision, and how a reply
 * reads. `FeishuBot` owns the interactive half (sending the question, waiting,
 * and routing the answer).
 */

/**
 * Default destructive-command patterns. Matched case-insensitively against the
 * command text; a match is denied outright (no approval prompt), because a
 * group member must not be able to talk the bot into wiping the machine.
 *
 * This is a lexical guard, not a sandbox: obfuscated forms can slip past it.
 * Approval and the file sandbox remain the structural limits.
 */
const SEGMENT = String.raw`(?:^|[\n;&|]\s*)`

export const DEFAULT_DENY_PATTERNS: string[] = [
  // Command-position destructive verbs: `rm -rf x`, `echo hi && rm x`, `; rmdir y`.
  `${SEGMENT}rm(?:\\s|$)`,
  `${SEGMENT}rmdir(?:\\s|$)`,
  `${SEGMENT}unlink(?:\\s|$)`,
  `${SEGMENT}dd\\b[^\\n]*\\bof=`,
  `${SEGMENT}mkfs\\b`,
  `${SEGMENT}fdisk\\b`,
  `${SEGMENT}parted\\b`,
  `${SEGMENT}diskutil\\s+(erase|partition)`,
  `${SEGMENT}shutdown\\b`,
  `${SEGMENT}reboot\\b`,
  `${SEGMENT}halt\\b`,
  `${SEGMENT}killall\\b`,
  `${SEGMENT}kill\\s+-9\\b`,
  `${SEGMENT}sudo\\b`,
  `${SEGMENT}su\\s+-`,
  `${SEGMENT}chmod\\s+-R\\b`,
  `${SEGMENT}chown\\s+-R\\b`,
  // Remote-history rewrites.
  `${SEGMENT}git\\s+push\\b[^\\n]*--force`,
  `${SEGMENT}git\\s+reset\\s+--hard`,
  `${SEGMENT}git\\s+clean\\s+-[a-z]*f`,
  // Piping a download into a shell.
  String.raw`\bcurl\b[^\n]*\|\s*(ba)?sh\b`,
  String.raw`\bwget\b[^\n]*\|\s*(ba)?sh\b`,
  // Raw block-device writes and fork bombs.
  String.raw`>\s*/dev/(sd|disk|nvme)`,
  String.raw`:\s*\(\s*\)\s*\{`,
  // Windows / PowerShell forms.
  String.raw`\bRemove-Item\b[^\n]*-Recurse`,
  String.raw`\bformat\s+[a-z]:`,
  // A delete hidden inside find.
  String.raw`\bfind\b[^\n]*-exec\s+rm\b`,
]

const ALLOW_WORDS = /^(同意|批准|可以|允许|执行|approve|allow|yes|y|ok)$/i
const DENY_WORDS = /^(拒绝|不同意|不允许|不要|取消|reject|deny|no|n)$/i
const MAX_COMMAND_CHARS = 300

/**
 * Read a human reply as an approval decision.
 * @param {string} text
 * @returns {'allow' | 'reject' | undefined} undefined when it is not an answer.
 */
export function parseApprovalReply(text: unknown): 'allow' | 'reject' | undefined {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') return undefined
  if (ALLOW_WORDS.test(trimmed)) return 'allow'
  if (DENY_WORDS.test(trimmed)) return 'reject'
  return undefined
}

/**
 * Compile configured pattern sources, dropping invalid regular expressions.
 * @param {string[]} sources
 * @returns {RegExp[]}
 */
export function compileDenyPatterns(sources: unknown): RegExp[] {
  const patterns: RegExp[] = []
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source !== 'string' || source === '') continue
    try {
      patterns.push(new RegExp(source, 'i'))
    } catch {
      // An unusable pattern must not disarm the others.
    }
  }
  return patterns
}

export interface ExecLike {
  name?: string
  agent?: { session?: { id?: string } }
  arguments?: unknown
}

export interface ApprovalPolicy {
  sessions: Set<string>
  tools: string[]
  denyTools?: string[]
  denyPatterns?: RegExp[]
  dangerousApproval?: 'ask' | 'deny'
}

/** The raw command text of one call, used for pattern matching. */
function argsOf(exec: ExecLike | undefined): Record<string, unknown> | undefined {
  const args = exec?.arguments
  return args !== null && typeof args === 'object' ? args as Record<string, unknown> : undefined
}

export function commandText(exec: ExecLike | undefined): string {
  const args = argsOf(exec)
  return typeof args?.command === 'string' ? args.command : safeJson(args)
}

/**
 * Whether a command matches one of the destructive patterns.
 * @param {{ arguments?: unknown }} exec
 * @param {RegExp[]} patterns
 */
export function isDangerousCommand(exec: ExecLike | undefined, patterns: RegExp[]): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const text = commandText(exec)
  return text !== '' && patterns.some(pattern => pattern.test(text))
}

/**
 * One-line summary of the call, for the approval prompt.
 * @param {{ name?: string, arguments?: unknown }} exec
 */
export function summarizeCommand(exec: ExecLike | undefined): string {
  const args = argsOf(exec)
  const name = typeof exec?.name === 'string' ? exec.name : 'tool'
  const raw = typeof args?.command === 'string'
    ? args.command
    : typeof args?.file_path === 'string'
      ? `${name} ${args.file_path}`
      : typeof args?.path === 'string'
        ? `${name} ${args.path}`
        : safeJson(args)
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (oneLine === '') return name
  return oneLine.length > MAX_COMMAND_CHARS ? `${oneLine.slice(0, MAX_COMMAND_CHARS)}…` : oneLine
}

/**
 * Decide one tool call for our own sessions.
 *
 * `tools/pre-execute` listeners return the decision object directly, so an
 * `undefined` result means "not mine, continue the chain".
 *
 * Two outcomes:
 * - `ask` for a command tool — the pipeline routes it through the approval seam;
 * - `deny` for a tool that could spawn another agent, because that child session
 *   is not tracked here and its commands would bypass this very gate.
 *
 * @param {{ name?: string, agent?: { session?: { id?: string } }, arguments?: unknown }} exec
 * @param {{ sessions: Set<string>, tools: string[], denyTools?: string[], denyPatterns?: RegExp[] }} policy
 * @returns {{ kind: 'ask', reason: string, displayReason: string } | { kind: 'deny', reason: string } | undefined}
 */
export function approvalDecision(
  exec: ExecLike | undefined,
  { sessions, tools, denyTools = [], denyPatterns = [], dangerousApproval = 'ask' }: ApprovalPolicy,
): PreToolDecision | undefined {
  const sessionId = exec?.agent?.session?.id
  if (typeof sessionId !== 'string' || !sessions.has(sessionId)) return undefined
  const name = exec?.name
  if (typeof name !== 'string') return undefined
  if (denyTools.includes(name)) {
    return { kind: 'deny', reason: `命令审批开启时不允许使用 ${name} 派生新 agent（新会话的命令无法被审批）` }
  }
  if (!tools.includes(name)) return undefined
  if (isDangerousCommand(exec, denyPatterns)) {
    if (dangerousApproval === 'deny') {
      return { kind: 'deny', reason: '危险命令已拒绝：当前配置不允许通过机器人执行删除/提权/磁盘类操作' }
    }
    const summary = summarizeCommand(exec)
    const reason = `⚠️ 危险操作审批：${summary}`
    return {
      kind: 'ask',
      reason,
      displayReason: { en: `Dangerous operation approval: ${summary}`, zh: reason },
    }
  }
  const summary = summarizeCommand(exec)
  const reason = `操作审批：${summary}`
  return {
    kind: 'ask',
    reason,
    // PreToolDecision.ask.displayReason is a locale map with a required `en`.
    displayReason: { en: `Approval required: ${summary}`, zh: reason },
  }
}

function safeJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
