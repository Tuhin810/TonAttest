import { describe, expect, it } from "vitest";
import { canonicalize, contentHash, ruleHash } from "../src/hash.js";
import { all, swap } from "../src/builder.js";

/**
 * RFC 8785 (JCS). Attestations are signed over these exact bytes, so a
 * signature scheme only this implementation can reproduce would be worthless.
 */
describe("canonicalize — RFC 8785", () => {
  it("sorts object keys by code unit", () => {
    expect(canonicalize({ b: 1, a: 2, C: 3 })).toBe('{"C":3,"a":2,"b":1}');
  });

  it("sorts nested objects too", () => {
    expect(canonicalize({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("emits no whitespace", () => {
    expect(canonicalize({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it("drops undefined-valued keys, as JSON does", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("normalizes negative zero", () => {
    expect(canonicalize(-0)).toBe("0");
  });

  it.each([
    [1, "1"],
    [1.5, "1.5"],
    [1e21, "1e+21"],
    [-0.000001, "-0.000001"],
    [123456789012345678901234567890, "1.2345678901234568e+29"],
  ])("serializes %s as the shortest round-trippable form", (input, expected) => {
    expect(canonicalize(input)).toBe(expected);
  });

  it("escapes control characters and quotes", () => {
    expect(canonicalize('a"b\nc')).toBe('"a\\"b\\nc"');
  });

  it("handles non-ASCII text", () => {
    expect(canonicalize("café ☕")).toBe('"café ☕"');
  });

  it("rejects a bigint rather than silently coercing it", () => {
    // Coercing would make the signature depend on a lossy conversion.
    expect(() => canonicalize(1n)).toThrow(/bigint/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (input) => {
    expect(() => canonicalize(input)).toThrow(/non-finite/);
  });

  it("round-trips to the same value it started from", () => {
    const value = { b: [1, "two", true, null], a: { c: 1.5 } };
    expect(JSON.parse(canonicalize(value))).toEqual(value);
  });
});

describe("ruleHash", () => {
  it("is stable across key order", () => {
    const a = { swap: { count: 2, minAmount: "100" } };
    const b = { swap: { minAmount: "100", count: 2 } };
    expect(ruleHash(a as never)).toBe(ruleHash(b as never));
  });

  it("is stable across whitespace and re-parsing", () => {
    const rule = all(swap({ minAmount: 100n }), swap({ count: 2 }));
    expect(ruleHash(JSON.parse(JSON.stringify(rule)))).toBe(ruleHash(rule));
  });

  it("changes when any threshold changes", () => {
    expect(ruleHash(swap({ count: 1 }))).not.toBe(ruleHash(swap({ count: 2 })));
  });

  it("distinguishes all from any", () => {
    expect(ruleHash(all(swap({ count: 1 })))).not.toBe(
      ruleHash({ any: [swap({ count: 1 })] }),
    );
  });

  it("is prefixed so the algorithm is never in doubt", () => {
    expect(ruleHash(swap({ count: 1 }))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("contentHash", () => {
  it("hashes arbitrary canonicalizable values", () => {
    expect(contentHash({ a: 1 })).toBe(contentHash({ a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});
