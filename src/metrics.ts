/**
 * In-process counters and latency samples.
 *
 * Deliberately tiny: no timers, no export pipeline. The bot logs a snapshot on
 * an interval, which is enough to answer "is the bot keeping up?" — ingress
 * rate, queue depth, first-feedback latency, and total turn latency.
 */

/**
 * Nearest-rank percentile over an ascending list.
 * @param {number[]} values already sorted ascending
 * @param {number} p 0-100
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const rank = Math.ceil((p / 100) * values.length) - 1
  return values[Math.min(Math.max(rank, 0), values.length - 1)] ?? 0
}

export interface TimingSummary {
  count: number
  p50: number
  p95: number
  max: number
}

export interface MetricsSnapshot {
  counts: Record<string, number>
  timings: Record<string, TimingSummary>
}

export class Metrics {
  private readonly windowSize: number
  private readonly counts: Map<string, number>
  private readonly samples: Map<string, number[]>

  constructor({ windowSize = 200 }: { windowSize?: number } = {}) {
    this.windowSize = windowSize
    this.counts = new Map()
    this.samples = new Map()
  }

  inc(name: string, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by)
  }

  /** Record one latency sample in milliseconds. */
  observe(name: string, value: number): void {
    if (!Number.isFinite(value) || value < 0) return
    let samples = this.samples.get(name)
    if (samples === undefined) {
      samples = []
      this.samples.set(name, samples)
    }
    samples.push(value)
    if (samples.length > this.windowSize) samples.shift()
  }

  snapshot(): MetricsSnapshot {
    const counts = Object.fromEntries(this.counts)
    const timings: Record<string, TimingSummary> = {}
    for (const [name, samples] of this.samples) {
      const sorted = [...samples].sort((left, right) => left - right)
      timings[name] = {
        count: sorted.length,
        p50: Math.round(percentile(sorted, 50)),
        p95: Math.round(percentile(sorted, 95)),
        max: Math.round(sorted[sorted.length - 1] ?? 0),
      }
    }
    return { counts, timings }
  }

  /** True when nothing has been recorded since the previous call. */
  isEmpty(): boolean {
    return this.counts.size === 0 && this.samples.size === 0
  }
}
