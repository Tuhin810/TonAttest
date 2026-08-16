/**
 * Freshness markers and cross-instance locks.
 *
 * Kept behind an interface so the whole verification path can be tested
 * without Redis, and so a single-instance deployment can run without it.
 */
export interface Cache {
  /** Returns true if the key was set, false if it already existed. */
  setIfAbsent(key: string, ttlSeconds: number): Promise<boolean>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class MemoryCache implements Cache {
  readonly #entries = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    if (await this.has(key)) return false;
    this.#entries.set(key, this.#now() + ttlSeconds * 1_000);
    return true;
  }

  async has(key: string): Promise<boolean> {
    const expiry = this.#entries.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.#now()) {
      this.#entries.delete(key);
      return false;
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
