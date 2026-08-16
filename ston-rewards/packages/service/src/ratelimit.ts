/**
 * Per-project token bucket.
 *
 * A bucket rather than a fixed window: an integrator with a bursty claim
 * screen should not be punished for a legitimate spike, while sustained abuse
 * still converges on the refill rate.
 */
export interface RateLimiter {
  /** Consumes one token. Returns whether the request may proceed. */
  consume(key: string, now?: number): Promise<RateLimitResult>;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface TokenBucketOptions {
  readonly burst: number;
  readonly perSecond: number;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

export class MemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, BucketState>();
  readonly #options: TokenBucketOptions;

  constructor(options: TokenBucketOptions) {
    this.#options = options;
  }

  async consume(key: string, now = Date.now()): Promise<RateLimitResult> {
    const { burst, perSecond } = this.#options;
    const bucket = this.#buckets.get(key) ?? { tokens: burst, updatedAt: now };

    const elapsed = Math.max(0, now - bucket.updatedAt) / 1_000;
    const tokens = Math.min(burst, bucket.tokens + elapsed * perSecond);

    if (tokens < 1) {
      this.#buckets.set(key, { tokens, updatedAt: now });
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / perSecond)),
      };
    }

    this.#buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return { allowed: true, remaining: Math.floor(tokens - 1), retryAfterSeconds: 0 };
  }
}
