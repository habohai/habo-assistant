/**
 * Per-session task status for the right-Sidebar "Feishu tasks" page.
 *
 * The projection is derived only from committed session events, so it replays
 * from the log like every other projection. It keeps the question, the chat
 * id, and whether the turn is running or blocked on an approval; the Client
 * reads these values through the session-list summary, which is why `summary`
 * stays enabled and the payload is deliberately small.
 */

export type TaskStatus = 'idle' | 'running' | 'approval'

export interface TaskView {
  /** True only for a session that was opened from a Feishu group message. */
  bot: boolean
  status: TaskStatus
  chatId: string
  chatName: string
  question: string
  startedAt: number
  updatedAt: number
  approval: string
}

export interface TaskState extends TaskView {
  /** Number of inherited fork events that are history, not work in this session. */
  inherited: number
  view: TaskView
}

interface ProjectionEvent {
  type: string
  seq?: number
  time?: number
  data?: {
    turn?: number
    content?: Array<{ type?: string; text?: string }>
    source?: { kind?: string }
    reason?: string
  }
}

const HEADER = /^\[飞书群:([^\]|]+)/
const MAX_QUESTION = 240
const MAX_APPROVAL = 240

function emptyState(inherited = 0): TaskState {
  const view: TaskView = {
    bot: false,
    status: 'idle',
    chatId: '',
    chatName: '',
    question: '',
    startedAt: 0,
    updatedAt: 0,
    approval: '',
  }
  return { ...view, inherited, view }
}

function sameView(left: TaskView, right: TaskView): boolean {
  return left.bot === right.bot
    && left.status === right.status
    && left.chatId === right.chatId
    && left.chatName === right.chatName
    && left.question === right.question
    && left.startedAt === right.startedAt
    && left.updatedAt === right.updatedAt
    && left.approval === right.approval
}

/** Build the next state, reusing the old view reference when nothing visible changed. */
function next(state: TaskState, patch: Partial<TaskView>): TaskState {
  const merged: TaskView = {
    bot: state.bot,
    status: state.status,
    chatId: state.chatId,
    chatName: state.chatName,
    question: state.question,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    approval: state.approval,
    ...patch,
  }
  const view = sameView(state.view, merged) ? state.view : { ...merged }
  return { ...merged, inherited: state.inherited, view }
}

function parseView(value: unknown): TaskView {
  if (value === null || typeof value !== 'object') throw new Error('feishuBotTask: invalid view')
  const record = value as Record<string, unknown>
  return {
    bot: record.bot === true,
    status: record.status === 'running' || record.status === 'approval' ? record.status : 'idle',
    chatId: typeof record.chatId === 'string' ? record.chatId : '',
    chatName: typeof record.chatName === 'string' ? record.chatName : '',
    question: typeof record.question === 'string' ? record.question : '',
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    approval: typeof record.approval === 'string' ? record.approval : '',
  }
}

function parseState(value: unknown): TaskState {
  const view = parseView(value)
  const inherited = value !== null && typeof value === 'object'
    && typeof (value as Record<string, unknown>).inherited === 'number'
    ? (value as Record<string, unknown>).inherited as number
    : 0
  return { ...view, inherited, view }
}

function textOf(event: ProjectionEvent): string {
  const blocks = Array.isArray(event.data?.content) ? event.data?.content : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim()
}

export const taskProjection = {
  key: 'feishuBotTask',
  stateVersion: 2,
  stateSchema: { parse: parseState },
  init: (_header: unknown, inheritedEventCount: number): TaskState => emptyState(inheritedEventCount),
  apply(state: TaskState, event: ProjectionEvent): TaskState {
    // A fork's inherited prefix is history, not work done in this session.
    if (typeof event.seq === 'number' && event.seq < state.inherited) return state
    const time = typeof event.time === 'number' ? event.time : Date.now()
    switch (event.type) {
      case 'user/message': {
        if (event.data?.source?.kind !== 'user') return state
        const text = textOf(event)
        const lineEnd = text.indexOf('\n')
        const header = lineEnd === -1 ? text : text.slice(0, lineEnd)
        const match = HEADER.exec(header)
        if (match === null) return state
        const first = match[1]?.trim() ?? ''
        const idMatch = /群ID:([^|\]]+)/.exec(header)
        const chatId = idMatch?.[1]?.trim() ?? (first.startsWith('oc_') ? first : '')
        const chatName = idMatch === null ? (first.startsWith('oc_') ? '' : first) : first
        const question = (lineEnd === -1 ? '' : text.slice(lineEnd + 1)).trim().slice(0, MAX_QUESTION)
        return next(state, {
          bot: true,
          status: 'running',
          chatId,
          chatName,
          question,
          startedAt: time,
          updatedAt: time,
          approval: '',
        })
      }
      case 'turn/start':
        return state.bot
          ? next(state, { status: 'running', startedAt: state.startedAt || time, updatedAt: time, approval: '' })
          : state
      case 'approval/asked': {
        if (!state.bot) return state
        const reason = typeof event.data?.reason === 'string' ? event.data.reason : ''
        return next(state, {
          status: 'approval',
          approval: reason.slice(0, MAX_APPROVAL),
          updatedAt: time,
        })
      }
      case 'approval/decided':
        return state.bot ? next(state, { status: 'running', approval: '', updatedAt: time }) : state
      case 'turn/end':
        return state.bot ? next(state, { status: 'idle', approval: '', updatedAt: time }) : state
      default:
        return state
    }
  },
  wire: {
    viewSchema: { parse: parseView },
    view: (state: TaskState): TaskView => state.view,
    summary: true,
  },
}
