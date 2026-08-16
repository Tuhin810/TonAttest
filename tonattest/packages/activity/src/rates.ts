import {
  TonAttestError,
  canonicalAsset,
  NATIVE_TON,
  type AssetId,
  type KnownAction,
  type UsdValuation,
} from "@tonattest/core-types";

/**
 * Attaches an optional USD valuation to a decoded action.
 *
 * USD is deliberately a decoration, never the primary path: token amounts are
 * on-chain truth, replayable and dispute-free, while any USD figure depends on
 * a rate source and a moment in time. Every valuation therefore records both,
 * so a disputed result can be re-derived exactly.
 */
export interface RateProvider {
  value(action: KnownAction): Promise<KnownAction>;
}

export interface AssetRate {
  readonly priceUsd: number;
  readonly decimals: number;
}

export interface StonFiRatesOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** How long a fetched rate table stays usable. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * USD valuation from STON.fi's own asset list.
 *
 * **Known limitation, stated rather than hidden.** This endpoint serves the
 * *current* price, not the price at the moment of the transaction. For a swap
 * that happened weeks ago in a volatile token, the resulting USD figure is a
 * present-day restatement, not a historical valuation. The `at` field on every
 * valuation records when the rate was observed, precisely so this is visible
 * in evidence rather than implied.
 *
 * Because of that, USD thresholds should be treated as marketing-grade and
 * token-unit thresholds as the dispute-proof ones. Closing this properly needs
 * a historical rate source keyed on the event timestamp.
 */
export class StonFiRateProvider implements RateProvider {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #ttlMs: number;
  readonly #now: () => number;

  #rates: Map<AssetId, AssetRate> | null = null;
  #fetchedAt = 0;
  #inflight: Promise<Map<AssetId, AssetRate>> | null = null;

  constructor(opts: StonFiRatesOptions = {}) {
    this.#baseUrl = (opts.baseUrl ?? "https://api.ston.fi").replace(/\/$/, "");
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = opts.now ?? Date.now;
  }

  async value(action: KnownAction): Promise<KnownAction> {
    const rates = await this.#load();
    const observedAt = Math.floor(this.#now() / 1000);

    if (action.type === "SWAP") {
      // The input side is what the user spent, so that is what a "swapped $50"
      // rule means. Falling back to the output side keeps a swap valued when
      // only one of its two assets has a published rate.
      const usd =
        valueOf(rates, action.tokenIn, action.amountIn, observedAt) ??
        valueOf(rates, action.tokenOut, action.amountOut, observedAt);
      return usd ? { ...action, usd } : action;
    }

    let total = 0;
    let valuedAny = false;
    for (const leg of action.assets) {
      const usd = valueOf(rates, leg.asset, leg.amount, observedAt);
      if (!usd) continue;
      total += usd.amount;
      valuedAny = true;
    }
    return valuedAny
      ? { ...action, usd: { amount: total, source: SOURCE, at: observedAt } }
      : action;
  }

  async #load(): Promise<Map<AssetId, AssetRate>> {
    const cached = this.#rates;
    if (cached && this.#now() - this.#fetchedAt < this.#ttlMs) return cached;

    // Single-flight: a burst of valuations must cause one upstream fetch.
    this.#inflight ??= this.#refresh().finally(() => {
      this.#inflight = null;
    });

    try {
      return await this.#inflight;
    } catch (err) {
      // A stale rate table is better than failing a verification that only
      // wanted a decorative USD figure.
      if (cached) return cached;
      throw err;
    }
  }

  async #refresh(): Promise<Map<AssetId, AssetRate>> {
    const res = await this.#fetch(`${this.#baseUrl}/v1/assets`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new TonAttestError(
        "PROVIDER_UNAVAILABLE",
        `api.ston.fi/v1/assets returned ${res.status}`,
      );
    }

    const rates = parseAssetRates(await res.json());
    this.#rates = rates;
    this.#fetchedAt = this.#now();
    return rates;
  }
}

const SOURCE = "stonfi:assets";

export function parseAssetRates(body: unknown): Map<AssetId, AssetRate> {
  const list = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as never)["asset_list"])
      ? ((body as Record<string, unknown>)["asset_list"] as unknown[])
      : null;

  if (!list) {
    throw new TonAttestError(
      "PROVIDER_MALFORMED_RESPONSE",
      "STON.fi asset list response was not an array or { asset_list }",
      { retryable: false },
    );
  }

  const rates = new Map<AssetId, AssetRate>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const asset = canonicalAsset(
      typeof record["contract_address"] === "string" ? record["contract_address"] : null,
    );
    const price = toNumber(record["dex_usd_price"] ?? record["third_party_usd_price"]);
    const decimals = toNumber(record["decimals"]);
    if (!asset || price === null || decimals === null) continue;
    if (price <= 0 || decimals < 0 || decimals > 30) continue;

    rates.set(asset, { priceUsd: price, decimals });
  }
  return rates;
}

function valueOf(
  rates: ReadonlyMap<AssetId, AssetRate>,
  asset: AssetId,
  amount: bigint,
  observedAt: number,
): UsdValuation | null {
  const rate = rates.get(asset === NATIVE_TON ? NATIVE_TON : asset);
  if (!rate) return null;

  // Scale by decimals in integer space first, so a jetton amount too large for
  // a double does not lose precision before it is ever multiplied by a price.
  const whole = amount / 10n ** BigInt(rate.decimals);
  const remainder = amount % 10n ** BigInt(rate.decimals);
  const units = Number(whole) + Number(remainder) / 10 ** rate.decimals;

  return { amount: units * rate.priceUsd, source: SOURCE, at: observedAt };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
