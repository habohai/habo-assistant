/**
 * Markdown table extraction for Feishu cards.
 *
 * Feishu has no table block in `post` messages and the CLI's markdown converter
 * drops the body rows, but interactive cards do carry a real `table` element.
 * Replies that contain a table are therefore sent as a card: prose as markdown
 * elements, each table as a table element.
 */

/** One parsed table, already stripped of Markdown decoration. */
export interface TableSpec {
  headers: string[]
  rows: string[][]
}

/** A reply split into prose and tables, in source order. */
export type ReplySegment =
  | { kind: 'text'; text: string }
  | { kind: 'table'; table: TableSpec }

/** Inline Markdown is noise inside a table cell; cells take plain text. */
function plainCell(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

const TABLE_ROW = /^\s*\|.*\|\s*$/
const DIVIDER = /^\s*\|[\s:|-]+\|\s*$/

function cellsIn(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => plainCell(cell))
}

/**
 * Split one reply into prose and tables.
 *
 * A contiguous pipe block is a table only when it has a divider row and at least
 * one body row; anything else stays in the prose so nothing is lost.
 */
export function splitTables(markdown: string): ReplySegment[] {
  const lines = markdown.split('\n')
  const segments: ReplySegment[] = []
  let prose: string[] = []
  let index = 0

  const flushProse = (): void => {
    const text = prose.join('\n').trim()
    if (text !== '') segments.push({ kind: 'text', text })
    prose = []
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!TABLE_ROW.test(line)) {
      prose.push(line)
      index += 1
      continue
    }
    const block: string[] = []
    while (index < lines.length && TABLE_ROW.test(lines[index] ?? '')) {
      block.push(lines[index] ?? '')
      index += 1
    }
    const dividerAt = block.findIndex(row => DIVIDER.test(row))
    const body = block.filter((row, position) => position !== dividerAt)
    if (dividerAt <= 0 || body.length <= 1) {
      prose.push(...block)
      continue
    }
    const headers = cellsIn(block[0] ?? '')
    const rows = body.slice(1).map(cellsIn).filter(row => row.some(cell => cell !== ''))
    if (headers.length === 0 || rows.length === 0) {
      prose.push(...block)
      continue
    }
    // Normalise ragged rows so every column has a cell.
    const width = Math.max(headers.length, ...rows.map(row => row.length))
    flushProse()
    segments.push({
      kind: 'table',
      table: {
        headers: Array.from({ length: width }, (_, column) => headers[column] ?? ''),
        rows: rows.map(row => Array.from({ length: width }, (_, column) => row[column] ?? '')),
      },
    })
  }
  flushProse()
  return segments
}

/** Whether a reply is worth sending as a card. */
export function hasTable(reply: string): boolean {
  return splitTables(reply).some(segment => segment.kind === 'table')
}
