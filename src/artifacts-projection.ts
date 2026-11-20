/**
 * Host half of the Session artifacts bundle.
 *
 * Folds one Session's committed events into the client-visible
 * `sessionArtifacts` projection:
 *
 * - files a `present` call declared (delivered) and files successful
 *   `write`/`edit`/mutating `str_replace_editor` calls touched (produced);
 * - Feishu/Lark cloud documents whose links appear in tool results, such as the
 *   `url` a `lark-cli docs|sheets|base|slides|wiki ...` call returns.
 *
 * Each artifact is listed once in first-seen Session order. Nothing is read from
 * the workspace and no model request changes.
 *
 * The fold is a pure synchronous reducer so the session-projection registry can
 * drive it, checkpoint it, and replay it. `wire.view` returns the cached view
 * object, so an event that changes no artifact costs zero downstream work.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Artifact, ArtifactsView } from './artifacts-shared.js'

type HostEvent = SessionEvent | { type: 'deliverables/presented'; seq?: number; data: unknown }

interface CallState {
  path?: string
  turn: number
  scan: boolean
}

interface State {
  inherited: number
  calls: Record<string, CallState>
  items: Artifact[]
  view: ArtifactsView
}

type MutableArtifact = Artifact

/** First-party tools whose successful result writes or rewrites a file. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * Tools whose command text can reveal a Feishu link: a terminal running
 * `lark-cli`, or a delegated task whose answer reports what it created.
 */
const TERMINAL_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent', 'terminal'])

/**
 * Feishu/Lark resource links. The host must be a Feishu/Lark tenant domain and
 * the first path segment must name a content resource, so help pages such as
 * `open.feishu.cn/document/...` and marketing pages never match.
 */
const LARK_URL = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+(?:feishu\.cn|larksuite\.com|larkoffice\.com))\/(docx|docs|doc|wiki|sheets|base|slides|minutes|mindnotes|file|board)\/([A-Za-z0-9_-]+)/gi

/** Resource links that are not documents on their own. */
const NON_DOCUMENT_RESOURCES = new Set(['space'])

/** @param {unknown} value */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** @param {string} path */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

/**
 * Parse one tool call's raw JSON arguments.
 * @param {string} rawArguments
 * @returns {Record<string, unknown> | undefined}
 */
