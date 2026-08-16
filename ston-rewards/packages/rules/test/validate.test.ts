import { describe, expect, it } from "vitest";
import { StonRewardsError } from "@ston-rewards/core-types";
import { all, any, lpAdd, lpHold, swap } from "../src/builder.js";
import { isValidRule, validateRule } from "../src/validate.js";

describe("validateRule — structure", () => {
  it("accepts a single condition", () => {
    expect(validateRule(swap({ minVolumeUsd: 50 }))).toEqual({ swap: { minVolumeUsd: 50 } });
  });

  it("accepts nested combinators up to the depth limit", () => {
    const rule = all(any(all(swap({ count: 1 })), swap({ count: 2 })), swap({ count: 3 }));
    expect(() => validateRule(rule)).not.toThrow();
  });

  it("rejects nesting past the depth limit, naming the level", () => {
    // Bounded depth keeps evaluation cheap and rules explainable.
    const rule = all(any(all(any(swap({ count: 1 })))));
    expect(() => validateRule(rule)).toThrow(/at most 3 levels deep/);
  });

  it("rejects an object with more than one rule key", () => {
    expect(() => validateRule({ swap: { count: 1 }, lpAdd: { count: 1 } })).toThrow(
      /exactly one of/,
    );
  });

  it("rejects an empty object", () => {
    expect(() => validateRule({})).toThrow(/empty object/);
  });

  it("rejects an unknown rule type", () => {
    expect(() => validateRule({ stake: { minAmount: "1" } })).toThrow(/unknown rule type/);
  });

  it("rejects an empty combinator array", () => {
    // An empty `all` is vacuously true — almost always a bug in rule generation.
    expect(() => validateRule({ all: [] })).toThrow(/at least one rule/);
    expect(() => validateRule({ any: [] })).toThrow(/at least one rule/);
  });

  it("rejects a combinator whose value is not an array", () => {
    expect(() => validateRule({ all: swap({ count: 1 }) })).toThrow(/expected an array/);
  });

  it("names the exact path of a nested failure", () => {
    const rule = all(swap({ count: 1 }), any(swap({ count: 1 }), { lpHold: {} } as never));
    expect(() => validateRule(rule)).toThrow(/\$\.all\[1\]\.any\[1\]\.lpHold\.minDuration/);
  });

  it.each([null, 42, "swap", [], undefined])("rejects %s as a rule", (input) => {
    expect(() => validateRule(input)).toThrow(StonRewardsError);
  });
});

describe("validateRule — swap fields", () => {
  it("rejects an unknown field rather than ignoring it", () => {
    // A typo like `minAmmount` would otherwise silently match everything.
    expect(() => validateRule({ swap: { minAmmount: "100" } })).toThrow(
      /unknown field; expected one of/,
    );
  });

  it("rejects a swap condition with no fields at all", () => {
    expect(() => validateRule({ swap: {} })).toThrow(/matches any swap at all/);
  });

  it("requires token amounts as decimal strings", () => {
    expect(() => validateRule({ swap: { minAmount: 100 } })).toThrow(/decimal string/);
    expect(() => validateRule({ swap: { minAmount: "1e9" } })).toThrow(/decimal string/);
    expect(validateRule({ swap: { minAmount: "100" } })).toEqual({
      swap: { minAmount: "100" },
    });
  });

  it("rejects a zero threshold, which would match everything", () => {
    expect(() => validateRule({ swap: { minAmount: "0" } })).toThrow(/positive amount/);
  });

  it("rejects a non-positive USD threshold", () => {
    expect(() => validateRule({ swap: { minVolumeUsd: 0 } })).toThrow(/positive number of USD/);
    expect(() => validateRule({ swap: { minVolumeUsd: -5 } })).toThrow(/positive number of USD/);
  });

  it("rejects a fractional or zero count", () => {
    expect(() => validateRule({ swap: { count: 1.5 } })).toThrow(/whole number/);
    expect(() => validateRule({ swap: { count: 0 } })).toThrow(/whole number/);
  });

  it("rejects a malformed window and suggests the right form", () => {
    expect(() => validateRule({ swap: { count: 1, window: "1 week" } })).toThrow(
      /expected a duration such as "7d"/,
    );
  });

  it("accepts the campaign window literal", () => {
    expect(() => validateRule({ swap: { count: 1, window: "campaign" } })).not.toThrow();
  });

  it("rejects a non-boolean netVolume", () => {
    expect(() => validateRule({ swap: { count: 1, netVolume: "yes" } })).toThrow(
      /expected true or false/,
    );
  });

  it("rejects an empty string for token or pool", () => {
    expect(() => validateRule({ swap: { token: "" } })).toThrow(/non-empty string/);
  });
});

describe("validateRule — lpAdd and lpHold", () => {
  it("accepts a valid lpAdd", () => {
    expect(validateRule(lpAdd({ minLpAmount: 100n, pool: "0:abc" }))).toEqual({
      lpAdd: { minLpAmount: "100", pool: "0:abc" },
    });
  });

  it("rejects an lpAdd with no fields", () => {
    expect(() => validateRule({ lpAdd: {} })).toThrow(/matches any deposit at all/);
  });

  it("requires minDuration on lpHold", () => {
    expect(() => validateRule({ lpHold: { pool: "0:abc" } })).toThrow(/required/);
  });

  it("requires minDuration to be a duration", () => {
    expect(() => validateRule({ lpHold: { minDuration: "a while" } })).toThrow(/such as "7d"/);
  });

  it("accepts a minimal lpHold", () => {
    expect(validateRule(lpHold({ minDuration: "7d" }))).toEqual({
      lpHold: { minDuration: "7d" },
    });
  });
});

describe("isValidRule", () => {
  it("answers without throwing", () => {
    expect(isValidRule(swap({ count: 1 }))).toBe(true);
    expect(isValidRule({ swap: {} })).toBe(false);
  });
});

describe("builders", () => {
  it("serializes bigint thresholds to strings", () => {
    expect(swap({ minAmount: 10n ** 18n }).swap.minAmount).toBe("1000000000000000000");
  });

  it("omits absent options entirely rather than writing undefined", () => {
    // `{}` and `{ token: undefined }` must not hash differently.
    expect(Object.keys(swap({ count: 1 }).swap)).toEqual(["count"]);
  });

  it("produces plain JSON that survives a round trip", () => {
    const rule = all(swap({ minAmount: 100n }), lpHold({ minDuration: "7d" }));
    expect(JSON.parse(JSON.stringify(rule))).toEqual(rule);
  });

  it("builds any() the same way", () => {
    expect(any(swap({ count: 1 }))).toEqual({ any: [{ swap: { count: 1 } }] });
  });
});
