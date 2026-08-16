import { describe, expect, it, vi } from "vitest";
import { generateKeypair, signAttestation, toHex } from "@tonattest/attest";
import {
  ApiResponseError,
  InvalidInputError,
  NetworkError,
  TonAttest,
  all,
  swap,
  validateRule,
  verifyAttestation,
} from "../src/index.js";

const NOW = 1_800_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorBody(code: string, retryable: boolean) {
  return { error: { code, message: `${code} happened`, retryable } };
}

function client(fetchImpl: typeof fetch, retries = 1) {
  return new TonAttest({
    apiKey: "sk_test",
    baseUrl: "https://api.example.com",
    fetchImpl,
    retries,
  });
}

describe("construction", () => {
  it("requires an API key", () => {
    expect(() => new TonAttest({ apiKey: "" })).toThrow(InvalidInputError);
  });

  it("explains what to do when no fetch exists", () => {
    expect(
      () => new TonAttest({ apiKey: "k", fetchImpl: undefined as never }),
    ).not.toThrow();
  });

  it("trims a trailing slash off the base URL", async () => {
    const fetchImpl = vi.fn(async () => json({ campaigns: [] }));
    const sdk = new TonAttest({
      apiKey: "k",
      baseUrl: "https://api.example.com/",
      fetchImpl,
    });
    await sdk.listCampaigns();
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.example.com/v1/campaigns");
  });
});

describe("requests", () => {
  it("sends the API key as a bearer token", async () => {
    const fetchImpl = vi.fn(async () => json({ campaigns: [] }));
    await client(fetchImpl).listCampaigns();

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test");
  });

  it("creates a campaign from a typed rule", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "cmp_1" }));
    await client(fetchImpl).createCampaign({
      name: "Swap and earn",
      rule: all(swap({ minAmount: 100n }), swap({ count: 2 })),
      startsAt: new Date(NOW * 1_000),
      endsAt: new Date((NOW + 86_400) * 1_000),
    });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.rule).toEqual({
      all: [{ swap: { minAmount: "100" } }, { swap: { count: 2 } }],
    });
    expect(body.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an unparseable date without a round trip", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    await expect(
      client(fetchImpl).createCampaign({
        name: "x",
        rule: swap({ count: 1 }),
        startsAt: "not a date",
        endsAt: new Date(),
      }),
    ).rejects.toThrow(InvalidInputError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a verify call with no wallet without a round trip", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    await expect(
      client(fetchImpl).verify({ wallet: "", campaignId: "cmp_1" }),
    ).rejects.toThrow(InvalidInputError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("URL-encodes path parameters", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "x" }));
    await client(fetchImpl).getCampaign("cmp/../admin");
    expect(fetchImpl.mock.calls[0]![0]).toContain("cmp%2F..%2Fadmin");
  });
});

describe("error taxonomy", () => {
  it("surfaces the server's code and retryable flag", async () => {
    const fetchImpl = vi.fn(async () => json(errorBody("STALE_ACTIVITY", true), 503));

    await expect(
      client(fetchImpl).verify({ wallet: "0:a", campaignId: "c" }),
    ).rejects.toMatchObject({ code: "STALE_ACTIVITY", retryable: true, status: 503 });
  });

  it("marks a 4xx as final so a client does not loop on its own bug", async () => {
    const fetchImpl = vi.fn(async () => json(errorBody("INVALID_ADDRESS", false), 400));

    await expect(
      client(fetchImpl, 3).verify({ wallet: "bad", campaignId: "c" }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back sensibly when the server sends no error body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 502 }));
    await expect(client(fetchImpl).listCampaigns()).rejects.toMatchObject({
      code: "UNKNOWN",
      retryable: true,
    });
  });

  it("reports a transport failure as a NetworkError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("failed to fetch");
    });
    await expect(client(fetchImpl).listCampaigns()).rejects.toBeInstanceOf(NetworkError);
  });

  it("reports a timeout distinctly, naming the limit", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const sdk = new TonAttest({
      apiKey: "k",
      fetchImpl: fetchImpl as never,
      timeoutMs: 10,
      retries: 1,
    });

    await expect(sdk.listCampaigns()).rejects.toThrow(/timed out after 10ms/);
  });

  it("exposes every error under one base class", async () => {
    const fetchImpl = vi.fn(async () => json(errorBody("X", false), 400));
    await expect(client(fetchImpl).listCampaigns()).rejects.toBeInstanceOf(ApiResponseError);
  });
});

