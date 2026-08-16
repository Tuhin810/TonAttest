import {
  TonAttestError,
  isKnownAction,
  normalizeAddress,
  type ActivitySet,
  type KnownAction,
} from "@tonattest/core-types";
import type { DataProvider, PoolRegistrySnapshot } from "@tonattest/data-provider";
import { decodeEvents, reconstructPositions } from "@tonattest/decoder";
import type { RateProvider } from "./rates.js";

export interface ResolveActivityOptions {
  readonly provider: DataProvider;
  readonly registry: PoolRegistrySnapshot;
  readonly wallet: string;
  /** Inclusive window bounds, unix seconds. */
  readonly from: number;
  readonly to: number;
  /** Hard cap on events fetched, bounding cost against very active wallets. */
  readonly limit?: number;
  /** Optional USD valuation. Omitted entirely when absent. */
  readonly rates?: RateProvider;
}

export interface ResolveActivityResult {
  readonly activity: ActivitySet;
  /** Share of considered STON.fi actions we could not decode, 0–1. */
  readonly unknownRate: number;
  readonly unknownCount: number;
}

/**
 * Resolves a wallet's STON.fi activity into the {@link ActivitySet} the rules
 * engine evaluates against.
 *
 * Fails closed. If the wallet's history could not be fetched completely, this
 * throws rather than returning a partial set: a partial history under-counts
 * volume, which produces a confident "ineligible" for a user who genuinely
 * qualified. A false negative is a support ticket; the alternative — trusting
 * incomplete data — eventually produces false positives too, and those are
 * payouts the integrating app cannot claw back.
 */
export async function resolveActivity(
  options: ResolveActivityOptions,
): Promise<ResolveActivityResult> {
  const wallet = normalizeAddress(options.wallet);
  if (!wallet) {
    throw new TonAttestError(
      "INVALID_ADDRESS",
      `Not a valid TON address: ${options.wallet}`,
      { retryable: false },
    );
  }

  const page = await options.provider.getAccountEvents({
    address: wallet,
    from: options.from,
    to: options.to,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  if (page.truncated) {
    throw new TonAttestError(
      "STALE_ACTIVITY",
      `Wallet ${wallet} has more history in this window than the fetch cap allows; ` +
        "refusing to evaluate against a partial activity set",
    );
  }

  const decoded = decodeEvents({ events: page.events, registry: options.registry, wallet });
  const actions = decoded.actions.filter(isKnownAction);
  const valued = options.rates ? await applyRates(actions, options.rates) : actions;

  const walletFirstSeenAt = await firstSeen(options.provider, wallet);

  return {
    activity: {
      wallet,
      actions: valued,
      positions: reconstructPositions(valued),
      walletFirstSeenAt,
      resolvedFrom: options.from,
      resolvedTo: options.to,
    },
    unknownCount: decoded.unknownCount,
    unknownRate:
      decoded.consideredCount === 0 ? 0 : decoded.unknownCount / decoded.consideredCount,
  };
}

/**
 * Wallet age is an optional anti-abuse input, not a correctness requirement,
 * so a provider that cannot answer leaves it unknown rather than failing the
 * whole resolution.
 */
async function firstSeen(provider: DataProvider, wallet: string): Promise<number | null> {
  try {
    return await provider.getAccountFirstActivity(wallet);
  } catch {
    return null;
  }
}

async function applyRates(
  actions: readonly KnownAction[],
  rates: RateProvider,
): Promise<KnownAction[]> {
  const valued: KnownAction[] = [];
  for (const action of actions) {
    valued.push(await rates.value(action));
  }
  return valued;
}
