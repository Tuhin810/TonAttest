import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isKnownAction } from "@tonattest/core-types";
import { parseEventsResponse, parsePoolsResponse } from "@tonattest/data-provider";
import { decodeEvents, reconstructPositions } from "@tonattest/decoder";
import { all, evaluate, lpHold, swap } from "@tonattest/rules";
import { generateKeypair, signAttestation, verifyAttestation } from "../src/attestation.js";

/**
 * The whole pipeline over real mainnet data: chain events -> decoded actions
 * -> evaluated rule -> signed attestation -> offline verification.
 *
 * The decoder fixtures are reused rather than re-fetched, so this stays
 * hermetic while still exercising real chain shapes end to end.
 */
const FIXTURES = new URL("../../decoder/test/fixtures/", import.meta.url);

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as T;
}

const registry = parsePoolsResponse(load<{ pool_list: unknown[] }>("pools.json"), 0);

function activityFrom(names: readonly string[], wallet: string) {
  const events = names.flatMap((name) => {
    const fixture = load<{ wallet: string; event: Record<string, unknown> }>(name);
    return fixture.wallet === wallet ? parseEventsResponse({ events: [fixture.event] }) : [];
  });

  const actions = decodeEvents({ events, registry, wallet }).actions.filter(isKnownAction);
  const occurred = actions.map((action) => action.occurredAt);

  return {
    activity: {
      wallet,
      actions,
      positions: reconstructPositions(actions),
      walletFirstSeenAt: Math.min(...occurred) - 86_400,
      resolvedFrom: Math.min(...occurred) - 86_400,
      resolvedTo: Math.max(...occurred) + 86_400,
    },
    campaign: { from: Math.min(...occurred) - 86_400, to: Math.max(...occurred) + 86_400 },
    now: Math.max(...occurred) + 60,
  };
}

const LP_WALLET = "0:83d606248e51ac6cd720ff254d63ed2b023161ab50ac026b4a245d463a62fa03";
const LP_FIXTURES = ["lp-add-ton-usdt.json", "lp-remove-ton-usdt.json"];

describe("chain data to signed attestation", () => {
  it("evaluates a real liquidity deposit and issues a verifiable attestation", async () => {
    const context = activityFrom(LP_FIXTURES, LP_WALLET);
    const rule = { lpAdd: { minLpAmount: "220021" } } as const;

    const result = evaluate(rule, context);
    expect(result.eligible).toBe(true);

    const keys = await generateKeypair();
    const attestation = await signAttestation(
      {
        project: "prj_demo",
        campaign: "cmp_demo",
        wallet: context.activity.wallet,
        ruleHash: result.ruleHash,
        evidenceHash: result.evidenceHash,
        issuedAt: context.now,
        nonce: "n1",
      },
      keys.privateKey,
    );

    // Offline: no network, no trust in the issuing service.
    await expect(
      verifyAttestation(attestation, keys.publicKey, { now: context.now }),
    ).resolves.toEqual({ valid: true });
  });

  it("refuses a threshold the real deposit does not meet", async () => {
    const context = activityFrom(LP_FIXTURES, LP_WALLET);
    const result = evaluate({ lpAdd: { minLpAmount: "999999999" } }, context);

    expect(result.eligible).toBe(false);
    // The shortfall names the real on-chain figure.
    expect((result.evidence.root as never)["detail"]).toContain("220021");
  });

  it("fails a hold rule the real position is too short for", () => {
    // The captured deposit and withdrawal are about two minutes apart.
    const context = activityFrom(LP_FIXTURES, LP_WALLET);
    const result = evaluate(lpHold({ minDuration: "7d" }), context);
    expect(result.eligible).toBe(false);
  });

  it("binds the attestation to the exact rule that produced it", async () => {
    const context = activityFrom(LP_FIXTURES, LP_WALLET);
    const a = evaluate({ lpAdd: { minLpAmount: "1" } }, context);
    const b = evaluate({ lpAdd: { minLpAmount: "2" } }, context);

    // A campaign that edits its rule cannot reuse an old attestation: the
    // rule hash inside the signed payload no longer matches.
    expect(a.ruleHash).not.toBe(b.ruleHash);
  });

  it("evaluates a composite rule against real swap history", () => {
    const SWAP_WALLET = "0:56a8387cc22e9e7e103f91f1d0aeff9449e60253d6eb7a656694054a258b122b";
    const names = readdirSync(FIXTURES).filter((n) => n.startsWith("swap-"));
    const context = activityFrom(names, SWAP_WALLET);

    const result = evaluate(all(swap({ count: 1 }), swap({ minAmount: 1n })), context);

    expect(result.eligible).toBe(true);
    expect((result.evidence.root as never)["children"]).toHaveLength(2);
  });
});
