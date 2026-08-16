import { PoolRegistry, TonapiProvider } from "@tonattest/data-provider";
import { StonFiRateProvider } from "@tonattest/activity";
import { buildApp } from "./app.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { RedisCache, RedisRateLimiter } from "./redis.js";
import { PostgresStore } from "./store/postgres.js";
import { Verifier } from "./verifier.js";

loadDotEnv(new URL("../../../.env", import.meta.url).pathname);
const config = loadConfig();

const store = new PostgresStore(config.databaseUrl);
const cache = new RedisCache(config.redisUrl);
const rateLimiter = new RedisRateLimiter(config.redisUrl, {
  burst: config.rateLimitBurst,
  perSecond: config.rateLimitPerSecond,
});

const provider = new TonapiProvider({
  ...(config.tonapiKey ? { apiKey: config.tonapiKey } : {}),
});
const poolRegistry = new PoolRegistry();

const verifier = new Verifier({
  store,
  cache,
  provider,
  registry: () => poolRegistry.get(),
  masterKey: config.masterKey,
  maxEventsPerWallet: config.maxEventsPerWallet,
  rates: new StonFiRateProvider(),
});

const app = buildApp({
  store,
  cache,
  verifier,
  rateLimiter,
  logLevel: config.logLevel,
});

// Drain in-flight requests before exiting, so a deploy does not turn an
// in-progress claim into a failed one.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, shutting down`);
    void app
      .close()
      .then(() => Promise.all([store.close(), cache.close()]))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error({ err }, "failed to start");
  process.exit(1);
}
