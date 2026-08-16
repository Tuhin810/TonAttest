import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { apiKeyMatches, generateApiKey, seal, unseal } from "../src/crypto.js";
import { verificationIdempotencyKey } from "../src/idempotency.js";
import { MemoryRateLimiter } from "../src/ratelimit.js";
import { SingleFlight } from "../src/singleflight.js";
import { Metrics } from "../src/metrics.js";
import { MemoryCache } from "../src/cache.js";

const VALID_ENV = {
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost",
  MASTER_KEY: "a".repeat(64),
};

describe("config", () => {
  it("names every missing variable at once", () => {
    // One restart per missing variable is a miserable first-run experience.
    expect(() => loadConfig({})).toThrow(/DATABASE_URL, REDIS_URL, MASTER_KEY/);
  });

  it("rejects a master key of the wrong length, with the command to make one", () => {
    expect(() => loadConfig({ ...VALID_ENV, MASTER_KEY: "abc" })).toThrow(
      /openssl rand -hex 32/,
    );
  });

  it("applies documented defaults", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.port).toBe(8080);
    expect(config.activityTtlSeconds).toBe(60);
    expect(config.maxEventsPerWallet).toBe(1_000);
  });

  it("rejects a non-numeric override rather than falling back silently", () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: "eight thousand" })).toThrow(ConfigError);
  });

  it("treats an empty optional value as absent", () => {
    expect(loadConfig({ ...VALID_ENV, TONAPI_KEY: "" }).tonapiKey).toBeUndefined();
  });
});

describe("API keys", () => {
  it("verifies a correct key", () => {
    const key = generateApiKey();
    expect(apiKeyMatches(key.apiKey, key.salt, key.hash)).toBe(true);
  });

  it("rejects a wrong key", () => {
    const key = generateApiKey();
    expect(apiKeyMatches("sk_wrong", key.salt, key.hash)).toBe(false);
  });

  it("salts each key, so identical keys would not share a hash", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.salt).not.toBe(b.salt);
  });

  it("keeps a hint that identifies without revealing", () => {
    const key = generateApiKey();
    expect(key.hint).toContain("…");
    expect(key.hint.length).toBeLessThan(key.apiKey.length);
  });

  it("does not fall over on a malformed stored hash", () => {
    const key = generateApiKey();
    expect(apiKeyMatches(key.apiKey, key.salt, "aa")).toBe(false);
  });
});

describe("signing key encryption", () => {
  it("round-trips a private key", () => {
    const master = randomBytes(32);
    const secret = randomBytes(32);
    expect(unseal(seal(secret, master), master)).toEqual(new Uint8Array(secret));
  });

  it("refuses to decrypt with the wrong master key", () => {
    const secret = randomBytes(32);
    const sealed = seal(secret, randomBytes(32));
    expect(() => unseal(sealed, randomBytes(32))).toThrow();
  });

  it("detects a tampered ciphertext instead of yielding a wrong key", () => {
    // AES-GCM is authenticated; a subtly wrong signing key would be far worse
    // than a loud failure.
    const master = randomBytes(32);
    const sealed = seal(randomBytes(32), master);
    const flipped = {
      ...sealed,
      ciphertext: `${sealed.ciphertext.slice(0, -2)}${sealed.ciphertext.endsWith("00") ? "11" : "00"}`,
    };
    expect(() => unseal(flipped, master)).toThrow();
  });

  it("uses a fresh IV each time, so identical keys differ in ciphertext", () => {
    const master = randomBytes(32);
    const secret = randomBytes(32);
    expect(seal(secret, master).ciphertext).not.toBe(seal(secret, master).ciphertext);
  });
});

describe("idempotency keys", () => {
  const base = {
    projectId: "prj",
    campaignId: "cmp",
    wallet: "0:abc",
    ruleHash: "sha256:x",
    now: 1_000,
    bucketSeconds: 60,
  };

  it("is stable inside a bucket", () => {
    // 1000 and 1010 both fall in bucket 16 (floor(t / 60)).
    expect(verificationIdempotencyKey(base)).toBe(
      verificationIdempotencyKey({ ...base, now: 1_010 }),
    );
  });

  it("changes across buckets, so a later claim re-verifies", () => {
    expect(verificationIdempotencyKey(base)).not.toBe(
      verificationIdempotencyKey({ ...base, now: 1_200 }),
    );
  });

  it("changes when the rule changes", () => {
    // Editing a campaign's rule must not reuse a verification made under the
    // old one.
    expect(verificationIdempotencyKey(base)).not.toBe(
      verificationIdempotencyKey({ ...base, ruleHash: "sha256:y" }),
    );
  });

  it.each(["projectId", "campaignId", "wallet"] as const)(
    "changes when %s changes",
    (field) => {
      expect(verificationIdempotencyKey(base)).not.toBe(
        verificationIdempotencyKey({ ...base, [field]: "different" }),
      );
    },
  );
});

