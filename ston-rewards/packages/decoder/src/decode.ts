import {
  NATIVE_TON,
  addressEquals,
  normalizeAddress,
  type Action,
  type DecodeResult,
  type LpLeg,
} from "@ston-rewards/core-types";
import type { PoolRegistrySnapshot, RawAction, RawEvent } from "@ston-rewards/data-provider";

/**
 * Raw provider events -> normalized STON.fi actions.
 *
 * This function is pure: `(events, registry, wallet) => actions`. All IO lives
 * in `@ston-rewards/data-provider`. That is what makes the golden-fixture
 * tests possible and what makes any eligibility answer reproducible offline.
 */
export function decodeEvents(input: DecodeInput): DecodeResult {
  const wallet = normalizeAddress(input.wallet);
  if (!wallet) {
    return { actions: [], unknownCount: 0, consideredCount: 0 };
  }

  const actions: Action[] = [];
  const seenTxHashes = new Set<string>();
  let unknownCount = 0;
  let consideredCount = 0;

  for (const event of input.events) {
    if (event.inProgress) continue;

    for (const action of event.actions) {
      // A failed action moved no value. Counting it would let a user farm
      // rewards from deliberately-reverting transactions.
      if (action.status !== "ok") continue;
      if (!touchesStonfi(action, input.registry)) continue;

      consideredCount++;
      const decoded = decodeAction(action, event, wallet, input.registry);

      const resolved: Action = decoded ?? {
        type: "UNKNOWN",
        txHash: event.eventId,
        lt: event.lt,
        wallet,
        occurredAt: event.timestamp,
        raw: { actionType: action.type, payload: action.payload },
      };

      // Replay guard at the decode boundary. One on-chain event can never
      // count twice, no matter how many times a page overlap repeats it.
      const key = `${resolved.txHash}:${resolved.type}:${resolved.pool ?? action.type}`;
      if (seenTxHashes.has(key)) continue;
      seenTxHashes.add(key);

      if (!decoded) unknownCount++;
      actions.push(resolved);
    }
  }

  actions.sort(compareByLt);
  return { actions, unknownCount, consideredCount };
}

export interface DecodeInput {
  readonly events: readonly RawEvent[];
  readonly registry: PoolRegistrySnapshot;
  /** The wallet whose activity we are attributing. Any address spelling. */
  readonly wallet: string;
}

/** Ascending by `lt`, with txHash as a deterministic tiebreak. */
function compareByLt(a: Action, b: Action): number {
  if (a.lt !== b.lt) return a.lt < b.lt ? -1 : 1;
  return a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0;
}

/**
 * Does this action involve a known STON.fi router or pool?
 *
 * Deliberately generous: anything touching STON.fi that we then fail to
 * decode becomes an UNKNOWN action rather than vanishing. A rising UNKNOWN
 * rate is the early-warning signal that STON.fi shipped a contract change.
 */
function touchesStonfi(action: RawAction, registry: PoolRegistrySnapshot): boolean {
  if (typeof action.payload["dex"] === "string") {
    return action.payload["dex"].toLowerCase().includes("ston");
  }
  for (const value of Object.values(action.payload)) {
    const address = extractAddress(value);
    if (!address) continue;
    const normalized = normalizeAddress(address);
    if (!normalized) continue;
    if (registry.pools.has(normalized) || registry.routers.has(normalized)) return true;
  }
  return false;
}

function decodeAction(
  action: RawAction,
  event: RawEvent,
  wallet: string,
  registry: PoolRegistrySnapshot,
): Action | null {
  switch (action.type) {
    case "JettonSwap":
      return decodeSwap(action, event, wallet, registry);
    case "DepositLiquidity":
      return decodeLiquidity(action, event, wallet, registry, "LP_ADD");
    case "WithdrawLiquidity":
      return decodeLiquidity(action, event, wallet, registry, "LP_REMOVE");
    default:
      return null;
  }
}

function decodeSwap(
  action: RawAction,
  event: RawEvent,
  wallet: string,
  registry: PoolRegistrySnapshot,
): Action | null {
  const p = action.payload;

  // Attribute strictly to the wallet we were asked about. Routers relay
  // messages on behalf of many users; without this check a shared router
  // event could be credited to the wrong account.
  const actor = normalizeAddress(extractAddress(p["user_wallet"]));
  if (actor && !addressEquals(actor, wallet)) return null;

  const legIn = resolveLeg(p["jetton_master_in"], p["amount_in"], p["ton_in"]);
  const legOut = resolveLeg(p["jetton_master_out"], p["amount_out"], p["ton_out"]);
  if (!legIn || !legOut) return null;

  const router = normalizeAddress(extractAddress(p["router"] ?? p["router_address"]));
  if (!router) return null;

  const pool = resolvePool(p, registry, legIn.asset, legOut.asset);

  return {
    type: "SWAP",
    txHash: event.eventId,
    lt: event.lt,
    wallet,
    occurredAt: event.timestamp,
    router,
    ...(pool ? { pool } : {}),
    tokenIn: legIn.asset,
    tokenOut: legOut.asset,
    amountIn: legIn.amount,
    amountOut: legOut.amount,
  };
}

