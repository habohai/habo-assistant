/**
 * Approval cards: what a button click carries, how the card is built, and how a
 * `card.action.trigger` event is read back.
 *
 * Kept pure so the button payload and the event shape stay unit-testable; the
 * bot only wires them to its approval state.
 */

/** Value carried by one approval button. */
export interface ApprovalCardValue {
  kind: 'feishu-approval'
  chatId: string
  /** Identity of the exact approval this button belongs to. */
  approvalId: string
  decision: 'allow' | 'reject'
}

/** One action-button click, already flattened from the CLI event. */
export interface CardAction {
  chatId: string
  /** Approval the clicked card was created for; absent on legacy cards. */
  approvalId?: string
  decision: 'allow' | 'reject'
  /** open_id of the person who clicked, when the event provides it. */
  operatorId: string
  /** Short-lived token that may update the clicked card in place. */
  token?: string
}

/** Build the approval card for one command. */
export function approvalCard(reason: string, chatId: string, approvalId: string, seconds: number): unknown {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: '需要审批' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: reason === '' ? '执行命令' : reason },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `仅限指定审批人，${seconds} 秒内有效；也可以直接回复「@我 同意」。` }],
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '同意' },
            type: 'primary',
            value: { kind: 'feishu-approval', chatId, approvalId, decision: 'allow' } satisfies ApprovalCardValue,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { kind: 'feishu-approval', chatId, approvalId, decision: 'reject' } satisfies ApprovalCardValue,
          },
        ],
      },
    ],
  }
}

/** The card sent after an approval settles, with its buttons removed. */
export function approvalResultCard(outcome: string, reason: string): unknown {
  const template = outcome === 'allowed-once' ? 'green' : outcome === 'rejected' ? 'red' : 'grey'
  const title = outcome === 'allowed-once' ? '已批准' : outcome === 'rejected' ? '已拒绝' : '审批已结束'
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: reason === '' ? title : reason } },
    ],
  }
}

/**
 * Read one `card.action.trigger` event.
 *
 * Accepts both the flat CLI shape and the `{header, event}` envelope. Returns
 * undefined for any other card click, so unrelated cards stay untouched.
 */
export function readCardAction(raw: unknown): CardAction | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const root = raw as Record<string, unknown>
  const event = (root.event ?? root) as Record<string, unknown>
  const action = event.action as { value?: unknown; tag?: unknown } | undefined
  const value = action?.value
  if (value === null || typeof value !== 'object') return undefined
  const payload = value as Record<string, unknown>
  if (payload.kind !== 'feishu-approval') return undefined
  const decision = payload.decision === 'allow' ? 'allow' : payload.decision === 'reject' ? 'reject' : undefined
  if (decision === undefined) return undefined
  const approvalId = typeof payload.approvalId === 'string' && payload.approvalId !== ''
    ? payload.approvalId
    : undefined
  const chatId = typeof payload.chatId === 'string' && payload.chatId !== ''
    ? payload.chatId
    : typeof event.chat_id === 'string' ? event.chat_id : ''
  if (chatId === '') return undefined
  const operator = event.operator as { open_id?: unknown } | undefined
  const operatorId = typeof operator?.open_id === 'string' ? operator.open_id : ''
  const token = typeof event.token === 'string' && event.token !== '' ? event.token : undefined
  return { chatId, decision, operatorId, ...(approvalId === undefined ? {} : { approvalId }), ...(token === undefined ? {} : { token }) }
}

/**
 * Build a card that renders a reply containing tables.
 *
 * Prose becomes markdown elements and each table becomes a real table element,
 * which is the only surface in Feishu that renders a table inside a chat.
 */
export function replyCard(segments: Array<
  | { kind: 'text'; text: string }
  | { kind: 'table'; table: { headers: string[]; rows: string[][] } }
>): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = []
  for (const segment of segments) {
    if (segment.kind === 'text') {
      elements.push({ tag: 'markdown', content: segment.text })
      continue
    }
    const table = segment.table
    elements.push({
      tag: 'table',
      page_size: Math.min(Math.max(table.rows.length, 1), 10),
      row_height: 'low',
      header_style: {
        text_align: 'left',
        text_size: 'normal',
        background_style: 'grey',
        bold: true,
        lines: 1,
      },
      columns: table.headers.map((header, column) => ({
        name: `c${column}`,
        display_name: header === '' ? `列 ${column + 1}` : header.slice(0, 40),
        data_type: 'text',
        horizontal_align: 'left',
        vertical_align: 'top',
        width: 'auto',
      })),
      rows: table.rows.map(row => Object.fromEntries(
        row.map((cell, column) => [`c${column}`, cell.slice(0, 300)]),
      )),
    })
  }
  return { schema: '2.0', body: { elements } }
}
