import { StonRewardsError } from "@ston-rewards/core-types";
import { MAX_RULE_DEPTH, isCombinator, type Rule } from "./types.js";
import { CAMPAIGN_WINDOW, isDuration } from "./window.js";

/**
 * Validates a rule and returns it narrowed to {@link Rule}.
 *
 * Every message names the offending path and says what was expected. A rule is
 * usually written once and then evaluated against real users' money for weeks;
 * the cost of a vague error here is paid many times over.
 *
 * Unknown fields are rejected rather than ignored. A typo like `minAmmount`
 * would otherwise produce a rule that silently matches everything.
 */
export function validateRule(input: unknown): Rule {
  return validateAt(input, "$", 1);
}

/** True when the input is a valid rule. Useful at boundaries that prefer no throw. */
export function isValidRule(input: unknown): input is Rule {
  try {
    validateRule(input);
    return true;
  } catch {
    return false;
  }
}

function validateAt(input: unknown, path: string, depth: number): Rule {
  const node = asObject(input, path);
  const keys = Object.keys(node);

  if (keys.length !== 1) {
    throw invalid(
      path,
      `expected exactly one of "all", "any", "swap", "lpAdd", or "lpHold", ` +
        `but found ${keys.length === 0 ? "an empty object" : `[${keys.join(", ")}]`}`,
    );
  }

  const key = keys[0]!;
  switch (key) {
    case "all":
    case "any":
      return validateCombinator(node[key], key, path, depth);
    case "swap":
      return { swap: validateSwap(node[key], `${path}.swap`) };
    case "lpAdd":
      return { lpAdd: validateLpAdd(node[key], `${path}.lpAdd`) };
    case "lpHold":
      return { lpHold: validateLpHold(node[key], `${path}.lpHold`) };
    default:
      throw invalid(
        path,
        `unknown rule type ${JSON.stringify(key)}; expected "all", "any", ` +
          `"swap", "lpAdd", or "lpHold"`,
      );
  }
}

function validateCombinator(
  value: unknown,
  key: "all" | "any",
  path: string,
  depth: number,
): Rule {
  if (depth > MAX_RULE_DEPTH) {
    throw invalid(
      path,
      `rules may nest at most ${MAX_RULE_DEPTH} levels deep; this is level ${depth}`,
    );
  }
  if (!Array.isArray(value)) {
    throw invalid(`${path}.${key}`, "expected an array of rules");
  }
  if (value.length === 0) {
    // An empty `all` is vacuously true and an empty `any` vacuously false.
    // Both are almost certainly a bug in the caller's rule generation.
    throw invalid(`${path}.${key}`, "expected at least one rule, but the array is empty");
  }

  const rules = value.map((child, i) =>
    validateAt(child, `${path}.${key}[${i}]`, depth + 1),
  );
  return key === "all" ? { all: rules } : { any: rules };
}

const SWAP_FIELDS = [
  "minAmount",
  "minVolumeUsd",
  "token",
  "pool",
  "count",
  "window",
  "netVolume",
] as const;

function validateSwap(value: unknown, path: string) {
  const node = asObject(value, path);
  rejectUnknownFields(node, SWAP_FIELDS, path);

  const condition = {
    ...optionalAmount(node["minAmount"], `${path}.minAmount`, "minAmount"),
    ...optionalUsd(node["minVolumeUsd"], `${path}.minVolumeUsd`, "minVolumeUsd"),
    ...optionalString(node["token"], `${path}.token`, "token"),
    ...optionalString(node["pool"], `${path}.pool`, "pool"),
    ...optionalCount(node["count"], `${path}.count`),
    ...optionalWindow(node["window"], `${path}.window`),
    ...optionalBoolean(node["netVolume"], `${path}.netVolume`, "netVolume"),
  };

  if (Object.keys(condition).length === 0) {
    throw invalid(
      path,
      "a swap condition with no fields matches any swap at all; set at least " +
        "one of minAmount, minVolumeUsd, count, token, or pool",
    );
  }
  return condition;
}

const LP_ADD_FIELDS = ["minLpAmount", "minAmountUsd", "pool", "count", "window"] as const;

function validateLpAdd(value: unknown, path: string) {
  const node = asObject(value, path);
  rejectUnknownFields(node, LP_ADD_FIELDS, path);

  const condition = {
    ...optionalAmount(node["minLpAmount"], `${path}.minLpAmount`, "minLpAmount"),
    ...optionalUsd(node["minAmountUsd"], `${path}.minAmountUsd`, "minAmountUsd"),
    ...optionalString(node["pool"], `${path}.pool`, "pool"),
    ...optionalCount(node["count"], `${path}.count`),
    ...optionalWindow(node["window"], `${path}.window`),
  };

  if (Object.keys(condition).length === 0) {
    throw invalid(
      path,
      "an lpAdd condition with no fields matches any deposit at all; set at " +
        "least one of minLpAmount, minAmountUsd, count, or pool",
    );
  }
  return condition;
}

const LP_HOLD_FIELDS = ["minDuration", "minLpAmount", "pool"] as const;

function validateLpHold(value: unknown, path: string) {
  const node = asObject(value, path);
  rejectUnknownFields(node, LP_HOLD_FIELDS, path);

  const minDuration = node["minDuration"];
  if (typeof minDuration !== "string" || !isDuration(minDuration)) {
    throw invalid(
      `${path}.minDuration`,
      `required, and must be a duration such as "7d"; got ${JSON.stringify(minDuration)}`,
    );
  }

  return {
    minDuration,
    ...optionalAmount(node["minLpAmount"], `${path}.minLpAmount`, "minLpAmount"),
    ...optionalString(node["pool"], `${path}.pool`, "pool"),
  };
}

function rejectUnknownFields(
  node: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(node)) {
    if (allowed.includes(key)) continue;
    throw invalid(
      `${path}.${key}`,
      `unknown field; expected one of ${allowed.join(", ")}`,
    );
  }
}

function optionalAmount(value: unknown, path: string, key: string) {
  if (value === undefined) return {};
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw invalid(
      path,
      `expected a decimal string of token units, such as "1000000000"; ` +
        `got ${JSON.stringify(value)}`,
    );
  }
  if (BigInt(value) <= 0n) {
    throw invalid(path, "expected a positive amount; a threshold of 0 matches everything");
  }
  return { [key]: value };
}

function optionalUsd(value: unknown, path: string, key: string) {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(path, `expected a positive number of USD; got ${JSON.stringify(value)}`);
  }
  return { [key]: value };
}

function optionalCount(value: unknown, path: string) {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid(path, `expected a whole number of at least 1; got ${JSON.stringify(value)}`);
  }
  return { count: value };
}

function optionalWindow(value: unknown, path: string) {
  if (value === undefined) return {};
  if (typeof value !== "string" || (value !== CAMPAIGN_WINDOW && !isDuration(value))) {
    throw invalid(
      path,
      `expected a duration such as "7d", or ${JSON.stringify(CAMPAIGN_WINDOW)}; ` +
        `got ${JSON.stringify(value)}`,
    );
  }
  return { window: value };
}

function optionalString(value: unknown, path: string, key: string) {
  if (value === undefined) return {};
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(path, `expected a non-empty string; got ${JSON.stringify(value)}`);
  }
  return { [key]: value };
}

function optionalBoolean(value: unknown, path: string, key: string) {
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw invalid(path, `expected true or false; got ${JSON.stringify(value)}`);
  }
  return { [key]: value };
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(path, `expected an object; got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function invalid(path: string, message: string): StonRewardsError {
  return new StonRewardsError("INVALID_RULE", `${path}: ${message}`, { retryable: false });
}
