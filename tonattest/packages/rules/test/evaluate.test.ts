import { beforeEach, describe, expect, it } from "vitest";
import { all, any, lpAdd, lpHold, swap } from "../src/builder.js";
import { evaluate, type AntiAbuseLimits } from "../src/evaluate.js";
import type { Rule } from "../src/types.js";
import {
  CAMPAIGN,
  DAY,
  NOT,
  POOL_A,
  POOL_B,
  T0,
  USDT,
  activity,
  lpAddAction,
  position,
  resetSeq,
  swapAction,
} from "./helpers.js";

beforeEach(resetSeq);

function run(
  rule: Rule,
  act: ReturnType<typeof activity>,
  limits?: AntiAbuseLimits,
  now = T0 + DAY,
) {
  return evaluate(rule, {
    activity: act,
    campaign: CAMPAIGN,
    now,
    ...(limits ? { limits } : {}),
  });
}

describe("swap conditions", () => {
  it("counts token-unit volume on the input side", () => {
    const result = run(
      swap({ minAmount: 2_000_000_000n }),
      activity({ actions: [swapAction(), swapAction()] }),
    );
    expect(result.eligible).toBe(true);
  });

  it("fails when volume falls short, and says by how much", () => {
    const result = run(
      swap({ minAmount: 5_000_000_000n }),
      activity({ actions: [swapAction()] }),
    );

    expect(result.eligible).toBe(false);
    // The shortfall is the single most useful thing a user can be told.
    expect(result.evidence.root).toMatchObject({
      satisfied: false,
      detail: expect.stringContaining("of 5000000000 token units"),
    });
  });

  it("fails with no activity at all rather than vacuously passing", () => {
    const result = run(swap({ minAmount: 1n }), activity());
    expect(result.eligible).toBe(false);
    expect(result.evidence.root).toMatchObject({ detail: "found no qualifying swaps" });
  });

  it("requires a minimum swap count", () => {
    expect(run(swap({ count: 3 }), activity({ actions: [swapAction(), swapAction()] })).eligible)
      .toBe(false);
    expect(
      run(swap({ count: 2 }), activity({ actions: [swapAction(), swapAction()] })).eligible,
    ).toBe(true);
  });

  it("filters by token on either side of the swap", () => {
    const act = activity({ actions: [swapAction({ tokenOut: NOT })] });
    expect(run(swap({ count: 1, token: USDT }), act).eligible).toBe(false);
    expect(run(swap({ count: 1, token: NOT }), act).eligible).toBe(true);
    expect(run(swap({ count: 1, token: "TON" }), act).eligible).toBe(true);
  });

  it("filters by pool", () => {
    const act = activity({ actions: [swapAction({ pool: POOL_B })] });
    expect(run(swap({ count: 1, pool: POOL_A }), act).eligible).toBe(false);
    expect(run(swap({ count: 1, pool: POOL_B }), act).eligible).toBe(true);
  });

  it("does not let an unattributed swap satisfy a pool-scoped rule", () => {
    // Gap G8: refusing to guess a pool has to hold here too, or the refusal
    // in the decoder buys nothing.
    const act = activity({ actions: [swapAction({ pool: undefined })] });
    expect(run(swap({ count: 1, pool: POOL_A }), act).eligible).toBe(false);
  });

  it("counts USD volume when actions carry a valuation", () => {
    const act = activity({
      actions: [swapAction({ usd: { amount: 60, source: "test", at: T0 } })],
    });
    expect(run(swap({ minVolumeUsd: 50 }), act).eligible).toBe(true);
    expect(run(swap({ minVolumeUsd: 100 }), act).eligible).toBe(false);
  });

  it("fails a USD rule when no valuation is attached rather than assuming zero cost", () => {
    // With USD off, actions carry no valuation; a USD rule must not silently
    // pass on unvalued activity.
    const act = activity({ actions: [swapAction()] });
    expect(run(swap({ minVolumeUsd: 1 }), act).eligible).toBe(false);
  });

  it("applies every stated threshold, not just the first", () => {
    const act = activity({ actions: [swapAction()] });
    expect(run(swap({ minAmount: 1n, count: 5 }), act).eligible).toBe(false);
  });
});

