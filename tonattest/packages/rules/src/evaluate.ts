import {
  NATIVE_TON,
  type ActivitySet,
  type KnownAction,
  type LpPosition,
  type SwapAction,
} from "@tonattest/core-types";
import { contentHash, ruleHash } from "./hash.js";
import { isAll, isCombinator, type Condition, type Rule } from "./types.js";
import { parseDuration, resolveWindow, withinWindow, type TimeWindow } from "./window.js";

/**
 * Rule evaluation.
 *
 * Pure by construction: it takes an {@link ActivitySet} and never fetches. The
 * same (rule, activity) pair must always produce byte-identical evidence —
 * that is the property the whole product's credibility rests on, and it is
 * what lets a disputed result be re-derived offline years later.
 */

export interface EvaluationContext {
  readonly activity: ActivitySet;
  /** The campaign's own window, unix seconds. */
  readonly campaign: TimeWindow;
  /** Evaluation time, unix seconds. */
  readonly now: number;
  readonly limits?: AntiAbuseLimits;
}

export interface AntiAbuseLimits {
  /**
   * Ceiling on how much volume, in token units, a single wallet can ever have
   * counted toward a campaign.
   */
  readonly maxRewardableVolumePerWallet?: bigint;
  /**
   * Minimum gap between two actions that both count. Rapid-fire activity
   * beyond this is treated as one qualifying action.
   */
  readonly minInterval?: string;
  /** Ignore wallets younger than this. Raises the cost of disposable wallets. */
  readonly minWalletAge?: string;
}

export interface EvaluationResult {
  readonly eligible: boolean;
  readonly ruleHash: string;
  readonly evidence: Evidence;
  readonly evidenceHash: string;
}

export interface Evidence {
  readonly wallet: string;
  readonly evaluatedAt: number;
  readonly window: TimeWindow;
  readonly root: EvidenceNode;
  /** Populated when a wallet-level guard rejected the wallet outright. */
  readonly disqualified?: string;
}

export type EvidenceNode = CombinatorEvidence | ConditionEvidence;

export interface CombinatorEvidence {
  readonly kind: "all" | "any";
  readonly satisfied: boolean;
  readonly children: readonly EvidenceNode[];
}

export interface ConditionEvidence {
  readonly kind: "swap" | "lpAdd" | "lpHold";
  readonly satisfied: boolean;
  /** Human-readable statement of what was required and what was found. */
  readonly detail: string;
  /** The computed aggregates, so a result can be checked without re-running. */
  readonly measured: Record<string, string | number>;
  /** The transactions that contributed. Lets a user audit the answer. */
  readonly txHashes: readonly string[];
  readonly window: TimeWindow;
}

export function evaluate(rule: Rule, context: EvaluationContext): EvaluationResult {
  const disqualified = checkWalletGuards(context);

  // A disqualified wallet is still evaluated, so the evidence shows both the
  // guard that rejected it and how it would otherwise have fared. Returning a
  // bare "no" would be unauditable and unanswerable in support.
  const root = evaluateNode(rule, context);

  const evidence: Evidence = {
    wallet: context.activity.wallet,
    evaluatedAt: context.now,
    window: context.campaign,
    root,
    ...(disqualified ? { disqualified } : {}),
  };

  return {
    eligible: disqualified === null && root.satisfied,
    ruleHash: ruleHash(rule),
    evidence,
    evidenceHash: contentHash(evidence),
  };
}

/** Wallet-level guards that apply regardless of what the rule says. */
function checkWalletGuards(context: EvaluationContext): string | null {
  const minWalletAge = context.limits?.minWalletAge;
  if (!minWalletAge) return null;

  const firstSeen = context.activity.walletFirstSeenAt;
  if (firstSeen === null) {
    // Unknown age is not young age. Refusing on missing data would reject
    // legitimate users whenever the provider cannot answer.
    return null;
  }

  const age = context.now - firstSeen;
  const required = parseDuration(minWalletAge);
  return age < required
    ? `wallet is ${formatDuration(age)} old, but ${minWalletAge} is required`
    : null;
}

