/**
 * One append-only binding journal for the (bot, chat/thread, session) relation.
 *
 * The journal replaces the old four-file split (active bindings, history,
 * outbound affinity, unbind suppression). Loading rebuilds an active index;
 * every write appends one record, so history and suppression come from the same
 * source of truth.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
export type BindingSource = 'external' | 'manual' | 'auto'

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

/** Internal map key: one active owner per (bot, chat/thread). */
function slot(botId: string, key: string): string {
  return `${botId}\u0000${key}`
}

function isSource(value: unknown): value is BindingSource {
  return value === 'manual' || value === 'external' || value === 'auto'
}

export class BindingRegistry {
  private readonly file: string
  private readonly legacyDir: string
  private readonly botId: string
  /** (botId, binding key) -> active bind record. */
  private readonly active: Map<string, BindingRecord>
  /** (botId, chatId) -> candidate from an outbound bot message. */
  private readonly candidates: Map<string, BindingRecord>
  /** (botId, chatId) -> history, newest first. */
  private readonly historyByChat: Map<string, BindingRecord[]>
  private readonly suppressed: Set<string>
  readonly ready: Promise<void>

  constructor(dir: string, botId = 'default') {
    this.legacyDir = dir
    this.botId = botId
    this.file = join(dir, 'binding-state.v2.jsonl')
    this.active = new Map()
    this.candidates = new Map()
    this.historyByChat = new Map()
    this.suppressed = new Set()
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
    const mapKey = slot(record.botId, record.chatId)
    const list = this.historyByChat.get(mapKey) ?? []
    const index = list.findIndex(item => item.sessionId === record.sessionId)
    if (index === -1) list.push(record)
    else if (list[index]!.at <= record.at) list[index] = record
    list.sort((left, right) => right.at - left.at)
    this.historyByChat.set(mapKey, list.slice(0, 100))
  }