describe("swap windows", () => {
  it("excludes activity outside a narrowed window", () => {
    const act = activity({ actions: [swapAction({ occurredAt: T0 - 20 * DAY })] });
    expect(run(swap({ count: 1, window: "7d" }), act).eligible).toBe(false);
    expect(run(swap({ count: 1 }), act).eligible).toBe(true);
  });

  it("excludes activity from before the campaign started", () => {
    const act = activity({ actions: [swapAction({ occurredAt: CAMPAIGN.from - DAY })] });
    expect(run(swap({ count: 1 }), act).eligible).toBe(false);
  });

  it("includes activity exactly on the window boundary", () => {
    const now = T0 + DAY;
    const act = activity({ actions: [swapAction({ occurredAt: now - 7 * DAY })] });
    expect(run(swap({ count: 1, window: "7d" }), act, undefined, now).eligible).toBe(true);
  });
});

describe("net volume", () => {
  it("cancels a round trip by default", () => {
    // Buy 5 USDT, sell it straight back. Gross looks like volume; net is zero.
    const act = activity({
      actions: [
        swapAction({ tokenIn: "TON", tokenOut: USDT, amountIn: 1_000_000_000n, amountOut: 5_000_000n }),
        swapAction({ tokenIn: USDT, tokenOut: "TON", amountIn: 5_000_000n, amountOut: 1_000_000_000n }),
      ],
    });

    expect(run(swap({ minAmount: 1_000_000n, token: USDT }), act).eligible).toBe(false);
  });

  it("counts gross volume when netting is explicitly disabled", () => {
    const act = activity({
      actions: [
        swapAction({ tokenIn: "TON", tokenOut: USDT, amountIn: 1_000_000_000n, amountOut: 5_000_000n }),
        swapAction({ tokenIn: USDT, tokenOut: "TON", amountIn: 5_000_000n, amountOut: 1_000_000_000n }),
      ],
    });

    expect(
      run(swap({ minAmount: 10_000_000n, token: USDT, netVolume: false }), act).eligible,
    ).toBe(true);
  });

  it("still counts a genuine one-way position", () => {
    const act = activity({
      actions: [swapAction({ tokenOut: USDT, amountOut: 5_000_000n })],
    });
    expect(run(swap({ minAmount: 5_000_000n, token: USDT }), act).eligible).toBe(true);
  });

  it("reports both gross and net so a shortfall is explainable", () => {
    const act = activity({
      actions: [
        swapAction({ tokenIn: "TON", tokenOut: USDT, amountOut: 5_000_000n }),
        swapAction({ tokenIn: USDT, tokenOut: "TON", amountIn: 5_000_000n }),
      ],
    });

    const measured = (run(swap({ minAmount: 1n, token: USDT }), act).evidence.root as never)[
      "measured"
    ] as Record<string, string>;

    expect(measured["volumeTokenUnits"]).toBe("0");
    expect(measured["grossVolumeTokenUnits"]).not.toBe("0");
  });
});