function parseArguments(rawArguments: string): Record<string, unknown> | undefined {
  try {
    const args = JSON.parse(rawArguments)
    return isRecord(args) ? args : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a call's result may report a Feishu link.
 * @param {string} name
 * @param {Record<string, unknown> | undefined} args
 * @returns {boolean}
 */
function scansLinks(name: string, args: Record<string, unknown> | undefined): boolean {
  if (name.startsWith('subagent') || name === 'workflow') return true
  if (!TERMINAL_TOOLS.has(name) || args === undefined) return false
  return typeof args.command === 'string' && /\blark-cli\b/.test(args.command)
}

/**
 * Extract the target path from one supported mutation call.
 * @param {string} name
 * @param {Record<string, unknown> | undefined} args
 * @returns {string | undefined}
 */
function mutationPath(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined
  switch (name) {
    case 'write':
      return typeof args.content === 'string' && nonEmptyString(args.file_path) ? args.file_path : undefined
    case 'edit':
      return typeof args.old_string === 'string'
        && args.old_string.length > 0
        && typeof args.new_string === 'string'
        && nonEmptyString(args.file_path)
        ? args.file_path
        : undefined
    case 'str_replace_editor': {
      if (!nonEmptyString(args.path)) return undefined
      switch (args.command) {
        case 'create':
          return typeof args.file_text === 'string' ? args.path : undefined
        case 'str_replace':
          return typeof args.old_str === 'string' && args.old_str.length > 0 ? args.path : undefined
        case 'insert':
          return typeof args.new_str === 'string' ? args.path : undefined
        default:
          return undefined
      }
    }
    default:
      return undefined
  }
}

/**
 * Prefer the recorded absolute target, falling back to the argument spelling for
 * legacy results. A relative argument stays relative; the Client resolves it
 * against the Session workspace before previewing.
 * @param {string} argumentPath
 * @param {unknown} meta
 * @returns {string}
 */
function resultPath(argumentPath: string, meta: unknown): string {
  if (isRecord(meta) && typeof meta.path === 'string' && isAbsolutePath(meta.path)) return meta.path
  return argumentPath
}

/**
 * Concatenate the text parts of one tool-result message.
 * @param {unknown} message
 * @returns {string}
 */
function resultText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  let text = ''
  for (const part of message.content) {
    if (isRecord(part) && typeof part.text === 'string') text += `${part.text}\n`
  }
  return text
}

/**
 * The dedupe identity of one artifact: the link for a cloud document, the path
 * for a file.
 * @param {{ path?: string, url?: string }} item
 * @returns {string | undefined}
 */
function itemKey(item: Pick<Artifact, 'path' | 'url'>): string | undefined {
  return item.url !== undefined ? item.url : item.path
}

/**
 * Insert or upgrade one artifact.
 * @param {{ items: Array<Record<string, unknown>>, view: unknown }} state
 * @param {{ path?: string, url?: string, resource?: string, kind: string, turn: number, description?: string }} item
 */
function upsert(state: State, item: MutableArtifact): State {
  const key = itemKey(item)
  if (key === undefined) return state
  const index = state.items.findIndex(entry => itemKey(entry) === key)
  if (index === -1) {
    const items = [...state.items, item]
    return { ...state, items, view: { artifacts: items } }
  }
  const current = state.items[index]
  if (item.url !== undefined) return state
  const merged: Artifact = {
    path: current.path,
    kind: current.kind === 'delivered' || item.kind === 'delivered' ? 'delivered' : 'produced',
    turn: current.turn,
    ...(item.description === undefined
      ? current.description === undefined ? {} : { description: current.description }
      : { description: item.description }),
  }
  if (merged.kind === current.kind
    && merged.description === current.description
    && merged.turn === current.turn) return state
  const items = state.items.slice()
  items[index] = merged
  return { ...state, items, view: { artifacts: items } }
}

/**
 * Append every Feishu/Lark content link in one text, normalized and deduped.
 * @param {{ items: Array<Record<string, unknown>>, view: unknown }} state
 * @param {string} text
 * @param {number} turn
 * @returns {typeof state}
 */
function upsertLinks(state: State, text: string, turn: number): State {
  const normalized = text.replace(/\\\//g, '/')
  let next = state
  const seen = new Set<string>()
  for (const match of normalized.matchAll(LARK_URL)) {
    const host = match[1].toLowerCase()
    const resource = match[2].toLowerCase()
    const token = match[3]
    if (NON_DOCUMENT_RESOURCES.has(token)) continue
    const url = `https://${host}/${resource}/${token}`
    if (seen.has(url)) continue
    seen.add(url)
    next = upsert(next, { url, resource, kind: 'document', turn })
  }
  return next
}

/** Persisted-state validation: the checkpoint may seed this fold after restart. */
function parseState(value: unknown): State {
  if (!isRecord(value)
    || !isRecord(value.calls)
    || !Array.isArray(value.items)
    || !isRecord(value.view)
    || !Array.isArray(value.view.artifacts)) {
    throw new Error('session-artifacts: invalid projection state')
  }
  for (const item of value.items) {
    if (!isRecord(item) || (typeof item.path !== 'string' && typeof item.url !== 'string')) {
      throw new Error('session-artifacts: invalid artifact entry')
    }
  }
  return value as unknown as State
}

/** Wire-view validation: the value the Client receives. */
function parseView(value: unknown): ArtifactsView {
  if (!isRecord(value) || !Array.isArray(value.artifacts)) {
    throw new Error('session-artifacts: invalid projection view')
  }
  return value as unknown as ArtifactsView
}

export const artifactsProjection = {
  key: 'sessionArtifacts',
  stateVersion: 3,
  stateSchema: { parse: parseState },
  init(_header: unknown, inheritedEventCount: number): State {
    return {
      inherited: typeof inheritedEventCount === 'number' ? inheritedEventCount : 0,
      calls: {},
      items: [],
      view: { artifacts: [] },
    }
  },
  apply(state: State, event: HostEvent): State {
    // A fork's inherited prefix is history, not work done in this Session.
    if (typeof event.seq === 'number' && event.seq < state.inherited) return state
    switch (event.type) {
      case 'turn/start': {
        // A call that never settled belongs to its turn and cannot cross into the next one.
        return Object.keys(state.calls).length === 0 ? state : { ...state, calls: {} }
      }
      case 'tool/call': {
        const name = event.data.name
        const args = parseArguments(event.data.arguments)
        const path = MUTATING_TOOLS.has(name) ? mutationPath(name, args) : undefined
        const scan = scansLinks(name, args)
        if (path === undefined && !scan) return state
        return {
          ...state,
          calls: {
            ...state.calls,
            [String(event.data.callId)]: { path, turn: event.data.turn, scan },
          },
        }
      }
      case 'tool/result': {
        const message = event.data.message
        const turn = typeof event.data.turn === 'number' ? event.data.turn : 0
        let next = state
        const callId = String(message?.source?.callId ?? '')
        const call = callId !== '' && Object.hasOwn(state.calls, callId) ? state.calls[callId] : undefined
        if (call !== undefined) {
          const calls = { ...next.calls }
          delete calls[callId]
          next = { ...next, calls }
          if (message?.isError !== true && call.path !== undefined) {
            next = upsert(next, {
              path: resultPath(call.path, event.data.meta),
              kind: 'produced',
              turn: typeof call.turn === 'number' ? call.turn : turn,
            })
          }
        }
        if (call?.scan !== true || message?.isError === true) return next
        const text = resultText(message)
        return text === '' ? next : upsertLinks(next, text, turn)
      }
      case 'deliverables/presented': {
        const data = event.data
        if (!isRecord(data) || !Array.isArray(data.files)) return state
        const turn = typeof data.turn === 'number' && Number.isInteger(data.turn) ? data.turn : 0
        let next = state
        for (const file of data.files) {
          if (!isRecord(file) || !nonEmptyString(file.path)) continue
          next = upsert(next, {
            path: file.path,
            kind: 'delivered',
            turn,
            ...(nonEmptyString(file.description) ? { description: file.description } : {}),
          })
        }
        return next
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: { parse: parseView },
    view: (state: State) => state.view,
    // The list belongs to an opened Session; list summaries stay small.
    summary: false,
  },
}

/** Services used by this Host half. */
export const inject = ['sessionProjections']

/**
 * Register the projection with the Session projection registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx: { sessionProjections: { register(definition: unknown): Promise<unknown> } }): Promise<void> {
  await ctx.sessionProjections.register(artifactsProjection)
}
