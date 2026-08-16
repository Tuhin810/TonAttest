import { describe, expect, it } from "vitest";
import { decodeEvents } from "../src/decode.js";
import {
  NOT,
  OTHER_WALLET,
  POOL_TON_NOT,
  POOL_TON_USDT,
  ROUTER,
  USDT,
  WALLET,
  ZERO_ADDRESS,
  event,
  jettonTransfer,
  lpAction,
  poolEntry,
  tonTransfer,
  registry,
  swapAction,
} from "./helpers.js";

function decode(events: ReturnType<typeof event>[], wallet = WALLET) {
  return decodeEvents({ events, registry: registry(), wallet });
}

describe("decodeEvents — swaps", () => {
  it("reads a native-TON leg from the ton_in field, not the empty jetton one", () => {
    // Most STON.fi swaps have a native-TON side. Reading only `amount_in`
    // would silently drop all of them.
    const result = decode([event([swapAction({})])]);

    expect(result.actions).toHaveLength(1);
    const action = result.actions[0]!;
    expect(action).toMatchObject({
      type: "SWAP",
      wallet: WALLET,
      router: ROUTER,
      pool: POOL_TON_USDT,
      tokenIn: "TON",
      tokenOut: USDT,
      amountIn: 1_000_000_000n,
      amountOut: 5_000_000n,
    });
  });

  it("accepts the wallet in any address spelling", () => {
    const friendly = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";
    const result = decode([event([swapAction({})])], friendly);
    expect(result.actions[0]).toMatchObject({ type: "SWAP", wallet: WALLET });
  });

  it("does not credit another wallet's swap relayed through the same router", () => {
    const result = decode([event([swapAction({ user_wallet: OTHER_WALLET })])]);

    // Recognised, but somebody else's — so it is not reported at all, and in
    // particular is not counted as an undecodable action.
    expect(result.actions).toHaveLength(0);
    expect(result.unknownCount).toBe(0);
  });

  it("ignores failed actions so reverting transactions cannot be farmed", () => {
    const result = decode([event([swapAction({}, "failed")])]);
    expect(result.actions).toHaveLength(0);
    expect(result.consideredCount).toBe(0);
  });

  it("skips events that are still in progress", () => {
    const result = decode([event([swapAction({})], { inProgress: true })]);
    expect(result.actions).toHaveLength(0);
  });

  it("ignores activity on other DEXes", () => {
    const result = decode([event([swapAction({ dex: "dedust", router: undefined })])]);
    expect(result.actions).toHaveLength(0);
  });

  it("falls back to token-pair matching when no pool address is given", () => {
    const result = decode([
      event([swapAction({ jetton_master_out: NOT })]),
    ]);
    expect(result.actions[0]).toMatchObject({ type: "SWAP", pool: POOL_TON_NOT });
  });

  it("records the swap without a pool when the pair matches several pools", () => {
    const duplicate = `0:${"44".repeat(32)}`;
    const ambiguous = registry([poolEntry(duplicate, ZERO_ADDRESS, USDT)]);

    const result = decodeEvents({
      events: [event([swapAction({})])],
      registry: ambiguous,
      wallet: WALLET,
    });

    // The swap is real and its amounts are known — only the pool is not.
    // Dropping it would under-count volume; guessing would let it satisfy a
    // pool-scoped rule it may not belong to.
    const action = result.actions[0]!;
    expect(action.type).toBe("SWAP");
    expect(action.pool).toBeUndefined();
  });
});

describe("decodeEvents — liquidity", () => {
  const POOL_JETTON_WALLET = `0:${"88".repeat(32)}`;

  it("reads a deposit from the LP jetton mint, with its legs", () => {
    const result = decode([
      event([
        lpAction("JettonMint"),
        jettonTransfer(WALLET, POOL_JETTON_WALLET, USDT, "5000000"),
        tonTransfer(WALLET, POOL_JETTON_WALLET, 1_000_000_000),
      ]),
    ]);

    expect(result.actions[0]).toMatchObject({
      type: "LP_ADD",
      pool: POOL_TON_USDT,
      lpAmount: 1_000n,
      assets: expect.arrayContaining([
        { asset: USDT, amount: 5_000_000n },
        { asset: "TON", amount: 1_000_000_000n },
      ]),
    });
  });

  it("reads a withdrawal from the LP jetton burn", () => {
    const result = decode([event([lpAction("JettonBurn")])]);
    expect(result.actions[0]).toMatchObject({ type: "LP_REMOVE", lpAmount: 1_000n });
  });

  it("ignores a mint of some unrelated jetton", () => {
    const result = decode([event([lpAction("JettonMint", { jetton: NOT })])]);
    expect(result.actions).toHaveLength(0);
  });

  it("does not credit a mint that went to somebody else", () => {
    const result = decode([event([lpAction("JettonMint", { recipient: OTHER_WALLET })])]);
    expect(result.actions).toHaveLength(0);
  });

  it("does not let a gas refund inflate the TON leg of a withdrawal", () => {
    // A withdrawal is accompanied by gas change from the pool, in TON.
    // Summing the transfers would silently fold that into the reported leg.
    const result = decode([
      event([
        lpAction("JettonBurn"),
        tonTransfer(POOL_JETTON_WALLET, WALLET, 7_642_096_705),
        tonTransfer(POOL_TON_USDT, WALLET, 248_856_731),
      ]),
    ]);

    const action = result.actions[0]!;
    const assets = action.type === "LP_REMOVE" ? action.assets : [];
    expect(assets).toEqual([{ asset: "TON", amount: 7_642_096_705n }]);
  });
});

