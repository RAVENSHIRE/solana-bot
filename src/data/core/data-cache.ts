/** Bounded cache: errors/stale values are never substituted for fresh observations. */
export class DataCache {
  private readonly values = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  hits = 0; misses = 0; shared = 0;
  constructor(private readonly capacity = 500, private readonly clock: () => number = Date.now) {}
  async get<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key);
    if (cached && this.clock() >= cached.at && this.clock() - cached.at < ttlMs) {
      this.hits++; this.values.delete(key); this.values.set(key, cached); return structuredClone(cached.value as T);
    }
    const pending = this.inflight.get(key);
    if (pending) { this.shared++; return structuredClone(await pending as T); }
    this.misses++; this.values.delete(key);
    const work = loader().then(value => {
      if (this.inflight.get(key) === work && ttlMs > 0) {
        this.values.set(key, { at: this.clock(), value: structuredClone(value) });
        while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
      }
      return value;
    }).finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key); });
    this.inflight.set(key, work);
    return structuredClone(await work);
  }
  invalidate(prefix = ''): void {
    for (const key of this.values.keys()) if (key.startsWith(prefix)) this.values.delete(key);
    for (const key of this.inflight.keys()) if (key.startsWith(prefix)) this.inflight.delete(key);
  }
  get size(): number { return this.values.size; }
}
