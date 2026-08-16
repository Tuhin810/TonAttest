import { ApiResponseError, InvalidInputError, NetworkError } from "./errors.js";
import type {
  Campaign,
  CreateCampaignInput,
  PublicKeyInfo,
  VerifyInput,
  VerifyResult,
} from "./types.js";

export interface TonAttestOptions {
  /** Project API key. Keep it server-side — see the note on `verify`. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Attempts for retryable failures, including the first. */
  readonly retries?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.tonattest.dev";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;

export class TonAttest {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;

  constructor(options: TonAttestOptions) {
    if (!options.apiKey) {
      throw new InvalidInputError("apiKey is required");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);
    this.#fetch = options.fetchImpl ?? globalThis.fetch;

    if (typeof this.#fetch !== "function") {
      throw new InvalidInputError(
        "No fetch implementation available; pass one as `fetchImpl`",
      );
    }
  }

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    return this.#request<Campaign>("POST", "/v1/campaigns", {
      name: input.name,
      rule: input.rule,
      ...(input.limits ? { limits: input.limits } : {}),
      startsAt: toIso(input.startsAt, "startsAt"),
      endsAt: toIso(input.endsAt, "endsAt"),
    });
  }

  async getCampaign(id: string): Promise<Campaign> {
    return this.#request<Campaign>("GET", `/v1/campaigns/${encodeURIComponent(id)}`);
  }

  async listCampaigns(): Promise<Campaign[]> {
    const { campaigns } = await this.#request<{ campaigns: Campaign[] }>(
      "GET",
      "/v1/campaigns",
    );
    return campaigns;
  }

  /**
   * Verifies a wallet against a campaign.
   *
   * Call this from your backend, not from the Mini App: the API key
   * authenticates your project, and anything shipped to a client is public.
   * The attestation it returns is the artifact meant to travel — it is signed,
   * so it cannot be forged, and it is verifiable without this SDK.
   *
   * Safe to retry. Repeated calls inside the idempotency window return the
   * same verification and the same attestation rather than issuing a second.
   */
  async verify(input: VerifyInput): Promise<VerifyResult> {
    if (!input.wallet) throw new InvalidInputError("wallet is required");
    if (!input.campaignId) throw new InvalidInputError("campaignId is required");

    return this.#request<VerifyResult>("POST", "/v1/verify", {
      wallet: input.wallet,
      campaignId: input.campaignId,
    });
  }

  /**
   * Public keys for this project, including retired ones.
   *
   * Pin these rather than fetching them on every check: an attestation you
   * verify against a key fetched from the same service you are verifying is
   * only as trustworthy as that live response.
   */
  async getKeys(): Promise<PublicKeyInfo[]> {
    const { keys } = await this.#request<{ keys: PublicKeyInfo[] }>("GET", "/v1/keys");
    return keys;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.#retries; attempt++) {
      if (attempt > 0) {
        // Full jitter: a campaign launch means many clients retrying at once,
        // and a fixed backoff would keep them synchronised.
        await sleep(Math.random() * Math.min(4_000, 250 * 2 ** (attempt - 1)));
      }

      try {
        return await this.#attempt<T>(method, path, body);
      } catch (err) {
        lastError = err;
        const retryable =
          err instanceof NetworkError ||
          (err instanceof ApiResponseError && err.retryable);
        if (!retryable) throw err;
      }
    }

    throw lastError;
  }

  async #attempt<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "AbortError";
      throw new NetworkError(
        aborted ? `Request timed out after ${this.#timeoutMs}ms` : "Network request failed",
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const parsed = text === "" ? undefined : safeJson(text);

    if (!response.ok) {
      const error = (parsed as { error?: Record<string, unknown> } | undefined)?.error;
      throw new ApiResponseError({
        status: response.status,
        code: typeof error?.["code"] === "string" ? error["code"] : "UNKNOWN",
        message:
          typeof error?.["message"] === "string"
            ? error["message"]
            : `Request failed with status ${response.status}`,
        // Trust the server's own judgement when it gives one; otherwise treat
        // 5xx and 429 as worth retrying and everything else as final.
        retryable:
          typeof error?.["retryable"] === "boolean"
            ? error["retryable"]
            : response.status >= 500 || response.status === 429,
        details: error?.["details"],
      });
    }

    return parsed as T;
  }
}

function toIso(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidInputError(`${field} is not a valid date`);
  }
  return date.toISOString();
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
