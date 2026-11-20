/**
 * Per-group binding history: every Session a group has pointed at, newest first.
 *
 * The authoritative `BindingStore` keeps only the active target per binding key.
 * This journal is display/history data for the Session info page: a rebind must
 * not erase the sessions a group used before, and unbinding keeps the history.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BindingSource } from './bindings.js'

export interface BindingHistoryEntry {
  sessionId: string
  at: number
  source: BindingSource
}

const MAX_PER_CHAT = 100

export class BindingHistoryStore {
  private readonly file: string
  private readonly map: Map<string, BindingHistoryEntry[]>
  readonly ready: Promise<void>

  constructor(dir: string) {
    this.file = join(dir, 'binding-history.json')
    this.map = new Map()
    this.ready = this.load()
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [chatId, value] of Object.entries(parsed)) {
        if (!Array.isArray(value)) continue
        const entries: BindingHistoryEntry[] = []
        for (const item of value) {
          if (item === null || typeof item !== 'object') continue
          const record = item as { sessionId?: unknown; at?: unknown; source?: unknown }
          if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
          entries.push({
            sessionId: record.sessionId,
            at: typeof record.at === 'number' ? record.at : 0,
            source: record.source === 'manual' || record.source === 'external' ? record.source : 'auto',
          })
        }
        entries.sort((left, right) => right.at - left.at)
        this.map.set(chatId, entries.slice(0, MAX_PER_CHAT))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  list(chatId: string): BindingHistoryEntry[] {
    return [...(this.map.get(chatId) ?? [])]
  }

  /** Insert or refresh one session, keeping the list newest-first. */
  async record(chatId: string, sessionId: string, at: number, source: BindingSource = 'auto'): Promise<void> {
    const entries = (this.map.get(chatId) ?? []).filter(entry => entry.sessionId !== sessionId)
    entries.push({ sessionId, at, source })
    entries.sort((left, right) => right.at - left.at)
    this.map.set(chatId, entries.slice(0, MAX_PER_CHAT))
    await this.flush()
  }

  async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(Object.fromEntries(this.map), null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
