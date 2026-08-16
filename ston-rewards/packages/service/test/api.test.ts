import { describe, expect, it } from "vitest";
import { verifyAttestation } from "@ston-rewards/attest";
import { swap } from "@ston-rewards/rules";
import { NOW, WALLET, auth, harness } from "./helpers.js";

describe("authentication", () => {
  it("rejects a request with no API key", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "GET", url: "/v1/campaigns" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a wrong API key", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/campaigns",
      headers: auth("sk_wrong"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed Authorization header", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/campaigns",
      headers: { authorization: h.apiKey },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid API key", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/campaigns",
      headers: auth(h.apiKey),
    });
    expect(res.statusCode).toBe(200);
  });

  it("never echoes the API key back", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/campaigns",
      headers: auth(h.apiKey),
    });
    expect(res.body).not.toContain(h.apiKey);
  });
});

describe("campaign creation", () => {
  it("creates a campaign and returns its rule hash", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: auth(h.apiKey),
      payload: {
        name: "Swap and earn",
        rule: swap({ minAmount: 1_000n }),
        startsAt: new Date(NOW * 1_000).toISOString(),
        endsAt: new Date((NOW + 86_400) * 1_000).toISOString(),
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().ruleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects an invalid rule before storing anything", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: auth(h.apiKey),
      payload: {
        name: "Broken",
        rule: { swap: { minAmmount: "100" } },
        startsAt: new Date(NOW * 1_000).toISOString(),
        endsAt: new Date((NOW + 86_400) * 1_000).toISOString(),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/unknown field/);
    expect((await h.store.listCampaigns(h.projectId)).length).toBe(1);
  });

  it("rejects an end date before the start", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: auth(h.apiKey),
      payload: {
        name: "Backwards",
        rule: swap({ count: 1 }),
        startsAt: new Date(NOW * 1_000).toISOString(),
        endsAt: new Date((NOW - 86_400) * 1_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown anti-abuse limits rather than ignoring them", async () => {
    // A silently-dropped limit is a campaign running without the protection
    // its operator believes it has.
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: auth(h.apiKey),
      payload: {
        name: "Typo",
        rule: swap({ count: 1 }),
        limits: { minIntervall: "1h" },
        startsAt: new Date(NOW * 1_000).toISOString(),
        endsAt: new Date((NOW + 86_400) * 1_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not a known limit/);
  });

  it("rejects extra body fields", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: auth(h.apiKey),
      payload: {
        name: "Extra",
        rule: swap({ count: 1 }),
        startsAt: new Date(NOW * 1_000).toISOString(),
        endsAt: new Date((NOW + 86_400) * 1_000).toISOString(),
        secretDiscount: true,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("campaign isolation", () => {
  it("reports another project's campaign as missing, not forbidden", async () => {
    // Distinguishing the two would let the endpoint be used to probe for
    // valid campaign ids.
    const a = await harness();
    const b = await harness();

    const res = await a.app.inject({
      method: "GET",
      url: `/v1/campaigns/${b.campaign.id}`,
      headers: auth(a.apiKey),
    });

    expect(res.statusCode).toBe(404);
  });

  it("refuses to verify against another project's campaign", async () => {
    const a = await harness();
    const b = await harness();

    const res = await a.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(a.apiKey),
      payload: { wallet: WALLET, campaignId: b.campaign.id },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("verification", () => {
  it("returns an attestation for an eligible wallet", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: WALLET, campaignId: h.campaign.id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eligible).toBe(true);
    expect(body.attestation.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("issues an attestation that verifies offline against the published key", async () => {
    // The whole design stance: the integrating app never has to trust a live
    // response.
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: WALLET, campaignId: h.campaign.id },
    });

    const keys = await h.app.inject({
      method: "GET",
      url: "/v1/keys",
      headers: auth(h.apiKey),
    });

    const publicKey = keys.json().keys[0].publicKey;
    await expect(
      verifyAttestation(res.json().attestation, publicKey, { now: NOW }),
    ).resolves.toEqual({ valid: true });
  });

  it("returns evidence but no attestation when ineligible", async () => {
    const h = await harness({ rule: swap({ count: 99 }) });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: WALLET, campaignId: h.campaign.id },
    });

    const body = res.json();
    expect(body.eligible).toBe(false);
    expect(body.attestation).toBeUndefined();
    // The shortfall has to be explainable to the user.
    expect(JSON.stringify(body.evidence)).toContain("of 99 qualifying swaps");
  });

  it("rejects an unparseable wallet with a 400", async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: "not-an-address", campaignId: h.campaign.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ADDRESS");
    expect(res.json().error.retryable).toBe(false);
  });

  it("refuses a campaign that has not started", async () => {
    const h = await harness({
      campaignOverrides: {
        startsAt: new Date((NOW + 86_400) * 1_000),
        endsAt: new Date((NOW + 172_800) * 1_000),
      },
    });

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: WALLET, campaignId: h.campaign.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CAMPAIGN_NOT_STARTED");
  });

  it("refuses a campaign that has ended", async () => {
    const h = await harness({
      campaignOverrides: {
        startsAt: new Date((NOW - 172_800) * 1_000),
        endsAt: new Date((NOW - 86_400) * 1_000),
      },
    });

    const res = await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: WALLET, campaignId: h.campaign.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CAMPAIGN_ENDED");
  });

  it("refuses a paused campaign", async () => {
    const h = await harness({ campaignOverrides: { status: "paused" } });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: WALLET, campaignId: h.campaign.id },
    });
    expect(res.json().error.code).toBe("CAMPAIGN_NOT_ACTIVE");
  });
});

describe("observability", () => {
  it("reports liveness without touching dependencies", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("reports readiness with per-dependency detail", async () => {
    const h = await harness();
    const res = await h.app.inject({ method: "GET", url: "/readyz" });
    expect(res.json()).toMatchObject({ ready: true, checks: { database: "ok", cache: "ok" } });
  });

  it("exposes metrics in Prometheus format", async () => {
    const h = await harness();
    await h.app.inject({
      method: "POST",
      url: "/v1/verify",
      headers: auth(h.apiKey),
      payload: { wallet: WALLET, campaignId: h.campaign.id },
    });

    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("ston_verify_total");
    expect(res.body).toContain("ston_attestations_issued_total");
    expect(res.body).toContain("ston_verify_duration_seconds");
  });

  it("does not require authentication for health or metrics", async () => {
    const h = await harness();
    for (const url of ["/healthz", "/readyz", "/metrics"]) {
      expect((await h.app.inject({ method: "GET", url })).statusCode).toBe(200);
    }
  });
});

describe("activity endpoint", () => {
  it("says it is unimplemented rather than returning an empty list", async () => {
    // An empty list reads as "this wallet has no activity" — the worst
    // possible answer for someone debugging a failed claim.
    const h = await harness();
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/wallets/${WALLET}/activity`,
      headers: auth(h.apiKey),
    });
    expect(res.statusCode).toBe(501);
  });
});
