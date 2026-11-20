/**
 * Small JSON-file binding store: `(chat | chat::thread) -> sessionId`.
 *
 * A record keeps where it came from: an explicit/manual binding is
 * authoritative, while an auto binding may be replaced by discovery. Legacy
 * string values load as `auto` so upgrades do not freeze old state.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type BindingSource = 'external' | 'manual' | 'auto'

export interface BindingMeta {
  source: BindingSource
  boundAt: number
}

export class BindingStore {
  private readonly file: string
  /** key -> active session id. */
  readonly map: Map<string, string>
  /** key -> source / bound time. */
  private readonly meta: Map<string, BindingMeta>
  readonly ready: Promise<void>

  /** @param dir directory holding `bindings.json`. */
  constructor(dir: string) {
    this.file = join(dir, 'bindings.json')
    this.map = new Map()
    this.meta = new Map()
    this.ready = this.load()
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value !== '') {
          // Legacy records predate sources; the user treats them as explicit.
          this.map.set(key, value)
          this.meta.set(key, { source: 'manual', boundAt: 0 })
          continue
        }
        if (value === null || typeof value !== 'object') continue
        const record = value as { sessionId?: unknown; source?: unknown; boundAt?: unknown }
        if (typeof record.sessionId !== 'string' || record.sessionId === '') continue
        this.map.set(key, record.sessionId)
        this.meta.set(key, {
          source: record.source === 'manual' || record.source === 'external' ? record.source : 'auto',
          boundAt: typeof record.boundAt === 'number' ? record.boundAt : 0,
        })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  get(key: string): string | undefined {
    return this.map.get(key)
  }

  source(key: string): BindingSource {
    return this.meta.get(key)?.source ?? 'auto'
  }

  boundAt(key: string): number {
    return this.meta.get(key)?.boundAt ?? 0
  }

  /** Whether this binding is explicit and must never be replaced automatically. */
  isExplicit(key: string): boolean {
    const source = this.source(key)
    return source === 'manual' || source === 'external'
  }

  /** Every `key -> sessionId` pair, for rebuilding session ownership at start. */
  entries(): Array<[string, string]> {
    return [...this.map.entries()]
  }

  async set(key: string, sessionId: string, source: BindingSource = 'auto', boundAt = Date.now()): Promise<void> {
    this.map.set(key, sessionId)
    this.meta.set(key, { source, boundAt })
    await this.flush()
  }

  async delete(key: string): Promise<void> {
    if (this.map.delete(key)) {
      this.meta.delete(key)
      await this.flush()
    }
  }

  async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const records: Record<string, { sessionId: string; source: BindingSource; boundAt: number }> = {}
    for (const [key, sessionId] of this.map) {
      records[key] = {
        sessionId,
        source: this.source(key),
        boundAt: this.boundAt(key),
      }
    }
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(records, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
