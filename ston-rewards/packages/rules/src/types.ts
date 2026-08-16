/**
 * The rule DSL.
 *
 * Rules are plain JSON so they can be stored, hashed, transmitted, and
 * re-evaluated years later by code that does not share this package. The typed
 * builder in `builder.ts` is a convenience over exactly this shape — never a
 * separate representation.
 */

/** Maximum nesting depth of combinators. Keeps evaluation bounded and rules explainable. */
export const MAX_RULE_DEPTH = 3;

export type Rule = Condition | Combinator;

export type Combinator = AllCombinator | AnyCombinator;

export interface AllCombinator {
  readonly all: readonly Rule[];
}

export interface AnyCombinator {
  readonly any: readonly Rule[];
}

export type Condition = SwapCondition | LpAddCondition | LpHoldCondition;

/**
 * A relative window such as "7d", or the literal "campaign" meaning the
 * campaign's own start. Conditions evaluate over the campaign window unless a
 * narrower one is given.
 */
export type Window = string;

export interface SwapCondition {
  readonly swap: {
    /**
     * Threshold in token units, as a decimal string.
     *
     * A string, not a number, because token amounts routinely exceed what a
     * double can hold exactly, and because a rule is stored and re-parsed as
     * JSON — where a bigint would not survive the round trip.
     */
    readonly minAmount?: string;
    /**
     * Threshold in USD. Optional sugar: USD depends on a rate source and a
     * moment in time, so it can be disputed in a way token units cannot.
     */
    readonly minVolumeUsd?: number;
    /** Restrict to swaps of this asset, on either side. "TON" or a jetton master. */
    readonly token?: string;
    /** Restrict to a single pool. */
    readonly pool?: string;
    /** Require at least this many qualifying swaps. */
    readonly count?: number;
    readonly window?: Window;
    /**
     * Count `|bought − sold|` per asset rather than gross volume. Defaults to
     * true: gross volume is trivially inflated by swapping back and forth.
     */
    readonly netVolume?: boolean;
  };
}

export interface LpAddCondition {
  readonly lpAdd: {
    /** Threshold in LP units, as a decimal string. */
    readonly minLpAmount?: string;
    readonly minAmountUsd?: number;
    readonly pool?: string;
    readonly count?: number;
    readonly window?: Window;
  };
}

export interface LpHoldCondition {
  readonly lpHold: {
    /** Required holding duration, e.g. "7d". The one mandatory field. */
    readonly minDuration: Window;
    readonly minLpAmount?: string;
    readonly pool?: string;
  };
}

export function isCombinator(rule: Rule): rule is Combinator {
  return "all" in rule || "any" in rule;
}

export function isAll(rule: Rule): rule is AllCombinator {
  return "all" in rule;
}