describe("anti-abuse limits", () => {
  it("caps rewardable volume per wallet", () => {
    const act = activity({
      actions: [swapAction({ amountIn: 10_000_000_000n, tokenOut: USDT })],
    });

    expect(
      run(swap({ minAmount: 5_000_000_000n }), act, {
        maxRewardableVolumePerWallet: 1_000_000_000n,
      }).eligible,
    ).toBe(false);
  });

  it("drops rapid-fire actions inside the cooldown", () => {
    const act = activity({
      actions: [
        swapAction({ occurredAt: T0 }),
        swapAction({ occurredAt: T0 + 60 }),
        swapAction({ occurredAt: T0 + 120 }),
      ],
    });

    expect(run(swap({ count: 3 }), act).eligible).toBe(true);
    expect(run(swap({ count: 3 }), act, { minInterval: "1h" }).eligible).toBe(false);
    expect(run(swap({ count: 1 }), act, { minInterval: "1h" }).eligible).toBe(true);
  });

  it("keeps actions spaced beyond the cooldown", () => {
    const act = activity({
      actions: [swapAction({ occurredAt: T0 }), swapAction({ occurredAt: T0 + 7_200 })],
    });
    expect(run(swap({ count: 2 }), act, { minInterval: "1h" }).eligible).toBe(true);
  });

  it("applies the cooldown before volume is aggregated, not after", () => {
    // Otherwise a burst inflates volume even though it is one qualifying action.
    const act = activity({
      actions: [
        swapAction({ occurredAt: T0, amountIn: 1_000_000_000n }),
        swapAction({ occurredAt: T0 + 10, amountIn: 1_000_000_000n }),
      ],
    });
    expect(
      run(swap({ minAmount: 2_000_000_000n }), act, { minInterval: "1h" }).eligible,
    ).toBe(false);
  });

  it("disqualifies a wallet younger than the floor", () => {
    const act = activity({
      actions: [swapAction()],
      walletFirstSeenAt: T0 - DAY,
    });

    const result = run(swap({ count: 1 }), act, { minWalletAge: "30d" });
    expect(result.eligible).toBe(false);
    expect(result.evidence.disqualified).toMatch(/30d is required/);
  });

  it("still shows how the rule fared for a disqualified wallet", () => {
    // A bare "no" would be unanswerable in support.
    const act = activity({ actions: [swapAction()], walletFirstSeenAt: T0 - DAY });
    const result = run(swap({ count: 1 }), act, { minWalletAge: "30d" });
    expect(result.evidence.root.satisfied).toBe(true);
  });

  it("does not disqualify a wallet whose age is unknown", () => {
    // Unknown age is not young age; refusing would reject real users whenever
    // the provider cannot answer.
    const act = activity({ actions: [swapAction()], walletFirstSeenAt: null });
    expect(run(swap({ count: 1 }), act, { minWalletAge: "30d" }).eligible).toBe(true);
  });

  it("accepts a wallet older than the floor", () => {
    const act = activity({ actions: [swapAction()], walletFirstSeenAt: T0 - 90 * DAY });
    expect(run(swap({ count: 1 }), act, { minWalletAge: "30d" }).eligible).toBe(true);
  });
});

describe("lpAdd conditions", () => {
  it("sums LP units across deposits", () => {
    const act = activity({ actions: [lpAddAction(), lpAddAction()] });
    expect(run(lpAdd({ minLpAmount: 2_000n }), act).eligible).toBe(true);
    expect(run(lpAdd({ minLpAmount: 2_001n }), act).eligible).toBe(false);
  });

  it("filters deposits by pool", () => {
    const act = activity({ actions: [lpAddAction({ pool: POOL_B })] });
    expect(run(lpAdd({ count: 1, pool: POOL_A }), act).eligible).toBe(false);
    expect(run(lpAdd({ count: 1, pool: POOL_B }), act).eligible).toBe(true);
  });

  it("ignores swaps when counting deposits", () => {
    const act = activity({ actions: [swapAction()] });
    expect(run(lpAdd({ count: 1 }), act).eligible).toBe(false);
  });
});

describe("lpHold conditions", () => {
  it("passes when a position has been open long enough", () => {
    const act = activity({ positions: [position({ openedAt: T0 - 10 * DAY })] });
    expect(run(lpHold({ minDuration: "7d" }), act).eligible).toBe(true);
  });

  it("fails a position held too briefly, and reports how long it was held", () => {
    const act = activity({
      positions: [position({ openedAt: T0 - 2 * DAY, closedAt: T0 - DAY })],
    });

    const result = run(lpHold({ minDuration: "7d" }), act);
    expect(result.eligible).toBe(false);
    expect((result.evidence.root as never)["detail"]).toMatch(/short of 7d/);
  });

  it("counts an open position up to now", () => {
    const now = T0 + 8 * DAY;
    const act = activity({ positions: [position({ openedAt: T0 })] });
    expect(run(lpHold({ minDuration: "7d" }), act, undefined, now).eligible).toBe(true);
  });

  it("does not carry pre-campaign holding time into the campaign", () => {
    // A position opened a year before the campaign must not arrive already
    // satisfying a hold requirement.
    const now = CAMPAIGN.from + DAY;
    const act = activity({ positions: [position({ openedAt: CAMPAIGN.from - 365 * DAY })] });
    expect(run(lpHold({ minDuration: "7d" }), act, undefined, now).eligible).toBe(false);
  });

  it("filters positions by pool", () => {
    const act = activity({ positions: [position({ pool: POOL_B, openedAt: T0 - 10 * DAY })] });
    expect(run(lpHold({ minDuration: "7d", pool: POOL_A }), act).eligible).toBe(false);
    expect(run(lpHold({ minDuration: "7d", pool: POOL_B }), act).eligible).toBe(true);
  });

  it("requires a minimum position size when one is set", () => {
    const act = activity({ positions: [position({ lpAmount: 10n, openedAt: T0 - 10 * DAY })] });
    expect(run(lpHold({ minDuration: "7d", minLpAmount: 100n }), act).eligible).toBe(false);
  });

  it("reports having no positions distinctly from having short ones", () => {
    const result = run(lpHold({ minDuration: "7d" }), activity());
    expect((result.evidence.root as never)["detail"]).toMatch(/no liquidity positions/);
  });
});