function evaluateNode(rule: Rule, context: EvaluationContext): EvidenceNode {
  if (!isCombinator(rule)) return evaluateCondition(rule, context);

  const kind = isAll(rule) ? "all" : "any";
  const children = (isAll(rule) ? rule.all : rule.any).map((child) =>
    evaluateNode(child, context),
  );

  // Every branch is evaluated even once the outcome is decided. Short-circuit
  // would make evidence depend on child order, so the same rule could produce
  // different evidence hashes for the same activity.
  const satisfied =
    kind === "all"
      ? children.every((child) => child.satisfied)
      : children.some((child) => child.satisfied);

  return { kind, satisfied, children };
}

function evaluateCondition(
  condition: Condition,
  context: EvaluationContext,
): ConditionEvidence {
  if ("swap" in condition) return evaluateSwap(condition.swap, context);
  if ("lpAdd" in condition) return evaluateLpAdd(condition.lpAdd, context);
  return evaluateLpHold(condition.lpHold, context);
}

function evaluateSwap(
  spec: Extract<Condition, { swap: unknown }>["swap"],
  context: EvaluationContext,
): ConditionEvidence {
  const window = resolveWindow(spec.window, context.campaign, context.now);
  const netVolume = spec.netVolume ?? true;

  const candidates = applyCooldown(
    context.activity.actions.filter(
      (action): action is SwapAction =>
        action.type === "SWAP" &&
        withinWindow(action.occurredAt, window) &&
        matchesPool(action.pool, spec.pool) &&
        matchesToken(action, spec.token),
    ),
    context.limits?.minInterval,
  );

  const volume = spec.token
    ? swapVolumeForToken(candidates, spec.token, netVolume)
    : swapVolumeAnyToken(candidates, netVolume);

  const capped = applyVolumeCap(volume, context.limits?.maxRewardableVolumePerWallet);
  const usdTotal = candidates.reduce((sum, action) => sum + (action.usd?.amount ?? 0), 0);

  const requirements: string[] = [];
  const failures: string[] = [];

  // With nothing to measure, the shortfall figures are noise: "counted 0 of
  // 100" alongside "found no swaps" tells the user the same thing twice.
  if (candidates.length === 0) {
    return {
      kind: "swap",
      satisfied: false,
      detail: "found no qualifying swaps",
      measured: { qualifyingSwaps: 0, volumeTokenUnits: "0", grossVolumeTokenUnits: "0", volumeUsd: 0, netVolume: netVolume ? 1 : 0 },
      txHashes: [],
      window,
    };
  }

  if (spec.minAmount !== undefined) {
    const required = BigInt(spec.minAmount);
    requirements.push(`${spec.minAmount} token units`);
    if (capped < required) {
      failures.push(`counted ${capped} of ${spec.minAmount} token units`);
    }
  }
  if (spec.minVolumeUsd !== undefined) {
    requirements.push(`$${spec.minVolumeUsd}`);
    if (usdTotal < spec.minVolumeUsd) {
      failures.push(`counted $${usdTotal.toFixed(2)} of $${spec.minVolumeUsd}`);
    }
  }
  if (spec.count !== undefined) {
    requirements.push(`${spec.count} swaps`);
    if (candidates.length < spec.count) {
      failures.push(`found ${candidates.length} of ${spec.count} qualifying swaps`);
    }
  }

  const satisfied = failures.length === 0;

  return {
    kind: "swap",
    satisfied,
    detail: satisfied
      ? `met ${requirements.join(" and ") || "the swap condition"} ` +
        `across ${candidates.length} swap(s)`
      : failures.join("; "),
    measured: {
      qualifyingSwaps: candidates.length,
      volumeTokenUnits: capped.toString(),
      grossVolumeTokenUnits: swapVolumeAnyToken(candidates, false).toString(),
      volumeUsd: Number(usdTotal.toFixed(6)),
      netVolume: netVolume ? 1 : 0,
    },
    txHashes: candidates.map((action) => action.txHash),
    window,
  };
}

