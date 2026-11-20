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
  const value = raw as Record<string, unknown>
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
 * @param {'chat' | 'thread'} routing
 */
export function acceptEvent(
  event: FeishuEvent | undefined,
  config: { allowChats: string[]; botOpenId?: string },
  routing: 'chat' | 'thread',
): boolean {
  if (event === undefined) return false
  if (event.chatType !== 'group') return false
  if (event.senderType === 'app' || event.senderType === 'bot') return false
  if (event.messageType !== 'text' && event.messageType !== 'post') return false
  if (!config.allowChats.includes('*') && !config.allowChats.includes(event.chatId)) return false
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
 * @param {'chat' | 'thread'} routing
 */
export function bindingKey(chatId: string, threadKey: string, routing: 'chat' | 'thread'): string {
  return routing === 'thread' && threadKey !== '' ? `${chatId}::${threadKey}` : chatId
}
