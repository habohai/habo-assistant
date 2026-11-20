/**
 * One append-only journal for the conversation → Session relation.
 *
 * A conversation is `(chatId, threadId)`; threadId '' is the group's main
 * conversation. A conversation owns exactly one active Session, while one
 * Session may own many conversations. Bot ids are lazy grants inside the
 * conversation, not part of the ownership key.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type BindingSource = 'external' | 'manual' | 'auto' | 'outbound'
export type BindingState = 'active' | 'replaced' | 'unbound' | 'candidate'

export interface BindingRecord {
  botId: string
  op: 'bind' | 'unbind' | 'candidate'
  key: string
  chatId: string
  threadId?: string
  sessionId?: string
  source: BindingSource
  at: number
  state: BindingState
}

export type BindingResolution =
  | { kind: 'explicit'; sessionId: string; source: BindingSource; at: number; key: string }
  | { kind: 'auto'; sessionId: string; source: BindingSource; at: number; key: string }
  | { kind: 'candidate'; sessionId: string; source: BindingSource; at: number; key: string }
  | { kind: 'unbound'; key: string }
  | { kind: 'none'; key: string }

interface JsonMap { [key: string]: unknown }

function parseKey(key: string): { chatId: string; threadId: string } {
  const index = key.indexOf('::')
  return index === -1
    ? { chatId: key, threadId: '' }
    : { chatId: key.slice(0, index), threadId: key.slice(index + 2) }
}

function makeKey(chatId: string, threadId: string): string {
  return threadId === '' ? chatId : `${chatId}::${threadId}`
}

function isSource(value: unknown): value is BindingSource {
  return value === 'manual' || value === 'external' || value === 'auto' || value === 'outbound'
}

export class BindingRegistry {
  private readonly file: string
  private readonly legacyDir: string
  private readonly defaultBotId: string
  /** conversation key -> active bind record. */
  private readonly active: Map<string, BindingRecord>
  /** conversation key -> lazily granted bot ids. */
  private readonly grants: Map<string, Map<string, number>>
  /** chat id -> candidate for discovery. */
  private readonly candidates: Map<string, BindingRecord>
  /** chat id -> history, newest first. */
  private readonly historyByChat: Map<string, BindingRecord[]>
  /** conversation key -> unbind suppression. */
  private readonly suppressed: Set<string>
  private writes: Promise<void>
  private appends: number
  readonly ready: Promise<void>

  constructor(dir: string, botId = 'default') {
    this.legacyDir = dir
    this.defaultBotId = botId
    this.file = join(dir, 'binding-state.v2.jsonl')
    this.active = new Map()
    this.grants = new Map()
    this.candidates = new Map()
    this.historyByChat = new Map()
    this.suppressed = new Set()
    this.writes = Promise.resolve()
    this.appends = 0
    this.ready = this.load()
  }

  private async readJson(name: string): Promise<JsonMap | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.legacyDir, name), 'utf8')) as unknown
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonMap : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }

  private addHistory(record: BindingRecord): void {
    if (record.sessionId === undefined) return
    const list = this.historyByChat.get(record.chatId) ?? []
    const index = list.findIndex(item => item.sessionId === record.sessionId && (item.threadId ?? '') === (record.threadId ?? ''))
    if (index === -1) list.push(record)
    else if (list[index]!.at <= record.at) list[index] = record
    list.sort((left, right) => right.at - left.at)
    this.historyByChat.set(record.chatId, list.slice(0, 100))
  }

  private apply(record: BindingRecord): void {
    const key = record.key
    if (record.op === 'candidate') {
      const previous = this.candidates.get(record.chatId)
      if (record.sessionId !== undefined && (previous === undefined || record.at >= previous.at)) {
        this.candidates.set(record.chatId, record)
      }
      return
    }
    if (record.op === 'unbind') {
      this.active.delete(key)
      this.grants.delete(key)
      this.suppressed.add(key)
      return
    }
    if (record.sessionId === undefined) return
    if (record.state === 'replaced') {
      this.addHistory(record)
      return
    }
    const previous = this.active.get(key)
    if (previous?.sessionId !== record.sessionId) this.grants.delete(key)
    this.active.set(key, record)
    this.suppressed.delete(key)
    const bots = this.grants.get(key) ?? new Map<string, number>()
    bots.set(record.botId, record.at)
    this.grants.set(key, bots)
    this.addHistory(record)
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8')
      let lines = 0
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        lines += 1
        try {
          const record = JSON.parse(line) as BindingRecord
          if (typeof record?.key === 'string' && typeof record?.chatId === 'string' && typeof record?.at === 'number') {
            this.apply({ ...record, botId: typeof record.botId === 'string' ? record.botId : this.defaultBotId })
          }
        } catch {
          // A torn tail is ignored; the next append repairs the journal.
        }
      }
      if (lines > 2000) await this.compact()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.migrateLegacy()
  }

  /** One-time import from the four old files, then start the unified journal. */
  private async migrateLegacy(): Promise<void> {
    const legacy: BindingRecord[] = []

    const active = await this.readJson('bindings.json')
    if (active !== undefined) {
      for (const [key, value] of Object.entries(active)) {
        const { chatId, threadId } = parseKey(key)
        if (typeof value === 'string' && value !== '') {
          legacy.push({ botId: this.defaultBotId, op: 'bind', key, chatId, ...(threadId === '' ? {} : { threadId }), sessionId: value, source: 'manual', at: 0, state: 'active' })
          continue
        }
        if (value === null || typeof value !== 'object') continue
        const record = value as { sessionId?: unknown; source?: unknown; boundAt?: unknown }
        if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
        legacy.push({
          botId: this.defaultBotId, op: 'bind', key, chatId, ...(threadId === '' ? {} : { threadId }),
          sessionId: record.sessionId,
          source: isSource(record.source) ? record.source : 'auto',
          at: typeof record.boundAt === 'number' ? record.boundAt : 0,
          state: 'active',
        })
      }
    }

    const history = await this.readJson('binding-history.json')
    if (history !== undefined) {
      for (const [chatId, value] of Object.entries(history)) {
        if (!Array.isArray(value)) continue
        for (const item of value) {
          if (item === null || typeof item !== 'object') continue
          const record = item as { sessionId?: unknown; at?: unknown; source?: unknown }
          if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
          legacy.push({
            botId: this.defaultBotId, op: 'bind', key: chatId, chatId, sessionId: record.sessionId,
            source: isSource(record.source) ? record.source : 'auto',
            at: typeof record.at === 'number' ? record.at : 0,
            state: 'replaced',
          })
        }
      }
    }

    const affinity = await this.readJson('chat-affinity.json')
    if (affinity !== undefined) {
      for (const [chatId, value] of Object.entries(affinity)) {
        if (value === null || typeof value !== 'object') continue
        const record = value as { sessionId?: unknown; at?: unknown }
        if (typeof record.sessionId !== 'string') continue
        legacy.push({
          botId: this.defaultBotId, op: 'candidate', key: chatId, chatId, sessionId: record.sessionId,
          source: 'auto', at: typeof record.at === 'number' ? record.at : 0, state: 'candidate',
        })
      }
    }

    try {
      const list = JSON.parse(await readFile(join(this.legacyDir, 'suppressed-chats.json'), 'utf8')) as unknown
      if (Array.isArray(list)) {
        for (const chatId of list) {
          if (typeof chatId === 'string') legacy.push({ botId: this.defaultBotId, op: 'unbind', key: chatId, chatId, source: 'auto', at: 0, state: 'unbound' })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    for (const record of legacy) this.apply(record)
    await mkdir(dirname(this.file), { recursive: true })
    const body = legacy.map(record => JSON.stringify(record)).join('\n')
    await writeFile(this.file, body === '' ? '' : `${body}\n`, 'utf8')
  }

  get(key: string): BindingRecord | undefined {
    return this.active.get(key)
  }

  resolve(chatId: string, threadId: string, routing: 'chat' | 'thread'): BindingResolution {
    const key = routing === 'thread' && threadId !== '' ? makeKey(chatId, threadId) : chatId
    const current = this.active.get(key)
    if (current?.sessionId !== undefined) {
      return current.source === 'manual' || current.source === 'external' || current.source === 'outbound'
        ? { kind: 'explicit', sessionId: current.sessionId, source: current.source, at: current.at, key }
        : { kind: 'auto', sessionId: current.sessionId, source: current.source, at: current.at, key }
    }
    if (this.suppressed.has(key)) return { kind: 'unbound', key }
    const candidate = this.candidates.get(chatId)
    if (candidate?.sessionId !== undefined) {
      return { kind: 'candidate', sessionId: candidate.sessionId, source: 'auto', at: candidate.at, key }
    }
    return { kind: 'none', key }
  }

  entries(): Array<[string, BindingRecord]> {
    return [...this.active.entries()]
  }

  botIdsFor(key: string): string[] {
    return [...(this.grants.get(key)?.keys() ?? [])]
  }

  hasGrant(key: string, botId: string): boolean {
    return this.grants.get(key)?.has(botId) === true
  }

  peersForChat(chatId: string): string[] {
    const ids = new Set<string>()
    for (const [key] of this.active) {
      if (key !== chatId && !key.startsWith(`${chatId}::`)) continue
      for (const botId of this.grants.get(key)?.keys() ?? []) ids.add(botId)
    }
    return [...ids]
  }

  listByChat(chatId: string, includeCandidates = false): BindingRecord[] {
    const records = [...(this.historyByChat.get(chatId) ?? [])]
    if (includeCandidates) {
      const candidate = this.candidates.get(chatId)
      if (candidate?.sessionId !== undefined && !records.some(item => item.sessionId === candidate.sessionId && item.at === candidate.at)) {
        records.push(candidate)
        records.sort((left, right) => right.at - left.at)
      }
    }
    return records
  }

  isSuppressed(key: string): boolean {
    return this.suppressed.has(key)
  }

  candidateFor(chatId: string): BindingRecord | undefined {
    return this.candidates.get(chatId)
  }

  async compact(): Promise<void> {
    const rewrite = async (): Promise<void> => {
      const records: BindingRecord[] = []
      const seen = new Set<string>()
      for (const list of this.historyByChat.values()) {
        for (const record of list) {
          const active = this.active.get(record.key)
          const state = active !== undefined && active.sessionId === record.sessionId && active.threadId === record.threadId && active.at === record.at ? 'active' : 'replaced'
          records.push({ ...record, state })
          if (state === 'active') seen.add(record.key)
        }
      }
      for (const [key, record] of this.active) {
        if (!seen.has(key)) records.push({ ...record, state: 'active' })
      }
      for (const record of this.candidates.values()) records.push(record)
      for (const key of this.suppressed) {
        const { chatId, threadId } = parseKey(key)
        records.push({ botId: this.defaultBotId, op: 'unbind', key, chatId, ...(threadId === '' ? {} : { threadId }), source: 'auto', at: Date.now(), state: 'unbound' })
      }
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, records.map(record => JSON.stringify(record)).join('\n') + (records.length === 0 ? '' : '\n'), 'utf8')
      await rename(temp, this.file)
    }
    this.writes = this.writes.catch(() => {}).then(rewrite)
    await this.writes
    this.appends = 0
  }

  private async append(record: BindingRecord): Promise<void> {
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
    })
    await this.writes
    this.appends += 1
    if (this.appends >= 500) await this.compact()
  }

  async grant(key: string, botId: string, at = Date.now()): Promise<void> {
    const current = this.active.get(key)
    if (current?.sessionId === undefined) return
    if (this.grants.get(key)?.has(botId) === true) return
    const record: BindingRecord = {
      botId, op: 'bind', key, chatId: current.chatId, ...(current.threadId === undefined ? {} : { threadId: current.threadId }),
      sessionId: current.sessionId, source: current.source, at, state: 'active',
    }
    this.apply(record)
    await this.append(record)
  }

  async bind(chatId: string, threadId: string, sessionId: string, source: BindingSource, at = Date.now(), botId = this.defaultBotId): Promise<BindingRecord> {
    const key = makeKey(chatId, threadId)
    const record: BindingRecord = {
      botId, op: 'bind', key, chatId, ...(threadId === '' ? {} : { threadId }), sessionId, source, at, state: 'active',
    }
    this.apply(record)
    await this.append(record)
    return record
  }

  async unbind(chatId: string, threadId: string, at = Date.now(), botId = this.defaultBotId): Promise<void> {
    const key = makeKey(chatId, threadId)
    const record: BindingRecord = { botId, op: 'unbind', key, chatId, ...(threadId === '' ? {} : { threadId }), source: 'auto', at, state: 'unbound' }
    this.apply(record)
    await this.append(record)
  }

  async recordCandidate(chatId: string, sessionId: string, at = Date.now(), botId = this.defaultBotId): Promise<void> {
    const record: BindingRecord = { botId, op: 'candidate', key: chatId, chatId, sessionId, source: 'auto', at, state: 'candidate' }
    this.apply(record)
    await this.append(record)
  }

  async clearSuppression(key: string): Promise<void> {
    this.suppressed.delete(key)
  }
}

