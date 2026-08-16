import { describe, expect, it, vi } from "vitest";
import { StonRewardsError } from "@ston-rewards/core-types";
import { TonapiProvider, parseEventsResponse } from "../src/tonapi.js";

const NO_RETRY = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tonapiEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "tx1",
    account: { address: "0:abc" },
    timestamp: 1_700_000_100,
    lt: "12345",
    in_progress: false,
    actions: [{ type: "JettonSwap", status: "ok", JettonSwap: { dex: "stonfi" } }],
    ...overrides,
  };
}

describe("parseEventsResponse", () => {
  it("lifts the type-named payload onto a uniform action shape", () => {
    const [event] = parseEventsResponse({ events: [tonapiEvent()] });
    expect(event!.actions[0]).toEqual({
      type: "JettonSwap",
      status: "ok",
      payload: { dex: "stonfi" },
    });
  });

  it("accepts an account given as a bare string", () => {
    const [event] = parseEventsResponse({ events: [tonapiEvent({ account: "0:abc" })] });
    expect(event!.account).toBe("0:abc");
  });

  it("parses lt as a bigint so large logical times keep full precision", () => {
    const lt = "123456789012345678901";
    const [event] = parseEventsResponse({ events: [tonapiEvent({ lt })] });
    expect(event!.lt).toBe(BigInt(lt));
  });

  it("rejects a response with no events array", () => {
    // Silently returning [] here would read to the user as "my swap didn't
    // register", so this fails loudly instead.
    expect(() => parseEventsResponse({})).toThrow(StonRewardsError);
  });

  it("rejects a structurally broken event rather than skipping it", () => {
    expect(() => parseEventsResponse({ events: [tonapiEvent({ timestamp: "soon" })] }))
      .toThrow(/timestamp/);
  });

  it("marks a malformed response as non-retryable", () => {
    try {
      parseEventsResponse({ events: [{}] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StonRewardsError);
      expect((err as StonRewardsError).retryable).toBe(false);
    }
  });
});

describe("TonapiProvider.getAccountEvents", () => {
  it("filters out events outside the window and events still in progress", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        events: [
          tonapiEvent({ event_id: "inside", timestamp: 150 }),
          tonapiEvent({ event_id: "running", timestamp: 150, in_progress: true }),
          tonapiEvent({ event_id: "future", timestamp: 500 }),
        ],
      }),
    );

    const provider = new TonapiProvider({ fetchImpl, retry: NO_RETRY, pageSize: 100 });
    const page = await provider.getAccountEvents({ address: "0:abc", from: 100, to: 200 });

    expect(page.events.map((e) => e.eventId)).toEqual(["inside"]);
    expect(page.truncated).toBe(false);
  });

  it("stops paging as soon as an event predates the window", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        events: [
          tonapiEvent({ event_id: "inside", timestamp: 150, lt: "20" }),
          tonapiEvent({ event_id: "older", timestamp: 50, lt: "10" }),
        ],
      }),
    );

    const provider = new TonapiProvider({ fetchImpl, retry: NO_RETRY, pageSize: 2 });
    const page = await provider.getAccountEvents({ address: "0:abc", from: 100, to: 200 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(page.events.map((e) => e.eventId)).toEqual(["inside"]);
  });

  it("reports truncation when the cost cap cuts history short", async () => {
    // An incomplete history under-counts volume. The resolver has to know.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        events: [
          tonapiEvent({ event_id: "a", timestamp: 150, lt: "20" }),
          tonapiEvent({ event_id: "b", timestamp: 140, lt: "10" }),
        ],
      }),
    );

    const provider = new TonapiProvider({ fetchImpl, retry: NO_RETRY, pageSize: 2 });
    const page = await provider.getAccountEvents({
      address: "0:abc",
      from: 100,
      to: 200,
      limit: 2,
    });

    expect(page.truncated).toBe(true);
    expect(page.events).toHaveLength(2);
  });

  it("does not loop forever when the cursor stops decreasing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        events: [
          tonapiEvent({ event_id: "a", timestamp: 150, lt: "10" }),
          tonapiEvent({ event_id: "b", timestamp: 140, lt: "10" }),
        ],
      }),
    );

    const provider = new TonapiProvider({ fetchImpl, retry: NO_RETRY, pageSize: 2 });
    const page = await provider.getAccountEvents({ address: "0:abc", from: 100, to: 200 });

    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
    expect(page.events.length).toBeGreaterThan(0);
  });

  it("surfaces a rate limit as a retryable error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429));
    const provider = new TonapiProvider({ fetchImpl, retry: NO_RETRY });

    await expect(
      provider.getAccountEvents({ address: "0:abc", from: 0, to: 1 }),
    ).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", retryable: true });
  });

  it("does not retry a client error, which would only burn rate budget", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 400));
    const provider = new TonapiProvider({
      fetchImpl,
      retry: { attempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await expect(
      provider.getAccountEvents({ address: "0:abc", from: 0, to: 1 }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a server error and succeeds on a later attempt", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls < 3 ? jsonResponse({}, 503) : jsonResponse({ events: [] });
    });

    const provider = new TonapiProvider({
      fetchImpl,
      retry: { attempts: 4, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const page = await provider.getAccountEvents({ address: "0:abc", from: 0, to: 1 });

    expect(page.events).toEqual([]);
    expect(calls).toBe(3);
  });

  it("sends the API key as a bearer token and keeps it out of the path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ events: [] }));
    const provider = new TonapiProvider({ fetchImpl, retry: NO_RETRY, apiKey: "secret" });
    await provider.getAccountEvents({ address: "0:abc", from: 0, to: 1 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("secret");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer secret");
  });
});

describe("TonapiProvider — completeness signalling", () => {
  it("does not report truncation when the account simply has no events", async () => {
    // Reaching the account's earliest event means the history is complete.
    // Flagging it as truncated would make every quiet wallet fail closed.
    const fetchImpl = vi.fn(async () => jsonResponse({ events: [] }));
    const provider = new TonapiProvider({ fetchImpl, retry: NO_RETRY });

    const page = await provider.getAccountEvents({ address: "0:abc", from: 0, to: 1 });

    expect(page.events).toEqual([]);
    expect(page.truncated).toBe(false);
  });
});
