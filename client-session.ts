import type * as ReactNS from 'react'
import type { Artifact, ArtifactsView } from './src/artifacts-shared.js'

type SectionKey = 'lark' | 'doc' | 'sheet' | 'slide' | 'image' | 'code' | 'other'
type TFunction = (key: string, params?: Record<string, string | number>) => string
type TriggerProps = Record<string, unknown>

interface TreeFile {
  artifact: Artifact
  name: string
  flat: boolean
}

interface TreeRoot {
  name: string
  dirs: Map<string, TreeRoot>
  files: TreeFile[]
  count: number
}

interface DirItem {
  kind: 'dir'
  key: string
  name: string
  count: number
  depth: number
  closed: boolean
  dirKey: string
  dirPath: string
}

interface FileItem {
  kind: 'file'
  key: string
  artifact: Artifact
  name: string
  flat: boolean
  depth: number
}

type TreeRow = DirItem | FileItem

interface RowMenuTarget {
  kind: 'file' | 'directory'
  value: { sessionId: string; path: string }
}

interface ContextMenuApi {
  getTriggerProps(target: RowMenuTarget): TriggerProps
}

interface TabInfoValue {
  tab: { title: string; actions: { openResource(address: string, options?: { paneId: string }): void } }
  panel: { id: string; isFloating: boolean }
}

interface SessionsState {
  byId: Record<string, { cwd?: string; title?: string } | undefined>
}

interface ArtifactsBodyProps {
  sessionId: string
  useSessions: <T>(selector: (sessions: SessionsState) => T) => T
  useProjection: (key: string) => ArtifactsView | undefined
  useTabInfo: () => TabInfoValue
  useContextMenu: () => ContextMenuApi
  t: TFunction
}

interface SectionProps {
  sectionKey: SectionKey
  title: string
  artifacts: Artifact[]
  cwd: string | undefined
  sessionId: string
  getTriggerProps: ContextMenuApi['getTriggerProps']
  onOpen: (path: string) => void
  t: TFunction
  closed: boolean
  onToggleSection: () => void
  closedDirs: Record<string, boolean>
  onToggleDir: (key: string) => void
}

interface FileRowProps {
  artifact: Artifact
  name?: string
  depth?: number
  showDirectory?: boolean
  cwd: string | undefined
  sessionId: string
  getTriggerProps: ContextMenuApi['getTriggerProps']
  onOpen: (path: string) => void
  t: TFunction
}

interface DirRowProps {
  row: DirItem
  onToggle: () => void
  t: TFunction
  cwd: string | undefined
  sessionId: string
  getTriggerProps: ContextMenuApi['getTriggerProps']
}

interface ClientLocale {
  bind(namespace: string): TFunction
  register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
}

import { FEISHU_API, fetchFeishuApi, groupDisplayName, sessionDisplayTitle, useFeishuStatus, type FeishuBinding, type FeishuChat, type FeishuGroupDetail, type FeishuSessionBinding, type FeishuStatus } from './client-shared.js'

interface ClientContext {
  locale: ClientLocale
  effect(callback: () => () => void, label: string): void
  sidebarRightTabs: { register(definition: Record<string, unknown>): () => void }
  slots: {
    inject(name: string, callback: () => () => void): () => void
    register(definition: { name: string; key: string; locale?: string }, component: unknown): () => void
  }
}

/**
 * Client half of the Session artifacts bundle.
 *
 * Registers `session-artifacts` as a right-Sidebar page type and its body: the
 * artifacts of the viewed Session, grouped by kind — Feishu cloud documents
 * first, then documents, spreadsheets, presentations, images, code, and
 * everything else. Each file section renders a directory tree relative to the
 * Session workspace; every section and directory collapses. File rows open the
 * right Sidebar's preview; cloud-document rows open their link in the browser.
 * The list is read from the Host's `sessionArtifacts` session projection, so
 * this half folds no events.
 */
