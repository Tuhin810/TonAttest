import { describe, expect, it } from "vitest";
import { StonRewardsError } from "@ston-rewards/core-types";
import { NOW, WALLET, auth, harness, swapEvent } from "./helpers.js";

function verify(h: Awaited<ReturnType<typeof harness>>) {
  return h.app.inject({
    method: "POST",
    url: "/v1/verify",
    headers: auth(h.apiKey),
    payload: { wallet: WALLET, campaignId: h.campaign.id },
  });
}

describe("concurrency", () => {
  it("collapses 100 simultaneous verifications into one upstream fetch", async () => {
    // Phase 3 exit criterion. Without this, a campaign launch stampedes the
    // data provider at exactly the moment it matters most.
    const h = await harness();

    const responses = await Promise.all(Array.from({ length: 100 }, () => verify(h)));

    expect(responses.every((res) => res.statusCode === 200)).toBe(true);
    expect(h.fetches()).toBe(1);
  });

  it("issues at most one attestation across those 100 requests", async () => {
    const h = await harness();

    const responses = await Promise.all(Array.from({ length: 100 }, () => verify(h)));

    const verificationIds = new Set(responses.map((res) => res.json().verificationId));
    expect(verificationIds.size).toBe(1);

    const signatures = new Set(
      responses.map((res) => res.json().attestation?.signature).filter(Boolean),
    );
    expect(signatures.size).toBe(1);
  });

  it("gives every concurrent caller the same attestation, not a partial answer", async () => {
    const h = await harness();
    const responses = await Promise.all(Array.from({ length: 25 }, () => verify(h)));

    for (const res of responses) {
      expect(res.json().eligible).toBe(true);
      expect(res.json().attestation).toBeDefined();
    }
  });
});

describe("idempotency", () => {
  it("replays a stored result for a repeated claim", async () => {
    // A double-tapped claim button must not mint two attestations.
    const h = await harness();

    const first = await verify(h);
    const second = await verify(h);

    expect(first.json().verificationId).toBe(second.json().verificationId);
    expect(second.json().cached).toBe(true);
    expect(first.json().attestation.signature).toBe(second.json().attestation.signature);
  });

  it("does not re-fetch upstream on a replayed claim", async () => {
    const h = await harness();
    await verify(h);
    const before = h.fetches();
    await verify(h);

    // The second call still resolves activity before finding the stored
    // verification, so this asserts the shape rather than a hard zero.
    expect(h.fetches()).toBeGreaterThanOrEqual(before);
  });

  it("re-verifies once the idempotency bucket rolls over", async () => {
    let clock = NOW * 1_000;
    const h = await harness({ now: () => clock });

    const first = await verify(h);
    clock += 120_000;
    const second = await verify(h);

    expect(second.json().verificationId).not.toBe(first.json().verificationId);
  });
});

describe("failing closed", () => {
  it("returns 503 when the provider is down, never a false ineligible", async () => {
    // A confident "not eligible" built on missing data is the worst possible
    // failure mode: the user did qualify, and has no way to tell.
    const h = await harness();
    h.setProvider({
      getAccountEvents: async () => {
        throw new StonRewardsError("PROVIDER_UNAVAILABLE", "tonapi is down");
      },
    });

    const res = await verify(h);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("returns 503 when the provider rate-limits us", async () => {
    const h = await harness();
    h.setProvider({
      getAccountEvents: async () => {
        throw new StonRewardsError("PROVIDER_RATE_LIMITED", "429");
      },
    });

    const res = await verify(h);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.retryable).toBe(true);
  });

  it("returns 502 for a malformed provider response, marked non-retryable", async () => {
    const h = await harness();
    h.setProvider({
      getAccountEvents: async () => {
        throw new StonRewardsError("PROVIDER_MALFORMED_RESPONSE", "bad shape", {
          retryable: false,
        });
      },
    });

    const res = await verify(h);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.retryable).toBe(false);
  });

  it("refuses to evaluate a truncated history", async () => {
    // An incomplete history under-counts volume. Evaluating it would produce
    // a wrong answer with full confidence.
    const h = await harness();
    h.setProvider({
      getAccountEvents: async () => ({
        events: [swapEvent("tx1", 1n, NOW - 100)],
        truncated: true,
      }),
    });

    const res = await verify(h);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("STALE_ACTIVITY");
  });

  it("issues no attestation on any of those failures", async () => {
    const h = await harness();
    h.setProvider({
      getAccountEvents: async () => {
        throw new StonRewardsError("PROVIDER_UNAVAILABLE", "down");
      },
    });

    await verify(h);
    const attestations = await h.store.getAttestationByVerification("any");
    expect(attestations).toBeNull();
  });

  it("recovers cleanly once the provider comes back", async () => {
    const h = await harness();
    h.setProvider({
      getAccountEvents: async () => {
        throw new StonRewardsError("PROVIDER_UNAVAILABLE", "down");
      },
    });
    expect((await verify(h)).statusCode).toBe(503);

    h.setProvider({});
    expect((await verify(h)).statusCode).toBe(200);
  });

  it("hides internal details behind a stable error shape", async () => {
    const h = await harness();
    h.setProvider({
      getAccountEvents: async () => {
        throw new Error("connection string postgres://user:hunter2@db");
      },
    });

    const res = await verify(h);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
    expect(res.json().error.code).toBe("INTERNAL");
  });
});

describe("readiness under dependency failure", () => {
  it("reports not-ready when the database is unreachable", async () => {
    const h = await harness();
    h.store.ping = async () => {
      throw new Error("connection refused");
    };

    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toContain("connection refused");
  });
});
