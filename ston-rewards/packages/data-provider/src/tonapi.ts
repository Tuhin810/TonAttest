import { StonRewardsError } from "@ston-rewards/core-types";
import { fetchJsonWithRetry, DEFAULT_RETRY, type RetryOptions } from "./http.js";
import type {
  DataProvider,
  GetAccountEventsParams,
  RawEvent,
  RawAction,
  RawEventPage,
} from "./provider.js";

export interface TonapiOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly retry?: RetryOptions;
  readonly fetchImpl?: typeof fetch;
  /** Events per request. tonapi caps this at 100. */
  readonly pageSize?: number;
}

const DEFAULT_LIMIT = 1_000;
const MAX_PAGE_SIZE = 100;

/**
 * tonapi.io implementation of {@link DataProvider}.
 *
 * Pages backwards from `to` using `before_lt` until the window's lower bound
 * is crossed. Events are returned newest-first, matching the API.
 */
export class TonapiProvider implements DataProvider {
  readonly name = "tonapi";

  readonly #baseUrl: string;
  readonly #headers: Record<string, string>;
  readonly #retry: RetryOptions;
  readonly #fetch: typeof fetch;
  readonly #pageSize: number;

  constructor(opts: TonapiOptions = {}) {
    this.#baseUrl = (opts.baseUrl ?? "https://tonapi.io").replace(/\/$/, "");
    this.#headers = {
      Accept: "application/json",
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    };
    this.#retry = opts.retry ?? DEFAULT_RETRY;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#pageSize = Math.min(opts.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  }

  async getAccountEvents(params: GetAccountEventsParams): Promise<RawEventPage> {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const events: RawEvent[] = [];
    let beforeLt: bigint | undefined;

    while (events.length < limit) {
      const page = await this.#fetchPage(params, beforeLt);
      // An empty page means we reached the account's earliest event: the
      // history is complete, not cut short.
      if (page.length === 0) return { events, truncated: false };

      let crossedLowerBound = false;
      for (const event of page) {
        if (event.timestamp < params.from) {
          crossedLowerBound = true;
          break;
        }
        if (event.timestamp > params.to) continue;
        if (event.inProgress) continue;
        events.push(event);
      }

      if (crossedLowerBound || page.length < this.#pageSize) {
        return { events, truncated: false };
      }

      const oldest = page[page.length - 1];
      // Defensive: without a strictly decreasing cursor we would loop forever.
      if (!oldest || (beforeLt !== undefined && oldest.lt >= beforeLt)) {
        return { events, truncated: false };
      }
      beforeLt = oldest.lt;
    }

    // We hit the cost cap before reaching the window's start. The history is
    // incomplete, and an incomplete history silently under-counts volume — so
    // this is surfaced, not swallowed.
    return { events: events.slice(0, limit), truncated: true };
  }

  async getAccountFirstActivity(address: string): Promise<number | null> {
    const url = `${this.#baseUrl}/v2/accounts/${encodeURIComponent(address)}`;
    const body = await fetchJsonWithRetry(
      url,
      { headers: this.#headers },
      this.#retry,
      this.#fetch,
    );
    if (!isRecord(body)) return null;
    const ts = body["last_activity"];
    return typeof ts === "number" ? ts : null;
  }

  async #fetchPage(
    params: GetAccountEventsParams,
    beforeLt: bigint | undefined,
  ): Promise<RawEvent[]> {
    const qs = new URLSearchParams({
      limit: String(this.#pageSize),
      start_date: String(params.from),
      end_date: String(params.to),
    });
    if (beforeLt !== undefined) qs.set("before_lt", beforeLt.toString());

    const url =
      `${this.#baseUrl}/v2/accounts/${encodeURIComponent(params.address)}` +
      `/events?${qs.toString()}`;

    const body = await fetchJsonWithRetry(
      url,
      { headers: this.#headers },
      this.#retry,
      this.#fetch,
    );
    return parseEventsResponse(body);
  }
}

/**
 * Shape-checks the provider response. Anything structurally wrong is a hard
 * error: a silently-dropped malformed event is an under-count, which reads to
 * the user as "my swap didn't register".
 */
export function parseEventsResponse(body: unknown): RawEvent[] {
  if (!isRecord(body) || !Array.isArray(body["events"])) {
    throw new StonRewardsError(
      "PROVIDER_MALFORMED_RESPONSE",
      "tonapi events response missing `events` array",
      { retryable: false },
    );
  }

  return body["events"].map((raw, i) => {
    if (!isRecord(raw)) {
      throw new StonRewardsError(
        "PROVIDER_MALFORMED_RESPONSE",
        `tonapi event ${i} is not an object`,
        { retryable: false },
      );
    }
    return {
      eventId: str(raw["event_id"], `event ${i} event_id`),
      ...accountField(raw["account"]),
      timestamp: num(raw["timestamp"], `event ${i} timestamp`),
      lt: bigintish(raw["lt"] ?? 0, `event ${i} lt`),
      inProgress: raw["in_progress"] === true,
      actions: parseActions(raw["actions"], i),
    };
  });
}

function parseActions(value: unknown, eventIndex: number): RawAction[] {
  if (!Array.isArray(value)) return [];
  const out: RawAction[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const type = str(item["type"], `event ${eventIndex} action type`);
    const status = typeof item["status"] === "string" ? item["status"] : "ok";
    // tonapi nests the typed payload under a key named after the action type,
    // e.g. { type: "JettonSwap", JettonSwap: { ... } }.
    const payload = item[type];
    out.push({ type, status, payload: isRecord(payload) ? payload : {} });
  }
  return out;
}

/**
 * The listing endpoint labels each event with the account it was fetched for;
 * the single-event endpoint does not. Decoding never reads it, so its absence
 * is not an error.
 */
function accountField(value: unknown): { account?: string } {
  if (typeof value === "string") return { account: value };
  if (isRecord(value) && typeof value["address"] === "string") {
    return { account: value["address"] };
  }
  return {};
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new StonRewardsError(
      "PROVIDER_MALFORMED_RESPONSE",
      `${what} is not a string`,
      { retryable: false },
    );
  }
  return value;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StonRewardsError(
      "PROVIDER_MALFORMED_RESPONSE",
      `${what} is not a finite number`,
      { retryable: false },
    );
  }
  return value;
}

function bigintish(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new StonRewardsError(
    "PROVIDER_MALFORMED_RESPONSE",
    `${what} is not an integer`,
    { retryable: false },
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
