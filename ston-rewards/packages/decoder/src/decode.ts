import {
  NATIVE_TON,
  addressEquals,
  canonicalAsset,
  normalizeAddress,
  type Action,
  type DecodeResult,
  type LpLeg,
} from "@ston-rewards/core-types";
import { pairKey, type PoolRegistrySnapshot, type RawAction, type RawEvent } from "@ston-rewards/data-provider";

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
  const seenKeys = new Set<string>();
  let unknownCount = 0;
  let consideredCount = 0;

  for (const event of input.events) {
    if (event.inProgress) continue;

    const decodedHere: Action[] = [];
    const undecoded: RawAction[] = [];

    for (const action of event.actions) {
      // A failed action moved no value. Counting it would let a user farm
      // rewards from deliberately-reverting transactions.
      if (action.status !== "ok") continue;
      if (!touchesStonfi(action, input.registry)) continue;

      const decoded = decodeAction(action, event, wallet, input.registry);
      // Recognised but belonging to somebody else: not evidence of anything,
      // so it is neither counted nor reported.
      if (decoded === NOT_OURS) continue;

      consideredCount++;
      if (decoded) decodedHere.push(decoded);
      else undecoded.push(action);
    }

    // A single STON.fi operation spans several actions: the swap or the
    // mint/burn that carries the meaning, plus the transfers and contract
    // calls that move the value. Once the event has yielded a decoded action,
    // the rest is plumbing, and flagging it as UNKNOWN would bury the signal
    // that flag exists for. Only an event we understood *nothing* of is
    // evidence that STON.fi shipped something new.
    if (decodedHere.length === 0) {
      for (const action of undecoded) {
        unknownCount++;
        decodedHere.push({
          type: "UNKNOWN",
          txHash: event.eventId,
          lt: event.lt,
          wallet,
          occurredAt: event.timestamp,
          ...(typeof action.payload["op_code"] === "number"
            ? { opCode: action.payload["op_code"] }
            : {}),
          raw: { actionType: action.type, payload: action.payload },
        });
      }
    }

    for (const action of decodedHere) {
      // Replay guard at the decode boundary. One on-chain event can never
      // count twice, no matter how many times a page overlap repeats it.
      const key = `${action.txHash}:${action.type}:${action.pool ?? ""}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      actions.push(action);
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

/**
 * Returned when an action was understood but belongs to another wallet.
 *
 * Distinct from `null`, which means "we could not read this at all". Only the
 * latter is evidence that STON.fi shipped something new, so conflating the two
 * would bury the contract-change signal under ordinary third-party traffic.
 */
const NOT_OURS = Symbol("not-ours");
type DecodedAction = Action | typeof NOT_OURS | null;

function decodeAction(
  action: RawAction,
  event: RawEvent,
  wallet: string,
  registry: PoolRegistrySnapshot,
): DecodedAction {
  switch (action.type) {
    case "JettonSwap":
      return decodeSwap(action, event, wallet, registry);
    // A STON.fi pool contract is itself the LP jetton master, so a wallet's
    // liquidity position is just its balance of that jetton. Every way that
    // balance moves is a position change, and all of them surface as ordinary
    // jetton actions — which is why no message-body decoding is needed.
    case "JettonMint":
    case "JettonBurn":
    case "JettonTransfer":
      return decodeLiquidity(action, event, wallet, registry);
    default:
      return null;
  }
}

function decodeSwap(
  action: RawAction,
  event: RawEvent,
  wallet: string,
  registry: PoolRegistrySnapshot,
): DecodedAction {
  const p = action.payload;

  // Attribute strictly to the wallet we were asked about. Routers relay
  // messages on behalf of many users; without this check a shared router
  // event could be credited to the wrong account.
  const actor = normalizeAddress(extractAddress(p["user_wallet"]));
  if (actor && !addressEquals(actor, wallet)) return NOT_OURS;

  const legIn = resolveLeg(p["jetton_master_in"], p["amount_in"], p["ton_in"]);
  const legOut = resolveLeg(p["jetton_master_out"], p["amount_out"], p["ton_out"]);
  if (!legIn || !legOut) return null;

  const router = normalizeAddress(extractAddress(p["router"] ?? p["router_address"]));
  if (!router) return null;

  const pool = resolvePool(p, registry, router, legIn.asset, legOut.asset);

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
): DecodedAction {
  const p = action.payload;

  // The jetton being moved must be a pool we know. Every other jetton action
  // in the wallet's history is an unrelated token and is not our business —
  // including the underlying tokens paid into the very same deposit.
  const pool = normalizeAddress(extractAddress(p["jetton"]));
  if (!pool) return null;
  const poolInfo = registry.pools.get(pool);
  if (!poolInfo) return null;

  const recipient = normalizeAddress(extractAddress(p["recipient"]));
  const sender = normalizeAddress(extractAddress(p["sender"] ?? p["owner"]));

  // Direction is read from the wallet's side of the movement. An outbound
  // transfer of LP jettons counts as a removal even though nothing was
  // burned: the position genuinely left the wallet, and treating only burns
  // as removals would let a user hand their LP to a second address and still
  // satisfy a hold-for-N-days rule.
  const type: "LP_ADD" | "LP_REMOVE" =
    addressEquals(recipient, wallet) && action.type !== "JettonBurn"
      ? "LP_ADD"
      : "LP_REMOVE";

  const party = type === "LP_ADD" ? recipient : sender;
  if (!addressEquals(party, wallet)) return NOT_OURS;

  const lpAmount = toBigInt(p["amount"] ?? p["lp_amount"]);
  if (lpAmount === null || lpAmount <= 0n) return null;

  return {
    type,
    txHash: event.eventId,
    lt: event.lt,
    wallet,
    occurredAt: event.timestamp,
    pool,
    lpAmount,
    assets: extractLegs(event, wallet, poolInfo, type),
  };
}

/**
 * Recovers the underlying token amounts that went into (or came out of) a
 * liquidity operation, by reading the transfers that accompany it in the same
 * event.
 *
 * Best-effort by design. The authoritative facts for every v1 rule — pool, LP
 * units, and timing — come from the mint/burn itself; these legs are evidence
 * for humans reading a verification result.
 *
 * Two filters keep them honest. Only assets that are one of the pool's own two
 * sides are considered, and for each asset the single largest transfer is
 * taken rather than the sum. The second matters more than it looks: a
 * withdrawal is accompanied by gas change from the pool, denominated in TON,
 * and summing would silently fold that refund into the reported TON leg.
 */
function extractLegs(
  event: RawEvent,
  wallet: string,
  pool: { token0: string; token1: string },
  type: "LP_ADD" | "LP_REMOVE",
): LpLeg[] {
  const poolAssets = new Set([pool.token0, pool.token1]);
  const totals = new Map<string, bigint>();

  for (const action of event.actions) {
    if (action.status !== "ok") continue;
    const p = action.payload;

    // On a deposit the value leaves the wallet; on a withdrawal it arrives.
    const party = type === "LP_ADD" ? p["sender"] : p["recipient"];
    if (!addressEquals(normalizeAddress(extractAddress(party)), wallet)) continue;

    let asset: string | null = null;
    if (action.type === "JettonTransfer") asset = canonicalAsset(extractAddress(p["jetton"]));
    else if (action.type === "TonTransfer") asset = NATIVE_TON;
    if (!asset || !poolAssets.has(asset)) continue;

    const amount = toBigInt(p["amount"]);
    if (amount === null || amount <= 0n) continue;
    const best = totals.get(asset);
    if (best === undefined || amount > best) totals.set(asset, amount);
  }

  return [...totals].map(([asset, amount]) => ({ asset, amount }));
}

/**
 * Finds the pool an action settled against.
 *
 * Providers report swaps at router level and do not name the pool, so an
 * explicit pool address is used when present and otherwise the pool is
 * recovered from `(router, token pair)`. Scoping by router is what makes that
 * lookup viable: across the full registry a popular pair such as TON/USDT
 * matches many pools, but within a single router it is nearly always unique
 * (~0.3% of router-scoped pairs remain ambiguous).
 *
 * When several pools still share the key, this refuses rather than guessing.
 * An action attributed to the wrong pool would satisfy a pool-scoped rule for
 * a pool the user never touched — a false positive, which becomes a payout the
 * integrating app cannot claw back.
 */
function resolvePool(
  payload: Record<string, unknown>,
  registry: PoolRegistrySnapshot,
  router: string | null,
  tokenIn: string | null,
  tokenOut: string | null,
): string | null {
  for (const key of ["pool", "pool_address"]) {
    const candidate = normalizeAddress(extractAddress(payload[key]));
    if (candidate && registry.pools.has(candidate)) return candidate;
  }

  if (!router || !tokenIn || !tokenOut) return null;

  const candidates = registry.byPair.get(pairKey(router, tokenIn, tokenOut));
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.address;

  // Several pools share this pair on this router. A single live pool among
  // deprecated ones is still unambiguous; anything else is a genuine tie.
  const live = candidates.filter((pool) => !pool.deprecated);
  return live.length === 1 ? live[0]!.address : null;
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
  // A pTON master means native TON wrapped for pool custody, so it collapses
  // to the TON sentinel here rather than being treated as its own jetton.
  const master = canonicalAsset(extractAddress(jettonMaster));
  if (master) {
    const amount = toBigInt(jettonAmount);
    if (amount === null || amount <= 0n) return null;
    return { asset: master, amount };
  }

  const ton = toBigInt(tonAmount);
  if (ton === null || ton <= 0n) return null;
  return { asset: NATIVE_TON, amount: ton };
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
