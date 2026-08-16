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
  event,
  lpAction,
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
    expect(result.actions.filter((a) => a.type === "SWAP")).toHaveLength(0);
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
    const ambiguous = registry();
    const duplicate = `0:${"44".repeat(32)}`;
    ambiguous.pools.set(duplicate, { address: duplicate, token0: "TON", token1: USDT });

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
  it("decodes a deposit with both legs", () => {
    const result = decode([event([lpAction("DepositLiquidity")])]);
    expect(result.actions[0]).toMatchObject({
      type: "LP_ADD",
      pool: POOL_TON_USDT,
      lpAmount: 1_000n,
      assets: [
        { asset: "TON", amount: 1_000_000_000n },
        { asset: USDT, amount: 5_000_000n },
      ],
    });
  });

  it("decodes a withdrawal", () => {
    const result = decode([event([lpAction("WithdrawLiquidity")])]);
    expect(result.actions[0]).toMatchObject({ type: "LP_REMOVE", lpAmount: 1_000n });
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
