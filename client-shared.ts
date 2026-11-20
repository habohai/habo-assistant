/**
 * Shared Client API surface for both right-Sidebar pages.
 *
 * The task page only needs the health/connection bit; the session-info page
 * reads bindings, groups, and history. Keeping one envelope, one URL, and one
 * set of wire types avoids two drifting copies of the Feishu protocol.
 */
import type * as ReactNS from 'react'

export const FEISHU_API = '/feishu-bot/api'

export interface ApiEnvelope<T> {
  ok: boolean
  value?: T
  error?: string
}

export interface FeishuTopic {
  threadId: string
  title: string
  updatedAt: number
}

export interface FeishuBinding {
  chatId: string
  chatType?: 'group' | 'p2p'
  botId?: string
  botIds?: string[]
  threadId?: string
  sessionId: string
  chatName?: string
  botMember?: boolean
  source?: string
  boundAt?: number
}

export interface FeishuChatBot {
  id: string
  name: string
  openId?: string
  member: boolean
  bound: boolean
}

export interface FeishuChat {
  chatId: string
  name: string
  botMember?: boolean
  allowed: boolean
  bound: boolean
  bots?: FeishuChatBot[]
}

export interface FeishuSessionBinding {
  sessionId: string
  at: number
  source: string
  current: boolean
}

export interface FeishuGroupDetail {
  chatId: string
  chatType?: 'group' | 'p2p'
  chatName?: string
  botMember: boolean
  bots?: FeishuChatBot[]
  sessions: FeishuSessionBinding[]
}

export interface FeishuStatus {
  ready?: boolean
  consumer?: boolean
  bindings: FeishuBinding[]
  bots?: Array<{ id: string; name: string; ready?: boolean; consumer?: boolean }>
  bot?: { name?: string; openId?: string }
}

export type ConnectionState = 'ready' | 'connecting' | 'offline'

/** Call the Host API and unwrap `{ ok, value }`. */
export async function fetchFeishuApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  let payload: ApiEnvelope<T>
  try {
    payload = await response.json() as ApiEnvelope<T>
  } catch {
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.ok || payload.ok !== true) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`)
  }
  return payload.value as T
}

export interface FeishuStatusState {
  data?: FeishuStatus
  loading: boolean
  error: string
  reload: () => void
}

/**
 * One status fetch/reload state machine for both Sidebar pages.
 * `pollMs` keeps a connection view live; session-info uses `refresh=1` on open.
 */
export function useFeishuStatus(
  React: typeof ReactNS,
  options: { refresh?: boolean; pollMs?: number } = {},
): FeishuStatusState {
  const refresh = options.refresh === true
  const pollMs = options.pollMs
  const [data, setData] = React.useState<FeishuStatus | undefined>(undefined)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState('')
  const [nonce, setNonce] = React.useState(0)
  React.useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    const load = async (): Promise<void> => {
      try {
        const value = await fetchFeishuApi<FeishuStatus>(`${FEISHU_API}?action=status${refresh ? '&refresh=1' : ''}`)
        if (!alive) return
        setData({ ...value, bindings: Array.isArray(value.bindings) ? value.bindings : [] })
        setError('')
      } catch (reason) {
        if (!alive) return
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    if (pollMs !== undefined && pollMs > 0) timer = setInterval(() => { void load() }, pollMs)
    return () => {
      alive = false
      if (timer !== undefined) clearInterval(timer)
    }
  }, [React, refresh, pollMs, nonce])
  return { data, loading, error, reload: () => setNonce(value => value + 1) }
}

/** Poll status for the task page's connection light and current binding set. */
export function useFeishuConnection(React: typeof ReactNS): {
  connection: ConnectionState
  boundSessions?: Set<string>
} {
  const { data } = useFeishuStatus(React, { pollMs: 3000 })
  const connection: ConnectionState = data === undefined
    ? 'connecting'
    : data.ready === true && data.consumer === true
      ? 'ready'
      : data.consumer === true ? 'connecting' : 'offline'
  return {
    connection,
    ...(data === undefined ? {} : { boundSessions: new Set(data.bindings.map(binding => binding.sessionId)) }),
  }
}

export interface SessionTitleRow {
  title?: unknown
  displayTitle?: unknown
}

/** One title fallback for both Sidebar pages. */
export function sessionDisplayTitle(row: SessionTitleRow | undefined, sessionId: string): string {
  const title = typeof row?.title === 'string' && row.title !== ''
    ? row.title
    : typeof row?.displayTitle === 'string' && row.displayTitle !== ''
      ? row.displayTitle
      : ''
  return title !== '' ? title : sessionId.slice(-8)
}

/** Prefer the resolved Feishu group name, then the raw chat id. */
export function groupDisplayName(name: string | undefined, chatId: string): string {
  return name !== undefined && name !== '' ? name : chatId
}