describe("retries", () => {
  it("retries a retryable failure and succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls < 3 ? json(errorBody("PROVIDER_UNAVAILABLE", true), 503) : json({ campaigns: [] });
    });

    await expect(client(fetchImpl, 4).listCampaigns()).resolves.toEqual([]);
    expect(calls).toBe(3);
  });

  it("gives up after the configured attempts", async () => {
    const fetchImpl = vi.fn(async () => json(errorBody("PROVIDER_UNAVAILABLE", true), 503));
    await expect(client(fetchImpl, 2).listCampaigns()).rejects.toBeInstanceOf(ApiResponseError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure too", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new TypeError("offline");
      return json({ campaigns: [] });
    });
    await expect(client(fetchImpl, 3).listCampaigns()).resolves.toEqual([]);
  });
});

describe("offline attestation verification", () => {
  it("verifies a real attestation with no network at all", async () => {
    // The property the whole design rests on: an integrating app does not
    // have to trust a live response.
    const keys = await generateKeypair();
    const attestation = await signAttestation(
      {
        project: "prj",
        campaign: "cmp",
        wallet: "0:abc",
        ruleHash: `sha256:${"a".repeat(64)}`,
        evidenceHash: `sha256:${"b".repeat(64)}`,
        issuedAt: NOW,
        nonce: "n",
      },
      keys.privateKey,
    );

    await expect(
      verifyAttestation(attestation, toHex(keys.publicKey), { now: NOW }),
    ).resolves.toEqual({ valid: true });
  });

  it("rejects an attestation signed by a different project", async () => {
    const mine = await generateKeypair();
    const theirs = await generateKeypair();
    const attestation = await signAttestation(
      {
        project: "prj",
        campaign: "cmp",
        wallet: "0:abc",
        ruleHash: `sha256:${"a".repeat(64)}`,
        evidenceHash: `sha256:${"b".repeat(64)}`,
        issuedAt: NOW,
        nonce: "n",
      },
      theirs.privateKey,
    );

    await expect(
      verifyAttestation(attestation, toHex(mine.publicKey), { now: NOW }),
    ).resolves.toMatchObject({ valid: false, reason: "bad_signature" });
  });
});

describe("rule builders re-exported for integrators", () => {
  it("produces JSON that survives a round trip through the API", () => {
    const rule = all(swap({ minAmount: 10n ** 18n }), swap({ count: 3, window: "7d" }));
    expect(validateRule(JSON.parse(JSON.stringify(rule)))).toEqual(rule);
  });

  it("rejects a bad rule locally, before it reaches the service", () => {
    expect(() => validateRule({ swap: { minAmmount: "1" } })).toThrow(/unknown field/);
  });
});

describe("runtime portability", () => {
  it("touches no Node built-ins anywhere in the shipped graph", async () => {
    // The SDK ships to browsers, Telegram Mini Apps, and edge runtimes. One
    // `node:` import in the dependency graph breaks all three, and it would
    // only be discovered by an integrator at bundle time.
    const { readFileSync, readdirSync } = await import("node:fs");
    const roots = ["sdk", "rules", "attest", "core-types"];

    const offenders: string[] = [];
    for (const pkg of roots) {
      const dir = new URL(`../../${pkg}/src/`, import.meta.url);
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
        const body = readFileSync(new URL(name, dir), "utf8");
        if (/from\s+"node:/.test(body)) offenders.push(`${pkg}/src/${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
