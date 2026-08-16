import { Redis } from "ioredis";
import type { Cache } from "./cache.js";
import type { RateLimitResult, RateLimiter, TokenBucketOptions } from "./ratelimit.js";

/**
 * Redis-backed cache and rate limiter.
 *
 * Both are used for coordination, never as a source of truth: an outage
 * degrades throughput and duplicate work, but cannot change an eligibility
 * answer. That is deliberate — the durable record lives in Postgres, so Redis
 * being unavailable must never be able to produce a wrong attestation.
 */
export class RedisCache implements Cache {
  readonly #redis: Redis;

  constructor(url: string) {
    this.#redis = new Redis(url, {
      maxRetriesPerRequest: 2,
      // Fail fast; the caller degrades rather than hangs.
      connectTimeout: 5_000,
      lazyConnect: false,
    });
    // Without a handler an ECONNRESET on an idle connection crashes the process.
    this.#redis.on("error", () => {});
  }

  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.#redis.set(key, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async has(key: string): Promise<boolean> {
    return (await this.#redis.exists(key)) === 1;
  }

  async delete(key: string): Promise<void> {
    await this.#redis.del(key);
  }

  async ping(): Promise<void> {
    await this.#redis.ping();
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}

/**
 * Token bucket in Redis, evaluated inside a Lua script so the read, refill,
 * and write happen atomically. Doing it in three round trips would let two
 * instances both see the last token.
 */
const BUCKET_SCRIPT = `
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local per_second = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local state = redis.call('HMGET', key, 'tokens', 'updated_at')
local tokens = tonumber(state[1])
local updated_at = tonumber(state[2])

if tokens == nil then
  tokens = burst
  updated_at = now
end

local elapsed = math.max(0, now - updated_at) / 1000
tokens = math.min(burst, tokens + elapsed * per_second)

local allowed = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
end

redis.call('HMSET', key, 'tokens', tokens, 'updated_at', now)
redis.call('EXPIRE', key, math.ceil(burst / per_second) + 60)

return { allowed, math.floor(tokens) }
`;

export class RedisRateLimiter implements RateLimiter {
  readonly #redis: Redis;
  readonly #options: TokenBucketOptions;

  constructor(url: string, options: TokenBucketOptions) {
    this.#redis = new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 5_000 });
    this.#redis.on("error", () => {});
    this.#options = options;
  }

  async consume(key: string, now = Date.now()): Promise<RateLimitResult> {
    const { burst, perSecond } = this.#options;
    try {
      const [allowed, remaining] = (await this.#redis.eval(
        BUCKET_SCRIPT,
        1,
        key,
        String(burst),
        String(perSecond),
        String(now),
      )) as [number, number];

      return {
        allowed: allowed === 1,
        remaining,
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, Math.ceil(1 / perSecond)),
      };
    } catch {
      // Fail open on a rate-limiter outage. Rate limiting protects capacity,
      // not correctness — refusing every request because Redis blinked would
      // turn a throughput safeguard into an outage of its own.
      return { allowed: true, remaining: burst, retryAfterSeconds: 0 };
    }
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
