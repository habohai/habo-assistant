/**
 * Durable message de-duplication.
 *
 * Feishu re-delivers an event when we never acknowledged it, and the host may
 * restart while a turn was in flight. Remembering accepted message ids across
 * restarts is what stops the bot from answering the same question twice.
 *
 * Memory is the authoritative hot path (Map insert/contains). Disk is an
 * append-only JSONL journal written off the hot path; it is compacted on load
 * whenever the file no longer matches memory.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX = 5000

export interface SeenOptions {
  ttlMs?: number
  max?: number
  logger?: { warn: (message: string) => void }
}

export class SeenStore {
  private readonly file: string
  private readonly ttlMs: number
  private readonly max: number
  private readonly logger: SeenOptions['logger']
  /** message id -> accepted-at, oldest first. */
  readonly map: Map<string, number>
  private writes: Promise<void>
  private appended: number

  /** @param file JSONL path. */
  constructor(file: string, { ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX, logger }: SeenOptions = {}) {
    this.file = file
    this.ttlMs = ttlMs
    this.max = max
    this.logger = logger
    this.map = new Map()
    this.writes = Promise.resolve()
    this.appended = 0
  }

  get size(): number {
    return this.map.size
  }

  /** Read the journal back into memory (missing file = first run). */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`cannot read ${this.file}: ${String(error)}`)
      return
    }
    const records: Array<{ id: string; at: number }> = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (typeof parsed?.id === 'string' && parsed.id !== '' && Number.isFinite(parsed.at)) {
          records.push({ id: parsed.id, at: parsed.at })
        }
      } catch {
        // A line torn by a crash mid-append: skip it, the id is simply unknown.
      }
    }
    records.sort((left, right) => left.at - right.at)
    const now = Date.now()
    for (const record of records) {
      if (now - record.at > this.ttlMs) continue
      this.map.delete(record.id)
      this.map.set(record.id, record.at)
    }
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
    if (records.length !== this.map.size) {
      await this.flush().catch(error => this.warn(`cannot compact ${this.file}: ${String(error)}`))
    }
  }

  /** True when this id was already accepted (no side effects). */
  has(id: string): boolean {
    return this.map.has(id)
  }

  /**
   * Record `id` as accepted.
   * @returns {boolean} false when it was already present (a duplicate).
   */
  claim(id: string): boolean {
    const now = Date.now()
    this.prune(now)
    if (this.map.has(id)) return false
    this.map.set(id, now)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
    this.append(id, now)
    this.appended += 1
    if (this.appended >= this.max) {
      this.appended = 0
      this.writes = this.writes
        .then(() => this.rewrite())
        .catch(error => this.warn(`cannot compact ${this.file}: ${String(error)}`))
    }
    return true
  }

  /** Rewrite the journal atomically from memory. */
  async flush(): Promise<void> {
    await this.writes
    await this.rewrite()
  }

  private async rewrite(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const body = [...this.map].map(([id, at]) => JSON.stringify({ id, at })).join('\n')
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, body === '' ? '' : `${body}\n`, 'utf8')
    await rename(temp, this.file)
  }

  /** Wait for queued appends to hit disk. */
  async dispose(): Promise<void> {
    await this.writes
  }

  /** Drop expired ids from the front of the insertion-ordered map. */
  prune(now: number): void {
    for (const [id, at] of this.map) {
      if (now - at <= this.ttlMs) break
      this.map.delete(id)
    }
  }

  append(id: string, at: number): void {
    this.writes = this.writes
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        await appendFile(this.file, `${JSON.stringify({ id, at })}\n`, 'utf8')
      })
      .catch(error => this.warn(`cannot append to ${this.file}: ${String(error)}`))
  }

  warn(message: string): void {
    this.logger?.warn(`feishu-bot: ${message}`)
  }
}
