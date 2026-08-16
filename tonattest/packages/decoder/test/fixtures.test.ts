import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEventsResponse, parsePoolsResponse } from "@tonattest/data-provider";
import { isKnownAction } from "@tonattest/core-types";
import { decodeEvents } from "../src/decode.js";
import { heldSeconds, reconstructPositions } from "../src/positions.js";

/**
 * Golden fixtures: real mainnet events, captured with
 * `node scripts/capture-fixture.mjs`, decoded through the same parsers the
 * service uses.
 *
 * These exist so a STON.fi contract change or a provider schema change fails
 * here, in CI, rather than silently in production — which for this system
 * means quietly telling real users they are ineligible.
 */
const DIR = new URL("./fixtures/", import.meta.url);

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DIR), "utf8")) as T;
}

const registry = parsePoolsResponse(load<{ pool_list: unknown[] }>("pools.json"), 0);

interface Fixture {
  readonly wallet: string;
  readonly event: Record<string, unknown>;
}

function decodeFixture(name: string) {
  const fixture = load<Fixture>(name);
  const [event] = parseEventsResponse({ events: [fixture.event] });
  return decodeEvents({ events: [event!], registry, wallet: fixture.wallet });
}

const names = readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "pools.json");

describe("golden mainnet fixtures", () => {
  it("has fixtures to run", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s decodes with no unknown actions", (name) => {
    const result = decodeFixture(name);
    expect(result.unknownCount).toBe(0);
    expect(result.actions.length).toBeGreaterThan(0);
  });

  it("decodes a native-TON-in swap, reading the amount from the TON field", () => {
    const [action] = decodeFixture("swap-ton-in.json").actions;
    expect(action).toMatchObject({
      type: "SWAP",
      tokenIn: "TON",
      amountIn: 73_119_572_975n,
      amountOut: 2_480_587_798_024n,
    });
  });

  it("collapses a pTON leg onto the native-TON sentinel", () => {
    // The chain reports pTON as the out-jetton; a rule written against "TON"
    // must still match it.
    const [action] = decodeFixture("swap-jetton-to-pton.json").actions;
    expect(action).toMatchObject({ type: "SWAP", tokenOut: "TON" });
  });

  it("attributes a swap to a specific pool", () => {
    const [action] = decodeFixture("swap-ton-in.json").actions;
    expect(action?.pool).toBeTypeOf("string");
  });

  it("decodes a liquidity withdrawal from the LP jetton burn", () => {
    // A STON.fi pool is its own LP jetton master, so burning that jetton is
    // the withdrawal. No message-body decoding is involved.
    const [action] = decodeFixture("lp-remove-ton-usdt.json").actions;
    expect(action).toMatchObject({
      type: "LP_REMOVE",
      lpAmount: 220_021n,
      pool: "0:fc4c9f311160754a99d113877cf583b78e5d16d048819cd4b820168769499d7e",
    });
  });

  it("recovers the underlying legs of a withdrawal from sibling transfers", () => {
    const [action] = decodeFixture("lp-remove-ton-usdt.json").actions;
    const assets = action?.type === "LP_REMOVE" ? action.assets : [];

    // USDT arrives as a jetton transfer; the TON side arrives as a plain TON
    // transfer because pTON unwraps on the way out.
    expect(assets).toEqual(
      expect.arrayContaining([
        {
          asset: "0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe",
          amount: 10_056_067n,
        },
        // The pool's gas change arrives as a second TON transfer in the same
        // event; the leg reports the payout, not payout + change.
        { asset: "TON", amount: 7_642_096_705n },
      ]),
    );
  });
});

describe("golden fixtures — liquidity round trip", () => {
  it("reads a deposit from the inbound transfer of the pool's own jetton", () => {
    // STON.fi credits LP tokens by transferring the pool jetton to the
    // provider rather than by minting, so a mint-only decoder sees nothing.
    const [action] = decodeFixture("lp-add-ton-usdt.json").actions;
    expect(action).toMatchObject({
      type: "LP_ADD",
      lpAmount: 220_021n,
      pool: "0:fc4c9f311160754a99d113877cf583b78e5d16d048819cd4b820168769499d7e",
    });
  });

  it("pairs the real deposit and withdrawal into one closed position", () => {
    const add = decodeFixture("lp-add-ton-usdt.json").actions;
    const remove = decodeFixture("lp-remove-ton-usdt.json").actions;

    const positions = reconstructPositions(
      [...add, ...remove].filter(isKnownAction),
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ lpAmount: 220_021n });
    expect(positions[0]!.closedAt).not.toBeNull();
    expect(heldSeconds(positions[0]!, 0)).toBeGreaterThan(0);
  });
});
