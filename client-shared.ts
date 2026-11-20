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

export interface FeishuBinding {
  chatId: string
  sessionId: string
  chatName?: string
  botMember?: boolean
  source?: string
  boundAt?: number
}

export interface FeishuChat {
  chatId: string
  name: string
  botMember?: boolean
  allowed: boolean
  bound: boolean
}

export interface FeishuSessionBinding {
  sessionId: string
  at: number
  source: string
  current: boolean
}

export interface FeishuGroupDetail {
  chatId: string
  chatName?: string
  botMember: boolean
  sessions: FeishuSessionBinding[]
}

export interface FeishuStatus {
  ready?: boolean
  consumer?: boolean
  bindings: FeishuBinding[]
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

/** Poll the bot health endpoint for the task page's connection light. */
export function useFeishuConnection(React: typeof ReactNS): ConnectionState {
  const [connection, setConnection] = React.useState<ConnectionState>('connecting')
  React.useEffect(() => {
    let disposed = false
    const poll = async (): Promise<void> => {
      try {
        const value = await fetchFeishuApi<{ ready?: boolean; consumer?: boolean }>(`${FEISHU_API}?action=status`)
        if (disposed) return
        if (value.ready === true && value.consumer === true) setConnection('ready')
        else if (value.consumer === true) setConnection('connecting')
        else setConnection('offline')
      } catch {
        if (!disposed) setConnection('offline')
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 3000)
    return () => { disposed = true; clearInterval(timer) }
  }, [React])
  return connection
}
