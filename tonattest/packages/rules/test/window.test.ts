import { describe, expect, it } from "vitest";
import { parseDuration, isDuration, resolveWindow, withinWindow } from "../src/window.js";
import { CAMPAIGN, DAY, T0 } from "./helpers.js";

describe("parseDuration", () => {
  it.each([
    ["30s", 30],
    ["5m", 300],
    ["12h", 43_200],
    ["7d", 604_800],
    ["2w", 1_209_600],
  ])("parses %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it.each(["7", "d", "7 d", "7D", "-1d", "1.5d", "7dd", ""])(
    "rejects %s with a message that shows the expected form",
    (input) => {
      expect(() => parseDuration(input)).toThrow(/Expected a number followed by/);
    },
  );

  it("recognises valid durations without throwing", () => {
    expect(isDuration("7d")).toBe(true);
    expect(isDuration("soon")).toBe(false);
  });
});

describe("resolveWindow", () => {
  it("defaults to the campaign window", () => {
    expect(resolveWindow(undefined, CAMPAIGN, T0)).toEqual({
      from: CAMPAIGN.from,
      to: T0,
    });
  });

  it("treats the campaign literal the same as no window", () => {
    expect(resolveWindow("campaign", CAMPAIGN, T0)).toEqual(
      resolveWindow(undefined, CAMPAIGN, T0),
    );
  });

  it("measures a relative window back from now, not from the campaign end", () => {
    // "swapped in the last 7 days" has to mean the 7 days before verification,
    // or a user could satisfy it once and let it lapse.
    const window = resolveWindow("7d", CAMPAIGN, T0);
    expect(window).toEqual({ from: T0 - 7 * DAY, to: T0 });
  });

  it("clamps a window that reaches back before the campaign", () => {
    const window = resolveWindow("365d", CAMPAIGN, T0);
    expect(window.from).toBe(CAMPAIGN.from);
  });

  it("never extends past the campaign end, even when evaluated later", () => {
    const window = resolveWindow(undefined, CAMPAIGN, CAMPAIGN.to + 10 * DAY);
    expect(window.to).toBe(CAMPAIGN.to);
  });
});

describe("withinWindow", () => {
  it("includes both bounds", () => {
    const window = { from: 100, to: 200 };
    expect(withinWindow(100, window)).toBe(true);
    expect(withinWindow(200, window)).toBe(true);
    expect(withinWindow(99, window)).toBe(false);
    expect(withinWindow(201, window)).toBe(false);
  });
});