function evaluateLpAdd(
  spec: Extract<Condition, { lpAdd: unknown }>["lpAdd"],
  context: EvaluationContext,
): ConditionEvidence {
  const window = resolveWindow(spec.window, context.campaign, context.now);

  const candidates = applyCooldown(
    context.activity.actions.filter(
      (action) =>
        action.type === "LP_ADD" &&
        withinWindow(action.occurredAt, window) &&
        matchesPool(action.pool, spec.pool),
    ),
    context.limits?.minInterval,
  );

  const lpTotal = candidates.reduce(
    (sum, action) => sum + (action.type === "LP_ADD" ? action.lpAmount : 0n),
    0n,
  );
  const usdTotal = candidates.reduce((sum, action) => sum + (action.usd?.amount ?? 0), 0);

  const failures: string[] = [];
  const requirements: string[] = [];

  if (candidates.length === 0) {
    return {
      kind: "lpAdd",
      satisfied: false,
      detail: "found no qualifying liquidity deposits",
      measured: { qualifyingDeposits: 0, lpUnits: "0", valueUsd: 0 },
      txHashes: [],
      window,
    };
  }

  if (spec.minLpAmount !== undefined) {
    requirements.push(`${spec.minLpAmount} LP units`);
    if (lpTotal < BigInt(spec.minLpAmount)) {
      failures.push(`counted ${lpTotal} of ${spec.minLpAmount} LP units`);
    }
  }
  if (spec.minAmountUsd !== undefined) {
    requirements.push(`$${spec.minAmountUsd}`);
    if (usdTotal < spec.minAmountUsd) {
      failures.push(`counted $${usdTotal.toFixed(2)} of $${spec.minAmountUsd}`);
    }
  }
  if (spec.count !== undefined) {
    requirements.push(`${spec.count} deposits`);
    if (candidates.length < spec.count) {
      failures.push(`found ${candidates.length} of ${spec.count} qualifying deposits`);
    }
  }

  const satisfied = failures.length === 0;

  return {
    kind: "lpAdd",
    satisfied,
    detail: satisfied
      ? `met ${requirements.join(" and ") || "the lpAdd condition"} ` +
        `across ${candidates.length} deposit(s)`
      : failures.join("; "),
    measured: {
      qualifyingDeposits: candidates.length,
      lpUnits: lpTotal.toString(),
      valueUsd: Number(usdTotal.toFixed(6)),
    },
    txHashes: candidates.map((action) => action.txHash),
    window,
  };
}

function evaluateLpHold(
  spec: Extract<Condition, { lpHold: unknown }>["lpHold"],
  context: EvaluationContext,
): ConditionEvidence {
  const required = parseDuration(spec.minDuration);
  const window = { from: context.campaign.from, to: Math.min(context.now, context.campaign.to) };

  const relevant = context.activity.positions.filter((position) =>
    matchesPool(position.pool, spec.pool),
  );

  const qualifying = relevant.filter((position) => {
    if (spec.minLpAmount !== undefined && position.lpAmount < BigInt(spec.minLpAmount)) {
      return false;
    }
    return heldWithin(position, window) >= required;
  });

  const longest = relevant.reduce(
    (best, position) => Math.max(best, heldWithin(position, window)),
    0,
  );

  const satisfied = qualifying.length > 0;

  return {
    kind: "lpHold",
    satisfied,
    detail: satisfied
      ? `held liquidity for ${formatDuration(longest)}, meeting ${spec.minDuration}`
      : relevant.length === 0
        ? "found no liquidity positions in this pool"
        : `longest holding was ${formatDuration(longest)}, short of ${spec.minDuration}`,
    measured: {
      positions: relevant.length,
      qualifyingPositions: qualifying.length,
      longestHoldSeconds: longest,
      requiredSeconds: required,
    },
    txHashes: qualifying.map((position) => position.openTxHash),
    window,
  };
}

