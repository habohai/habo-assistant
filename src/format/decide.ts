/**
 * Reply-format routing for Feishu messages.
 *
 * Feishu renders Markdown only in `post` (rich text) messages, tables only in
 * documents, and plain text not at all. This module is a pure decision over one
 * reply's text, so the rules stay unit-testable and the transport (lark-cli)
 * stays dumb.
 */

/** Transport chosen for one reply. */
export type ReplyKind = 'text' | 'post'

/** Why a reply was routed the way it was. */
export type ReplyReason = 'empty' | 'plain' | 'markdown' | 'table'

export interface ReplyPlan {
  kind: ReplyKind
  reason: ReplyReason
  /** Rendered Markdown, or the original text when the plan is `text`. */
  content: string
  /** Markdown markers found in the source, for logs and tests. */
  markers: string[]
  /** Whether the source contains a Markdown table. */
  table: boolean
}

/**
 * Replies never create documents.
 *
 * A document is a deliberate deliverable with an owner, a location and an access
 * decision; formatting must not produce one as a side effect. Everything stays
 * in the chat until a document flow is designed.
 */

const MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'bold', pattern: /\*\*[^*\n]+\*\*/ },
  { name: 'italic', pattern: /(?:^|[^*\w])\*[^*\n]+\*(?!\*)/ },
  { name: 'strike', pattern: /~~[^~\n]+~~/ },
  { name: 'inline-code', pattern: /`[^`\n]+`/ },
  { name: 'code-block', pattern: /```/ },
  { name: 'heading', pattern: /^#{1,6}\s+\S/m },
  { name: 'list', pattern: /^\s*(?:[-*+]|\d+\.)\s+\S/m },
  { name: 'quote', pattern: /^\s*>\s+\S/m },
  { name: 'link', pattern: /\[[^\]\n]+\]\([^)\n]+\)/ },
]

/** Markdown markers present in one text, in a stable order. */
export function markdownMarkers(text: string): string[] {
  if (typeof text !== 'string' || text === '') return []
  return MARKERS.filter(marker => marker.pattern.test(text)).map(marker => marker.name)
}

/**
 * Whether the text contains a Markdown table.
 *
 * Requires a header row and the delimiter row directly below it, so a log line
 * that merely contains `|` never matches.
 */
export function hasMarkdownTable(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false
  const lines = text.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    const header = lines[index - 1] ?? ''
    const delimiter = lines[index] ?? ''
    if ((header.match(/\|/g) ?? []).length < 2) continue
    if (!/^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/.test(delimiter)) continue
    if (!/[-]{2,}/.test(delimiter)) continue
    return true
  }
  return false
}

/**
 * Decide how one reply should be sent.
 *
 * Order: an empty reply stays `text`; a table or an over-long reply becomes a
 * document when documents are enabled; any other supported Markdown becomes
 * `post`; everything else stays plain `text`, Feishu's cheapest transport.
 */
export function decideReply(text: string): ReplyPlan {
  const content = typeof text === 'string' ? text : ''
  if (content.trim() === '') return { kind: 'text', reason: 'empty', content, markers: [], table: false }
  const markers = markdownMarkers(content)
  const table = hasMarkdownTable(content)
  // A table has no post rendering either, but plain text collapses its columns;
  // rich text at least keeps the rows apart.
  if (markers.length === 0 && !table) return { kind: 'text', reason: 'plain', content, markers, table }
  return { kind: 'post', reason: table && markers.length === 0 ? 'table' : 'markdown', content, markers, table }
}


/** Which transport one outbound message may use. */
export type OutboundTransport = 'edit' | 'reply'

/**
 * Decide whether an answer may reuse the placeholder message.
 *
 * `+messages-edit` re-encodes Markdown and loses table structure (it drops the
 * divider row and the leading pipes), so an answer containing a table must be a
 * fresh reply even when a placeholder exists. Keeping this decision in one pure
 * function stops the three send paths from drifting apart.
 */
export function chooseTransport(input: { hasTable: boolean; hasPlaceholder: boolean }): OutboundTransport {
  if (!input.hasPlaceholder) return 'reply'
  return input.hasTable ? 'reply' : 'edit'
}
