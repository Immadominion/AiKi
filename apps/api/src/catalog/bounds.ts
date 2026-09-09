import { CatalogError } from './types.js'

/** Process-local bounds, deliberately conservative for anonymous upstream access. */
export class WindowBudget {
  private readonly entries = new Map<string, { count: number; until: number }>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 2048,
    private readonly now = Date.now,
  ) {}

  take(key: string): void {
    const now = this.now()
    let item = this.entries.get(key)
    if (!item || item.until <= now) {
      if (this.entries.size >= this.maxKeys) {
        for (const [k, entry] of this.entries) {
          if (entry.until <= now) this.entries.delete(k)
        }
        // Refuse, rather than evicting an active identity and resetting its budget.
        if (this.entries.size >= this.maxKeys && !item) {
          throw new CatalogError(429, 'CATALOG_BUSY', 'Please try again shortly.', 60)
        }
      }
      item = { count: 0, until: now + this.windowMs }
      this.entries.set(key, item)
    }
    if (item.count >= this.limit) {
      throw new CatalogError(
        429,
        'CATALOG_RATE_LIMIT',
        'Please wait before making another request.',
        Math.max(1, Math.ceil((item.until - now) / 1000)),
      )
    }
    item.count++
  }
}

export class BoundedCache<T> {
  private readonly entries = new Map<string, { value: T; until: number; weight: number }>()
  private readonly pending = new Map<string, Promise<T>>()
  private totalWeight = 0
  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
    private readonly now = Date.now,
    private readonly measure: (value: T) => number = () => 1,
    private readonly maxWeight = capacity,
  ) {}

  private remove(key: string): void {
    this.totalWeight -= this.entries.get(key)?.weight ?? 0
    this.entries.delete(key)
  }

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key)
    if (hit && hit.until > this.now()) return hit.value
    this.remove(key)
    const inflight = this.pending.get(key)
    if (inflight) return inflight
    if (this.pending.size >= 8) {
      throw new CatalogError(503, 'CATALOG_BUSY', 'The catalog is busy. Try again shortly.', 5)
    }
    const promise = load().then((value) => {
      const weight = Math.max(1, this.measure(value))
      if (weight > this.maxWeight) return value
      while (this.entries.size >= this.capacity || this.totalWeight + weight > this.maxWeight) {
        const first = this.entries.keys().next().value
        if (first !== undefined) this.remove(first)
        else break
      }
      this.entries.set(key, { value, until: this.now() + this.ttlMs, weight })
      this.totalWeight += weight
      return value
    })
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      this.pending.delete(key)
    }
  }
}
