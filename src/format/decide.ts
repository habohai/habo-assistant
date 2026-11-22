/**
 * Reply-format routing for Feishu messages.
 *
 * Feishu renders Markdown only in `post` (rich text) messages, tables only in
 * documents, and plain text not at all. This module is a pure decision over one
 * reply's text, so the rules stay unit-testable and the transport (lark-cli)
 * stays dumb.
 */

/** Transport chosen for one reply. */
export type ReplyKind = 'text' | 'post' | 'doc'

/** Why a reply was routed the way it was. */
export type ReplyReason = 'empty' | 'plain' | 'markdown' | 'table' | 'long'

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

/** Thresholds and switches for document routing. */
export interface ReplyPolicy {
  /** Character count above which a reply becomes a document; 0 disables. */
  docThresholdChars: number
  /** Line count above which a reply becomes a document; 0 disables. */
  docThresholdLines: number
  /**
   * Whether long/table content may become a document on its own.
   *
   * Off by default: a document is a deliberate deliverable, not a side effect of
   * formatting. Replies stay in the chat unless someone asks for a document.
   */
  docsEnabled: boolean
  /** Explicit request for a document, regardless of length or tables. */
  forceDoc?: boolean
}

export const DEFAULT_REPLY_POLICY: ReplyPolicy = {
  docThresholdChars: 4000,
  docThresholdLines: 60,
  docsEnabled: false,
}

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
export function decideReply(text: string, policy: ReplyPolicy = DEFAULT_REPLY_POLICY): ReplyPlan {
  const content = typeof text === 'string' ? text : ''
  if (content.trim() === '') return { kind: 'text', reason: 'empty', content, markers: [], table: false }
  const markers = markdownMarkers(content)
  const table = hasMarkdownTable(content)
  if (policy.forceDoc === true) return { kind: 'doc', reason: 'long', content, markers, table }
  if (policy.docsEnabled) {
    if (table) return { kind: 'doc', reason: 'table', content, markers, table }
    const chars = content.length
    const lines = content.split('\n').length
    const tooLong = (policy.docThresholdChars > 0 && chars > policy.docThresholdChars)
      || (policy.docThresholdLines > 0 && lines > policy.docThresholdLines)
    if (tooLong) return { kind: 'doc', reason: 'long', content, markers, table }
  }
  // A table has no post rendering either, but plain text collapses its columns;
  // rich text at least keeps the rows apart.
  if (markers.length === 0 && !table) return { kind: 'text', reason: 'plain', content, markers, table }
  return { kind: 'post', reason: 'markdown', content, markers, table }
}

/** One-line summary used in the chat message that links to a document. */
export function docSummary(markdown: string, limit = 120): string {
  const text = typeof markdown === 'string' ? markdown : ''
  const flattened = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flattened.slice(0, limit)
}