/** One bot's view over the shared conversation journal. */
export class BotBindings {
  constructor(
    private readonly registry: BindingRegistry,
    readonly botId: string,
  ) {}

  get ready(): Promise<void> {
    return this.registry.ready
  }

  get(key: string): BindingRecord | undefined {
    return this.registry.get(key)
  }

  resolve(chatId: string, threadId: string, routing: 'chat' | 'thread'): BindingResolution {
    return this.registry.resolve(chatId, threadId, routing)
  }

  entries(): Array<[string, BindingRecord]> {
    return this.registry.entries()
  }

  botIdsFor(key: string): string[] {
    return this.registry.botIdsFor(key)
  }

  hasGrant(key: string): boolean {
    return this.registry.hasGrant(key, this.botId)
  }

  peersForChat(chatId: string): string[] {
    return this.registry.peersForChat(chatId)
  }

  listByChat(chatId: string, includeCandidates = false): BindingRecord[] {
    return this.registry.listByChat(chatId, includeCandidates)
  }

  candidateFor(chatId: string): BindingRecord | undefined {
    return this.registry.candidateFor(chatId)
  }

  isSuppressed(key: string): boolean {
    return this.registry.isSuppressed(key)
  }

  bind(chatId: string, threadId: string, sessionId: string, source: BindingSource, at = Date.now()): Promise<BindingRecord> {
    return this.registry.bind(chatId, threadId, sessionId, source, at, this.botId)
  }

  grant(key: string, at = Date.now()): Promise<void> {
    return this.registry.grant(key, this.botId, at)
  }

  unbind(chatId: string, threadId: string, at = Date.now()): Promise<void> {
    return this.registry.unbind(chatId, threadId, at, this.botId)
  }

  recordCandidate(chatId: string, sessionId: string, at = Date.now()): Promise<void> {
    return this.registry.recordCandidate(chatId, sessionId, at, this.botId)
  }
}
