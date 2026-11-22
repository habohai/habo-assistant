/**
 * Which tool calls count as "acting" rather than "reading".
 *
 * Approval in action mode hangs off this list: a read is free, a write or a
 * shell command needs a human. The list is explicit rather than derived from
 * tool metadata because DSH does not publish a risk attribute.
 */

/** Built-in tools that change state, run code, or start long-lived work. */
export const MUTATING_TOOLS: readonly string[] = [
  'bash',
  'pwsh',
  'write',
  'edit',
  'apply_patch',
  'str_replace_editor',
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'job_kill',
  'schedule_create',
  'subagent',
  'workflow',
]

/** Tools that only read; listed so the intent is explicit and testable. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'fs_search',
  'web_fetch',
  'web_search',
  'job_output',
  'job_list',
  'todo_write',
  'skill',
  'session_query',
  'present',
]

/** Whether one tool name needs approval before it runs. */
export function isMutatingTool(name: string, extra: readonly string[] = []): boolean {
  if (typeof name !== 'string' || name === '') return false
  if (extra.includes(name)) return true
  return MUTATING_TOOLS.includes(name)
}

/** Short human description of what a tool call will do, for the approval prompt. */
export function describeToolCall(name: string, args: unknown, limit = 160): string {
  const command = extractCommand(args)
  if (command !== '') return `${name}: ${truncate(command, limit)}`
  const path = extractPath(args)
  if (path !== '') return `${name}: ${path}`
  return name
}

function extractCommand(args: unknown): string {
  if (args === null || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function extractPath(args: unknown): string {
  if (args === null || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of ['path', 'file_path', 'filePath', 'target']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function truncate(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}