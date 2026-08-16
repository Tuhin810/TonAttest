import {
  TonAttestError,
  canonicalAsset,
  normalizeAddress,
} from "@tonattest/core-types";
import { fetchJsonWithRetry, DEFAULT_RETRY, type RetryOptions } from "./http.js";
import { isRecord } from "./tonapi.js";

export interface PoolInfo {
  /** Raw-form pool contract address. */
  readonly address: string;
  /** The router this pool belongs to. Scopes pool lookup — see `byPair`. */
  readonly router: string;
  /** Canonical assets: every spelling of native TON collapses to "TON". */
  readonly token0: string;
  readonly token1: string;
  readonly lpJetton?: string;
  readonly deprecated: boolean;
}

/**
 * Which STON.fi contracts we recognise. The decoder consults this before
 * interpreting anything: an event that does not touch a known router or pool
 * is not our business, and an event that does but decodes to nothing becomes
 * an UNKNOWN action rather than being dropped.
 */
export interface PoolRegistrySnapshot {
  readonly pools: ReadonlyMap<string, PoolInfo>;
  readonly routers: ReadonlySet<string>;
  /**
   * Pools indexed by `router|assetA|assetB` with the asset pair sorted, so a
   * swap that names only its router and token pair can still be attributed.
   * Keys with more than one pool stay ambiguous and are left unattributed.
   */
  readonly byPair: ReadonlyMap<string, readonly PoolInfo[]>;
  readonly fetchedAt: number;
}

export interface PoolRegistryOptions {
  readonly baseUrl?: string;
  readonly retry?: RetryOptions;
  readonly fetchImpl?: typeof fetch;
  /** How long a snapshot stays usable before a refresh is attempted. */
  readonly ttlMs?: number;
  /** Extra router addresses to trust, for testnet or a new deployment. */
  readonly extraRouters?: readonly string[];
  /** Persistence hook so a provider outage cannot leave us with no registry. */
  readonly store?: PoolRegistryStore;
}

export interface PoolRegistryStore {
  load(): Promise<PoolRegistrySnapshot | null>;
  save(snapshot: PoolRegistrySnapshot): Promise<void>;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class PoolRegistry {
  readonly #baseUrl: string;
  readonly #retry: RetryOptions;
  readonly #fetch: typeof fetch;
  readonly #ttlMs: number;
  readonly #extraRouters: readonly string[];
  readonly #store: PoolRegistryStore | undefined;

  #snapshot: PoolRegistrySnapshot | null = null;
  #inflight: Promise<PoolRegistrySnapshot> | null = null;

  constructor(opts: PoolRegistryOptions = {}) {
    this.#baseUrl = (opts.baseUrl ?? "https://api.ston.fi").replace(/\/$/, "");
    this.#retry = opts.retry ?? DEFAULT_RETRY;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.#extraRouters = opts.extraRouters ?? [];
    this.#store = opts.store;
  }

  /**
   * Returns a usable snapshot, refreshing if stale.
   *
   * If the refresh fails but a stale snapshot exists, the stale one is served:
   * pool sets change slowly, and an hour-old registry is far better than
   * failing every verification in the ecosystem because one API blipped.
   */
  async get(now: number = Date.now()): Promise<PoolRegistrySnapshot> {
    const current = this.#snapshot ?? (await this.#loadFromStore());
    if (current && now - current.fetchedAt < this.#ttlMs) return current;

    // Single-flight: a burst of verifications must cause one upstream fetch.
    this.#inflight ??= this.#refresh(now).finally(() => {
      this.#inflight = null;
    });

    try {
      return await this.#inflight;
    } catch (err) {
      if (current) return current;
      throw err instanceof TonAttestError
        ? err
        : new TonAttestError(
            "POOL_REGISTRY_UNAVAILABLE",
            "Could not load the STON.fi pool registry and no cached snapshot exists",
            { cause: err },
          );
    }
  }

  async #loadFromStore(): Promise<PoolRegistrySnapshot | null> {
    if (!this.#store) return null;
    const loaded = await this.#store.load();
    if (loaded) this.#snapshot = loaded;
    return loaded;
  }

  async #refresh(now: number): Promise<PoolRegistrySnapshot> {
    const body = await fetchJsonWithRetry(
      `${this.#baseUrl}/v1/pools`,
      { headers: { Accept: "application/json" } },
      this.#retry,
      this.#fetch,
    );

    const snapshot = parsePoolsResponse(body, now, this.#extraRouters);
    this.#snapshot = snapshot;
    await this.#store?.save(snapshot);
    return snapshot;
  }
}

export function parsePoolsResponse(
  body: unknown,
  fetchedAt: number,
  extraRouters: readonly string[] = [],
): PoolRegistrySnapshot {
  const list = isRecord(body) && Array.isArray(body["pool_list"])
    ? body["pool_list"]
    : Array.isArray(body)
      ? body
      : null;

  if (!list) {
    throw new TonAttestError(
      "POOL_REGISTRY_UNAVAILABLE",
      "STON.fi pool list response was not an array or { pool_list }",
      { retryable: false },
    );
  }

  const pools = new Map<string, PoolInfo>();
  const byPair = new Map<string, PoolInfo[]>();
  // Every address is reduced to canonical raw form on the way in. STON.fi
  // publishes user-friendly base64 while chain events carry raw addresses;
  // indexing them in different spellings means no lookup ever hits.
  const routers = new Set<string>(
    extraRouters.map(normalizeAddress).filter((a): a is string => a !== null),
  );

  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const address = normalizeAddress(asString(entry["address"]));
    const router = normalizeAddress(asString(entry["router_address"]));
    const token0 = canonicalAsset(asString(entry["token0_address"]));
    const token1 = canonicalAsset(asString(entry["token1_address"]));
    if (!address || !router || !token0 || !token1) continue;

    const lpJetton = normalizeAddress(
      asString(entry["lp_account_address"]) ?? asString(entry["lp_jetton"]),
    );
    const pool: PoolInfo = {
      address,
      router,
      token0,
      token1,
      ...(lpJetton ? { lpJetton } : {}),
      deprecated: entry["deprecated"] === true,
    };
    pools.set(address, pool);
    routers.add(router);

    const key = pairKey(router, token0, token1);
    const bucket = byPair.get(key);
    if (bucket) bucket.push(pool);
    else byPair.set(key, [pool]);
  }

  if (pools.size === 0) {
    throw new TonAttestError(
      "POOL_REGISTRY_UNAVAILABLE",
      "STON.fi pool list decoded to zero pools",
      { retryable: false },
    );
  }

  return { pools, routers, byPair, fetchedAt };
}

/** Router-scoped, order-independent key for a token pair. */
export function pairKey(router: string, assetA: string, assetB: string): string {
  const [first, second] = assetA <= assetB ? [assetA, assetB] : [assetB, assetA];
  return `${router}|${first}|${second}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
