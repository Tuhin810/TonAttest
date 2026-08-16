import type { StonRewardsError } from "@ston-rewards/core-types";

/**
 * The seam that keeps a self-hosted indexer a drop-in replacement later
 * (design doc §5). Nothing above this interface knows what tonapi is.
 */
export interface DataProvider {
  readonly name: string;

  /**
   * Account events in descending `lt` order, newest first.
   * Implementations must page until `from` is crossed or `limit` is hit.
   *
   * Throws {@link StonRewardsError} with a retryable code on transport
   * failure — callers must never see a partial list presented as complete.
   */
  getAccountEvents(params: GetAccountEventsParams): Promise<RawEventPage>;

  /** Unix seconds of the account's first activity, or null if unknown. */
  getAccountFirstActivity(address: string): Promise<number | null>;
}

export interface GetAccountEventsParams {
  readonly address: string;
  /** Inclusive lower bound, unix seconds. */
  readonly from: number;
  /** Inclusive upper bound, unix seconds. */
  readonly to: number;
  /** Hard cap on events fetched, to bound cost against whale wallets. */
  readonly limit?: number;
}

export interface RawEventPage {
  readonly events: readonly RawEvent[];
  /**
   * True when `limit` cut the result short. The resolver treats this as a
   * correctness problem, not a pagination detail: an incomplete history can
   * silently under-count volume, so it fails closed rather than evaluating.
   */
  readonly truncated: boolean;
}

/**
 * Provider-agnostic event shape. Deliberately close to tonapi's account-event
 * model, but with only the fields the decoder actually reads, so a second
 * provider does not have to fabricate tonapi internals.
 */
export interface RawEvent {
  readonly eventId: string;
  /**
   * The account the event was listed under. Absent when an event is fetched
   * by id rather than through an account listing, and unused by decoding —
   * attribution is done per action, against the wallet being verified.
   */
  readonly account?: string;
  readonly timestamp: number;
  readonly lt: bigint;
  /** False while the event is still being finalized; such events are skipped. */
  readonly inProgress: boolean;
  readonly actions: readonly RawAction[];
}

export interface RawAction {
  /** Provider's semantic action label, e.g. "JettonSwap", "JettonTransfer". */
  readonly type: string;
  readonly status: "ok" | "failed" | string;
  /** The provider's decoded payload for this action type, shape-checked later. */
  readonly payload: Record<string, unknown>;
}
