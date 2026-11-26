import type * as ReactNS from 'react'
import { createSessionInfoPlugin } from './client-session.js'
import { FEISHU_API, sessionDisplayTitle, useFeishuConnection } from './client-shared.js'

declare global {
  namespace JSX {
    interface Element extends ReactNS.ReactElement {}
    interface ElementChildrenAttribute { children: unknown }
    interface IntrinsicElements { [name: string]: any }
  }
}

type TaskStatus = 'idle' | 'running' | 'approval'

interface TaskView {
  bot: boolean
  status: TaskStatus
  chatId: string
  chatName: string
  question: string
  startedAt: number
  updatedAt: number
  approval: string
}

interface SessionRow {
  displayTitle?: string
  title?: string
  running?: boolean
  updatedAt?: number
  projectionValues?: Record<string, unknown>
}

interface SessionsState {
  ids: string[]
  byId: Record<string, SessionRow | undefined>
  projectionsBySession?: Record<string, { values?: Record<string, unknown> } | undefined>
}

interface TabInfoValue {
  tab: { title: string }
}

type TFunction = (key: string, params?: Record<string, string | number>) => string

/** Assigned by the module factory before any component renders. */
let React!: typeof ReactNS
let h!: (...args: any[]) => ReactNS.ReactElement

interface ClientContext {
  locale: {
    bind(namespace: string): TFunction
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
  }
  effect(callback: () => () => void, label: string): void
  get(name: string): unknown
  sidebarRightTabs: { register(definition: Record<string, unknown>): () => void }
  sidebarRight: { openTab(kind: string, options?: Record<string, unknown>): void }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(definition: Record<string, unknown>, component: unknown): () => void
  }
}

const NS = 'feishuBot'
const TAB_ID = 'feishu-tasks'
const TAB_KIND = 'feishu-tasks'

const zh: Record<string, string> = {
  // One name for the tab strip, the pane title and the start-page guide.
  tab: '飞书任务',
  guideDescription: '查看飞书群机器人当前处理中、待审批和最近完成的会话，点击直达会话。',
  emptyTitle: '暂无飞书任务',
  emptyHint: '群里 @ 机器人后，这里会出现它的会话。',
  summaryActive: '思考中 {running}，待审批 {approval}',
  summaryIdle: '当前没有运行中的任务',
  statusRunning: '思考中',
  statusApproval: '待审批',
  statusIdle: '已完成',
  connReady: '已连接',
  statusUpdated: '状态更新于 {time}',
  connConnecting: '连接中',
  connOffline: '未连接',
  chat: '群 {id}',
  group: '飞书群',
  elapsed: '{time}',
  open: '打开会话',
  questionFallback: '（无问题文本）',
  sendToGroup: '飞书',
  sendToGroupHint: '把最近一条回答发到本会话绑定的群',
  sendToGroupEmpty: '先把要发的话写进输入框',
  sendToGroupAttachments: '暂只支持文本，请先移除附件',
  sendToGroupPick: '飞书群 · 点击群名发送上一条回答',
  sendToGroupNone: '本会话还没有绑定群',
  sendToGroupSending: '发送中…',
  sendToGroupDone: '已发送到 {name}',
  sendToGroupUndo: '撤销',
  sendToGroupFailed: '发送失败：{error}',
  sendToGroupTopic: '{name} · 话题',
  sendToGroupRead: '读',
  sendToGroupSend: '发',
  sendToGroupSendLast: '发回答',
  sendToGroupSendDraft: '发草稿',
  sendToGroupRowSend: '把上一条回答整理后发到这个群',
  sendToGroupRowRead: '读这个群最近的消息',
  sendToGroupRowSendDraft: '把输入框里的话校对后发到这个群',
  sendToGroupReadDone: '已开始读 {name}',
  sendToGroupReadManual: '当前输入框不支持提交，请直接说「读一下 XX 群」',
}

