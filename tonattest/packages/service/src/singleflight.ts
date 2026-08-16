/**
 * Collapses concurrent work on the same key into a single execution.
 *
 * Without this, fifty users tapping "claim" on the same campaign at the same
 * moment produce fifty identical upstream fetches — which is how a service
 * gets itself rate-limited by its own data provider under exactly the load it
 * most needs to survive.
 *
 * In-process only. It is paired with a Redis lock for the multi-instance case;
 * see `cache.ts`.
 */
export class SingleFlight<T> {
  readonly #inflight = new Map<string, Promise<T>>();

  async run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.#inflight.get(key);
    if (existing) return existing;

    // The entry is registered before awaiting, so a caller arriving in the
    // same tick still joins rather than starting a second run.
    const promise = task().finally(() => {
      this.#inflight.delete(key);
    });

    this.#inflight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.#inflight.size;
  }
}
