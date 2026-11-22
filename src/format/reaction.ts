/**
 * Acknowledgement reaction choice.
 *
 * The reaction only means "received, working on it" — never success or failure.
 * A single fixed emoji reads as mechanical, so `auto` picks one of a small set of
 * equally valid acknowledgements. The choice is derived from the triggering
 * message id, which keeps it stable per message (a redelivered event cannot flip
 * the emoji) while varying across messages.
 */

/** Emojis that all read as "received / in progress". */
export const ACK_POOL = ['OnIt', 'Eyes', 'Typing'] as const

/** Explicit modes that bypass the pool. */
const DISABLED = ''
const AUTO = 'auto'

/**
 * Pick the reaction for one message.
 *
 * @param configured - `ackReaction` from config: `none`/empty disables, `auto`
 *   rotates the pool, anything else is used verbatim.
 * @param messageId - triggering message id; seeds the stable rotation.
 */
export function pickAckReaction(configured: string, messageId: string): string {
  const value = typeof configured === 'string' ? configured.trim() : ''
  if (value === DISABLED) return ''
  if (/^(none|off)$/i.test(value)) return ''
  if (value.toLowerCase() === 'off') return ''
  if (value.toLowerCase() !== AUTO) return value
  if (typeof messageId !== 'string' || messageId === '') return ACK_POOL[0]
  let hash = 0
  for (let index = 0; index < messageId.length; index += 1) {
    hash = (hash * 31 + messageId.charCodeAt(index)) % 100_000
  }
  return ACK_POOL[hash % ACK_POOL.length] as string
}