describe("single flight", () => {
  it("runs one task for concurrent callers on the same key", async () => {
    const flight = new SingleFlight<number>();
    let runs = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        flight.run("k", async () => {
          runs++;
          await new Promise((r) => setTimeout(r, 5));
          return 42;
        }),
      ),
    );

    expect(runs).toBe(1);
    expect(results).toEqual(Array(10).fill(42));
  });

  it("keeps different keys independent", async () => {
    const flight = new SingleFlight<string>();
    const [a, b] = await Promise.all([
      flight.run("a", async () => "a"),
      flight.run("b", async () => "b"),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
  });

  it("releases the key after a failure, so a retry is not poisoned", async () => {
    const flight = new SingleFlight<string>();
    await expect(
      flight.run("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(flight.run("k", async () => "ok")).resolves.toBe("ok");
    expect(flight.size).toBe(0);
  });
});

describe("rate limiting", () => {
  it("allows a burst then refuses", async () => {
    const limiter = new MemoryRateLimiter({ burst: 3, perSecond: 1 });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume("k", 0));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it("refills over time", async () => {
    const limiter = new MemoryRateLimiter({ burst: 1, perSecond: 1 });
    expect((await limiter.consume("k", 0)).allowed).toBe(true);
    expect((await limiter.consume("k", 0)).allowed).toBe(false);
    expect((await limiter.consume("k", 1_000)).allowed).toBe(true);
  });

  it("never refills past the burst ceiling", async () => {
    const limiter = new MemoryRateLimiter({ burst: 2, perSecond: 1 });
    await limiter.consume("k", 0);
    await limiter.consume("k", 1_000_000);
    expect((await limiter.consume("k", 1_000_000)).allowed).toBe(true);
    expect((await limiter.consume("k", 1_000_000)).allowed).toBe(false);
  });

  it("keeps projects independent", async () => {
    const limiter = new MemoryRateLimiter({ burst: 1, perSecond: 1 });
    await limiter.consume("a", 0);
    expect((await limiter.consume("b", 0)).allowed).toBe(true);
  });

  it("suggests when to retry", async () => {
    const limiter = new MemoryRateLimiter({ burst: 1, perSecond: 1 });
    await limiter.consume("k", 0);
    expect((await limiter.consume("k", 0)).retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("cache", () => {
  it("sets a key only once within its TTL", async () => {
    let now = 0;
    const cache = new MemoryCache(() => now);
    expect(await cache.setIfAbsent("k", 60)).toBe(true);
    expect(await cache.setIfAbsent("k", 60)).toBe(false);
  });

  it("expires a key once its TTL passes", async () => {
    let now = 0;
    const cache = new MemoryCache(() => now);
    await cache.setIfAbsent("k", 60);
    now = 61_000;
    expect(await cache.has("k")).toBe(false);
  });
});

describe("metrics", () => {
  it("renders counters with labels", () => {
    const metrics = new Metrics();
    metrics.increment("reqs", { status: "200" });
    metrics.increment("reqs", { status: "200" });
    expect(metrics.render()).toContain('reqs{status="200"} 2');
  });

  it("renders quantiles, sum and count for a histogram", () => {
    const metrics = new Metrics();
    for (const value of [1, 2, 3, 4]) metrics.observe("latency", value);
    const output = metrics.render();
    expect(output).toContain('latency{quantile="0.95"}');
    expect(output).toContain("latency_sum 10");
    expect(output).toContain("latency_count 4");
  });

  it("computes the p95 that will actually be asked about", () => {
    const metrics = new Metrics();
    for (let i = 1; i <= 100; i++) metrics.observe("latency", i);
    expect(metrics.quantile("latency", 0.95)).toBe(96);
  });

  it("bounds sample retention so a long-lived process cannot grow forever", () => {
    const metrics = new Metrics();
    for (let i = 0; i < 12_000; i++) metrics.observe("latency", i);
    expect(metrics.render()).toContain("latency_count 10000");
  });

  it("escapes label values", () => {
    const metrics = new Metrics();
    metrics.increment("m", { path: 'a"b' });
    expect(metrics.render()).toContain('path="a\\"b"');
  });
});
