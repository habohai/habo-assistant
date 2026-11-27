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
/**
 * Rewrite Markdown tables into readable lines.
 *
 * Feishu's rich text has no table block: a pipe table arrives as a half-rendered
 * header followed by literal rows, which is worse than no table at all. Each row
 * becomes one bullet with its column names, so the meaning survives.
 */
export function flattenTables(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      out.push(line)
      index += 1
      continue
    }
    // Collect the whole contiguous table block.
    const block: string[] = []
    while (index < lines.length) {
      const current = lines[index]
      if (current === undefined || !/^\s*\|.*\|\s*$/.test(current)) break
      block.push(current)
      index += 1
    }
    const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    const isDivider = (row: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(row)
    const header = cells(block[0] ?? '')
    const body = block.filter(row => !isDivider(row) && row !== block[0])
    if (body.length === 0) {
      out.push(block.join('\n'))
      continue
    }
    for (const row of body) {
      const values = cells(row)
      const parts = values
        .map((value, column) => {
          const name = header[column] ?? ''
          return name === '' ? value : `${name}：${value}`
        })
        .filter(part => part !== '' && !/：\s*$/.test(part))
      out.push(`- ${parts.join(' · ')}`)
    }
  }
  return out.join('\n')
}
