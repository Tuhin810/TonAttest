import { describe, expect, it } from "vitest";
import type { KnownAction } from "@ston-rewards/core-types";
import { heldSeconds, reconstructPositions } from "../src/positions.js";
import { POOL_TON_NOT, POOL_TON_USDT, WALLET } from "./helpers.js";

const DAY = 86_400;
const T0 = 1_700_000_000;

let seq = 0;

function add(pool: string, lpAmount: bigint, atDays: number): KnownAction {
  seq++;
  return {
    type: "LP_ADD",
    txHash: `add${seq}`,
    lt: BigInt(seq),
    wallet: WALLET,
    occurredAt: T0 + atDays * DAY,
    pool,
    lpAmount,
    assets: [{ asset: "TON", amount: lpAmount }],
  };
}

function remove(pool: string, lpAmount: bigint, atDays: number): KnownAction {
  seq++;
  return {
    type: "LP_REMOVE",
    txHash: `rm${seq}`,
    lt: BigInt(seq),
    wallet: WALLET,
    occurredAt: T0 + atDays * DAY,
    pool,
    lpAmount,
    assets: [{ asset: "TON", amount: lpAmount }],
  };
}

describe("reconstructPositions", () => {
  it("leaves a deposit with no withdrawal open", () => {
    const [position] = reconstructPositions([add(POOL_TON_USDT, 100n, 0)]);
    expect(position).toMatchObject({ closedAt: null, lpAmount: 100n });
  });

  it("closes a fully-withdrawn position", () => {
    const positions = reconstructPositions([
      add(POOL_TON_USDT, 100n, 0),
      remove(POOL_TON_USDT, 100n, 7),
    ]);
    expect(positions).toHaveLength(1);
    expect(heldSeconds(positions[0]!, T0 + 30 * DAY)).toBe(7 * DAY);
  });

  it("splits a partial withdrawal into a closed slice and an open remainder", () => {
    const positions = reconstructPositions([
      add(POOL_TON_USDT, 100n, 0),
      remove(POOL_TON_USDT, 40n, 3),
    ]);
    expect(positions).toEqual([
      expect.objectContaining({ lpAmount: 40n, closedAt: T0 + 3 * DAY }),
      expect.objectContaining({ lpAmount: 60n, closedAt: null }),
    ]);
  });

  it("closes oldest units first, so churn cannot preserve a stale open position", () => {
    // FIFO: the day-0 deposit is the one the withdrawal consumes. Under LIFO
    // the user would keep an artificially old position alive by cycling
    // deposits on top of it.
    const positions = reconstructPositions([
      add(POOL_TON_USDT, 100n, 0),
      add(POOL_TON_USDT, 100n, 5),
      remove(POOL_TON_USDT, 100n, 6),
    ]);

    const open = positions.filter((p) => p.closedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0]!.openedAt).toBe(T0 + 5 * DAY);
  });

  it("lets one withdrawal close across several deposits", () => {
    const positions = reconstructPositions([
      add(POOL_TON_USDT, 60n, 0),
      add(POOL_TON_USDT, 40n, 1),
      remove(POOL_TON_USDT, 100n, 2),
    ]);
    expect(positions).toHaveLength(2);
    expect(positions.every((p) => p.closedAt === T0 + 2 * DAY)).toBe(true);
  });

  it("keeps pools independent", () => {
    const positions = reconstructPositions([
      add(POOL_TON_USDT, 100n, 0),
      add(POOL_TON_NOT, 100n, 0),
      remove(POOL_TON_USDT, 100n, 1),
    ]);
    const open = positions.filter((p) => p.closedAt === null);
    expect(open.map((p) => p.pool)).toEqual([POOL_TON_NOT]);
  });

  it("ignores a withdrawal with no matching deposit in the resolved window", () => {
    // The wallet may have acquired LP jettons before the window we fetched.
    expect(reconstructPositions([remove(POOL_TON_USDT, 100n, 1)])).toEqual([]);
  });

  it("ignores the excess when a withdrawal exceeds what is open", () => {
    const positions = reconstructPositions([
      add(POOL_TON_USDT, 50n, 0),
      remove(POOL_TON_USDT, 200n, 1),
    ]);
    expect(positions).toEqual([expect.objectContaining({ lpAmount: 50n, closedAt: T0 + DAY })]);
  });

  it("orders by logical time, not array order", () => {
    const deposit = add(POOL_TON_USDT, 100n, 0);
    const withdrawal = remove(POOL_TON_USDT, 100n, 4);
    expect(reconstructPositions([withdrawal, deposit])).toEqual(
      reconstructPositions([deposit, withdrawal]),
    );
  });
});

describe("heldSeconds", () => {
  it("measures an open position against now", () => {
    const [position] = reconstructPositions([add(POOL_TON_USDT, 100n, 0)]);
    expect(heldSeconds(position!, T0 + 10 * DAY)).toBe(10 * DAY);
  });

  it("never returns a negative duration for a clock skew", () => {
    const [position] = reconstructPositions([add(POOL_TON_USDT, 100n, 5)]);
    expect(heldSeconds(position!, T0)).toBe(0);
  });
});
