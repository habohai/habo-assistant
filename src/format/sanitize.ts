/**
 * Outbound text clean-up for Feishu messages.
 *
 * Two things break posts in practice: an `<at>` tag inside a rich-text payload
 * (that syntax belongs to plain text messages, and the converter rejects it) and
 * "smart quotes" that a model emits around the `user_id`, which Feishu then fails
 * to parse as a mention.
 */

const AT_TAG = /<at\s+user_id=(["'“”‘’])([^"'“”‘’]+)\1\s*>(.*?)<\/at>/g

/**
 * Rewrite `<at>` tags so Feishu parses them.
 *
 * @param text - message text as produced by the agent.
 * @param kind - transport the text will use: `text` keeps mentions, `post`
 *   cannot carry them, so they become plain `@name`.
 * @returns text safe for that transport.
 */
export function normalizeMentions(text: string, kind: 'text' | 'post'): string {
  if (typeof text !== 'string' || text === '') return text
  let out = text.replace(AT_TAG, (_match, _quote: string, id: string, label: string) => {
    const name = label.trim()
    // An empty label is intentional: Feishu renders the mentioned user's name,
    // and filling the id in would print a raw open_id in the message.
    if (kind === 'post') return `@${name === '' ? id : name}`
    return `<at user_id="${id}">${name}</at>`
  })
  // A bare tag without a closing partner still needs straight quotes, or the
  // whole mention renders literally.
  out = out.replace(/<at\s+user_id=[“”‘’]([^“”‘’]+)[“”‘’]/g, '<at user_id="$1"')
  return out
}

/** Remove characters that make the post converter produce invalid JSON. */
export function sanitizeForPost(text: string): string {
  if (typeof text !== 'string') return ''
  // Control characters other than newline and tab are never valid in the payload.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}