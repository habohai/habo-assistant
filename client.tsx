import type * as ReactNS from 'react'
import { createSessionInfoPlugin } from './client-session.js'
import { sessionDisplayTitle, useFeishuConnection } from './client-shared.js'

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
    register(definition: { name: string; key: string; locale?: string }, component: unknown): () => void
  }
}

const NS = 'feishuBot'
const TAB_ID = 'feishu-tasks'
const TAB_KIND = 'feishu-tasks'

const zh: Record<string, string> = {
  tab: '飞书任务',
  tabShort: '任务',
  guideTitle: '飞书任务',
  guideDescription: '查看飞书群机器人当前处理中、待审批和最近完成的会话，点击直达会话。',
  emptyTitle: '暂无飞书任务',
  emptyHint: '群里 @ 机器人后，这里会出现它的会话。',
  summaryActive: '思考中 {running}，待审批 {approval}',
  summaryIdle: '当前没有运行中的任务',
  statusRunning: '思考中',
  statusApproval: '待审批',
  statusIdle: '已完成',
  connReady: '已连接',
  connConnecting: '连接中',
  connOffline: '未连接',
  chat: '群 {id}',
  group: '飞书群',
  elapsed: '{time}',
  open: '打开会话',
  questionFallback: '（无问题文本）',
}

