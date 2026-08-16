import type { Action, KnownAction, LpPosition } from "@ston-rewards/core-types";

/**
 * Pairs LP_ADD and LP_REMOVE events per pool into holding intervals, so
 * `lpHold` rules ("held liquidity for 7 days") can be answered without the
 * rules engine ever re-deriving chain semantics.
 *
 * Matching is FIFO per pool: the oldest open LP units are the ones a
 * withdrawal closes. FIFO is the choice that cannot be gamed — under LIFO a
 * user could park a large deposit, churn small ones on top, and keep an
 * artificially old "oldest position" alive.
 *
 * Removals are allowed to close across several deposits, and a removal with
 * no matching deposit is ignored rather than treated as an error: the wallet
 * may have acquired LP jettons outside the window we resolved.
 */
export function reconstructPositions(
  actions: readonly KnownAction[],
): LpPosition[] {
  const openByPool = new Map<string, OpenSlice[]>();
  const closed: LpPosition[] = [];

  for (const action of sortedByLt(actions)) {
    if (action.type === "LP_ADD") {
      const slices = openByPool.get(action.pool) ?? [];
      slices.push({
        pool: action.pool,
        openedAt: action.occurredAt,
        remaining: action.lpAmount,
        openTxHash: action.txHash,
      });
      openByPool.set(action.pool, slices);
      continue;
    }

    if (action.type !== "LP_REMOVE") continue;

    const slices = openByPool.get(action.pool);
    if (!slices || slices.length === 0) continue;

    let toClose = action.lpAmount;
    while (toClose > 0n && slices.length > 0) {
      const slice = slices[0]!;
      const consumed = slice.remaining <= toClose ? slice.remaining : toClose;

      closed.push({
        pool: slice.pool,
        openedAt: slice.openedAt,
        closedAt: action.occurredAt,
        lpAmount: consumed,
        openTxHash: slice.openTxHash,
        closeTxHash: action.txHash,
      });

      slice.remaining -= consumed;
      toClose -= consumed;
      if (slice.remaining === 0n) slices.shift();
    }
  }

  const open: LpPosition[] = [];
  for (const slices of openByPool.values()) {
    for (const slice of slices) {
      if (slice.remaining <= 0n) continue;
      open.push({
        pool: slice.pool,
        openedAt: slice.openedAt,
        closedAt: null,
        lpAmount: slice.remaining,
        openTxHash: slice.openTxHash,
        closeTxHash: null,
      });
    }
  }

  return [...closed, ...open].sort(
    (a, b) => a.openedAt - b.openedAt || compareStrings(a.openTxHash, b.openTxHash),
  );
}

/** How long a position was (or has been) held, in seconds. */
export function heldSeconds(position: LpPosition, now: number): number {
  return Math.max(0, (position.closedAt ?? now) - position.openedAt);
}

interface OpenSlice {
  readonly pool: string;
  readonly openedAt: number;
  readonly openTxHash: string;
  remaining: bigint;
}

function sortedByLt(actions: readonly KnownAction[]): KnownAction[] {
  return [...actions].sort((a: Action, b: Action) =>
    a.lt === b.lt ? compareStrings(a.txHash, b.txHash) : a.lt < b.lt ? -1 : 1,
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