const en: Record<string, string> = {
  tab: 'Feishu tasks',
  guideDescription: 'Running, approval-blocked, and recently finished Feishu group sessions; click one to open it.',
  emptyTitle: 'No Feishu tasks',
  emptyHint: 'Mention the bot in a group and its session shows up here.',
  summaryActive: '{running} thinking, {approval} awaiting approval',
  summaryIdle: 'No task is running',
  statusRunning: 'Thinking',
  statusApproval: 'Approval',
  statusIdle: 'Done',
  connReady: 'Connected',
  statusUpdated: 'Updated at {time}',
  connConnecting: 'Connecting',
  connOffline: 'Offline',
  chat: 'Chat {id}',
  group: 'Feishu group',
  elapsed: '{time}',
  open: 'Open session',
  questionFallback: '(no question text)',
}

/**
 * Feishu/Lark brand mark, paths from Semi Design's `feishu_logo.svg` (MIT).
 * Muted blue keeps it in the same visual weight as the host's colored glyphs.
 */
function TasksMark({ size = 16 }: { size?: number }): ReactNS.ReactElement {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="#5F7CF0" aria-hidden="true">
    <g transform="translate(2.4 2.4) scale(.8)">
    <path d="M6.13732 3.80654C8.76716 5.98777 11.0232 8.49408 12.7428 11.4327L14.4397 9.75535C15.2458 8.96545 16.2113 8.34129 17.258 7.93496C16.7802 6.31936 16.0033 4.98005 14.9403 3.65376C14.8135 3.49449 14.6185 3.40346 14.4137 3.40346L6.28362 3.40021C6.06906 3.40021 5.9748 3.67001 6.13732 3.80654Z" />
    <path d="M20.5703 14.1922L20.58 14.1793L20.6155 14.1146C20.6026 14.1372 20.5864 14.1631 20.5703 14.1922Z" />
    <path d="M11.0361 14.5567C12.2714 15.0833 13.3766 15.5287 14.6899 15.883C17.0207 16.5136 19.2311 15.5709 20.3234 13.4872L21.6432 10.8541C21.939 10.2105 22.3128 9.6156 22.7647 9.07273C21.9715 8.78016 21.3149 8.63064 20.4534 8.63064C18.5518 8.63064 16.7606 9.36205 15.4018 10.6948L13.3831 12.6875C12.6647 13.3929 11.878 14.0203 11.0361 14.5567Z" />
    <path d="M20.7945 13.7752L20.8039 13.7566L20.8101 13.7473C20.8039 13.7535 20.8007 13.7659 20.7945 13.7752Z" />
    <path d="M1.62519 9.74885C1.47889 9.60906 1.23511 9.70983 1.23511 9.91463L1.23834 17.8724C1.23834 18.1 1.34887 18.3112 1.53416 18.4348C3.66663 19.8521 6.15343 20.5998 8.72151 20.5998C11.166 20.5998 13.5488 19.9171 15.6098 18.6266C16.3867 18.139 16.9979 17.7099 17.6512 17.0792C16.6013 17.388 15.4472 17.4075 14.2835 17.0922C9.37815 15.7594 5.20097 13.2044 1.62519 9.74885Z" />
    </g>
  </svg>
}

/** Pure status dot: color carries state; the label stays as a tooltip only. */
function StatusMark({ status, label }: { status: TaskStatus; label: string }): ReactNS.ReactElement {
  return <span className={`ft-status-dot ${status}`} role="img" aria-label={label} title={label} />
}

function taskOf(raw: unknown): TaskView | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (record.bot !== true) return undefined
  return {
    bot: true,
    status: record.status === 'running' || record.status === 'approval' ? record.status : 'idle',
    chatId: typeof record.chatId === 'string' ? record.chatId : '',
    chatName: typeof record.chatName === 'string' ? record.chatName : '',
    question: typeof record.question === 'string' ? record.question : '',
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    approval: typeof record.approval === 'string' ? record.approval : '',
  }
}

function formatDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function formatClockSeconds(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return '--:--:--'
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23' })
}

function formatClock(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return ''
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' })
}

/** Create the tab body with the host navigation and refresh hooks captured. */
function makeBody(openSession: (id: string) => void, refresh: () => Promise<void>, sidebarRight: { openTab(kind: string): void }) {
  return function TasksBody(props: {
    useSessions: unknown
    t: TFunction
  }): ReactNS.ReactElement {
    const { t } = props
    const { connection, boundSessions, updatedAt } = useFeishuConnection(React)
    const useSessions = props.useSessions as <T>(selector: (state: SessionsState) => T) => T
    const state = useSessions(snapshot => snapshot)
    React.useEffect(() => {
      // Don't refresh on mount: reopening this page after a session click used
      // to reorder the sidebar session list and flash every time. The 5s poll
      // keeps task projections fresh without an immediate remount refresh.
      const timer = setInterval(() => { void refresh().catch(() => {}) }, 5000)
      return () => clearInterval(timer)
    }, [])

    const items: Array<{ id: string; row: SessionRow; task: TaskView }> = []
    for (const id of state.ids) {
      const row = state.byId[id]
      if (row === undefined) continue
      const raw = row.projectionValues?.feishuBotTask
        ?? state.projectionsBySession?.[id]?.values?.feishuBotTask
      const task = taskOf(raw)
      if (task !== undefined) {
        items.push({ id, row, task })
        continue
      }
      // Fallback for a bot session whose projection summary has not arrived yet.
      const title = row.title || row.displayTitle || ''
      if (!title.startsWith('飞书·')) continue
      items.push({
        id,
        row,
        task: {
          bot: true,
          status: row.running === true ? 'running' : 'idle',
          chatId: '',
          chatName: '',
          question: title,
          startedAt: row.updatedAt ?? 0,
          updatedAt: row.updatedAt ?? 0,
          approval: '',
        },
      })
    }
    const rank = (task: TaskView): number => task.status === 'approval' ? 0 : task.status === 'running' ? 1 : 2
    items.sort((left, right) => rank(left.task) - rank(right.task) || right.task.updatedAt - left.task.updatedAt)
    // A task without an active binding is an orphan (e.g. an old session whose
    // p2p candidate was replaced); hide it so the task page and session-info
    // page agree.
    const visible = boundSessions === undefined ? items : items.filter(item => boundSessions.has(item.id))
    const running = visible.filter(item => item.task.status === 'running').length
    const approval = visible.filter(item => item.task.status === 'approval').length
    const now = Date.now()

    return <div className="ft-page" data-feishu-tasks="">
      <style>{`
        .ft-page { display: flex; flex-direction: column; height: 100%; min-height: 0; color: inherit; }
        .ft-statusbar { display: flex; align-items: center; gap: 6px; padding: 9px 12px 0; }
        .ft-summary { display: flex; align-items: center; justify-content: flex-start; gap: 8px; padding: 5px 12px 7px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
        .ft-summary-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ft-conn { flex: none; display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; line-height: 14px; white-space: nowrap; }
        .ft-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
        .ft-conn.ready .ft-live-dot { background: var(--dsw-alias-state-business-primary, #3370FF); animation: ft-breathe 7.2s ease-in-out infinite; }
        .ft-conn.connecting .ft-live-dot { background: var(--dsw-alias-state-warning-primary, #D97706); animation: ft-live 1.6s ease-in-out infinite; }
        .ft-conn.offline .ft-live-dot { background: var(--dsw-alias-state-error-primary, #E5484D); }
        @keyframes ft-live { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
        @keyframes ft-breathe { 0%, 100% { opacity: .78; } 50% { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .ft-conn .ft-live-dot { animation: none; } }
        .ft-list { list-style: none; margin: 0; padding: 2px 6px 14px; overflow: auto; min-height: 0; }
        .ft-row { box-sizing: border-box; display: flex; gap: 10px; width: 100%; padding: 9px 8px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
        @media (hover: hover) { .ft-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
        .ft-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
        .ft-status { flex: none; width: 14px; height: 16px; margin-top: 0; display: flex; align-items: center; justify-content: center; }
        .ft-tab-title { display: inline-flex; align-items: center; gap: 3px; min-width: 0; white-space: nowrap; }
.ft-tab-title svg { flex: none; }
.ft-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-success-primary, #16A34A); }
        .ft-status-dot.running { background: var(--dsw-alias-state-business-primary, #3370FF); animation: ft-dot-breathe 3.4s ease-in-out infinite; }
        .ft-status-dot.approval { background: var(--dsw-alias-state-warning-primary, #D97706); }
        @keyframes ft-dot-breathe { 0%, 100% { opacity: .55; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.08); } }
        @media (prefers-reduced-motion: reduce) { .ft-status-dot.running { animation: none; } }
        .ft-pulse { animation: ft-pulse 1.5s ease-in-out infinite; }
        @keyframes ft-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
        @media (prefers-reduced-motion: reduce) { .ft-pulse { animation: none; } }
        .ft-body { flex: 1; min-width: 0; }
        .ft-line { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
        .ft-title { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 500; line-height: 17px; }
        .ft-state { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; line-height: 14px; white-space: nowrap; }
        .ft-state.running { color: var(--dsw-alias-state-business-primary, #3370FF); }
        .ft-state.approval { color: var(--dsw-alias-state-warning-primary, #D97706); }
        .ft-subject { display: block; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; }
        .ft-time { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .ft-meta { display: flex; align-items: center; gap: 6px; margin-top: 1px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; line-height: 14px; }
        .ft-sep { opacity: .5; }
        .ft-approval { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 10px; }
        .ft-empty { display: flex; flex-direction: column; gap: 4px; padding: 24px 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
        .ft-empty-title { color: inherit; font-size: 13px; font-weight: 500; }
        .ft-empty-hint { font-size: 11px; opacity: .8; }
      `}</style>
      <div className="ft-statusbar">
        <span className={`ft-conn ${connection}`} role="status" title={t(connection === 'ready' ? 'connReady' : connection === 'connecting' ? 'connConnecting' : 'connOffline')}>
          <span>{connection === 'ready' ? t('statusUpdated', { time: formatClockSeconds(updatedAt ?? 0) }) : t(connection === 'connecting' ? 'connConnecting' : 'connOffline')}</span>
          <span className="ft-live-dot" aria-hidden="true" />
        </span>
      </div>
      <div className="ft-summary">
        <span className="ft-summary-text">
          {running + approval > 0
            ? t('summaryActive', { running: String(running), approval: String(approval) })
            : t('summaryIdle')}
        </span>
      </div>
      {visible.length === 0
        ? <div className="ft-empty">
          <div className="ft-empty-title">{t('emptyTitle')}</div>
          <div className="ft-empty-hint">{t('emptyHint')}</div>
        </div>
        : <ul className="ft-list">
          {visible.map(({ id, row, task }) => <li key={id}>
            <button
              type="button"
              className="ft-row"
              title={t('open')}
              aria-label={t('open')}
              onClick={() => {
                openSession(id)
                // openSession collapses the right column; reopen the task page in the
                // arriving Session so navigation matches the other Sidebar pages.
                setTimeout(() => {
                  try {
                    sidebarRight.openTab(TAB_KIND)
                  } catch {
                    // The target Session may have disappeared; navigation still stands.
                  }
                }, 0)
              }}
            >
              <span className="ft-status"><StatusMark status={task.status} label={task.status === 'approval' ? t('statusApproval') : task.status === 'running' ? t('statusRunning') : t('statusIdle')} /></span>
              <span className="ft-body">
                <span className="ft-line">
                  <span className="ft-title">{sessionDisplayTitle(row, id)}</span>
                  <span className={`ft-state ${task.status}`}>{task.status === 'approval' ? t('statusApproval') : task.status === 'running' ? t('statusRunning') : t('statusIdle')}</span>
                  <span className="ft-time">
                    {task.status === 'idle'
                      ? formatClock(task.updatedAt)
                      : formatDuration(task.startedAt, now)}
                  </span>
                </span>
                {task.question !== '' && task.question !== sessionDisplayTitle(row, id)
                  ? <span className="ft-subject">{task.question}</span>
                  : null}
                {task.chatName !== '' && !sessionDisplayTitle(row, id).includes(task.chatName)
                  ? <span className="ft-meta"><span>{task.chatName}</span></span>
                  : null}
                {task.status === 'approval' && task.approval !== ''
                  ? <span className="ft-approval">{task.approval}</span>
                  : null}
              </span>
            </button>
          </li>)}
        </ul>}
    </div>
  }
}


