import type { Action, AssetId, KnownAction } from "./action.js";

/**
 * A closed or open liquidity position, reconstructed by pairing LP_ADD and
 * LP_REMOVE events per pool. `lpHold` rules are answered from these, not from
 * the raw action list.
 */
export interface LpPosition {
  readonly pool: string;
  readonly openedAt: number;
  /** Unix seconds, or `null` while the position is still open. */
  readonly closedAt: number | null;
  /** LP units currently held in this position slice. */
  readonly lpAmount: bigint;
  readonly openTxHash: string;
  readonly closeTxHash: string | null;
}

/**
 * Everything the rules engine is allowed to see about a wallet.
 *
 * The engine takes this as an argument and never fetches: the same
 * (rule, ActivitySet) pair must always produce byte-identical evidence.
 */
export interface ActivitySet {
  readonly wallet: string;
  /** Sorted ascending by `lt`. Deduplicated by txHash. */
  readonly actions: readonly KnownAction[];
  readonly positions: readonly LpPosition[];
  /** Unix seconds of the wallet's first observed on-chain activity, if known. */
  readonly walletFirstSeenAt: number | null;
  /** The window this set was resolved over, as unix seconds. */
  readonly resolvedFrom: number;
  readonly resolvedTo: number;
}

export interface DecodeResult {
  readonly actions: readonly Action[];
  /** Count of events that matched a STON.fi address but not a known op-code. */
  readonly unknownCount: number;
  /** Total events considered, for computing the unknown rate. */
  readonly consideredCount: number;
}

export type { AssetId };
