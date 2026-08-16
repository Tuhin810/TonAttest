import type { ActivitySet, KnownAction, LpPosition } from "@ston-rewards/core-types";

export const WALLET = `0:${"cc".repeat(32)}`;
export const POOL_A = `0:${"11".repeat(32)}`;
export const POOL_B = `0:${"22".repeat(32)}`;
export const ROUTER = `0:${"33".repeat(32)}`;
export const USDT = `0:${"aa".repeat(32)}`;
export const NOT = `0:${"bb".repeat(32)}`;

export const DAY = 86_400;
export const T0 = 1_700_000_000;

let seq = 0;

export function resetSeq(): void {
  seq = 0;
}

export function swapAction(overrides: Partial<KnownAction> & Record<string, unknown> = {}) {
  seq++;
  return {
    type: "SWAP",
    txHash: `swap${seq}`,
    lt: BigInt(seq),
    wallet: WALLET,
    occurredAt: T0,
    router: ROUTER,
    pool: POOL_A,
    tokenIn: "TON",
    tokenOut: USDT,
    amountIn: 1_000_000_000n,
    amountOut: 5_000_000n,
    ...overrides,
  } as KnownAction;
}

export function lpAddAction(overrides: Record<string, unknown> = {}) {
  seq++;
  return {
    type: "LP_ADD",
    txHash: `lpadd${seq}`,
    lt: BigInt(seq),
    wallet: WALLET,
    occurredAt: T0,
    pool: POOL_A,
    lpAmount: 1_000n,
    assets: [],
    ...overrides,
  } as KnownAction;
}

export function position(overrides: Partial<LpPosition> = {}): LpPosition {
  return {
    pool: POOL_A,
    openedAt: T0,
    closedAt: null,
    lpAmount: 1_000n,
    openTxHash: "lpadd1",
    closeTxHash: null,
    ...overrides,
  };
}

export function activity(overrides: Partial<ActivitySet> = {}): ActivitySet {
  return {
    wallet: WALLET,
    actions: [],
    positions: [],
    walletFirstSeenAt: T0 - 365 * DAY,
    resolvedFrom: T0 - 30 * DAY,
    resolvedTo: T0 + 30 * DAY,
    ...overrides,
  };
}

export const CAMPAIGN = { from: T0 - 30 * DAY, to: T0 + 30 * DAY };