/** One row of the group picker: a conversation this session already owns. */
interface SendTarget {
  key: string
  chatId: string
  threadId: string
  label: string
}

interface ComposerInputState {
  draft: string
  attachmentIds?: readonly string[]
}

interface ComposerInputActions {
  setDraft(text: string): void
  /** Present on the shipped composer; used to submit the instruction for us. */
  submit?(): void
}

interface SendToGroupProps {
  useInput: (selector: (state: ComposerInputState) => unknown) => unknown
  inputActions: ComposerInputActions
  sessionId: string
  t: TFunction
}

/**
 * Composer control: post the draft into a group this Session owns.
 *
 * The draft only exists inside the composer, which is why this lives in the
 * composer slot rather than the right sidebar.
 */


/** Styles for the composer control; they must not depend on the tasks pane. */
const COMPOSER_CSS = `
.ft-composer-send { position: relative; display: inline-flex; align-items: center; }
.ft-send-button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #8A8F98); cursor: pointer; transition: background .12s ease, color .12s ease; }
.ft-send-button:hover:not(:disabled), .ft-send-button.open { background: var(--dsw-alias-bg-secondary, rgba(0,0,0,.06)); color: var(--dsw-alias-state-business-primary, #3370FF); }
.ft-send-button:disabled { opacity: .38; cursor: default; }
.ft-send-menu { position: absolute; right: 0; bottom: 34px; z-index: 40; width: 320px; max-width: min(380px, 84vw); max-height: 300px; overflow: auto; padding: 6px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.08)); background: var(--dsw-alias-bg-elevated, #fff); box-shadow: 0 12px 36px rgba(15,23,42,.16); }
.ft-send-menu-head { padding: 4px 8px 8px; }
.ft-send-menu-title { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary, #8A8F98); }
/* Row: the name owns the full width; actions float above it on hover, so a long
   group name is never squeezed by controls that are not even visible. */
.ft-send-menu-row { position: relative; display: flex; align-items: center; border-radius: 8px; }
.ft-send-menu-row:hover { background: var(--dsw-alias-bg-secondary, rgba(0,0,0,.05)); }
.ft-send-menu-row:focus-within { background: var(--dsw-alias-bg-secondary, rgba(0,0,0,.05)); }
.ft-send-menu-item { flex: 1 1 auto; width: 100%; height: 34px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; text-align: left; font-size: 13px; line-height: 34px; color: var(--dsw-alias-label-primary, #1F2329); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ft-send-menu-item:hover { background: transparent; }
.ft-send-row-actions { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center; gap: 4px; padding-left: 18px; opacity: 0; pointer-events: none; transition: opacity .12s ease; }
.ft-send-menu-row:hover .ft-send-row-actions, .ft-send-menu-row:focus-within .ft-send-row-actions { opacity: 1; pointer-events: auto; }
.ft-send-row-icon { display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0 9px; border: 0; border-radius: 6px; background: var(--dsw-alias-bg-elevated, #fff); box-shadow: 0 1px 3px rgba(15,23,42,.12); font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-secondary, #4B5563); cursor: pointer; }
.ft-send-row-icon:hover { color: var(--dsw-alias-state-business-primary, #3370FF); }
.ft-send-row-icon.read:hover { color: var(--dsw-alias-state-success-primary, #16A34A); }
.ft-send-note { position: absolute; right: 0; bottom: 34px; z-index: 40; display: inline-flex; align-items: center; gap: 8px; width: max-content; max-width: 340px; white-space: nowrap; padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-primary, #1F2329); background: var(--dsw-alias-bg-elevated, #fff); border: 1px solid var(--dsw-alias-border-secondary, rgba(0,0,0,.08)); box-shadow: 0 8px 24px rgba(15,23,42,.12); }
.ft-send-undo { border: 0; background: transparent; padding: 0; color: var(--dsw-alias-state-business-primary, #3370FF); font-size: 12px; cursor: pointer; }
.ft-send-spin { animation: ft-send-rotate .9s linear infinite; transform-origin: 50% 50%; }
@keyframes ft-send-rotate { to { transform: rotate(360deg); } }
`

