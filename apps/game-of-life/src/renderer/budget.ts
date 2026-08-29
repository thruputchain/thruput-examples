export const DEFAULT_CPU_BUDGET = 64 * 1024 * 1024;
export const DEFAULT_GPU_BUDGET = 64 * 1024 * 1024;
export const SHARED_CPU_CACHE_BUDGET = DEFAULT_CPU_BUDGET / 2;
export const DECK_LAYER_CACHE_BUDGET = DEFAULT_CPU_BUDGET / 4;

export class ByteBudget<T> {
  private readonly entries = new Map<
    string,
    { value: T; bytes: number; finalize?: () => void }
  >();
  private used = 0;
  private readonly pinned = new Set<string>();
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("budget must be positive");
  }
  get byteLength(): number {
    return this.used;
  }
  get size(): number {
    return this.entries.size;
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number, finalize?: () => void): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit)
      throw new RangeError("resource exceeds budget");
    this.delete(key, true);
    this.entries.set(key, { value, bytes, ...(finalize ? { finalize } : {}) });
    this.used += bytes;
    while (this.used > this.limit) {
      const oldest = [...this.entries.keys()].find(
        (candidate) => !this.pinned.has(candidate),
      );
      if (oldest === undefined) {
        this.delete(key, true);
        throw new RangeError("pinned resources exceed budget");
      }
      this.delete(oldest);
    }
  }
  pin(key: string): void {
    this.pinned.add(key);
  }
  unpin(key: string): void {
    this.pinned.delete(key);
  }
  delete(key: string, force = false): boolean {
    if (!force && this.pinned.has(key)) return false;
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.used -= entry.bytes;
    entry.finalize?.();
    return true;
  }
  clear(): void {
    this.pinned.clear();
    for (const key of [...this.entries.keys()]) this.delete(key, true);
  }
  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()])
      if (key.startsWith(prefix)) this.delete(key, true);
  }
}

/** Tracks live GPU allocations without ever destroying resources still owned by layers. */
export class ActiveByteBudget {
  private used = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("budget must be positive");
  }
  get byteLength(): number {
    return this.used;
  }
  reserve(bytes: number): () => void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.limit - this.used
    )
      throw new RangeError("active GPU resources exceed budget");
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= bytes;
    };
  }
}
