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
  decision: 'allow' | 'reject'
}

/** One action-button click, already flattened from the CLI event. */
export interface CardAction {
  chatId: string
  decision: 'allow' | 'reject'
  /** open_id of the person who clicked, when the event provides it. */
  operatorId: string
}

/** Build the approval card for one command. */
export function approvalCard(reason: string, chatId: string, seconds: number): unknown {
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
            value: { kind: 'feishu-approval', chatId, decision: 'allow' } satisfies ApprovalCardValue,
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { kind: 'feishu-approval', chatId, decision: 'reject' } satisfies ApprovalCardValue,
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
  const chatId = typeof payload.chatId === 'string' && payload.chatId !== ''
    ? payload.chatId
    : typeof event.chat_id === 'string' ? event.chat_id : ''
  if (chatId === '') return undefined
  const operator = event.operator as { open_id?: unknown } | undefined
  const operatorId = typeof operator?.open_id === 'string' ? operator.open_id : ''
  return { chatId, decision, operatorId }
}