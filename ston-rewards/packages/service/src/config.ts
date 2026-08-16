import { readFileSync } from "node:fs";

/**
 * Configuration is read once at startup and validated eagerly.
 *
 * A service that boots with a missing signing key and only discovers it on the
 * first verification has turned a deployment error into a user-facing one.
 */
export interface Config {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /** 32 bytes. Encrypts project signing keys at rest. */
  readonly masterKey: Uint8Array;
  readonly tonapiKey: string | undefined;
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly activityTtlSeconds: number;
  readonly rateLimitBurst: number;
  readonly rateLimitPerSecond: number;
  readonly maxEventsPerWallet: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];

  const databaseUrl = env["DATABASE_URL"];
  const redisUrl = env["REDIS_URL"];
  const masterKeyHex = env["MASTER_KEY"];

  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!redisUrl) missing.push("REDIS_URL");
  if (!masterKeyHex) missing.push("MASTER_KEY");

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill them in.",
    );
  }

  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex!)) {
    throw new ConfigError(
      "MASTER_KEY must be 32 bytes hex-encoded (64 hex characters). " +
        "Generate one with: openssl rand -hex 32",
    );
  }

  return {
    databaseUrl: databaseUrl!,
    redisUrl: redisUrl!,
    masterKey: Buffer.from(masterKeyHex!, "hex"),
    tonapiKey: env["TONAPI_KEY"] || undefined,
    port: int(env["PORT"], 8080),
    host: env["HOST"] ?? "0.0.0.0",
    logLevel: env["LOG_LEVEL"] ?? "info",
    activityTtlSeconds: int(env["ACTIVITY_TTL_SECONDS"], 60),
    rateLimitBurst: int(env["RATE_LIMIT_BURST"], 60),
    rateLimitPerSecond: int(env["RATE_LIMIT_PER_SECOND"], 10),
    maxEventsPerWallet: int(env["MAX_EVENTS_PER_WALLET"], 1_000),
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`Expected a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Minimal .env loader so a fresh clone runs without extra tooling.
 * Real environment variables always win — a deployed service must never be
 * overridden by a stray file in the image.
 */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}
