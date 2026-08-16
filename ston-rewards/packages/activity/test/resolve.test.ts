import { describe, expect, it, vi } from "vitest";
import { StonRewardsError } from "@ston-rewards/core-types";
import { parsePoolsResponse, type DataProvider, type RawEvent } from "@ston-rewards/data-provider";
import { resolveActivity } from "../src/resolve.js";

const WALLET = "0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e";
const POOL = `0:${"11".repeat(32)}`;
const ROUTER = `0:${"33".repeat(32)}`;
const USDT = `0:${"aa".repeat(32)}`;
const ZERO = `0:${"00".repeat(32)}`;

const registry = parsePoolsResponse(
  [{ address: POOL, router_address: ROUTER, token0_address: ZERO, token1_address: USDT }],
  0,
);

function swapEvent(id: string, lt: bigint): RawEvent {
  return {
    eventId: id,
    timestamp: 1_700_000_000,
    lt,
    inProgress: false,
    actions: [
      {
        type: "JettonSwap",
        status: "ok",
        payload: {
          dex: "stonfi",
          user_wallet: WALLET,
          router: ROUTER,
          ton_in: 1_000_000_000,
          amount_in: "",
          amount_out: "5000000",
          jetton_master_out: USDT,
        },
      },
    ],
  };
}

function provider(overrides: Partial<DataProvider> = {}): DataProvider {
  return {
    name: "stub",
    getAccountEvents: async () => ({ events: [swapEvent("tx1", 1n)], truncated: false }),
    getAccountFirstActivity: async () => 1_600_000_000,
    ...overrides,
  };
}

describe("resolveActivity", () => {
  it("builds an activity set from decoded events", async () => {
    const { activity } = await resolveActivity({
      provider: provider(),
      registry,
      wallet: WALLET,
      from: 0,
      to: 2_000_000_000,
    });

    expect(activity.actions).toHaveLength(1);
    expect(activity.actions[0]).toMatchObject({ type: "SWAP", pool: POOL });
    expect(activity.walletFirstSeenAt).toBe(1_600_000_000);
  });

  it("fails closed when the history was truncated", async () => {
    // A partial history under-counts volume, producing a confident
    // "ineligible" for a user who genuinely qualified.
    const truncating = provider({
      getAccountEvents: async () => ({ events: [swapEvent("tx1", 1n)], truncated: true }),
    });

    await expect(
      resolveActivity({ provider: truncating, registry, wallet: WALLET, from: 0, to: 1 }),
    ).rejects.toMatchObject({ code: "STALE_ACTIVITY", retryable: true });
  });

  it("propagates a provider outage rather than returning an empty set", async () => {
    const failing = provider({
      getAccountEvents: async () => {
        throw new StonRewardsError("PROVIDER_UNAVAILABLE", "down");
      },
    });

    await expect(
      resolveActivity({ provider: failing, registry, wallet: WALLET, from: 0, to: 1 }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects an unparseable wallet without calling the provider", async () => {
    const spy = vi.fn();
    await expect(
      resolveActivity({
        provider: provider({ getAccountEvents: spy }),
        registry,
        wallet: "nonsense",
        from: 0,
        to: 1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ADDRESS", retryable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("still resolves when wallet age is unavailable", async () => {
    // Wallet age is an optional anti-abuse input, not a correctness input.
    const noAge = provider({
      getAccountFirstActivity: async () => {
        throw new Error("unsupported");
      },
    });

    const { activity } = await resolveActivity({
      provider: noAge,
      registry,
      wallet: WALLET,
      from: 0,
      to: 2_000_000_000,
    });
    expect(activity.walletFirstSeenAt).toBeNull();
  });

  it("reports the undecodable share, the contract-change early warning", async () => {
    const withUnknown = provider({
      getAccountEvents: async () => ({
        events: [
          {
            eventId: "tx9",
            timestamp: 1_700_000_000,
            lt: 9n,
            inProgress: false,
            actions: [{ type: "SomethingNew", status: "ok", payload: { dex: "stonfi" } }],
          },
        ],
        truncated: false,
      }),
    });

    const result = await resolveActivity({
      provider: withUnknown,
      registry,
      wallet: WALLET,
      from: 0,
      to: 2_000_000_000,
    });

    expect(result.unknownCount).toBe(1);
    expect(result.unknownRate).toBe(1);
  });

  it("leaves USD off entirely when no rate provider is supplied", async () => {
    const { activity } = await resolveActivity({
      provider: provider(),
      registry,
      wallet: WALLET,
      from: 0,
      to: 2_000_000_000,
    });
    expect(activity.actions[0]?.usd).toBeUndefined();
  });
});
