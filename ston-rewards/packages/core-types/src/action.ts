/**
 * Normalized STON.fi actions. This is the boundary between the decoder
 * (Phase 1) and everything downstream: the rules engine only ever sees
 * these shapes, never raw chain events.
 *
 * Amounts are always bigint token units. USD is decorative and optional —
 * see the design doc, §15.1.
 */

export type ActionType = "SWAP" | "LP_ADD" | "LP_REMOVE" | "UNKNOWN";

/** A jetton master address, or the literal "TON" for the native coin. */
export type AssetId = string;

export interface UsdValuation {
  /** Value in USD at the time of the event, as a float. Never used for equality. */
  readonly amount: number;
  /** Where the rate came from, e.g. "stonfi:rates". Recorded in evidence. */
  readonly source: string;
  /** Unix seconds at which the rate was observed. */
  readonly at: number;
}

interface ActionBase {
  readonly type: ActionType;
  /** Base64 tx hash. The replay guard key — unique across the whole system. */
  readonly txHash: string;
  /**
   * TON logical time. The ordering key: timestamps collide within a block,
   * `lt` does not.
   */
  readonly lt: bigint;
  /** Raw (non-bounceable) address of the acting wallet. */
  readonly wallet: string;
  /** Unix seconds. Display and windowing only — never for ordering. */
  readonly occurredAt: number;
  /** STON.fi pool contract address, when the action is pool-scoped. */
  readonly pool?: string;
  readonly usd?: UsdValuation;
}

export interface SwapAction extends ActionBase {
  readonly type: "SWAP";
  /** The STON.fi router that settled the swap. Always known. */
  readonly router: string;
  /**
   * The pool, when it can be identified unambiguously.
   *
   * Providers report swaps at router level and do not name the pool, so this
   * is resolved by matching the token pair against the registry and is absent
   * whenever several pools share that pair. A pool-scoped rule simply will not
   * match such a swap — which is the correct outcome, and far better than
   * discarding a real swap or attributing it to a pool it may not have used.
   */
  readonly pool?: string;
  readonly tokenIn: AssetId;
  readonly tokenOut: AssetId;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export interface LpAddAction extends ActionBase {
  readonly type: "LP_ADD";
  readonly pool: string;
  /** LP jetton units minted to the wallet. */
  readonly lpAmount: bigint;
  readonly assets: readonly LpLeg[];
}

export interface LpRemoveAction extends ActionBase {
  readonly type: "LP_REMOVE";
  readonly pool: string;
  /** LP jetton units burned by the wallet. */
  readonly lpAmount: bigint;
  readonly assets: readonly LpLeg[];
}

export interface LpLeg {
  readonly asset: AssetId;
  readonly amount: bigint;
}

/**
 * An event that matched a known STON.fi address but not a known op-code.
 *
 * These are never dropped: a rising UNKNOWN rate is the early-warning signal
 * that STON.fi shipped a contract change we do not decode yet. The raw payload
 * is retained so the event can be re-decoded later without re-fetching.
 */
export interface UnknownAction extends ActionBase {
  readonly type: "UNKNOWN";
  readonly opCode?: number;
  readonly raw: unknown;
}

export type Action =
  | SwapAction
  | LpAddAction
  | LpRemoveAction
  | UnknownAction;

/** Actions the rules engine can reason about. */
export type KnownAction = SwapAction | LpAddAction | LpRemoveAction;

export function isKnownAction(a: Action): a is KnownAction {
  return a.type !== "UNKNOWN";
}
