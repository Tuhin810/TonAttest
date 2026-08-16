import type {
  AllCombinator,
  AnyCombinator,
  LpAddCondition,
  LpHoldCondition,
  Rule,
  SwapCondition,
  Window,
} from "./types.js";

/**
 * Typed builders over the JSON rule shape.
 *
 * These produce exactly the JSON in `types.ts` — there is no second
 * representation to keep in step. Their job is to make thresholds hard to get
 * wrong: token amounts are accepted as `bigint` and serialized to strings
 * here, so a caller never has to remember that a rule stores them as text.
 */

export interface SwapOptions {
  readonly minAmount?: bigint;
  readonly minVolumeUsd?: number;
  readonly token?: string;
  readonly pool?: string;
  readonly count?: number;
  readonly window?: Window;
  readonly netVolume?: boolean;
}

export function swap(options: SwapOptions = {}): SwapCondition {
  return {
    swap: {
      ...optionalBigint("minAmount", options.minAmount),
      ...optional("minVolumeUsd", options.minVolumeUsd),
      ...optional("token", options.token),
      ...optional("pool", options.pool),
      ...optional("count", options.count),
      ...optional("window", options.window),
      ...optional("netVolume", options.netVolume),
    },
  };
}

export interface LpAddOptions {
  readonly minLpAmount?: bigint;
  readonly minAmountUsd?: number;
  readonly pool?: string;
  readonly count?: number;
  readonly window?: Window;
}

export function lpAdd(options: LpAddOptions = {}): LpAddCondition {
  return {
    lpAdd: {
      ...optionalBigint("minLpAmount", options.minLpAmount),
      ...optional("minAmountUsd", options.minAmountUsd),
      ...optional("pool", options.pool),
      ...optional("count", options.count),
      ...optional("window", options.window),
    },
  };
}

export interface LpHoldOptions {
  readonly minDuration: Window;
  readonly minLpAmount?: bigint;
  readonly pool?: string;
}

export function lpHold(options: LpHoldOptions): LpHoldCondition {
  return {
    lpHold: {
      minDuration: options.minDuration,
      ...optionalBigint("minLpAmount", options.minLpAmount),
      ...optional("pool", options.pool),
    },
  };
}

export function all(...rules: Rule[]): AllCombinator {
  return { all: rules };
}

export function any(...rules: Rule[]): AnyCombinator {
  return { any: rules };
}

/**
 * Omitting a key entirely rather than writing `undefined` matters: the rule is
 * hashed, and `{}` and `{ token: undefined }` must not produce different
 * hashes for what is the same rule.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function optionalBigint<K extends string>(
  key: K,
  value: bigint | undefined,
): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value.toString() } as Record<K, string>);
}