export function createSessionInfoPlugin(React: typeof ReactNS, h: any): { inject: string[]; apply(ctx: ClientContext): void } {
    const useState = React.useState as <T>(initial: T) => [T, (next: T | ((previous: T) => T)) => void]
    const useEffect = React.useEffect as (effect: () => void | (() => void), deps?: unknown[]) => void

    /** Locale namespace owned by this plugin. */
    const NS = 'sessionArtifacts'
    /** This implementation's identity: the tab type id and the body's seat key. */
    const TAB_ID = '@local/session-artifacts'
    /** The tab kind the registry opens by name. */
    const TAB_KIND = 'session-artifacts'

    /** Section order: cloud documents first, then local kinds by frequency. */
    const SECTIONS: SectionKey[] = ['lark', 'doc', 'sheet', 'slide', 'image', 'code', 'other']

    /** Extension → section. Anything unlisted is `other`. */
    const EXT_SECTION: Record<string, SectionKey> = {
      md: 'doc', markdown: 'doc', txt: 'doc', pdf: 'doc', doc: 'doc', docx: 'doc',
      rtf: 'doc', odt: 'doc', pages: 'doc', epub: 'doc', html: 'doc', htm: 'doc',
      csv: 'sheet', tsv: 'sheet', xlsx: 'sheet', xls: 'sheet', ods: 'sheet', numbers: 'sheet',
      pptx: 'slide', ppt: 'slide', key: 'slide', odp: 'slide',
      png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
      bmp: 'image', ico: 'image', avif: 'image', tiff: 'image', heic: 'image',
      ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', py: 'code',
      go: 'code', rs: 'code', java: 'code', kt: 'code', kts: 'code', c: 'code', h: 'code',
      cpp: 'code', hpp: 'code', cc: 'code', cs: 'code', rb: 'code', php: 'code', swift: 'code',
      m: 'code', mm: 'code', sh: 'code', bash: 'code', zsh: 'code', fish: 'code', sql: 'code',
      json: 'code', yaml: 'code', yml: 'code', toml: 'code', xml: 'code', ini: 'code',
      cfg: 'code', conf: 'code', env: 'code', css: 'code', scss: 'code', less: 'code',
      vue: 'code', svelte: 'code', lua: 'code', r: 'code', dart: 'code', scala: 'code',
      gradle: 'code', proto: 'code', dockerfile: 'code',
    }

    /** Feishu resource segment → its display-label key. */
    const LARK_LABEL: Record<string, string> = {
      docx: 'lark.docx',
      docs: 'lark.docx',
      doc: 'lark.docx',
      wiki: 'lark.wiki',
      sheets: 'lark.sheets',
      base: 'lark.base',
      slides: 'lark.slides',
      minutes: 'lark.minutes',
      mindnotes: 'lark.mindnotes',
      file: 'lark.file',
      board: 'lark.board',
    }

    /** Simplified Chinese copy (the key-set source of truth). */
    const zh = {
      typeLabel: '会话信息',
      guideTitle: '会话信息',
      guideDescription: '本会话绑定的飞书群与机器人，以及文件和飞书云文档；可在这里绑定新群',
      scopeLabel: '本会话',
      loading: '正在读取本会话产物…',
      header: '共 {count} 个产物',
      'section.lark': '飞书云文档',
      'section.doc': '文档',
      'section.sheet': '表格',
      'section.slide': '演示文稿',
      'section.image': '图片',
      'section.code': '代码与配置',
      'section.other': '其他',
      deliveredBadge: '交付',
      collapseSection: '收起 {name}',
      expandSection: '展开 {name}',
      collapseAll: '收起所有分组',
      expandAll: '展开所有分组',
      collapseDirs: '折叠所有目录',
      expandDirs: '展开所有目录',
      folderCount: '{count} 个文件',
      emptyTitle: '本会话还没有产物',
      emptyHint: 'Agent 用 present 交付文件、用文件工具写入文件，或通过 lark-cli 创建飞书文档后，会实时出现在这里。',
      openFileAria: '在右侧栏预览 {name}',
      openUrlAria: '在浏览器中打开 {name}',
      unnamed: '未命名文件',
      'lark.docx': '飞书文档',
      'lark.wiki': '飞书知识库',
      'lark.sheets': '飞书表格',
      'lark.base': '飞书多维表格',
      'lark.slides': '飞书幻灯片',
      'lark.minutes': '飞书妙记',
      'lark.mindnotes': '飞书思维笔记',
      'lark.file': '飞书文件',
      'lark.board': '飞书画板',
      'lark.other': '飞书资源',
      'feishu.title': '飞书群',
      'feishu.bot': '机器人',
      'feishu.bind': '绑定飞书群',
      'feishu.refresh': '刷新',
      'feishu.empty': '还没有绑定飞书群',
      'feishu.emptyHint': '绑定后，群里 @机器人 的消息会继续到当前会话。',
      'feishu.loading': '正在读取飞书绑定…',
      'feishu.unbind': '解绑',
      'feishu.bindTitle': '绑定飞书群',
      'feishu.bindHint': '选择一个群，未来的 @机器人 消息会进入当前会话。',
      'feishu.search': '搜索群名或 chat_id',
      'feishu.cancel': '取消',
      'feishu.none': '没有可选的群',
      'feishu.manual': '手动输入群 ID',
      'feishu.manualPlaceholder': 'oc_...',
      'feishu.bindAction': '绑定',
      'feishu.botLabel': '机器人',
      'feishu.bound': '已绑定',
      'feishu.botMissing': '机器人不在群',
      'feishu.botMissingHint': '机器人不在该群，先把机器人拉进群才能接收 @ 消息',
      'feishu.allowed': '已允许',
      'feishu.missing': '未检测到飞书机器人插件',
      'feishu.missingHint': '安装并启用 dsh-feishu-bot 后，这里会显示群绑定。',
      'feishu.failed': '操作失败：{error}',
      'feishu.artifacts': '会话产物',
      'feishu.chatCount': '{count} 个群',
      'feishu.groupHint': '查看绑定的会话',
      'feishu.groupDetail': '群绑定详情',
      'feishu.sessions': '已绑定的会话',
      'feishu.current': '当前',
      'feishu.unbindGroup': '解绑该群',
      'feishu.sessionsEmpty': '这个群还没有绑定记录',
      'feishu.close': '关闭',
      'feishu.unknownTime': '时间未知',
      'feishu.boundAt': '绑定于 {time}',
      'feishu.source.manual': '手动绑定',
      'feishu.source.external': '外部绑定',
      'feishu.source.auto': '自动绑定',
    }

    /** English copy (same key set). */
    const en = {
      typeLabel: 'Session info',
      guideTitle: 'Session info',
      guideDescription: 'Feishu groups and bot bound to this session, plus files and Feishu docs; bind a group here',
      scopeLabel: 'This session',
      loading: 'Reading this session’s artifacts…',
      header: '{count} artifacts',
      'section.lark': 'Feishu cloud docs',
      'section.doc': 'Documents',
      'section.sheet': 'Spreadsheets',
      'section.slide': 'Presentations',
      'section.image': 'Images',
      'section.code': 'Code and config',
      'section.other': 'Other',
      deliveredBadge: 'Delivered',
      collapseSection: 'Collapse {name}',
      expandSection: 'Expand {name}',
      collapseAll: 'Collapse all groups',
      expandAll: 'Expand all groups',
      collapseDirs: 'Collapse all folders',
      expandDirs: 'Expand all folders',
      folderCount: '{count} files',
      emptyTitle: 'No artifacts in this session yet',
      emptyHint: 'Files the agent delivers with present or writes with file tools, and Feishu docs it creates through lark-cli, appear here as the session runs.',
      openFileAria: 'Preview {name} in the right sidebar',
      openUrlAria: 'Open {name} in the browser',
      unnamed: 'Unnamed file',
      'lark.docx': 'Feishu doc',
      'lark.wiki': 'Feishu wiki',
      'lark.sheets': 'Feishu sheet',
      'lark.base': 'Feishu base',
      'lark.slides': 'Feishu slides',
      'lark.minutes': 'Feishu Minutes',
      'lark.mindnotes': 'Feishu mind note',
      'lark.file': 'Feishu file',
      'lark.board': 'Feishu board',
      'lark.other': 'Feishu resource',
      'feishu.title': 'Feishu groups',
      'feishu.bot': 'Bot',
      'feishu.bind': 'Bind Feishu group',
      'feishu.refresh': 'Refresh',
      'feishu.empty': 'No Feishu group bound yet',
      'feishu.emptyHint': 'After binding, @bot messages in the group continue in this session.',
      'feishu.loading': 'Reading Feishu bindings…',
      'feishu.unbind': 'Unbind',
      'feishu.bindTitle': 'Bind a Feishu group',
      'feishu.bindHint': 'Pick a group; future @bot messages will enter this session.',
      'feishu.search': 'Search name or chat_id',
      'feishu.cancel': 'Cancel',
      'feishu.none': 'No groups available',
      'feishu.manual': 'Enter a chat ID manually',
      'feishu.manualPlaceholder': 'oc_...',
      'feishu.bindAction': 'Bind',
      'feishu.botLabel': 'Bot',
      'feishu.bound': 'Bound',
      'feishu.botMissing': 'Bot not in group',
      'feishu.botMissingHint': 'The bot is not a member; add it to the group before binding',
      'feishu.allowed': 'Allowed',
      'feishu.missing': 'Feishu bot plugin not detected',
      'feishu.missingHint': 'Install and enable dsh-feishu-bot to see group bindings here.',
      'feishu.failed': 'Action failed: {error}',
      'feishu.artifacts': 'Session artifacts',
      'feishu.chatCount': '{count} groups',
      'feishu.groupHint': 'View bound sessions',
      'feishu.groupDetail': 'Group bindings',
      'feishu.sessions': 'Bound sessions',
      'feishu.current': 'Current',
      'feishu.unbindGroup': 'Unbind group',
      'feishu.sessionsEmpty': 'No sessions bound to this group yet',
      'feishu.close': 'Close',
      'feishu.unknownTime': 'Time unknown',
      'feishu.boundAt': 'Bound {time}',
      'feishu.source.manual': 'Manual',
      'feishu.source.external': 'External',
      'feishu.source.auto': 'Automatic',
    }

    const CSS = `
.sa-page { display: flex; flex: 1 1 auto; flex-direction: column; box-sizing: border-box; width: 100%; height: 100%; min-width: 0; min-height: 0; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5; }
.sa-header { box-sizing: border-box; display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 8px; height: 38px; padding: 0 8px 0 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 18px; }
.sa-title-icon { flex: none; }
.sa-path { display: flex; flex: 1 1 auto; align-items: baseline; min-width: 0; overflow: hidden; white-space: nowrap; font-size: 13px; line-height: 18px; }
.sa-path-dir { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-tertiary); }
.sa-path-name { flex: none; color: var(--dsw-alias-label-primary); }
.sa-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.sa-count { flex: none; margin-right: 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
.sa-icon { display: grid; flex: none; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
@media (hover: hover) { .sa-icon:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); } }
.sa-icon:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.sa-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px 8px 16px; scrollbar-gutter: stable; }
.sa-section + .sa-section { margin-top: 10px; }
.sa-list { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.sa-section-title, .sa-row, .sa-dir { box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; padding: 5px 8px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
.sa-section-title { color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600; line-height: 18px; }
.sa-row { text-decoration: none; }
.sa-dir { color: var(--dsw-alias-label-secondary); }
@media (hover: hover) { .sa-section-title:hover, .sa-dir:hover, .sa-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.sa-section-title:focus-visible, .sa-dir:focus-visible, .sa-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.sa-section-body { padding-top: 1px; }
.sa-section-count, .sa-dir-count { flex: none; margin-left: auto; color: var(--dsw-alias-label-quaternary); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; }
.sa-glyph { flex: none; display: grid; place-items: center; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary); }
.sa-glyph[data-link='true'] { color: var(--dsw-alias-link); }
.sa-folder { color: var(--dsw-alias-label-tertiary); }
.sa-text { display: flex; flex: 1 1 auto; flex-direction: column; gap: 1px; min-width: 0; }
.sa-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sa-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 18px; }
.sa-dir-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.sa-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.sa-badge { flex: none; padding: 0 5px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 4px; background: var(--dsw-alias-card-fill); color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 14px; }
.sa-empty { display: flex; flex: 1 1 auto; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 40px 28px; text-align: center; }
.sa-empty-glyph { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; color: var(--dsw-alias-label-tertiary); }
.sa-loading { display: flex; flex: 1 1 auto; align-items: center; justify-content: center; padding: 24px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.sa-empty-title { color: var(--dsw-alias-label-secondary); font-size: 13px; font-weight: 500; }
.sa-empty-hint { max-width: 250px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.sa-feishu { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 10px; padding: 0 0 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.sa-feishu-head { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 2px 8px 4px; }
.sa-feishu-title { flex: none; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; line-height: 18px; }
.sa-feishu-total { flex: none; color: var(--dsw-alias-label-quaternary); font-size: 11px; line-height: 16px; }
.sa-feishu-bot { padding: 0 8px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.sa-feishu-actions { display: flex; flex: none; align-items: center; gap: 2px; margin-left: auto; }
.sa-feishu-bind { display: inline-flex; align-items: center; height: 26px; padding: 0 9px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
@media (hover: hover) { .sa-feishu-bind:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.sa-feishu-bind:focus-visible, .sa-feishu-row:focus-visible, .sa-feishu-remove:focus-visible, .sa-button:focus-visible, .sa-dialog-close:focus-visible, .sa-manual-toggle:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.sa-feishu-row { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 6px 8px; border-radius: 8px; }
@media (hover: hover) { .sa-feishu-row:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.sa-feishu-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 18px; }
.sa-feishu-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-quaternary); font-size: 11px; line-height: 16px; }
.sa-feishu-remove { display: grid; flex: none; place-items: center; width: 24px; height: 24px; margin-left: auto; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font: inherit; font-size: 14px; line-height: 1; opacity: 0; }
@media (hover: hover) { .sa-feishu-row:hover .sa-feishu-remove, .sa-feishu-row:focus-within .sa-feishu-remove { opacity: 1; } .sa-feishu-remove:hover { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); } }
@media (hover: none) { .sa-feishu-remove { opacity: 1; } }
.sa-feishu-empty { padding: 2px 8px 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.sa-feishu-empty-hint { display: block; color: var(--dsw-alias-label-quaternary); font-size: 11px; line-height: 16px; }
.sa-feishu-note { padding: 2px 8px 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.sa-avatar { display: grid; flex: none; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-secondary); }
.sa-subhead { padding: 2px 8px 4px; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-weight: 600; line-height: 18px; }
.sa-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, 0.32); }
.sa-dialog { display: flex; flex-direction: column; width: min(480px, 100%); max-height: min(620px, 86vh); overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base)); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22); }
.sa-dialog-head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 20px 0; }
.sa-dialog-title { flex: 1 1 auto; color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 22px; }
.sa-dialog-close { display: grid; flex: none; place-items: center; width: 28px; height: 28px; margin: -2px -4px 0 0; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font: inherit; font-size: 16px; line-height: 1; }
@media (hover: hover) { .sa-dialog-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.sa-dialog-desc { padding: 2px 20px 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.sa-dialog-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; overflow-y: auto; padding: 14px 20px 0; }
.sa-input { box-sizing: border-box; width: 100%; height: 36px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px); outline: none; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.sa-input::placeholder { color: var(--dsw-alias-label-quaternary); }
.sa-input:focus { border-color: var(--dsw-alias-state-business-primary); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-state-business-primary); }
.sa-bot-picker { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sa-bot-picker .sa-input { flex: 1; }
.sa-chat-list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; min-height: 0; overflow: auto; margin: 0; padding: 0; list-style: none; }
.sa-chat { display: flex; align-items: center; gap: 9px; width: 100%; min-width: 0; padding: 7px 8px; border: 0.5px solid transparent; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
@media (hover: hover) { .sa-chat:hover { background: var(--dsw-alias-interactive-bg-hover); } }
.sa-chat[aria-selected='true'] { border-color: var(--dsw-alias-border-l4); background: var(--dsw-alias-bg-layer-3); }
.sa-chat:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.sa-chat-text { display: flex; flex: 1 1 auto; flex-direction: column; gap: 1px; min-width: 0; }
.sa-chat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 18px; }
.sa-chat-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-quaternary); font-size: 11px; line-height: 16px; }
.sa-chat-badge { flex: none; padding: 0 5px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 4px; color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 15px; }
.sa-chat-badge[data-warning='true'] { border-color: var(--dsw-alias-state-error-primary, #d33); color: var(--dsw-alias-state-error-primary, #d33); }
.sa-dialog-empty { padding: 8px 8px 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.sa-manual-toggle { align-self: flex-start; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 12px; line-height: 18px; }
@media (hover: hover) { .sa-manual-toggle:hover { color: var(--dsw-alias-label-primary); } }
.sa-manual { display: flex; align-items: center; gap: 8px; }
.sa-manual .sa-input { flex: 1 1 auto; min-width: 0; }
.sa-dialog-footer { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding: 12px 20px 16px; border-top: 0.5px solid var(--dsw-alias-border-l3); }
.sa-footer-spacer { flex: 1 1 auto; }
.sa-button { height: 28px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
@media (hover: hover) { .sa-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); } }
.sa-button[data-primary='true'] { border-color: transparent; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-inverse, #fff); }
.sa-button[data-primary='true']:hover:not(:disabled) { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-inverse, #fff); opacity: 0.9; }
.sa-button:disabled { opacity: 0.45; cursor: default; }
.sa-dialog-error { color: var(--dsw-alias-state-error-primary, #d33); font-size: 11px; line-height: 16px; }
.sa-feishu-row { cursor: pointer; }
.sa-feishu-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.sa-feishu-chevron { flex: none; color: var(--dsw-alias-label-quaternary); font-size: 14px; line-height: 1; }
.sa-feishu-unbind { display: inline-flex; flex: none; align-items: center; height: 22px; padding: 0 6px; border: 0.5px solid transparent; border-radius: 5px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; opacity: 0; }
@media (hover: hover) { .sa-feishu-row:hover .sa-feishu-unbind, .sa-feishu-row:focus-within .sa-feishu-unbind { opacity: 1; } .sa-feishu-unbind:hover { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); } }
@media (hover: none) { .sa-feishu-unbind { opacity: 1; } }
.sa-session-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; min-height: 0; overflow: auto; }
.sa-session-row { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 7px 8px; border-radius: 8px; }
.sa-session-row[data-current='true'] { background: var(--dsw-alias-bg-layer-3); }
.sa-session-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 18px; }
.sa-session-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-quaternary); font-size: 11px; line-height: 16px; }
.sa-session-meta { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.sa-session-current { flex: none; margin-left: auto; }
.sa-button[data-danger='true'] { border-color: var(--dsw-alias-state-error-primary, #d33); color: var(--dsw-alias-state-error-primary, #d33); }
@media (hover: hover) { .sa-button[data-danger='true']:hover:not(:disabled) { background: var(--dsw-alias-state-error-primary, #d33); color: #fff; } }
`


    /** Component-local styles: unmounting the body removes them. */
    function Styles() {
      return h('style', { 'data-session-artifacts': '' }, CSS)
    }

    /**
     * Component-encode one address segment, keeping `:` literal for drive letters.
     * @param {string} segment
     */
    function encodeSegment(segment: string): string {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    /**
     * The `dsh-resource://file/session/<id>/<path>` address of a file, made
     * workspace-relative when it sits under the viewed Session's root.
     * @param {string} sessionId
     * @param {string | undefined} cwd
     * @param {string} path
     */
    function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      let relative = normalized
      const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
      if (absolute) {
        const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
        if (root !== '' && normalized === root) relative = ''
        else if (root !== '' && normalized.startsWith(`${root}/`)) relative = normalized.slice(root.length + 1)
      }
      const encoded = relative.split('/').map(encodeSegment).join('/')
      return `dsh-resource://file/session/${encodeSegment(String(sessionId))}/${encoded}`
    }

    /**
     * Split a path into the directory part and the name shown in the row.
     * @param {string} path
     * @param {string | undefined} cwd
     */
    function displayPath(path: string, cwd: string | undefined): { directory: string; name: string } {
      const normalized = String(path).replace(/\\/g, '/')
      const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      const shown = root !== '' && normalized === root
        ? ''
        : root !== '' && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized
      const cut = shown.lastIndexOf('/')
      return {
        directory: cut > 0 ? shown.slice(0, cut) : cut === 0 ? '/' : '',
        name: cut >= 0 ? shown.slice(cut + 1) : shown,
      }
    }

    /**
     * Whether a path can join the workspace tree, and the tree-relative spelling.
     * @param {string} path
     * @param {string | undefined} cwd
     * @returns {{ relative: string, tree: boolean }}
     */
    function treePathOf(path: string, cwd: string | undefined): { relative: string; tree: boolean } {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
      if (root !== '' && normalized === root) return { relative: '', tree: false }
      if (root !== '' && normalized.startsWith(`${root}/`)) return { relative: normalized.slice(root.length + 1), tree: true }
      const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
      // A relative argument is already workspace-relative; an absolute path outside the root stays flat.
      return { relative: normalized, tree: !absolute }
    }

    /**
     * The section one artifact belongs to.
     * @param {{ path?: string, url?: string }} artifact
     * @returns {string}
     */
    function sectionOf(artifact: Artifact): SectionKey {
      if (typeof artifact.url === 'string') return 'lark'
      const base = String(artifact.path ?? '').replace(/\\/g, '/').split('/').pop() || ''
      const at = base.lastIndexOf('.')
      const extension = at > 0 ? base.slice(at + 1).toLowerCase() : ''
      return EXT_SECTION[extension] || 'other'
    }

    /** @param {string} a @param {string} b */
    function byName(a: string, b: string): number {
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
    }

    /**
     * Build one section's directory tree. Files outside the workspace root stay
     * flat at the top, because their absolute path is not part of the tree.
     * @param {Array<{ path: string }>} artifacts
     * @param {string | undefined} cwd
     */
    function buildTree(artifacts: Artifact[], cwd: string | undefined): TreeRoot {
      const root: TreeRoot = { name: '', dirs: new Map(), files: [], count: 0 }
      for (const artifact of artifacts) {
        const path = artifact.path ?? ''
        const { relative, tree } = treePathOf(path, cwd)
        const segments = tree ? relative.split('/').filter(Boolean) : []
        if (!tree || segments.length === 0) {
          root.files.push({ artifact, name: displayPath(path, cwd).name, flat: true })
          root.count += 1
          continue
        }
        let node = root
        node.count += 1
        for (let index = 0; index < segments.length - 1; index += 1) {
          const name = segments[index]
          let child = node.dirs.get(name)
          if (child === undefined) {
            child = { name, dirs: new Map(), files: [], count: 0 }
            node.dirs.set(name, child)
          }
          child.count += 1
          node = child
        }
        node.files.push({ artifact, name: segments[segments.length - 1], flat: false })
      }
      return root
    }

    /**
     * Flatten one tree into rows, skipping closed directories' descendants.
     * @param {ReturnType<typeof buildTree>} root
     * @param {string} sectionKey
     * @param {Record<string, boolean>} closedDirs
     */
    function treeRows(root: TreeRoot, sectionKey: string, closedDirs: Record<string, boolean>): TreeRow[] {
      const rows: TreeRow[] = []
      const walk = (node: TreeRoot, prefix: string, depth: number): void => {
        const dirs = [...node.dirs.values()].sort((left, right) => byName(left.name, right.name))
        for (const dir of dirs) {
          const dirPath = prefix === '' ? dir.name : `${prefix}/${dir.name}`
          const dirKey = `${sectionKey}|${dirPath}`
          const closed = closedDirs[dirKey] === true
          rows.push({ kind: 'dir', key: `d:${dirKey}`, name: dir.name, count: dir.count, depth, closed, dirKey, dirPath })
          if (!closed) walk(dir, dirPath, depth + 1)
        }
        const files = [...node.files].sort((left, right) => byName(left.name, right.name))
        for (const file of files) {
          rows.push({ kind: 'file', key: `f:${file.artifact.path}`, artifact: file.artifact, name: file.name, flat: file.flat, depth })
        }
      }
      walk(root, '', 0)
      return rows
    }

    /** Depth step for one tree level. */
    const INDENT_STEP = 14
    /** Rows start one level under their section header. */
    const INDENT_BASE = 18

    /**
     * Every directory key in one file section, whether open or closed.
     * @param {Array<{ path: string }>} artifacts
     * @param {string} section
     * @param {string | undefined} cwd
     */
    function dirKeysOf(artifacts: Artifact[], section: string, cwd: string | undefined): string[] {
      const keys: string[] = []
      const walk = (node: TreeRoot, prefix: string): void => {
        for (const dir of node.dirs.values()) {
          const path = prefix === '' ? dir.name : `${prefix}/${dir.name}`
          keys.push(`${section}|${path}`)
          walk(dir, path)
        }
      }
      walk(buildTree(artifacts, cwd), '')
      return keys
    }

    /**
     * Indentation for one tree level.
     * @param {number} depth
     */
    function indentOf(depth: number): { paddingLeft: number } {
      return { paddingLeft: 8 + INDENT_BASE + depth * INDENT_STEP }
    }

    /**
     * Absolute spelling of a workspace-relative or already absolute path.
     * @param {string | undefined} cwd
     * @param {string} path
     */
    function joinAbsolute(cwd: string | undefined, path: string): string {
      const normalized = String(path).replace(/\\/g, '/')
      if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) return normalized
      if (typeof cwd !== 'string' || cwd === '') return normalized
      const separator = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
      return `${cwd.replace(/[\\/]+$/, '')}${separator}${normalized.replace(/^[\\/]+/, '')}`
    }

    /** Outline paths of each section's mark, drawn on the same 24-unit grid. */
    const SECTION_GLYPHS = {
      // Cloud: a Feishu document lives in the cloud, not in the workspace.
      lark: ['M7 18h9.6a3.4 3.4 0 0 0 .4-6.8 5 5 0 0 0-9.6-1.3A3.6 3.6 0 0 0 7 18Z'],
      // Page with a folded corner.
      doc: ['M13.5 3.75h-6a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.75Z', 'M13.5 3.75v5h5'],
      // Two-column, two-row grid.
      sheet: ['M4.5 5.5h15v13h-15z', 'M4.5 11.5h15', 'M12 5.5v13'],
      // Screen on a stand.
      slide: ['M4.5 4.5h15v10.5h-15z', 'M12 15v3.5', 'M8.5 20h7'],
      // Frame with a landscape and a sun.
      image: ['M4.5 5.5h15v13h-15z', 'M4.5 16l4.5-4.5 3.5 3.5 3-3 4.5 4.5', 'M9.5 9.5h.01'],
      // Angle brackets.
      code: ['M9.5 8 6 12l3.5 4', 'M14.5 8 18 12l-3.5 4'],
      // Archive box.
      other: ['M4.5 7.5h15v3h-15z', 'M6.5 10.5v8h11v-8', 'M10 13.5h4'],
    }

    /** Section glyph: one shared drawing style, a different mark per kind. */
    function SectionGlyph({ section }: { section: SectionKey }) {
      const paths = SECTION_GLYPHS[section] || SECTION_GLYPHS.other
      return h('svg', {
        viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        paths.map((d, index) => h('path', { key: index, d })),
      )
    }

    /** Colored chip icon: a blue sheet over a lighter one, the plugin's own mark at tab size. */
    function ArtifactsChipIcon({ size = 16, className }: { size?: number; className?: string }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        className, 'aria-hidden': true,
      },
        h('rect', { x: 9.5, y: 3.25, width: 11, height: 14, rx: 2.2, fill: '#A9C8E4' }),
        h('path', { d: 'M6.5 5.75h5.9L17 10.25v8.5a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z', fill: '#247BBF' }),
        h('path', { d: 'M12.4 5.75v4.5H17Z', fill: '#DCEBFA' }),
        h('path', { d: 'M8 13.25h5M8 16.25h3.5', stroke: '#FFFFFF', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    /**
     * The tab chip's title: the colored mark before the type label.
     * @param {{ useTabInfo: () => { tab: { title: string } } }} props
     */
    function ArtifactsTitle({ useTabInfo }: { useTabInfo: () => { tab: { title: string } } }) {
      const { tab } = useTabInfo()
      return h(React.Fragment, null, h(ArtifactsChipIcon, { size: 16, className: 'sa-title-icon' }), tab.title)
    }

    /** File-row glyph: a small document. */
    function FileGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M13.5 3.75H7.5a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.75Z' }),
        h('path', { d: 'M13.5 3.75v5h5' }),
      )
    }

    /** Cloud-document glyph: a chain link. */
    function LinkGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M10.5 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1' }),
        h('path', { d: 'M13.5 10.5a3.5 3.5 0 0 0-5 0L6 13a3.5 3.5 0 0 0 5 5l1-1' }),
      )
    }

    /** Empty-state glyph: an empty tray. */
    function EmptyGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3.75 13.5 6 6.75a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 6.75l2.25 6.75' }),
        h('path', { d: 'M3.75 13.5h4.4l1.2 2.1h5.3l1.2-2.1h4.4v3.6a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2Z' }),
      )
    }

    /**
     * The viewed Session's workspace path, directories muted and the final
     * segment in the primary color, as the Files page header shows it.
     * @param {{ cwd: string | undefined, t: (key: string) => string }} props
     */
    function WorkspacePath({ cwd, t }: { cwd: string | undefined; t: TFunction }) {
      if (typeof cwd !== 'string' || cwd === '') return h('span', { className: 'sa-path' }, t('scopeLabel'))
      const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
      const cut = normalized.lastIndexOf('/')
      const directory = cut > 0 ? normalized.slice(0, cut + 1) : cut === 0 ? '/' : ''
      const name = cut >= 0 ? normalized.slice(cut + 1) : normalized
      return h('span', { className: 'sa-path', title: cwd },
        directory === '' ? null : h('span', { className: 'sa-path-dir' }, directory),
        h('span', { className: 'sa-path-name' }, name),
      )
    }

    /** Header glyph for the directory control: a squared folder, open when files show, closed when folded. */
    function FoldersToggleGlyph({ open, size = 18 }: { open: boolean; size?: number }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        open
          ? [
            h('path', { key: 0, d: 'M4.5 9V7a2 2 0 0 1 2-2h3.2l1.5 1.5h6.3a2 2 0 0 1 2 2V9' }),
            h('path', { key: 1, d: 'M4.5 9h15.3l-1.4 7.6a2 2 0 0 1-2 1.6H6.4a2 2 0 0 1-2-2Z' }),
          ]
          : h('path', { d: 'M4.5 8.5V7a2 2 0 0 1 2-2h3.2l1.5 1.5h6.3a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z' }),
      )
    }

    /** Header glyph for the group control: a squared panel with content when groups show, its title bar alone when folded. */
    function GroupsToggleGlyph({ open }: { open: boolean }) {
      const frame = 'M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z'
      return h('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        open
          ? [
            h('path', { key: 0, d: frame }),
            h('path', { key: 1, d: 'M4.5 10h15' }),
            h('path', { key: 2, d: 'M8 14h8' }),
          ]
          : [
            h('path', { key: 0, d: frame }),
            h('path', { key: 1, d: 'M4.5 10h15' }),
          ],
      )
    }

    /**
     * One cloud-document row: its Feishu type and the link without its scheme.
     * @param {{ artifact: { url: string, resource?: string }, t: (key: string, params?: object) => string }} props
     */
    function LinkRow({ artifact, t }: { artifact: Artifact; t: TFunction }) {
      const label = t(LARK_LABEL[artifact.resource ?? ''] || 'lark.other')
      const href = artifact.url ?? ''
      return h('li', null,
        h('a', {
          className: 'sa-row',
          style: { paddingLeft: 8 + INDENT_BASE },
          href,
          target: '_blank',
          rel: 'noreferrer noopener',
          title: href,
          'aria-label': t('openUrlAria', { name: label }),
        },
          h('span', { className: 'sa-glyph', 'data-link': 'true', 'aria-hidden': true }, h(LinkGlyph)),
          h('span', { className: 'sa-text' },
            h('span', { className: 'sa-name' }, label),
            h('span', { className: 'sa-meta' }, href.replace(/^https?:\/\//, '')),
          ),
        ),
      )
    }

    /**
     * One file row: its name, delivered marker, and either its description or
     * its directory. Tree rows omit the directory because the tree shows it.
     * @param {{ artifact: { path: string, kind: string, description?: string }, name?: string, depth?: number, showDirectory?: boolean, cwd: string | undefined, onOpen: (path: string) => void, t: (key: string, params?: object) => string }} props
     */
    function FileRow({ artifact, name, depth = 0, showDirectory = false, cwd, sessionId, getTriggerProps, onOpen, t }: FileRowProps) {
      const path = artifact.path ?? ''
      const shown = displayPath(path, cwd)
      const label = (name !== undefined ? name : shown.name) || t('unnamed')
      const description = artifact.description !== undefined && artifact.description !== '' ? artifact.description : ''
      const directory = showDirectory ? shown.directory : ''
      const meta = description === ''
        ? directory
        : directory === '' ? description : `${description} · ${directory}`
      const menu = getTriggerProps({ kind: 'file', value: { sessionId, path: joinAbsolute(cwd, path) } })
      return h('li', null,
        h('button', {
          type: 'button',
          className: 'sa-row',
          style: indentOf(depth),
          title: path,
          'aria-label': t('openFileAria', { name: label }),
          onClick: () => { onOpen(path) },
          ...menu,
        },
          h('span', { className: 'sa-glyph', 'aria-hidden': true }, h(FileGlyph)),
          h('span', { className: 'sa-text' },
            h('span', { className: 'sa-line' },
              h('span', { className: 'sa-name' }, label),
              artifact.kind === 'delivered' ? h('span', { className: 'sa-badge' }, t('deliveredBadge')) : null,
            ),
            meta === '' ? null : h('span', { className: 'sa-meta' }, meta),
          ),
        ),
      )
    }

    /**
     * One directory row: chevron, folder, name, and its file count.
     * @param {{ row: { name: string, count: number, depth: number, closed: boolean, dirKey: string }, onToggle: () => void, t: (key: string, params?: object) => string }} props
     */
    function DirRow({ row, onToggle, t, cwd, sessionId, getTriggerProps }: DirRowProps) {
      const menu = getTriggerProps({ kind: 'directory', value: { sessionId, path: joinAbsolute(cwd, row.dirPath) } })
      return h('li', null,
        h('button', {
          type: 'button',
          className: 'sa-dir',
          style: indentOf(row.depth),
          'aria-expanded': !row.closed,
          onClick: onToggle,
          ...menu,
        },
          h(FoldersToggleGlyph, { open: !row.closed, size: 16 }),
          h('span', { className: 'sa-dir-name' }, row.name),
          h('span', { className: 'sa-dir-count', title: t('folderCount', { count: String(row.count) }) }, String(row.count)),
        ),
      )
    }

    /**
     * One titled, collapsible group of rows.
     * @param {object} props
     */
    function ArtifactSection(props: SectionProps) {
      const {
        sectionKey, title, artifacts, cwd, sessionId, getTriggerProps,
        onOpen, t, closed, onToggleSection, closedDirs, onToggleDir,
      } = props
      if (artifacts.length === 0) return null
      const body = closed ? null : sectionKey === 'lark'
        ? h('ul', { className: 'sa-list' },
          artifacts.map(artifact => h(LinkRow, { key: artifact.url, artifact, t })))
        : h('ul', { className: 'sa-list' },
          treeRows(buildTree(artifacts, cwd), sectionKey, closedDirs).map(row => row.kind === 'dir'
            ? h(DirRow, { key: row.key, row, onToggle: () => { onToggleDir(row.dirKey) }, t, cwd, sessionId, getTriggerProps })
            : h(FileRow, {
              key: row.key,
              artifact: row.artifact,
              name: row.name,
              depth: row.depth,
              showDirectory: row.flat,
              cwd,
              sessionId,
              getTriggerProps,
              onOpen,
              t,
            })))
      return h('section', { className: 'sa-section' },
        h('button', {
          type: 'button',
          className: 'sa-section-title',
          'aria-expanded': !closed,
          'aria-label': closed ? t('expandSection', { name: title }) : t('collapseSection', { name: title }),
          onClick: onToggleSection,
        },
          h('span', { className: 'sa-glyph', 'aria-hidden': true }, h(SectionGlyph, { section: sectionKey })),
          h('span', null, title),
          h('span', { className: 'sa-section-count' }, String(artifacts.length)),
        ),
        body === null ? null : h('div', { className: 'sa-section-body' }, body),
      )
    }

    /** Group chip shown for a bound Feishu group. */
    function GroupGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M5.5 5.5h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6.8l-4.2 3v-3H5.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z' }),
        h('path', { d: 'M8 10h8M8 13h5' }),
      )
    }

    /** Session row glyph: a terminal prompt in a rounded panel. */
    function SessionGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M4.5 6.5h15v11h-15z' }),
        h('path', { d: 'm8.5 10 2.5 2-2.5 2' }),
        h('path', { d: 'M13 14h3' }),
      )
    }

    /** Small refresh glyph for the Feishu header. */
    function RefreshGlyph() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M19 8a7.5 7.5 0 1 0 1 6' }),
        h('path', { d: 'M19 4v4h-4' }),
      )
    }

    interface FeishuPanelProps {
      sessionId: string
      status: FeishuStatus | undefined
      loading: boolean
      error: string
      actionError: string
      onBind: () => void
      onOpenGroup: (binding: FeishuBinding) => void
      onUnbind: (chatId: string, botId?: string) => void
      onReload: () => void
      t: TFunction
    }

    /** Bound Feishu groups and the bot that owns them. */
    function FeishuPanel({ sessionId, status, loading, error, actionError, onBind, onOpenGroup, onUnbind, onReload, t }: FeishuPanelProps) {
      const bound = (status?.bindings ?? []).filter(binding => binding.sessionId === sessionId)
      const botById = new Map((status?.bots ?? []).map(bot => [bot.id, bot.name]))
      const boundBotIds = [...new Set(bound.map(binding => binding.botId).filter((id): id is string => id !== undefined))]
      const botLabel = boundBotIds.map(id => botById.get(id) ?? id).join(' / ')
      const botNameOf = (botId?: string): string => botId === undefined ? '' : (botById.get(botId) ?? botId)
      const boundGroups = new Map<string, FeishuBinding[]>()
      for (const binding of bound) {
        const list = boundGroups.get(binding.chatId) ?? []
        list.push(binding)
        boundGroups.set(binding.chatId, list)
      }
      return h('section', { className: 'sa-feishu' },
        h('div', { className: 'sa-feishu-head' },
          h('span', { className: 'sa-feishu-title' }, t('feishu.title')),
          boundGroups.size === 0 ? null : h('span', { className: 'sa-feishu-total' }, t('feishu.chatCount', { count: String(boundGroups.size) })),
          h('span', { className: 'sa-feishu-actions' },
            h('button', {
              type: 'button',
              className: 'sa-feishu-bind',
              disabled: loading || (status === undefined && error !== ''),
              onClick: onBind,
            }, t('feishu.bind')),
            h('button', {
              type: 'button',
              className: 'sa-icon',
              title: t('feishu.refresh'),
              'aria-label': t('feishu.refresh'),
              onClick: onReload,
            }, h(RefreshGlyph)),
          ),
        ),
        botLabel === '' ? null : h('div', { className: 'sa-feishu-bot', title: botLabel }, `${t('feishu.bot')} · ${botLabel}`),
        loading
          ? h('div', { className: 'sa-feishu-note' }, t('feishu.loading'))
          : error !== ''
            ? h('div', { className: 'sa-feishu-empty' }, t('feishu.missing'), h('span', { className: 'sa-feishu-empty-hint' }, t('feishu.missingHint')))
            : boundGroups.size === 0
              ? h('div', { className: 'sa-feishu-empty' }, t('feishu.empty'), h('span', { className: 'sa-feishu-empty-hint' }, t('feishu.emptyHint')))
              : h('div', null, [...boundGroups.entries()].map(([chatId, bindings]) => {
                const binding = bindings[0]
                const names = bindings.map(item => botNameOf(item.botId)).filter(name => name !== '').join(' / ')
                return h('div', {
                className: 'sa-feishu-row',
                key: chatId,
                role: 'button',
                tabIndex: 0,
                title: t('feishu.groupHint'),
                onClick: () => { onOpenGroup(binding) },
                onKeyDown: (event: { key: string; preventDefault(): void }) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onOpenGroup(binding)
                },
              },
                h('span', { className: 'sa-avatar', 'aria-hidden': true }, h(GroupGlyph)),
                h('span', { className: 'sa-text' },
                  h('span', { className: 'sa-feishu-name' }, groupDisplayName(binding.chatName, binding.chatId)),
                  h('span', { className: 'sa-feishu-id' }, names === '' ? binding.chatId : `${binding.chatId} · ${names}`),
                ),
                binding.botMember === false
                  ? h('span', { className: 'sa-chat-badge', 'data-warning': 'true', title: t('feishu.botMissingHint') }, t('feishu.botMissing'))
                  : null,
                h('button', {
                  type: 'button',
                  className: 'sa-feishu-unbind',
                  title: t('feishu.unbind'),
                  'aria-label': t('feishu.unbind'),
                  onClick: (event: { stopPropagation(): void }) => {
                    event.stopPropagation()
                    onUnbind(chatId)
                  },
                }, t('feishu.unbind')),
                h('span', { className: 'sa-feishu-chevron', 'aria-hidden': true }, '›'),
              )
            })),
        actionError === '' ? null : h('div', { className: 'sa-dialog-error' }, t('feishu.failed', { error: actionError })),
      )
    }

    interface BindDialogProps {
      open: boolean
      chats: FeishuChat[]
      bots: Array<{ id: string; name: string }>
      botId: string
      onBotChange: (botId: string) => void
      loading: boolean
      error: string
      busy: boolean
      onClose: () => void
      onRefresh: () => void
      onBind: (chatId: string) => void
      t: TFunction
    }

    /** Modal picker: search visible groups or paste a chat id. */
    function BindDialog({ open, chats, bots, botId, onBotChange, loading, error, busy, onClose, onRefresh, onBind, t }: BindDialogProps) {
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState('')
      const [manual, setManual] = useState('')
      const [manualOpen, setManualOpen] = useState(false)
      useEffect(() => {
        if (!open) {
          setQuery('')
          setSelected('')
          setManual('')
          setManualOpen(false)
        }
      }, [open])
      useEffect(() => {
        if (open && !loading && chats.length === 0) setManualOpen(true)
      }, [open, loading, chats.length])
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event: KeyboardEvent): void => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, onClose])
      if (!open) return null
      const needle = query.trim().toLowerCase()
      const visible = chats.filter(chat => needle === ''
        || chat.name.toLowerCase().includes(needle)
        || chat.chatId.toLowerCase().includes(needle))
      const target = manual.trim() !== '' ? manual.trim() : selected
      const selectedChat = chats.find(chat => chat.chatId === selected)
      const availableBots = selectedChat?.bots?.filter(bot => bot.member) ?? bots
      const choose = (chatId: string): void => {
        setSelected(chatId)
        setManual('')
        const chat = chats.find(item => item.chatId === chatId)
        const memberBots = chat?.bots?.filter(bot => bot.member) ?? []
        if (memberBots.length > 0 && !memberBots.some(bot => bot.id === botId)) onBotChange(memberBots[0].id)
      }
      const submit = (): void => {
        if (target !== '' && !busy) onBind(target)
      }
      return h('div', { className: 'sa-overlay', onClick: onClose },
        h('div', {
          className: 'sa-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('feishu.bindTitle'),
          onClick: (event: { stopPropagation(): void }) => { event.stopPropagation() },
        },
          h('div', { className: 'sa-dialog-head' },
            h('span', { className: 'sa-dialog-title' }, t('feishu.bindTitle')),
            h('button', { type: 'button', className: 'sa-dialog-close', 'aria-label': t('feishu.cancel'), onClick: onClose }, '×'),
          ),
          h('div', { className: 'sa-dialog-desc' }, t('feishu.bindHint')),
          h('div', { className: 'sa-dialog-body' },
            availableBots.length > 1
              ? h('label', { className: 'sa-bot-picker' },
                h('span', null, t('feishu.botLabel')),
                h('select', {
                  className: 'sa-input',
                  value: botId,
                  onChange: (event: { target: { value: string } }) => { onBotChange(event.target.value) },
                }, availableBots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
              )
              : null,
            h('input', {
              className: 'sa-input',
              value: query,
              placeholder: t('feishu.search'),
              onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
              onKeyDown: (event: { key: string; preventDefault(): void }) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (visible.length === 1) onBind(visible[0].chatId)
                else submit()
              },
            }),
            loading
              ? h('div', { className: 'sa-dialog-empty' }, t('feishu.loading'))
              : h('ul', { className: 'sa-chat-list', role: 'listbox', 'aria-label': t('feishu.title') },
                visible.length === 0
                  ? h('li', { className: 'sa-dialog-empty' }, t('feishu.none'))
                  : visible.map(chat => h('li', { key: chat.chatId },
                    h('button', {
                      type: 'button',
                      className: 'sa-chat',
                      role: 'option',
                      'aria-selected': selected === chat.chatId,
                      disabled: busy || chat.botMember === false,
                      title: chat.botMember === false ? t('feishu.botMissingHint') : undefined,
                      onClick: () => { choose(chat.chatId) },
                    },
                      h('span', { className: 'sa-avatar', 'aria-hidden': true }, h(GroupGlyph)),
                      h('span', { className: 'sa-chat-text' },
                        h('span', { className: 'sa-chat-name' }, chat.name),
                        h('span', { className: 'sa-chat-id' }, chat.chatId),
                      ),
                      chat.botMember === false
                        ? h('span', { className: 'sa-chat-badge', 'data-warning': 'true' }, t('feishu.botMissing'))
                        : chat.bound ? h('span', { className: 'sa-chat-badge' }, t('feishu.bound')) : null,
                    ),
                  ))),
            h('button', {
              type: 'button',
              className: 'sa-manual-toggle',
              'aria-expanded': manualOpen,
              onClick: () => { setManualOpen(value => !value) },
            }, t('feishu.manual')),
            manualOpen
              ? h('div', { className: 'sa-manual' },
                h('input', {
                  className: 'sa-input',
                  value: manual,
                  placeholder: t('feishu.manualPlaceholder'),
                  onChange: (event: { target: { value: string } }) => {
                    setManual(event.target.value)
                    if (event.target.value !== '') setSelected('')
                  },
                  onKeyDown: (event: { key: string; preventDefault(): void }) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    if (manual.trim() !== '') onBind(manual.trim())
                  },
                }),
              )
              : null,
            error === '' ? null : h('div', { className: 'sa-dialog-error' }, error),
          ),
          h('div', { className: 'sa-dialog-footer' },
            h('button', {
              type: 'button',
              className: 'sa-button',
              disabled: busy || loading,
              onClick: onRefresh,
            }, t('feishu.refresh')),
            h('span', { className: 'sa-footer-spacer' }),
            h('button', { type: 'button', className: 'sa-button', disabled: busy, onClick: onClose }, t('feishu.cancel')),
            h('button', {
              type: 'button',
              className: 'sa-button',
              'data-primary': 'true',
              disabled: busy || target === '' || (selectedChat !== undefined && selectedChat.bots !== undefined && availableBots.length === 0),
              onClick: submit,
            }, t('feishu.bindAction')),
          ),
        ),
      )
    }

    interface GroupDialogProps {
      open: boolean
      group: FeishuGroupDetail | undefined
      loading: boolean
      error: string
      busy: boolean
      onClose: () => void
      onUnbind: (chatId: string, botId?: string) => void
      sessionTitle: (sessionId: string) => string
      t: TFunction
    }

    /** One group's binding history: sessions newest first, with the active one marked. */
    function GroupDialog({ open, group, loading, error, busy, onClose, onUnbind, sessionTitle, t }: GroupDialogProps) {
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event: KeyboardEvent): void => {
          if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, onClose])
      if (!open) return null
      const sessions = [...(group?.sessions ?? [])].sort((left, right) => right.at - left.at)
      const hasCurrent = sessions.some(session => session.current)
      const title = group === undefined
        ? t('feishu.groupDetail')
        : groupDisplayName(group.chatName, group.chatId)
      const timeOf = (at: number): string => at > 0 ? new Date(at).toLocaleString() : t('feishu.unknownTime')
      return h('div', { className: 'sa-overlay', onClick: onClose },
        h('div', {
          className: 'sa-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('feishu.groupDetail'),
          onClick: (event: { stopPropagation(): void }) => { event.stopPropagation() },
        },
          h('div', { className: 'sa-dialog-head' },
            h('span', { className: 'sa-dialog-title' }, title),
            h('button', { type: 'button', className: 'sa-dialog-close', 'aria-label': t('feishu.close'), onClick: onClose }, '×'),
          ),
          h('div', { className: 'sa-dialog-desc' }, group === undefined ? t('feishu.groupDetail') : `${group.chatId}${group.botMember ? '' : ` · ${t('feishu.botMissing')}`}`),
          group?.bots === undefined || group.bots.length === 0
            ? null
            : h('div', { className: 'sa-dialog-desc' },
              `${t('feishu.botLabel')}: ${group.bots.filter(bot => bot.member).map(bot => `${bot.name}${bot.bound ? ' ✓' : ''}`).join(' / ')}`),
          h('div', { className: 'sa-dialog-body' },
            loading
              ? h('div', { className: 'sa-dialog-empty' }, t('feishu.loading'))
              : error !== ''
                ? h('div', { className: 'sa-dialog-error' }, t('feishu.failed', { error }))
                : group === undefined
                  ? h('div', { className: 'sa-dialog-empty' }, t('feishu.sessionsEmpty'))
                  : h('div', null,
                    h('div', { className: 'sa-subhead', style: { paddingLeft: 0 } }, t('feishu.sessions')),
                    sessions.length === 0
                      ? h('div', { className: 'sa-dialog-empty' }, t('feishu.sessionsEmpty'))
                      : h('div', { className: 'sa-session-list' }, sessions.map(session => h('div', {
                        className: 'sa-session-row',
                        key: session.sessionId,
                        'data-current': session.current,
                      },
                        h('span', { className: 'sa-avatar', 'aria-hidden': true }, h(SessionGlyph)),
                        h('span', { className: 'sa-text' },
                          h('span', { className: 'sa-session-name' }, sessionTitle(session.sessionId)),
                          h('span', { className: 'sa-session-id' }, session.sessionId),
                          h('span', { className: 'sa-session-meta' },
                            t('feishu.boundAt', { time: timeOf(session.at) }),
                            h('span', null, ' · '),
                            t(`feishu.source.${session.source}`),
                          ),
                        ),
                        session.current ? h('span', { className: 'sa-chat-badge sa-session-current' }, t('feishu.current')) : null,
                      ))),
                  ),
          ),
          h('div', { className: 'sa-dialog-footer' },
            h('span', { className: 'sa-footer-spacer' }),
            h('button', { type: 'button', className: 'sa-button', disabled: busy, onClick: onClose }, t('feishu.close')),
            hasCurrent && group !== undefined
              ? h('button', {
                type: 'button',
                className: 'sa-button',
                'data-danger': 'true',
                disabled: busy,
                onClick: () => { onUnbind(group.chatId) },
              }, t('feishu.unbindGroup'))
              : null,
          ),
        ),
      )
    }

    /**
     * The tab body: the viewed Session's artifacts, live from its projection.
     * @param {object} props - composed slot props.
     */
    function ArtifactsBody(props: ArtifactsBodyProps) {
      const { sessionId, useSessions, useProjection, useTabInfo, useContextMenu, t } = props
      const view = useProjection('sessionArtifacts')
      const cwd = useSessions(sessions => (sessions.byId[sessionId] || {}).cwd)
      const sessionsById = useSessions(sessions => sessions.byId)
      const { tab, panel } = useTabInfo()
      const { getTriggerProps } = useContextMenu()
      const [closedSections, setClosedSections] = useState<Record<string, boolean>>({})
      const [closedDirs, setClosedDirs] = useState<Record<string, boolean>>({})
      const feishu = useFeishuStatus(React, { refresh: true })
      const [bindOpen, setBindOpen] = useState(false)
      const [chats, setChats] = useState<FeishuChat[]>([])
      const [chatsLoading, setChatsLoading] = useState(false)
      const [chatsError, setChatsError] = useState('')
      const [binding, setBinding] = useState(false)
      const [botId, setBotId] = useState('')
      const bots = feishu.data?.bots ?? []
      useEffect(() => {
        if (botId === '' && bots.length > 0) setBotId(bots[0].id)
      }, [botId, bots])
      const [actionError, setActionError] = useState('')
      const [groupOpen, setGroupOpen] = useState(false)
      const [group, setGroup] = useState<FeishuGroupDetail | undefined>(undefined)
      const [groupLoading, setGroupLoading] = useState(false)
      const [groupError, setGroupError] = useState('')

      const loadChats = (): void => {
        setChatsLoading(true)
        setChatsError('')
        fetchFeishuApi<{ chats: FeishuChat[] }>(`${FEISHU_API}?action=chats&refresh=1`)
          .then(value => { setChats(Array.isArray(value.chats) ? value.chats : []) })
          .catch(reason => {
            setChats([])
            setChatsError(reason instanceof Error ? reason.message : String(reason))
          })
          .finally(() => { setChatsLoading(false) })
      }
      const openBind = (): void => {
        setActionError('')
        setBindOpen(true)
        loadChats()
      }
      const bindChatToSession = (chatId: string): void => {
        if (chatId === '' || binding) return
        setBinding(true)
        setActionError('')
        fetchFeishuApi<FeishuStatus>(FEISHU_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'bind', chatId, sessionId, botId }),
        })
          .then(() => {
            setBindOpen(false)
            feishu.reload()
          })
          .catch(reason => { setActionError(reason instanceof Error ? reason.message : String(reason)) })
          .finally(() => { setBinding(false) })
      }
      const unbindChat = (chatId: string, botId?: string): void => {
        setActionError('')
        fetchFeishuApi<FeishuStatus>(FEISHU_API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'unbind', chatId, botId }),
        })
          .then(() => {
            setGroupOpen(false)
            setGroup(undefined)
            feishu.reload()
          })
          .catch(reason => { setActionError(reason instanceof Error ? reason.message : String(reason)) })
      }
      const openGroup = (target: FeishuBinding): void => {
        setGroupOpen(true)
        setGroup(undefined)
        setGroupError('')
        setGroupLoading(true)
        fetchFeishuApi<FeishuGroupDetail>(`${FEISHU_API}?action=group&chatId=${encodeURIComponent(target.chatId)}`)
          .then(value => { setGroup(value) })
          .catch(reason => { setGroupError(reason instanceof Error ? reason.message : String(reason)) })
          .finally(() => { setGroupLoading(false) })
      }
      const sessionTitleOf = (id: string): string => sessionDisplayTitle(sessionsById[id], id)

      const feishuPanel = h(FeishuPanel, {
        sessionId,
        status: feishu.data,
        loading: feishu.loading,
        error: feishu.error,
        actionError,
        onBind: openBind,
        onOpenGroup: openGroup,
        onUnbind: unbindChat,
        onReload: () => { feishu.reload() },
        t,
      })
      const bindDialog = h(BindDialog, {
        open: bindOpen,
        chats,
        bots,
        botId,
        onBotChange: setBotId,
        loading: chatsLoading,
        error: chatsError === '' ? actionError : chatsError,
        busy: binding,
        onClose: () => { setBindOpen(false) },
        onRefresh: loadChats,
        onBind: bindChatToSession,
        t,
      })
      const groupDialog = h(GroupDialog, {
        open: groupOpen,
        group,
        loading: groupLoading,
        error: groupError,
        busy: binding,
        onClose: () => { setGroupOpen(false) },
        onUnbind: unbindChat,
        sessionTitle: sessionTitleOf,
        t,
      })

      if (view === undefined) {
        return h('div', { className: 'sa-page', 'data-session-artifacts': '' },
          h(Styles),
          h('div', { className: 'sa-scroll' }, feishuPanel, h('div', { className: 'sa-loading' }, t('loading'))),
          bindDialog,
          groupDialog,
        )
      }

      const groups: Record<SectionKey, Artifact[]> = { lark: [], doc: [], sheet: [], slide: [], image: [], code: [], other: [] }
      for (const section of SECTIONS) groups[section] = []
      let total = 0
      const artifacts = Array.isArray(view.artifacts) ? view.artifacts : []
      for (const artifact of artifacts) {
        if (!artifact) continue
        if (typeof artifact.path !== 'string' && typeof artifact.url !== 'string') continue
        if (artifact.path === '') continue
        groups[sectionOf(artifact)].push(artifact)
        total += 1
      }
      const present = SECTIONS.filter(section => groups[section].length > 0)
      const allClosed = present.length > 0 && present.every(section => closedSections[section] === true)
      const dirKeys: string[] = []
      for (const section of SECTIONS) {
        if (section === 'lark' || groups[section].length === 0) continue
        for (const key of dirKeysOf(groups[section], section, cwd)) dirKeys.push(key)
      }
      const allDirsClosed = dirKeys.length > 0 && dirKeys.every(key => closedDirs[key] === true)

      const onOpen = (path: string): void => {
        const address = fileAddressFor(sessionId, cwd, path)
        if (panel.isFloating) tab.actions.openResource(address)
        else tab.actions.openResource(address, { paneId: panel.id })
      }
      const toggleSection = (section: SectionKey): void => {
        setClosedSections(previous => ({ ...previous, [section]: previous[section] !== true }))
      }
      const toggleDir = (key: string): void => {
        setClosedDirs(previous => ({ ...previous, [key]: previous[key] !== true }))
      }
      const toggleAll = () => {
        if (allClosed) {
          setClosedSections({})
          return
        }
        const next: Record<string, boolean> = {}
        for (const section of present) next[section] = true
        setClosedSections(next)
      }
      const toggleDirs = () => {
        if (allDirsClosed) {
          setClosedDirs({})
          return
        }
        const next: Record<string, boolean> = {}
        for (const key of dirKeys) next[key] = true
        setClosedDirs(next)
      }

      return h('div', { className: 'sa-page', 'data-session-artifacts': '' },
        h(Styles),
        h('div', { className: 'sa-header' },
          h(WorkspacePath, { cwd, t }),
          h('span', { className: 'sa-actions' },
            h('span', { className: 'sa-count' }, t('header', { count: String(total) })),
            total === 0 || dirKeys.length === 0 || allClosed ? null : h('button', {
              type: 'button',
              className: 'sa-icon',
              'data-action': 'folders',
              title: allDirsClosed ? t('expandDirs') : t('collapseDirs'),
              'aria-label': allDirsClosed ? t('expandDirs') : t('collapseDirs'),
              onClick: toggleDirs,
            }, h(FoldersToggleGlyph, { open: !allDirsClosed })),
            total === 0 ? null : h('button', {
              type: 'button',
              className: 'sa-icon',
              'data-action': 'sections',
              title: allClosed ? t('expandAll') : t('collapseAll'),
              'aria-label': allClosed ? t('expandAll') : t('collapseAll'),
              onClick: toggleAll,
            }, h(GroupsToggleGlyph, { open: !allClosed })),
          ),
        ),
        h('div', { className: 'sa-scroll' },
          feishuPanel,
          h('div', { className: 'sa-subhead' }, t('feishu.artifacts')),
          total === 0
            ? h('div', { className: 'sa-empty' },
              h('span', { className: 'sa-empty-glyph', 'aria-hidden': true }, h(EmptyGlyph)),
              h('span', { className: 'sa-empty-title' }, t('emptyTitle')),
              h('span', { className: 'sa-empty-hint' }, t('emptyHint')),
            )
            : SECTIONS.map(section => h(ArtifactSection, {
              key: section,
              sectionKey: section,
              title: t(`section.${section}`),
              artifacts: groups[section],
              cwd,
              sessionId,
              getTriggerProps,
              onOpen,
              t,
              closed: closedSections[section] === true,
              onToggleSection: () => { toggleSection(section) },
              closedDirs,
              onToggleDir: toggleDir,
            })),
        ),
        bindDialog,
        groupDialog,
      )
    }

    /**
     * Register the page type, its copy, and its body.
     * @param {object} ctx - Client plugin context.
     */
    function apply(ctx: ClientContext): void {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-artifacts: dictionaries')
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'builtin',
        keepMounted: true,
        title: () => t('typeLabel'),
        guide: [{
          id: 'session-artifacts',
          order: 25,
          title: () => t('guideTitle'),
          description: () => t('guideDescription'),
          icon: ArtifactsChipIcon,
        }],
      }), 'session-artifacts: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        locale: NS,
      }, ArtifactsBody)), 'session-artifacts: tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
      }, ArtifactsTitle)), 'session-artifacts: tab title')
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply,
    }
}