const en: Record<string, string> = {
  tab: 'Feishu tasks',
  tabShort: 'Tasks',
  guideTitle: 'Feishu tasks',
  guideDescription: 'Running, approval-blocked, and recently finished Feishu group sessions; click one to open it.',
  emptyTitle: 'No Feishu tasks',
  emptyHint: 'Mention the bot in a group and its session shows up here.',
  summaryActive: '{running} thinking, {approval} awaiting approval',
  summaryIdle: 'No task is running',
  statusRunning: 'Thinking',
  statusApproval: 'Approval',
  statusIdle: 'Done',
  connReady: 'Connected',
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

/** Row status marker: soft tinted circle, no heavy outline noise. */
function StatusMark({ status }: { status: TaskStatus }): ReactNS.ReactElement {
  if (status === 'approval') {
    return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="var(--dsw-alias-state-warning-primary, #D97706)" opacity=".12" />
      <path d="M8 4.7v4.2" stroke="var(--dsw-alias-state-warning-primary, #D97706)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r=".9" fill="var(--dsw-alias-state-warning-primary, #D97706)" />
    </svg>
  }
  if (status === 'running') {
    return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="var(--dsw-alias-state-business-primary, #3370FF)" opacity=".10" />
      <circle cx="8" cy="8" r="5.1" stroke="var(--dsw-alias-state-business-primary, #3370FF)" strokeWidth="1.4" opacity=".24" />
      <circle cx="8" cy="8" r="1.9" fill="var(--dsw-alias-state-business-primary, #3370FF)" className="ft-pulse" />
    </svg>
  }
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="7" fill="var(--dsw-alias-state-success-primary, #16A34A)" opacity=".10" />
    <path d="M5.1 8.1l1.9 1.9 3.9-4.1" stroke="var(--dsw-alias-state-success-primary, #16A34A)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity=".9" />
  </svg>
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

function formatClock(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return ''
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Create the tab body with the host navigation and refresh hooks captured. */
function makeBody(openSession: (id: string) => void, refresh: () => Promise<void>, sidebarRight: { openTab(kind: string): void }) {
  return function TasksBody(props: {
    useSessions: unknown
    t: TFunction
  }): ReactNS.ReactElement {
    const { t } = props
    const { connection, boundSessions } = useFeishuConnection(React)
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
        .ft-summary { display: flex; align-items: center; justify-content: flex-start; gap: 8px; padding: 10px 12px 7px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
        .ft-summary-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ft-conn { flex: none; display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px 1px 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .18)); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 14px; white-space: nowrap; }
        .ft-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
        .ft-conn.ready .ft-live-dot { background: var(--dsw-alias-state-success-primary, #16A34A); animation: ft-live-ready 2.4s ease-in-out infinite; }
        .ft-conn.connecting .ft-live-dot { background: var(--dsw-alias-state-warning-primary, #D97706); animation: ft-live 1.6s ease-in-out infinite; }
        .ft-conn.offline .ft-live-dot { background: var(--dsw-alias-state-error-primary, #E5484D); }
        @keyframes ft-live { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
        @keyframes ft-live-ready { 0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(22, 163, 74, .26); } 50% { opacity: .72; box-shadow: 0 0 0 3px rgba(22, 163, 74, 0); } }
        @media (prefers-reduced-motion: reduce) { .ft-conn .ft-live-dot { animation: none; } }
        .ft-list { list-style: none; margin: 0; padding: 2px 6px 14px; overflow: auto; min-height: 0; }
        .ft-row { box-sizing: border-box; display: flex; gap: 10px; width: 100%; padding: 9px 8px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
        @media (hover: hover) { .ft-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
        .ft-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
        .ft-status { flex: none; width: 16px; height: 16px; margin-top: 0; display: flex; align-items: center; justify-content: center; }
        .ft-pulse { animation: ft-pulse 1.5s ease-in-out infinite; }
        @keyframes ft-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
        @media (prefers-reduced-motion: reduce) { .ft-pulse { animation: none; } }
        .ft-body { flex: 1; min-width: 0; }
        .ft-line { display: flex; align-items: baseline; gap: 8px; }
        .ft-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 500; line-height: 17px; }
        .ft-subject { display: block; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; }
        .ft-time { flex: none; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; font-variant-numeric: tabular-nums; }
        .ft-meta { display: flex; align-items: center; gap: 6px; margin-top: 1px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; line-height: 14px; }
        .ft-sep { opacity: .5; }
        .ft-approval { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 10px; }
        .ft-empty { display: flex; flex-direction: column; gap: 4px; padding: 24px 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
        .ft-empty-title { color: inherit; font-size: 13px; font-weight: 500; }
        .ft-empty-hint { font-size: 11px; opacity: .8; }
      `}</style>
      <div className="ft-summary">
        <span className={`ft-conn ${connection}`} role="status" title={t(connection === 'ready' ? 'connReady' : connection === 'connecting' ? 'connConnecting' : 'connOffline')}>
          <span className="ft-live-dot" aria-hidden="true" />
          {t(connection === 'ready' ? 'connReady' : connection === 'connecting' ? 'connConnecting' : 'connOffline')}
        </span>
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
              <span className="ft-status"><StatusMark status={task.status} /></span>
              <span className="ft-body">
                <span className="ft-line">
                  <span className="ft-title">{sessionDisplayTitle(row, id)}</span>
                  <span className="ft-time">
                    {task.status === 'idle'
                      ? formatClock(task.updatedAt)
                      : formatDuration(task.startedAt, now)}
                  </span>
                </span>
                {task.question !== '' && task.question !== sessionDisplayTitle(row, id)
                  ? <span className="ft-subject">{task.question}</span>
                  : null}
                <span className="ft-meta">
                  <span className="ft-status-label">{task.status === 'approval' ? t('statusApproval') : task.status === 'running' ? t('statusRunning') : t('statusIdle')}</span>
                  {task.chatName !== '' && !sessionDisplayTitle(row, id).includes(task.chatName)
                    ? <><span className="ft-sep">·</span><span>{task.chatName}</span></>
                    : null}
                </span>
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

function TasksTitle({ useTabInfo }: { useTabInfo: () => TabInfoValue }): ReactNS.ReactElement {
  const { tab } = useTabInfo()
  return <>{TasksMark({ size: 16 })}{tab.title}</>
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
        title: () => t('tabShort'),
        guide: [{
          id: 'feishu-tasks',
          order: 26,
          title: () => t('guideTitle'),
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
