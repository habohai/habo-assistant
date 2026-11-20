/**
 * Feishu `im.message.receive_v1` event parsing and admission.
 *
 * Kept pure: everything here is a decision over one already-parsed event, so
 * the hot path stays allocation-light and the rules stay unit-testable.
 */

export interface Mention {
  id?: string
  name?: string
}

export interface FeishuEvent {
  chatId: string
  chatType: string
  messageId: string
  /** Actual topic thread id (omt_...); empty outside a topic. */
  threadId: string
  /** Reply-thread root message id (om_...); empty outside a reply thread. */
  rootId: string
  /** Legacy combined key (thread_id or root_id). */
  threadKey: string
  senderType: string
  senderId: string
  messageType: string
  mentions: Mention[]
  content: string
}

/** Strip the mention placeholders and surrounding whitespace from message text. */
export function cleanMessageText(content: unknown, mentions: Mention[] = [], botOpenId?: string): string {
  if (typeof content !== 'string') return ''
  let text = content
  for (const mention of mentions) {
    if (typeof mention?.name !== 'string' || mention.name === '') continue
    if (botOpenId !== undefined && mention.id !== botOpenId) continue
    text = text.split(`@${mention.name}`).join(' ')
  }
  return text
    .replace(/@_user_\d+/g, ' ')
    .replace(/@_all\b/g, ' ')
    .trim()
}

/**
 * The Feishu event the CLI emits for `im.message.receive_v1`, flattened.
 * @param {unknown} raw
 * @returns {{ chatId: string, chatType: string, messageId: string, threadKey: string, senderType: string, senderId: string, messageType: string, mentions: Array<{ id?: string, name?: string }>, content: string } | undefined}
 */
export function readFeishuEvent(raw: unknown): FeishuEvent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  let value = raw as Record<string, unknown>
  // Feishu event v2 envelope: { header, event: { sender, message } }.
  const envelope = value.event
  if (value.chat_id === undefined && envelope !== null && typeof envelope === 'object') {
    const event = envelope as Record<string, unknown>
    const message = event.message
    if (message !== null && typeof message === 'object') {
      const msg = message as Record<string, unknown>
      const sender = event.sender as { sender_id?: { open_id?: unknown }; sender_type?: unknown } | undefined
      const mentions = Array.isArray(msg.mentions) ? msg.mentions : []
      return {
        chatId: typeof msg.chat_id === 'string' ? msg.chat_id : '',
        chatType: typeof msg.chat_type === 'string' ? msg.chat_type : '',
        messageId: typeof msg.message_id === 'string' ? msg.message_id : '',
        threadId: typeof msg.thread_id === 'string' ? msg.thread_id : '',
        rootId: typeof msg.root_id === 'string' ? msg.root_id : '',
        threadKey: typeof msg.thread_id === 'string' ? msg.thread_id : typeof msg.root_id === 'string' ? msg.root_id : '',
        senderType: typeof sender?.sender_type === 'string' ? sender.sender_type : '',
        senderId: typeof sender?.sender_id?.open_id === 'string' ? sender.sender_id.open_id : '',
        messageType: typeof msg.message_type === 'string' ? msg.message_type : '',
        mentions: mentions.filter(item => item && typeof item === 'object').map(item => {
          const mention = item as Record<string, unknown>
          return {
            ...(typeof mention.id === 'string' ? { id: mention.id } : {}),
            ...(typeof mention.name === 'string' ? { name: mention.name } : {}),
          }
        }),
        content: typeof msg.content === 'string' ? msg.content : '',
      }
    }
  }
  const chatId = typeof value.chat_id === 'string' ? value.chat_id : ''
  const messageId = typeof value.message_id === 'string'
    ? value.message_id
    : typeof value.id === 'string' ? value.id : ''
  if (chatId === '' || messageId === '') return undefined
  const threadId = typeof value.thread_id === 'string' ? value.thread_id : ''
  const rootId = typeof value.root_id === 'string' ? value.root_id : ''
  return {
    chatId,
    chatType: typeof value.chat_type === 'string' ? value.chat_type : '',
    messageId,
    threadId,
    rootId,
    threadKey: threadId || rootId,
    senderType: typeof value.sender_type === 'string' ? value.sender_type : '',
    senderId: typeof value.sender_id === 'string' ? value.sender_id : '',
    messageType: typeof value.message_type === 'string' ? value.message_type : '',
    mentions: Array.isArray(value.mentions)
      ? value.mentions.filter(item => item && typeof item === 'object').map(item => ({
        id: typeof item.id === 'string' ? item.id : undefined,
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
      }))
      : [],
    content: typeof value.content === 'string' ? value.content : '',
  }
}

/**
 * Whether an event should reach the agent.
 * @param {ReturnType<typeof readFeishuEvent>} event
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @param {'chat' | 'topic' | 'thread'} routing
 */
export function acceptEvent(
  event: FeishuEvent | undefined,
  config: { allowChats: string[]; botOpenId?: string },
  routing: 'chat' | 'topic' | 'thread',
  alreadyAllowed = false,
): boolean {
  if (event === undefined) return false
  if (event.chatType !== 'group' && event.chatType !== 'p2p') return false
  if (event.senderType === 'app' || event.senderType === 'bot') return false
  if (event.messageType !== 'text' && event.messageType !== 'post') return false
  if (!alreadyAllowed && !config.allowChats.includes('*') && !config.allowChats.includes(event.chatId)) return false
  // A direct chat has no @ mention; the chat itself is the address.
  if (event.chatType === 'p2p') return true
  if (config.botOpenId !== undefined) {
    return event.mentions.some(mention => mention.id === config.botOpenId)
  }
  // Without the bot's open_id, the group @ subscription itself is the filter.
  return event.mentions.length > 0
}

/**
 * Binding key for one chat (and thread when routing per thread).
 * @param {string} chatId
 * @param {string} threadKey
 * @param {'chat' | 'topic' | 'thread'} routing
 */
export function bindingKey(chatId: string, threadKey: string, routing: 'chat' | 'topic' | 'thread'): string {
  return routing !== 'chat' && threadKey !== '' ? `${chatId}::${threadKey}` : chatId
}

/** The thread id that should scope a binding for this routing mode. */
export function routeThreadKey(event: Pick<FeishuEvent, 'threadId' | 'threadKey'>, routing: 'chat' | 'topic' | 'thread'): string {
  return routing === 'topic' ? (event.threadId ?? '') : (event.threadKey ?? '')
}
