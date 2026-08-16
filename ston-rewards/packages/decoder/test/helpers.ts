import { parsePoolsResponse, type PoolRegistrySnapshot, type RawEvent } from "@ston-rewards/data-provider";

export const WALLET = "0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e";
export const OTHER_WALLET = "0:9c2c05b9dfb2a7460fda48fae7409a32623399933a98a7a15599152f37572b49";
export const POOL_TON_USDT = `0:${"11".repeat(32)}`;
export const POOL_TON_NOT = `0:${"22".repeat(32)}`;
export const ROUTER = `0:${"33".repeat(32)}`;
export const USDT = `0:${"aa".repeat(32)}`;
export const NOT = `0:${"bb".repeat(32)}`;

const ZERO_ADDRESS = `0:${"00".repeat(32)}`;

export function registry(extraPools: readonly Record<string, unknown>[] = []): PoolRegistrySnapshot {
  // Built through the real parser so tests exercise the same canonicalization
  // the service uses — including the zero address standing in for native TON.
  return parsePoolsResponse(
    [
      poolEntry(POOL_TON_USDT, ZERO_ADDRESS, USDT),
      poolEntry(POOL_TON_NOT, ZERO_ADDRESS, NOT),
      ...extraPools,
    ],
    0,
  );
}

export function poolEntry(
  address: string,
  token0: string,
  token1: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    address,
    router_address: ROUTER,
    token0_address: token0,
    token1_address: token1,
    ...extra,
  };
}

export { ZERO_ADDRESS };

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

/**
 * A STON.fi pool is its own LP jetton master, so liquidity operations appear
 * as an ordinary mint (deposit) or burn (withdrawal) of the pool's jetton.
 */
export function lpAction(
  type: "JettonMint" | "JettonBurn",
  payload: Record<string, unknown> = {},
) {
  const party = type === "JettonMint" ? { recipient: WALLET } : { sender: WALLET };
  return {
    type,
    status: "ok",
    payload: { ...party, jetton: POOL_TON_USDT, amount: "1000", ...payload },
  };
}

/** A value leg accompanying a liquidity operation in the same event. */
export function jettonTransfer(
  from: string,
  to: string,
  jetton: string,
  amount: string,
) {
  return {
    type: "JettonTransfer",
    status: "ok",
    payload: { sender: from, recipient: to, jetton, amount },
  };
}

export function tonTransfer(from: string, to: string, amount: number) {
  return { type: "TonTransfer", status: "ok", payload: { sender: from, recipient: to, amount } };
}
