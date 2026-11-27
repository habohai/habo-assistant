/**
 * Detection of Markdown tables in a reply.
 *
 * Feishu's post renderer draws a Markdown table correctly, but `+messages-edit`
 * converts it badly (it drops the divider row and the leading pipes). The only
 * rule this module has to carry is therefore "does this reply contain a table",
 * so delivery can avoid the edit path.
 */

const DIVIDER = /^\s*\|[\s:|-]+\|\s*$/

/** Whether a reply contains a well-formed Markdown table. */
export function hasTable(markdown: string): boolean {
  if (typeof markdown !== 'string') return false
  const lines = markdown.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1] ?? ''
    const current = lines[index] ?? ''
    if (!/^\s*\|.*\|\s*$/.test(previous)) continue
    if (!DIVIDER.test(current)) continue
    // A table needs at least one body row, or the "table" is just decoration.
    const body = lines[index + 1] ?? ''
    if (/^\s*\|.*\|\s*$/.test(body)) return true
  }
  return false
}
