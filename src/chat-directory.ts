/**
 * Chat admission for the bot: the static profile allowlist plus groups enabled
 * at runtime. Runtime enables migrate from the old `dynamic-chats.json` into a
 * small `chats.json`; names/membership still come from the live Lark directory.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface ChatEntry {
  allowedAt: number
}

export class ChatDirectory {
  private readonly file: string
  private readonly legacyFile: string
  private readonly runtime: Map<string, ChatEntry>
  readonly ready: Promise<void>

  constructor(dir: string) {
    this.file = join(dir, 'chats.json')
    this.legacyFile = join(dir, 'dynamic-chats.json')
    this.runtime = new Map()
    this.ready = this.load()
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [chatId, value] of Object.entries(parsed)) {
          if (!chatId.startsWith('oc_')) continue
          const record = value as { allowedAt?: unknown }
          this.runtime.set(chatId, { allowedAt: typeof record.allowedAt === 'number' ? record.allowedAt : 0 })
        }
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      const legacy = JSON.parse(await readFile(this.legacyFile, 'utf8')) as unknown
      if (Array.isArray(legacy)) {
        for (const chatId of legacy) {
          if (typeof chatId === 'string' && chatId.startsWith('oc_')) this.runtime.set(chatId, { allowedAt: 0 })
        }
        await this.flush()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(Object.fromEntries(this.runtime), null, 2), 'utf8')
    await rename(temp, this.file)
  }

  /** Profile `allowChats` is checked by the caller; this covers runtime enables. */
  isAllowed(chatId: string): boolean {
    return this.runtime.has(chatId)
  }

  async allow(chatId: string, at = Date.now()): Promise<void> {
    this.runtime.set(chatId, { allowedAt: at })
    await this.flush()
  }

  get size(): number {
    return this.runtime.size
  }

  entries(): Array<[string, number]> {
    return [...this.runtime].map(([chatId, entry]) => [chatId, entry.allowedAt])
  }
}