/** Chat bubble: the composer row is outline glyphs, so this matches the neighbours. */
function SendPlaneIcon(): ReactNS.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 3H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2v2.4L8 11h5a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1Z" />
      <path d="M5.2 6.1h5.6" />
      <path d="M5.2 8.4h3.6" />
    </svg>
  )
}

/** Same footprint while a send is in flight. */
function SendSpinner(): ReactNS.ReactElement {
  return (
    <svg className="ft-send-spin" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2" />
    </svg>
  )
}

function SendToGroup(props: SendToGroupProps): ReactNS.ReactElement | null {
  const { useInput, inputActions, sessionId } = props
  const t: TFunction = typeof props.t === 'function' ? props.t : (key => key)
  const draft = String(useInput(state => state.draft) ?? '')
  const attachments = Number((useInput(state => (state.attachmentIds?.length ?? 0)) as number) ?? 0)
  const [targets, setTargets] = React.useState<SendTarget[] | null>(null)
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const [note, setNote] = React.useState<{ text: string; previous?: string } | null>(null)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const draftRef = React.useRef(draft)

  // A popover that survives a click elsewhere reads as a stuck panel: close it on
  // any outside pointer press, on Escape, and as soon as the user types.
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  React.useEffect(() => {
    if (open && draft !== draftRef.current) setOpen(false)
    draftRef.current = draft
  }, [draft, open])

  React.useEffect(() => {
    console.info('[feishu-bot] composer props', Object.keys(props), 'sessionId=', sessionId,
      'actions=', typeof inputActions?.setDraft, 'useInput=', typeof useInput)
  }, [])

  React.useEffect(() => {
    let alive = true
    void fetch(`${FEISHU_API}?action=bindings`)
      .then(response => response.json())
      .then((payload: { value?: { bindings?: Array<Record<string, unknown>> } }) => {
        if (!alive) return
        const rows = (payload.value?.bindings ?? [])
          .filter(row => row.sessionId === sessionId)
          .map(row => {
            const chatId = String(row.chatId ?? '')
            const threadId = String(row.threadId ?? '')
            const name = String(row.chatName ?? '') || chatId
            return {
              key: `${chatId}::${threadId}`,
              chatId,
              threadId,
              label: threadId === '' ? name : t('sendToGroupTopic', { name }),
            }
          })
        console.info('[feishu-bot] composer targets', rows.length, 'sessionId=', sessionId)
        setTargets(rows)
      })
      .catch(error => {
        console.info('[feishu-bot] composer targets failed', String(error))
        if (alive) setTargets([])
      })
    return () => { alive = false }
  }, [sessionId])

  const ready = targets !== null && targets.length > 0
  const blocked = targets === null
    ? t('sendToGroupSending')
    : targets.length === 0
      ? t('sendToGroupNone')
      : attachments > 0 ? t('sendToGroupAttachments') : ''

  React.useEffect(() => {
    if (note === null) return
    const timer = setTimeout(() => setNote(current => (current === note ? null : current)), 6000)
    return () => clearTimeout(timer)
  }, [note])

  async function read(target: SendTarget): Promise<void> {
    if (busy || targets === null) return
    setBusy(true)
    setOpen(false)
    setNote(null)
    if (typeof inputActions.submit !== 'function') {
      setBusy(false)
      setNote({ text: t('sendToGroupReadManual') })
      return
    }
    const previous = draft
    inputActions.setDraft(`用 feishu_read_chat 读一下飞书群「${target.label}」最近 10 条消息，结合当前会话的上下文分析，把要点告诉我；需要我在群里回的话再问我。`)
    window.setTimeout(() => {
      inputActions.submit?.()
      setBusy(false)
      setNote({ text: t('sendToGroupReadDone', { name: target.label }), previous })
    }, 30)
  }

  async function send(target: SendTarget, mode: 'last' | 'draft'): Promise<void> {
    if (busy || blocked !== '' || targets === null) return
    const wantsDraft = mode === 'draft'
    if (wantsDraft && draft.trim() === '') {
      setNote({ text: t('sendToGroupEmpty') })
      return
    }
    setBusy(true)
    setNote(null)
    // Both sources go through the model: it reads the material, tidies it into
    // something a group can read, then posts. A verbatim forward would be
    // something the user can do in Feishu directly.
    if (typeof inputActions.submit === 'function') {
      const previous = draft
      const instruction = wantsDraft
        ? `把下面这段内容校对、整理成一段可以直接发群里的消息，用 feishu_send_to_chat 发到飞书群「${target.label}」：\n\n${previous}`
        : `把上面那条回答整理成一段可以直接发群里的消息，用 feishu_send_to_chat 发到飞书群「${target.label}」。`
      inputActions.setDraft(instruction)
      window.setTimeout(() => {
        inputActions.submit?.()
        setBusy(false)
        setNote({ text: t('sendToGroupDone', { name: target.label }), previous })
      }, 30)
      return
    }
    // A composer without submit cannot drive the model, so post the draft as-is.
    try {
      const response = await fetch(FEISHU_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'sendToChat',
          sessionId,
          chatId: target.chatId,
          threadId: target.threadId,
          text: draft,
        }),
      })
      const payload = await response.json() as { ok?: boolean; error?: string }
      if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`)
      inputActions.setDraft('')
      setNote({ text: t('sendToGroupDone', { name: target.label }) })
    } catch (error) {
      setNote({ text: t('sendToGroupFailed', { error: String((error as Error).message ?? error) }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ft-composer-send" ref={rootRef}>
      <style>{COMPOSER_CSS}</style>
      <button
        type="button"
        className={`ft-send-button${open ? ' open' : ''}`}
        title={blocked === '' ? t('sendToGroupHint') : blocked}
        aria-label={t('sendToGroup')}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={busy || !ready}
        onMouseDown={(event: ReactNS.MouseEvent) => event.preventDefault()}
        onClick={() => {
          if (blocked !== '') { setNote({ text: blocked }); return }
          setOpen(current => !current)
        }}
      >
        {busy ? SendSpinner() : SendPlaneIcon()}
      </button>
      {open ? (
        <div className="ft-send-menu" role="menu" aria-label={t('sendToGroupPick')}>
          <div className="ft-send-menu-head">
            <span className="ft-send-menu-title">{t('sendToGroupPick')}</span>
          </div>
          {(targets ?? []).map(target => (
            <div key={target.key} className="ft-send-menu-row">
              <button
                type="button"
                role="menuitem"
                className="ft-send-menu-item"
                title={target.label}
                disabled={busy}
                onClick={() => { void send(target, 'last') }}
              >
                {target.label}
              </button>
              <span className="ft-send-row-actions">
                <button
                  type="button"
                  className="ft-send-row-icon send"
                  title={t('sendToGroupRowSend')}
                  disabled={busy}
                  onClick={() => { void send(target, 'last') }}
                >
                  {t('sendToGroupSendLast')}
                </button>
                {draft.trim() === '' ? null : (
                  <button
                    type="button"
                    className="ft-send-row-icon send"
                    title={t('sendToGroupRowSendDraft')}
                    disabled={busy}
                    onClick={() => { void send(target, 'draft') }}
                  >
                    {t('sendToGroupSendDraft')}
                  </button>
                )}
                <button
                  type="button"
                  className="ft-send-row-icon read"
                  title={t('sendToGroupRowRead')}
                  disabled={busy}
                  onClick={() => { void read(target) }}
                >
                  {t('sendToGroupRead')}
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {note === null ? null : (
        <div className="ft-send-note" role="status">
          {note.text}
          {note.previous === undefined ? null : (
            <button
              type="button"
              className="ft-send-undo"
              onClick={() => {
                inputActions.setDraft(note.previous ?? '')
                setNote(null)
              }}
            >
              {t('sendToGroupUndo')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TasksTitle({ useTabInfo }: { useTabInfo: () => TabInfoValue }): ReactNS.ReactElement {
  const { tab } = useTabInfo()
  // The icon must not shrink or push the label: the strip gives a fixed width.
  return (
    <span className="ft-tab-title">
      {TasksMark({ size: 14 })}
      {tab.title}
    </span>
  )
}

;(window as unknown as { __ModuleLoader__: { load(definition: { id: string; factory(require: (id: string) => unknown): unknown }): void } }).__ModuleLoader__.load({
  id: 'habo-assistant',
  factory(require) {
    React = require('react') as typeof ReactNS
    h = React.createElement as (...args: any[]) => ReactNS.ReactElement

    function applyTasks(ctx: ClientContext): void {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'feishu-bot: dictionaries')
      const uiWorkspace = ctx.get('uiWorkspace') as { openSession(id: string): void }
      const sessions = ctx.get('sessions') as { refresh(): Promise<void> }
      const sidebarRight = ctx.get('sidebarRight') as { openTab(kind: string): void }
      const Body = makeBody(id => uiWorkspace.openSession(id), () => sessions.refresh(), sidebarRight)
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'builtin',
        // One name everywhere: the sidebar tab and the start-page guide must match.
        title: () => t('tab'),
        guide: [{
          id: 'feishu-tasks',
          order: 26,
          title: () => t('tab'),
          description: () => t('guideDescription'),
          icon: (props: { size?: number }) => TasksMark({ size: props.size ?? 18 }),
        }],
      }), 'feishu-bot: tasks tab')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, Body)), 'feishu-bot: tasks body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
      }, TasksTitle)), 'feishu-bot: tasks title')
      // The draft lives in the composer, so this control must too. The slot does
      // not provide a locale binder, so the bound `t` travels through a closure.
      const ComposerSend = (props: Omit<SendToGroupProps, 't'>): ReactNS.ReactElement | null =>
        SendToGroup({ ...props, t })
      ctx.effect(() => {
        console.info('[feishu-bot] composer slot: injecting')
        return ctx.slots.inject('conversation.input.right', () => {
          console.info('[feishu-bot] composer slot: registering')
          return ctx.slots.register({
            name: 'conversation.input.right',
            id: 'feishu-send',
            order: 120,
            label: '发到飞书群',
          }, ComposerSend)
        })
      }, 'feishu-bot: composer send')
    }

    const sessionInfo = createSessionInfoPlugin(React, h)
    return {
      inject: [...new Set(['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'uiWorkspace', 'sessions', ...sessionInfo.inject])],
      apply(ctx: ClientContext) {
        applyTasks(ctx)
        sessionInfo.apply(ctx)
      },
    }
  },
})