describe("decodeEvents — unknown handling", () => {
  it("records an unrecognised STON.fi action instead of dropping it", () => {
    const result = decode([
      event([{ type: "SomethingNew", status: "ok", payload: { dex: "stonfi" } }]),
    ]);

    expect(result.unknownCount).toBe(1);
    expect(result.consideredCount).toBe(1);
    expect(result.actions[0]).toMatchObject({ type: "UNKNOWN" });
  });

  it("keeps the raw payload so the event can be re-decoded later", () => {
    const result = decode([
      event([{ type: "SomethingNew", status: "ok", payload: { dex: "stonfi", x: 1 } }]),
    ]);
    const action = result.actions[0]!;
    expect(action.type === "UNKNOWN" && action.raw).toMatchObject({
      actionType: "SomethingNew",
      payload: { x: 1 },
    });
  });

  it("treats a swap with a fractional amount as unknown rather than rounding it", () => {
    const result = decode([event([swapAction({ ton_in: 1.5 })])]);
    expect(result.actions[0]?.type).toBe("UNKNOWN");
  });

  it("treats a zero-value swap as unknown rather than recording a swap of nothing", () => {
    const result = decode([event([swapAction({ amount_out: "0" })])]);
    expect(result.actions[0]?.type).toBe("UNKNOWN");
  });
});

describe("decodeEvents — ordering and replay", () => {
  it("sorts ascending by logical time, not by arrival order", () => {
    const a = event([swapAction({})], { eventId: "b", lt: 20n });
    const b = event([swapAction({})], { eventId: "a", lt: 10n });
    const result = decode([a, b]);
    expect(result.actions.map((x) => x.txHash)).toEqual(["a", "b"]);
  });

  it("counts a duplicated event once, however many times a page repeats it", () => {
    const duplicated = event([swapAction({})], { eventId: "same", lt: 5n });
    const result = decode([duplicated, { ...duplicated }]);
    expect(result.actions).toHaveLength(1);
  });

  it("returns nothing for an unparseable wallet rather than throwing", () => {
    const result = decode([event([swapAction({})])], "not-an-address");
    expect(result.actions).toHaveLength(0);
  });
});

describe("decodeEvents — pool attribution", () => {
  it("matches a native-TON leg against the pool's TON side", () => {
    // Chain events name a pTON master, the pool list uses the zero address.
    // Without collapsing both onto the TON sentinel, a TON leg never matches
    // the TON side of its own pool and every TON swap goes unattributed.
    const PTON_V1 =
      "0:8cdc1d7640ad5ee326527fc1ad0514f468b30dc84b0173f0e155f451b4e11f7c";
    const result = decode([
      event([
        swapAction({
          ton_in: undefined,
          amount_in: "5000000",
          jetton_master_in: USDT,
          amount_out: "1000000000",
          jetton_master_out: PTON_V1,
        }),
      ]),
    ]);

    const action = result.actions[0]!;
    expect(action).toMatchObject({ type: "SWAP", tokenOut: "TON", pool: POOL_TON_USDT });
  });

  it("scopes pool lookup to the router that settled the swap", () => {
    // The same pair exists on another router; only this router's pool counts.
    const otherRouter = `0:${"55".repeat(32)}`;
    const otherPool = `0:${"66".repeat(32)}`;
    const withOtherRouter = registry([
      poolEntry(otherPool, ZERO_ADDRESS, USDT, { router_address: otherRouter }),
    ]);

    const result = decodeEvents({
      events: [event([swapAction({})])],
      registry: withOtherRouter,
      wallet: WALLET,
    });

    expect(result.actions[0]).toMatchObject({ pool: POOL_TON_USDT });
  });

  it("breaks a tie in favour of the one live pool among deprecated ones", () => {
    const retired = `0:${"77".repeat(32)}`;
    const withRetired = registry([
      poolEntry(retired, ZERO_ADDRESS, USDT, { deprecated: true }),
    ]);

    const result = decodeEvents({
      events: [event([swapAction({})])],
      registry: withRetired,
      wallet: WALLET,
    });

    expect(result.actions[0]).toMatchObject({ pool: POOL_TON_USDT });
  });

  it("prefers an explicitly named pool over pair inference", () => {
    const result = decode([event([swapAction({ pool: POOL_TON_NOT })])]);
    expect(result.actions[0]).toMatchObject({ pool: POOL_TON_NOT });
  });
});
