/**
 * Admission control for agent work.
 *
 * Two independent budgets keep a busy group from taking the host down while
 * still admitting parallel work across groups:
 *
 * - `Semaphore` bounds how many jobs run at once across every chat.
 * - `KeyedQueue` keeps one FIFO queue per binding key (so a chat's questions
 *   stay in order) and rejects a burst beyond `maxQueue` waiting jobs instead
 *   of letting it grow without bound.
 *
 * Nothing here awaits inside `push`, so a slow agent never blocks event
 * consumption; that is the latency/throughput split this plugin depends on.
 */

export class Semaphore {
  readonly limit: number
  active: number
  private waiters: Array<() => void>

  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error('Semaphore limit must be >= 1')
    this.limit = Math.floor(limit)
    this.active = 0
    this.waiters = []
  }

  get pending(): number {
    return this.waiters.length
  }

  /** @returns {Promise<void>} resolves once a slot is held. */
  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiters.push(resolve)
    })
  }

  /** Release a slot, handing it straight to the oldest waiter when present. */
  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    if (this.active > 0) this.active -= 1
  }
}

export interface KeyedQueueOptions<T> {
  maxConcurrent?: number
  maxQueue?: number
  run: (key: string, job: T) => Promise<void>
  onError?: (key: string, error: unknown) => void
}

interface KeyedQueueState<T> {
  running: boolean
  items: T[]
}

export class KeyedQueue<T = unknown> {
  private readonly semaphore: Semaphore
  private readonly maxQueue: number
  private readonly run: (key: string, job: T) => Promise<void>
  private readonly onError?: (key: string, error: unknown) => void
  private readonly queues: Map<string, KeyedQueueState<T>>
  private closed: boolean
  private idleWaiters: Array<() => void>

  constructor({ maxConcurrent = 4, maxQueue = 20, run, onError }: KeyedQueueOptions<T> = {} as KeyedQueueOptions<T>) {
    if (typeof run !== 'function') throw new TypeError('KeyedQueue needs a run(key, job) callback')
    this.semaphore = new Semaphore(maxConcurrent)
    this.maxQueue = maxQueue
    this.run = run
    this.onError = onError
    this.queues = new Map()
    this.closed = false
    this.idleWaiters = []
  }

  /**
   * Queue one job behind the others for the same key.
   * @returns false when this key already has `maxQueue` waiting jobs.
   */
  push(key: string, job: T): boolean {
    if (this.closed) return false
    let queue = this.queues.get(key)
    if (queue === undefined) {
      queue = { running: false, items: [] }
      this.queues.set(key, queue)
    }
    if (queue.items.length >= this.maxQueue) return false
    queue.items.push(job)
    this.pump(key)
    return true
  }

  /** Drop every waiting job for one key; the running job is untouched. */
  clear(key: string): number {
    const queue = this.queues.get(key)
    if (queue === undefined) return 0
    const dropped = queue.items.length
    queue.items.length = 0
    if (!queue.running) this.queues.delete(key)
    this.settle()
    return dropped
  }

  /** Start the next job for `key` as soon as a global slot is free. */
  pump(key: string): void {
    const queue = this.queues.get(key)
    if (queue === undefined || queue.running || this.closed) {
      this.settle()
      return
    }
    const job = queue.items.shift()
    if (job === undefined) {
      this.queues.delete(key)
      this.settle()
      return
    }
    queue.running = true
    void this.semaphore.acquire().then(async () => {
      try {
        await this.run(key, job)
      } catch (error) {
        this.onError?.(key, error)
      } finally {
        queue.running = false
        this.semaphore.release()
        if (this.closed) this.queues.delete(key)
        else this.pump(key)
        this.settle()
      }
    })
  }

  /** Depth of every queue plus the concurrency budget, for logs and `/status`. */
  stats(): { keys: number; running: number; queued: number; active: number; waiting: number } {
    let queued = 0
    let running = 0
    for (const queue of this.queues.values()) {
      running += queue.running ? 1 : 0
      queued += queue.items.length
    }
    return {
      keys: this.queues.size,
      running,
      queued,
      active: this.semaphore.active,
      waiting: this.semaphore.pending,
    }
  }

  isIdle(): boolean {
    if (this.semaphore.active > 0 || this.semaphore.pending > 0) return false
    for (const queue of this.queues.values()) {
      if (queue.running || queue.items.length > 0) return false
    }
    return true
  }

  /** @returns {Promise<void>} resolves when no job is running and every queue is empty. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise(resolve => {
      this.idleWaiters.push(resolve)
    })
  }

  /** Refuse new work and drop what is still waiting (dispose path). */
  close(): void {
    this.closed = true
    for (const queue of this.queues.values()) queue.items.length = 0
    this.settle()
  }

  settle(): void {
    if (this.idleWaiters.length === 0 || !this.isIdle()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}
