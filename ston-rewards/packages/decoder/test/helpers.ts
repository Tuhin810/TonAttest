import type { PoolRegistrySnapshot, RawEvent } from "@ston-rewards/data-provider";

export const WALLET = "0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e";
export const OTHER_WALLET = "0:9c2c05b9dfb2a7460fda48fae7409a32623399933a98a7a15599152f37572b49";
export const POOL_TON_USDT = `0:${"11".repeat(32)}`;
export const POOL_TON_NOT = `0:${"22".repeat(32)}`;
export const ROUTER = `0:${"33".repeat(32)}`;
export const USDT = `0:${"aa".repeat(32)}`;
export const NOT = `0:${"bb".repeat(32)}`;

export function registry(): PoolRegistrySnapshot {
  return {
    pools: new Map([
      [POOL_TON_USDT, { address: POOL_TON_USDT, token0: "TON", token1: USDT }],
      [POOL_TON_NOT, { address: POOL_TON_NOT, token0: "TON", token1: NOT }],
    ]),
    routers: new Set([ROUTER]),
    fetchedAt: 0,
  };
}

let seq = 0;

export function event(
  actions: RawEvent["actions"],
  overrides: Partial<RawEvent> = {},
): RawEvent {
  seq++;
  return {
    eventId: `tx${seq}`,
    account: WALLET,
    timestamp: 1_700_000_000 + seq,
    lt: BigInt(seq),
    inProgress: false,
    actions,
    ...overrides,
  };
}

export function swapAction(payload: Record<string, unknown>, status = "ok") {
  return {
    type: "JettonSwap",
    status,
    payload: {
      // Mirrors a real tonapi JettonSwap: routers are named, pools are not,
      // and a native-TON leg leaves the jetton amount empty.
      dex: "stonfi",
      user_wallet: WALLET,
      router: ROUTER,
      ton_in: 1_000_000_000,
      amount_in: "",
      amount_out: "5000000",
      jetton_master_out: USDT,
      ...payload,
    },
  };
}

export function lpAction(
  type: "DepositLiquidity" | "WithdrawLiquidity",
  payload: Record<string, unknown> = {},
) {
  return {
    type,
    status: "ok",
    payload: {
      dex: "stonfi",
      user_wallet: WALLET,
      pool: POOL_TON_USDT,
      lp_amount: "1000",
      jetton_master_0: "TON",
      amount_0: "1000000000",
      jetton_master_1: USDT,
      amount_1: "5000000",
      ...payload,
    },
  };
}