/**
 * How long a position was held *within the evaluated window*.
 *
 * Clamping to the window is what stops a position opened long before a
 * campaign from carrying its full age into that campaign's hold requirement.
 */
function heldWithin(position: LpPosition, window: TimeWindow): number {
  const start = Math.max(position.openedAt, window.from);
  const end = Math.min(position.closedAt ?? window.to, window.to);
  return Math.max(0, end - start);
}

function matchesPool(actual: string | undefined, required: string | undefined): boolean {
  if (required === undefined) return true;
  // A swap we could not attribute to a pool must not satisfy a pool-scoped
  // rule. See gap G8: refusing is deliberate, and it has to hold here too.
  return actual !== undefined && actual === required;
}

function matchesToken(action: SwapAction, token: string | undefined): boolean {
  if (token === undefined) return true;
  return action.tokenIn === token || action.tokenOut === token;
}

/**
 * Net volume per asset: `|bought − sold|`.
 *
 * Gross volume is trivially inflated by swapping back and forth, so this is
 * the default. Washing a token in a circle nets to roughly zero.
 */
function swapVolumeForToken(
  swaps: readonly SwapAction[],
  token: string,
  net: boolean,
): bigint {
  let bought = 0n;
  let sold = 0n;
  for (const swap of swaps) {
    if (swap.tokenOut === token) bought += swap.amountOut;
    if (swap.tokenIn === token) sold += swap.amountIn;
  }
  if (!net) return bought + sold;
  return bought > sold ? bought - sold : sold - bought;
}

/**
 * With no token named, volume is measured on the input side — what the user
 * spent — summed across assets.
 *
 * Netting subtracts, per asset, whatever came back: an asset that was sold and
 * then re-bought in equal measure contributes nothing. A one-way swap still
 * counts in full, while a round trip cancels on both of its legs.
 */
function swapVolumeAnyToken(swaps: readonly SwapAction[], net: boolean): bigint {
  if (!net) return swaps.reduce((sum, swap) => sum + swap.amountIn, 0n);

  const spent = new Map<string, bigint>();
  const received = new Map<string, bigint>();
  for (const swap of swaps) {
    spent.set(swap.tokenIn, (spent.get(swap.tokenIn) ?? 0n) + swap.amountIn);
    received.set(swap.tokenOut, (received.get(swap.tokenOut) ?? 0n) + swap.amountOut);
  }

  let total = 0n;
  // Sorted so the result cannot depend on Map insertion order.
  for (const asset of [...spent.keys()].sort()) {
    const net = spent.get(asset)! - (received.get(asset) ?? 0n);
    if (net > 0n) total += net;
  }
  return total;
}

/**
 * Drops actions that follow too closely on the previous counted one.
 *
 * Applied before any aggregate is computed, so a burst of rapid-fire swaps
 * cannot be used to inflate either a count or a volume.
 */
function applyCooldown<T extends KnownAction>(
  actions: readonly T[],
  minInterval: string | undefined,
): T[] {
  const sorted = [...actions].sort((a, b) =>
    a.lt === b.lt ? compare(a.txHash, b.txHash) : a.lt < b.lt ? -1 : 1,
  );
  if (!minInterval) return sorted;

  const gap = parseDuration(minInterval);
  const kept: T[] = [];
  let lastAt = Number.NEGATIVE_INFINITY;

  for (const action of sorted) {
    if (action.occurredAt - lastAt < gap) continue;
    kept.push(action);
    lastAt = action.occurredAt;
  }
  return kept;
}

function applyVolumeCap(volume: bigint, cap: bigint | undefined): bigint {
  if (cap === undefined) return volume;
  return volume > cap ? cap : volume;
}

function formatDuration(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export { NATIVE_TON };
