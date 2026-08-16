import { randomBytes } from "node:crypto";
import { generateKeypair, toHex } from "@ston-rewards/attest";
import { parsePoolsResponse, type DataProvider, type RawEvent } from "@ston-rewards/data-provider";
import { ruleHash, swap, type Rule } from "@ston-rewards/rules";
import { buildApp } from "../src/app.js";
import { MemoryCache } from "../src/cache.js";
import { generateApiKey, newId, seal } from "../src/crypto.js";
import { MemoryRateLimiter } from "../src/ratelimit.js";
import { MemoryStore } from "../src/store/memory.js";
import type { Campaign } from "../src/store/types.js";
import { Verifier } from "../src/verifier.js";

export const WALLET = "0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e";
export const POOL = `0:${"11".repeat(32)}`;
export const ROUTER = `0:${"33".repeat(32)}`;
export const USDT = `0:${"aa".repeat(32)}`;
const ZERO = `0:${"00".repeat(32)}`;

export const REGISTRY = parsePoolsResponse(
  [{ address: POOL, router_address: ROUTER, token0_address: ZERO, token1_address: USDT }],
  0,
);

export function swapEvent(id: string, lt: bigint, timestamp: number): RawEvent {
  return {
    eventId: id,
    timestamp,
    lt,
    inProgress: false,
    actions: [
      {
        type: "JettonSwap",
        status: "ok",
        payload: {
          dex: "stonfi",
          user_wallet: WALLET,
          router: ROUTER,
          ton_in: 1_000_000_000,
          amount_in: "",
          amount_out: "5000000",
          jetton_master_out: USDT,
        },
      },
    ],
  };
}

export interface Harness {
  app: ReturnType<typeof buildApp>;
  store: MemoryStore;
  apiKey: string;
  projectId: string;
  publicKey: string;
  campaign: Campaign;
  fetches: () => number;
  setProvider(provider: Partial<DataProvider>): void;
}

export const NOW_MS = 1_800_000_000_000;
export const NOW = NOW_MS / 1_000;

export async function harness(
  opts: {
    rule?: Rule;
    events?: RawEvent[];
    campaignOverrides?: Partial<Campaign>;
    now?: () => number;
  } = {},
): Promise<Harness> {
  const store = new MemoryStore();
  const cache = new MemoryCache();
  const now = opts.now ?? (() => NOW_MS);

  const credentials = generateApiKey();
  const projectId = newId("prj");
  await store.createProject({
    id: projectId,
    name: "test",
    apiKeyHash: credentials.hash,
    apiKeySalt: credentials.salt,
    apiKeyHint: credentials.hint,
    disabledAt: null,
  });

  const masterKey = randomBytes(32);
  const keypair = await generateKeypair();
  const sealed = seal(keypair.privateKey, masterKey);
  await store.createSigningKey({
    id: newId("key"),
    projectId,
    publicKey: toHex(keypair.publicKey),
    privateKeyCiphertext: sealed.ciphertext,
    privateKeyIv: sealed.iv,
    privateKeyTag: sealed.tag,
    createdAt: new Date(NOW_MS - 1_000),
    retiredAt: null,
  });

  const rule = opts.rule ?? swap({ count: 1 });
  const campaign: Campaign = {
    id: newId("cmp"),
    projectId,
    name: "test campaign",
    rule,
    ruleHash: ruleHash(rule),
    limits: null,
    startsAt: new Date(NOW_MS - 30 * 86_400_000),
    endsAt: new Date(NOW_MS + 30 * 86_400_000),
    status: "active",
    ...opts.campaignOverrides,
  };
  await store.createCampaign(campaign);

  let fetches = 0;
  let overrides: Partial<DataProvider> = {};
  const events = opts.events ?? [swapEvent("tx1", 1n, NOW - 3_600)];

  const provider: DataProvider = {
    name: "stub",
    async getAccountEvents(params) {
      fetches++;
      if (overrides.getAccountEvents) return overrides.getAccountEvents(params);
      return { events, truncated: false };
    },
    async getAccountFirstActivity(address) {
      if (overrides.getAccountFirstActivity) {
        return overrides.getAccountFirstActivity(address);
      }
      return NOW - 365 * 86_400;
    },
  };

  const verifier = new Verifier({
    store,
    cache,
    provider,
    registry: async () => REGISTRY,
    masterKey,
    maxEventsPerWallet: 1_000,
    now,
  });

  const app = buildApp({
    store,
    cache,
    verifier,
    rateLimiter: new MemoryRateLimiter({ burst: 1_000, perSecond: 1_000 }),
    logLevel: "silent",
    now,
  });

  return {
    app,
    store,
    apiKey: credentials.apiKey,
    projectId,
    publicKey: toHex(keypair.publicKey),
    campaign,
    fetches: () => fetches,
    setProvider(next) {
      overrides = next;
    },
  };
}

export function auth(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}
