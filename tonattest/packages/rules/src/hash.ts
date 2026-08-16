import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";
import type { Rule } from "./types.js";

/**
 * RFC 8785 (JCS) canonical JSON.
 *
 * Two things depend on this being exactly right. A rule's hash binds an
 * attestation to the rule that produced it, so the same rule must hash
 * identically regardless of key order or whitespace. And attestations are
 * signed over canonical JSON, so any other implementation — in any language —
 * must be able to reproduce the same bytes.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value);
    case "string":
      return canonicalString(value);
    case "bigint":
      // A bigint has no JSON representation. Silently coercing it would make
      // the signature depend on a lossy conversion, so it is rejected.
      throw new TypeError(
        "Cannot canonicalize a bigint; convert it to a decimal string first",
      );
    case "object":
      break;
    default:
      throw new TypeError(`Cannot canonicalize a value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  // Keys sort by UTF-16 code unit, which is what String comparison already
  // does in JavaScript. Undefined-valued keys are dropped, matching JSON.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, v]) => `${canonicalString(key)}:${canonicalize(v)}`)
    .join(",")}}`;
}

/**
 * JCS requires the shortest round-trippable representation, which is exactly
 * what JavaScript's own number-to-string produces — except for the values JSON
 * cannot represent at all.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot canonicalize a non-finite number: ${value}`);
  }
  // Normalizes -0 to 0, as JSON.stringify does.
  return JSON.stringify(value);
}

function canonicalString(value: string): string {
  return JSON.stringify(value);
}

/**
 * `sha256:<hex>` over the rule's canonical form.
 *
 * Hashing comes from `@noble/hashes` rather than `node:crypto` so that this
 * whole path stays runtime-agnostic: the SDK ships the same rule builder and
 * offline attestation check to Node, browsers, Telegram Mini Apps, and edge
 * runtimes, and a single Node built-in anywhere in the graph would break the
 * last three.
 */
export function ruleHash(rule: Rule): string {
  return contentHash(rule);
}

/** `sha256:<hex>` over any canonicalizable value — used for evidence hashes. */
export function contentHash(value: unknown): string {
  const digest = sha256(utf8ToBytes(canonicalize(value)));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