  private apply(record: BindingRecord): void {
    const key = slot(record.botId, record.key)
    const chatKey = slot(record.botId, record.chatId)
    if (record.op === 'candidate') {
      const previous = this.candidates.get(chatKey)
      if (record.sessionId !== undefined && (previous === undefined || record.at >= previous.at)) {
        this.candidates.set(chatKey, record)
      }
      return
    }
    if (record.op === 'unbind') {
      this.active.delete(key)
      this.suppressed.add(chatKey)
      return
    }
    if (record.sessionId === undefined) return
    if (record.state === 'replaced') {
      this.addHistory(record)
      return
    }
    this.active.set(key, record)
    this.suppressed.delete(chatKey)
    this.addHistory(record)
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8')
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const record = JSON.parse(line) as BindingRecord
          if (typeof record?.key === 'string' && typeof record?.chatId === 'string' && typeof record?.at === 'number') {
            this.apply({ ...record, botId: typeof record.botId === 'string' ? record.botId : this.botId })
          }
        } catch {
          // A torn tail is ignored; the next append repairs the journal.
        }
      }
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
          legacy.push({ botId: this.botId, op: 'bind', key, chatId, ...(threadId === '' ? {} : { threadId }), sessionId: value, source: 'manual', at: 0, state: 'active' })
          continue
        }
        if (value === null || typeof value !== 'object') continue
        const record = value as { sessionId?: unknown; source?: unknown; boundAt?: unknown }
        if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
        legacy.push({
          botId: this.botId, op: 'bind', key, chatId, ...(threadId === '' ? {} : { threadId }),
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
            botId: this.botId, op: 'bind', key: chatId, chatId, sessionId: record.sessionId,
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
          botId: this.botId, op: 'candidate', key: chatId, chatId, sessionId: record.sessionId,
          source: 'auto', at: typeof record.at === 'number' ? record.at : 0, state: 'candidate',
        })
      }
    }

    const suppressed = await this.readJson('suppressed-chats.json')
    // suppressed-chats.json is an array, handled separately.
    try {
      const list = JSON.parse(await readFile(join(this.legacyDir, 'suppressed-chats.json'), 'utf8')) as unknown
      if (Array.isArray(list)) {
        for (const chatId of list) {
          if (typeof chatId === 'string') legacy.push({ botId: this.botId, op: 'unbind', key: chatId, chatId, source: 'auto', at: 0, state: 'unbound' })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    void suppressed

    for (const record of legacy) this.apply(record)
    await mkdir(dirname(this.file), { recursive: true })
    const body = legacy.map(record => JSON.stringify(record)).join('\n')
    await writeFile(this.file, body === '' ? '' : `${body}\n`, 'utf8')
  }

  /** Active binding for one exact key. */
  get(key: string, botId = this.botId): BindingRecord | undefined {
    return this.active.get(slot(botId, key))
  }

  resolve(chatId: string, threadId: string, routing: 'chat' | 'thread', botId = this.botId): BindingResolution {
    const key = routing === 'thread' && threadId !== '' ? makeKey(chatId, threadId) : chatId
    const current = this.active.get(slot(botId, key))
    if (current?.sessionId !== undefined) {
      return current.source === 'manual' || current.source === 'external'
        ? { kind: 'explicit', sessionId: current.sessionId, source: current.source, at: current.at, key }
        : { kind: 'auto', sessionId: current.sessionId, source: current.source, at: current.at, key }
    }
    if (this.suppressed.has(slot(botId, chatId))) return { kind: 'unbound', key }
    const candidate = this.candidates.get(slot(botId, chatId))
    if (candidate?.sessionId !== undefined) {
      return { kind: 'candidate', sessionId: candidate.sessionId, source: 'auto', at: candidate.at, key }
    }
    return { kind: 'none', key }
  }

  entries(): Array<[string, BindingRecord]> {
    return [...this.active.values()].map(record => [record.key, record])
  }

  listByChat(chatId: string, includeCandidates = false, botId = this.botId): BindingRecord[] {
    const chatKey = slot(botId, chatId)
    const records = [...(this.historyByChat.get(chatKey) ?? [])]
    if (includeCandidates) {
      const candidate = this.candidates.get(chatKey)
      if (candidate?.sessionId !== undefined && !records.some(item => item.sessionId === candidate.sessionId && item.at === candidate.at)) {
        records.push(candidate)
        records.sort((left, right) => right.at - left.at)
      }
    }
    return records
  }

  isSuppressed(chatId: string, botId = this.botId): boolean {
    return this.suppressed.has(slot(botId, chatId))
  }

  candidateFor(chatId: string, botId = this.botId): BindingRecord | undefined {
    return this.candidates.get(slot(botId, chatId))
  }

  private async append(record: BindingRecord): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
  }

  async bind(chatId: string, threadId: string, sessionId: string, source: BindingSource, at = Date.now(), botId = this.botId): Promise<BindingRecord> {
    const key = makeKey(chatId, threadId)
    const record: BindingRecord = {
      botId, op: 'bind', key, chatId, ...(threadId === '' ? {} : { threadId }), sessionId, source, at, state: 'active',
    }
    this.apply(record)
    await this.append(record)
    return record
  }

  async unbind(chatId: string, threadId: string, at = Date.now(), botId = this.botId): Promise<void> {
    const key = makeKey(chatId, threadId)
    const record: BindingRecord = { botId, op: 'unbind', key, chatId, ...(threadId === '' ? {} : { threadId }), source: 'auto', at, state: 'unbound' }
    this.apply(record)
    await this.append(record)
    this.active.delete(slot(botId, key))
  }

  async recordCandidate(chatId: string, sessionId: string, at = Date.now(), botId = this.botId): Promise<void> {
    const record: BindingRecord = { botId, op: 'candidate', key: chatId, chatId, sessionId, source: 'auto', at, state: 'candidate' }
    this.apply(record)
    await this.append(record)
  }

  async clearSuppression(chatId: string, botId = this.botId): Promise<void> {
    this.suppressed.delete(slot(botId, chatId))
  }

}

/** One bot's view over the shared journal. */
export class BotBindings {
  constructor(
    private readonly registry: BindingRegistry,
    readonly botId: string,
  ) {}

  get ready(): Promise<void> {
    return this.registry.ready
  }

  get(key: string): BindingRecord | undefined {
    return this.registry.get(key, this.botId)
  }

  resolve(chatId: string, threadId: string, routing: 'chat' | 'thread'): BindingResolution {
    return this.registry.resolve(chatId, threadId, routing, this.botId)
  }

  entries(): Array<[string, BindingRecord]> {
    return this.registry.entries().filter(([, record]) => record.botId === this.botId)
  }

  listByChat(chatId: string, includeCandidates = false): BindingRecord[] {
    return this.registry.listByChat(chatId, includeCandidates, this.botId)
  }

  candidateFor(chatId: string): BindingRecord | undefined {
    return this.registry.candidateFor(chatId, this.botId)
  }

  isSuppressed(chatId: string): boolean {
    return this.registry.isSuppressed(chatId, this.botId)
  }

  bind(chatId: string, threadId: string, sessionId: string, source: BindingSource, at = Date.now()): Promise<BindingRecord> {
    return this.registry.bind(chatId, threadId, sessionId, source, at, this.botId)
  }

  unbind(chatId: string, threadId: string, at = Date.now()): Promise<void> {
    return this.registry.unbind(chatId, threadId, at, this.botId)
  }

  recordCandidate(chatId: string, sessionId: string, at = Date.now()): Promise<void> {
    return this.registry.recordCandidate(chatId, sessionId, at, this.botId)
  }
}
