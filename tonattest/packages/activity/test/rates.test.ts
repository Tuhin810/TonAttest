import { describe, expect, it, vi } from "vitest";
import type { SwapAction } from "@tonattest/core-types";
import { StonFiRateProvider, parseAssetRates } from "../src/rates.js";

const USDT = `0:${"aa".repeat(32)}`;
const ZERO = `0:${"00".repeat(32)}`;

const ASSETS = {
  asset_list: [
    { contract_address: ZERO, dex_usd_price: "1.34", decimals: 9 },
    { contract_address: USDT, dex_usd_price: "1.0", decimals: 6 },
    { contract_address: `0:${"bb".repeat(32)}`, decimals: 9 },
  ],
};

function swap(overrides: Partial<SwapAction> = {}): SwapAction {
  return {
    type: "SWAP",
    txHash: "tx1",
    lt: 1n,
    wallet: `0:${"cc".repeat(32)}`,
    occurredAt: 1_700_000_000,
    router: `0:${"33".repeat(32)}`,
    tokenIn: "TON",
    tokenOut: USDT,
    amountIn: 2_000_000_000n,
    amountOut: 2_680_000n,
    ...overrides,
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("parseAssetRates", () => {
  it("keys native TON under the sentinel, not the zero address", () => {
    const rates = parseAssetRates(ASSETS);
    expect(rates.get("TON")).toEqual({ priceUsd: 1.34, decimals: 9 });
  });

  it("skips assets with no published price rather than valuing them at zero", () => {
    const rates = parseAssetRates(ASSETS);
    expect(rates.has(`0:${"bb".repeat(32)}`)).toBe(false);
  });

  it("rejects a response that is not a list", () => {
    expect(() => parseAssetRates({ nope: 1 })).toThrow(/not an array/);
  });
});

describe("StonFiRateProvider", () => {
  it("values a swap by what the user spent", () => {
    const provider = new StonFiRateProvider({
      fetchImpl: async () => ok(ASSETS),
      now: () => 1_800_000_000_000,
    });

    return provider.value(swap()).then((valued) => {
      expect(valued.usd?.amount).toBeCloseTo(2.68, 6);
      expect(valued.usd?.source).toBe("stonfi:assets");
      // The rate's own observation time, not the transaction time — the whole
      // point of recording it is that the two differ.
      expect(valued.usd?.at).toBe(1_800_000_000);
    });
  });

  it("keeps full precision on amounts too large for a double", async () => {
    const provider = new StonFiRateProvider({ fetchImpl: async () => ok(ASSETS) });
    const huge = swap({ tokenIn: USDT, amountIn: 123_456_789_012_345_678n });

    const valued = await provider.value(huge);
    expect(valued.usd?.amount).toBeCloseTo(123_456_789_012.345678, 3);
  });

  it("falls back to the output side when the input asset has no rate", async () => {
    const provider = new StonFiRateProvider({ fetchImpl: async () => ok(ASSETS) });
    const valued = await provider.value(swap({ tokenIn: `0:${"bb".repeat(32)}` }));
    expect(valued.usd?.amount).toBeCloseTo(2.68, 6);
  });

  it("leaves the action untouched when neither asset has a rate", async () => {
    const provider = new StonFiRateProvider({ fetchImpl: async () => ok(ASSETS) });
    const unknown = `0:${"bb".repeat(32)}`;
    const valued = await provider.value(swap({ tokenIn: unknown, tokenOut: unknown }));
    expect(valued.usd).toBeUndefined();
  });

  it("caches the rate table within its TTL", async () => {
    const fetchImpl = vi.fn(async () => ok(ASSETS));
    const provider = new StonFiRateProvider({ fetchImpl, ttlMs: 60_000, now: () => 0 });

    await provider.value(swap());
    await provider.value(swap());

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("collapses concurrent valuations into one upstream fetch", async () => {
    const fetchImpl = vi.fn(async () => ok(ASSETS));
    const provider = new StonFiRateProvider({ fetchImpl });

    await Promise.all([provider.value(swap()), provider.value(swap()), provider.value(swap())]);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("serves stale rates rather than failing a verification over a decoration", async () => {
    let calls = 0;
    const clock = { now: 0 };
    const provider = new StonFiRateProvider({
      ttlMs: 1_000,
      now: () => clock.now,
      fetchImpl: async () => {
        calls++;
        return calls === 1 ? ok(ASSETS) : new Response("", { status: 503 });
      },
    });

    await provider.value(swap());
    clock.now = 100_000;
    const valued = await provider.value(swap());

    expect(valued.usd?.amount).toBeCloseTo(2.68, 6);
  });

  it("throws when the very first rate load fails and nothing is cached", async () => {
    const provider = new StonFiRateProvider({
      fetchImpl: async () => new Response("", { status: 503 }),
    });
    await expect(provider.value(swap())).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});
