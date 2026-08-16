#!/usr/bin/env node
/**
 * Applies pending migrations, then exits.
 *
 *   pnpm --filter @ston-rewards/service migrate
 *
 * Safe to run on every deploy: each migration runs once, in a transaction.
 */
import { loadConfig, loadDotEnv } from "../config.js";
import { PostgresStore } from "../store/postgres.js";

loadDotEnv(new URL("../../../../.env", import.meta.url).pathname);
const config = loadConfig();

const store = new PostgresStore(config.databaseUrl);
const directory = new URL("../../migrations/", import.meta.url).pathname;

try {
  const applied = await store.migrate(directory);
  console.log(
    applied.length === 0
      ? "No pending migrations."
      : `Applied ${applied.length} migration(s):\n  ${applied.join("\n  ")}`,
  );
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await store.close();
}
