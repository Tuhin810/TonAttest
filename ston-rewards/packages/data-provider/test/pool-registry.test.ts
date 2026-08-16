import { describe, expect, it, vi } from "vitest";
import { PoolRegistry, parsePoolsResponse } from "../src/pool-registry.js";

const NO_RETRY = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

const POOL_ADDRESS = `0:${"11".repeat(32)}`;
const ROUTER_ADDRESS = `0:${"33".repeat(32)}`;

const POOL = {
  address: POOL_ADDRESS,
  token0_address: `0:${"aa".repeat(32)}`,
  token1_address: `0:${"bb".repeat(32)}`,
  router_address: ROUTER_ADDRESS,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("parsePoolsResponse", () => {
  it("indexes pools and collects their routers", () => {
    const snapshot = parsePoolsResponse({ pool_list: [POOL] }, 1_000);
    expect(snapshot.pools.get(POOL_ADDRESS)).toMatchObject({ token0: `0:${"aa".repeat(32)}` });
    expect(snapshot.routers.has(ROUTER_ADDRESS)).toBe(true);
    expect(snapshot.fetchedAt).toBe(1_000);
  });

  it("accepts a bare array as well as { pool_list }", () => {
    expect(parsePoolsResponse([POOL], 0).pools.size).toBe(1);
  });

  it("carries extra routers through, for testnet or a new deployment", () => {
    const custom = `0:${"cc".repeat(32)}`;
    const snapshot = parsePoolsResponse([POOL], 0, [custom]);
    expect(snapshot.routers.has(custom)).toBe(true);
  });

  it("skips entries missing an address or a token, but keeps the rest", () => {
    const snapshot = parsePoolsResponse([POOL, { address: `0:${"dd".repeat(32)}` }], 0);
    expect(snapshot.pools.size).toBe(1);
  });

  it("indexes a user-friendly pool address in canonical raw form", () => {
    // STON.fi publishes base64 addresses; chain events carry raw ones. Both
    // must land on the same key or no pool lookup ever hits.
    const snapshot = parsePoolsResponse(
      [{ ...POOL, address: "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt" }],
      0,
    );
    expect(
      snapshot.pools.has("0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e"),
    ).toBe(true);
  });

  it("rejects a response that decodes to zero pools", () => {
    // An empty registry would make every event look like it is not STON.fi's,
    // quietly returning "ineligible" for everyone.
    expect(() => parsePoolsResponse({ pool_list: [] }, 0)).toThrow(/zero pools/);
  });

  it("rejects a response that is not a list at all", () => {
    expect(() => parsePoolsResponse({ nope: true }, 0)).toThrow(/not an array/);
  });
});

describe("PoolRegistry", () => {
  it("caches within the TTL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pool_list: [POOL] }));
    const registry = new PoolRegistry({ fetchImpl, retry: NO_RETRY, ttlMs: 1_000 });

    await registry.get(0);
    await registry.get(500);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes once the TTL has passed", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pool_list: [POOL] }));
    const registry = new PoolRegistry({ fetchImpl, retry: NO_RETRY, ttlMs: 1_000 });

    await registry.get(0);
    await registry.get(2_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves a stale snapshot when a refresh fails", async () => {
    // Pool sets change slowly. An hour-old registry beats failing every
    // verification in the ecosystem because one API blipped.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ pool_list: [POOL] });
      return jsonResponse({}, 503);
    });

    const registry = new PoolRegistry({ fetchImpl, retry: NO_RETRY, ttlMs: 1_000 });
    await registry.get(0);
    const stale = await registry.get(5_000);

    expect(stale.pools.size).toBe(1);
    expect(stale.fetchedAt).toBe(0);
  });

  it("fails when the first load fails and nothing is cached", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const registry = new PoolRegistry({ fetchImpl, retry: NO_RETRY });

    await expect(registry.get(0)).rejects.toMatchObject({ retryable: true });
  });

  it("collapses a burst of concurrent loads into one upstream fetch", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pool_list: [POOL] }));
    const registry = new PoolRegistry({ fetchImpl, retry: NO_RETRY });

    await Promise.all([registry.get(0), registry.get(0), registry.get(0)]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("survives a cold start from the persisted snapshot", async () => {
    const persisted = parsePoolsResponse([POOL], 0);
    const fetchImpl = vi.fn(async () => jsonResponse({}, 503));
    const registry = new PoolRegistry({
      fetchImpl,
      retry: NO_RETRY,
      store: { load: async () => persisted, save: async () => {} },
    });

    await expect(registry.get(10_000_000)).resolves.toMatchObject({ fetchedAt: 0 });
  });

  it("persists each successful refresh", async () => {
    const save = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => jsonResponse({ pool_list: [POOL] }));
    const registry = new PoolRegistry({
      fetchImpl,
      retry: NO_RETRY,
      store: { load: async () => null, save },
    });

    await registry.get(0);
    expect(save).toHaveBeenCalledOnce();
  });
});