function decodeLiquidity(
  action: RawAction,
  event: RawEvent,
  wallet: string,
  registry: PoolRegistrySnapshot,
  type: "LP_ADD" | "LP_REMOVE",
): Action | null {
  const p = action.payload;

  const actor = normalizeAddress(extractAddress(p["user_wallet"] ?? p["source"]));
  if (actor && !addressEquals(actor, wallet)) return null;

  const pool = resolvePool(p, registry, null, null);
  if (!pool) return null;

  const lpAmount = toBigInt(p["lp_amount"] ?? p["amount"]);
  if (lpAmount === null || lpAmount <= 0n) return null;

  const assets = extractLegs(p);
  if (assets.length === 0) return null;

  return {
    type,
    txHash: event.eventId,
    lt: event.lt,
    wallet,
    occurredAt: event.timestamp,
    pool,
    lpAmount,
    assets,
  };
}

/**
 * Finds the pool this action settled against.
 *
 * Preference order matters: an explicit pool address from the provider is
 * authoritative, and only when it is absent do we fall back to matching the
 * token pair. The fallback is ambiguous when several pools share a pair (fee
 * tiers, v1 vs v2), so it refuses rather than guessing — an action attributed
 * to the wrong pool would satisfy a pool-scoped rule it should not.
 */
function resolvePool(
  payload: Record<string, unknown>,
  registry: PoolRegistrySnapshot,
  tokenIn: string | null,
  tokenOut: string | null,
): string | null {
  for (const key of ["pool", "pool_address"]) {
    const candidate = normalizeAddress(extractAddress(payload[key]));
    if (candidate && registry.pools.has(candidate)) return candidate;
  }

  if (!tokenIn || !tokenOut) return null;

  let match: string | null = null;
  for (const pool of registry.pools.values()) {
    const t0 = normalizeAddress(pool.token0);
    const t1 = normalizeAddress(pool.token1);
    const pairMatches =
      (matches(t0, tokenIn) && matches(t1, tokenOut)) ||
      (matches(t0, tokenOut) && matches(t1, tokenIn));
    if (!pairMatches) continue;
    if (match) return null; // ambiguous — refuse rather than guess
    match = pool.address;
  }
  return match;
}

function matches(poolToken: string | null, actionToken: string): boolean {
  if (!poolToken) return false;
  return poolToken === actionToken;
}

function extractLegs(payload: Record<string, unknown>): LpLeg[] {
  const legs: LpLeg[] = [];
  for (const [assetKey, amountKey] of [
    ["jetton_master_0", "amount_0"],
    ["jetton_master_1", "amount_1"],
  ] as const) {
    const amount = toBigInt(payload[amountKey]);
    if (amount === null || amount <= 0n) continue;
    const asset = assetOf(payload[assetKey], undefined);
    if (!asset) continue;
    legs.push({ asset, amount });
  }
  return legs;
}

/**
 * Resolves one side of a swap to an (asset, amount) pair.
 *
 * A native-TON leg is reported differently from a jetton leg: the jetton
 * amount field is left empty and the value appears in `ton_in`/`ton_out`
 * instead. Reading only the jetton field would silently drop every
 * TON-denominated swap, which is most of them.
 */
function resolveLeg(
  jettonMaster: unknown,
  jettonAmount: unknown,
  tonAmount: unknown,
): { asset: string; amount: bigint } | null {
  const master = normalizeAddress(extractAddress(jettonMaster));
  if (master) {
    const amount = toBigInt(jettonAmount);
    if (amount === null || amount <= 0n) return null;
    return { asset: master, amount };
  }

  const ton = toBigInt(tonAmount);
  if (ton === null || ton <= 0n) return null;
  return { asset: NATIVE_TON, amount: ton };
}

/** Resolves an asset for a liquidity leg, which has no native-TON variant. */
function assetOf(jettonMaster: unknown, tonAmount: unknown): string | null {
  const master = normalizeAddress(extractAddress(jettonMaster));
  if (master) return master;
  const ton = toBigInt(tonAmount);
  if (ton !== null && ton > 0n) return NATIVE_TON;
  return null;
}

/** Providers spell addresses as bare strings or as `{ address }` objects. */
function extractAddress(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const address = (value as Record<string, unknown>)["address"];
    if (typeof address === "string") return address;
  }
  return null;
}

/**
 * Amounts are bigint token units everywhere. A JS number cannot hold a
 * nanoton balance without losing precision, so a float here is rejected
 * outright rather than silently rounded.
 */
function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}