describe("combinators", () => {
  const act = activity({ actions: [swapAction()], positions: [] });

  it("all requires every branch", () => {
    expect(run(all(swap({ count: 1 }), swap({ count: 1 })), act).eligible).toBe(true);
    expect(run(all(swap({ count: 1 }), swap({ count: 9 })), act).eligible).toBe(false);
  });

  it("any requires one branch", () => {
    expect(run(any(swap({ count: 9 }), swap({ count: 1 })), act).eligible).toBe(true);
    expect(run(any(swap({ count: 9 }), swap({ count: 8 })), act).eligible).toBe(false);
  });

  it("nests to the full allowed depth", () => {
    const rule = all(any(all(swap({ count: 1 }))));
    expect(run(rule, act).eligible).toBe(true);
  });

  it("evaluates every branch even once the outcome is decided", () => {
    // Short-circuiting would make evidence depend on child order, so the same
    // rule could produce different evidence hashes for the same activity.
    const result = run(any(swap({ count: 1 }), swap({ count: 99 })), act);
    const root = result.evidence.root as { children: unknown[] };
    expect(root.children).toHaveLength(2);
  });

  it("records evidence for a mixed composite", () => {
    const composite = all(swap({ count: 1 }), lpHold({ minDuration: "7d" }));
    const result = run(composite, act);
    const root = result.evidence.root as { children: { kind: string }[] };
    expect(root.children.map((c) => c.kind)).toEqual(["swap", "lpHold"]);
  });
});

describe("evidence", () => {
  it("lists the transactions that contributed", () => {
    const act = activity({ actions: [swapAction(), swapAction()] });
    const result = run(swap({ count: 2 }), act);
    expect((result.evidence.root as never)["txHashes"]).toEqual(["swap1", "swap2"]);
  });

  it("is produced on failure as well as success", () => {
    const result = run(swap({ count: 5 }), activity({ actions: [swapAction()] }));
    expect(result.evidence.root.satisfied).toBe(false);
    expect((result.evidence.root as never)["measured"]).toBeDefined();
  });

  it("binds the rule by hash", () => {
    const a = run(swap({ count: 1 }), activity());
    const b = run(swap({ count: 2 }), activity());
    expect(a.ruleHash).not.toBe(b.ruleHash);
    expect(a.ruleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is byte-identical across repeated evaluations of the same inputs", () => {
    // The property the whole product's credibility rests on.
    const act = activity({ actions: [swapAction(), swapAction()] });
    const rule = all(swap({ count: 1 }), lpHold({ minDuration: "7d" }));

    const hashes = new Set(
      Array.from({ length: 50 }, () => run(rule, act).evidenceHash),
    );
    expect(hashes.size).toBe(1);
  });

  it("changes when the activity changes", () => {
    const rule = swap({ count: 1 });
    const a = run(rule, activity({ actions: [swapAction()] }));
    const b = run(rule, activity({ actions: [swapAction(), swapAction()] }));
    expect(a.evidenceHash).not.toBe(b.evidenceHash);
  });

  it("does not depend on the order actions arrive in", () => {
    const first = swapAction({ occurredAt: T0, lt: 1n });
    const second = swapAction({ occurredAt: T0 + DAY, lt: 2n });

    const forward = run(swap({ count: 2 }), activity({ actions: [first, second] }));
    const reverse = run(swap({ count: 2 }), activity({ actions: [second, first] }));

    expect(forward.evidenceHash).toBe(reverse.evidenceHash);
  });
});
