import type { FeishuEvent } from './event.js'

/**
 * Reply shaping: chunking for Feishu's per-message length limit, and the
 * session title shown in the DSH session list.
 */

const STOP_WORDS = /^(停|停下|停下吧|停一下|停止|停止吧|终止|终止吧|取消|取消吧|别做了|stop|stop it|cancel|\/stop)$/i

/** A short, explicit request to stop the current work — never a substring match. */
export function isStopCommand(text: string): boolean {
  return STOP_WORDS.test(text.trim().replace(/[!！。.？?]+$/, ''))
}

/** Session title: the first question when known, otherwise the chat suffix. */
export function sessionTitle(event: Pick<FeishuEvent, 'chatId'>, text = '', groupName = ''): string {
  const name = groupName.trim()
  if (name !== '') return `飞书·${name}`
  const snippet = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 18) : ''
  if (snippet !== '') return `飞书·${snippet}`
  const suffix = event.chatId.length > 8 ? event.chatId.slice(-8) : event.chatId
  return `飞书·${suffix}`
}

/** Title for a direct chat: peer + bot identity. */
export function privateSessionTitle(peerName: string, botName: string): string {
  const peer = peerName.trim()
  const bot = botName.trim()
  if (peer === '') return bot === '' ? '私聊' : `私聊 · ${bot}`
  return bot === '' ? `与 ${peer} 的私聊` : `与 ${peer} 的私聊 · ${bot}`
}

/**
 * Split a long reply on line boundaries without exceeding `limit` characters.
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function splitReply(text: string, limit: number): string[] {
  const normalized = typeof text === 'string' ? text.trim() : ''
  if (normalized === '') return []
  if (normalized.length <= limit) return [normalized]
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current !== '') {
      chunks.push(current)
      current = ''
    }
  }
  for (const line of normalized.split('\n')) {
    if (line.length > limit) {
      flush()
      let rest = line
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit))
        rest = rest.slice(limit)
      }
      current = rest
      continue
    }
    if (current === '') {
      current = line
      continue
    }
    if (current.length + 1 + line.length <= limit) {
      current += `\n${line}`
      continue
    }
    flush()
    current = line
  }
  flush()
  return chunks
}
