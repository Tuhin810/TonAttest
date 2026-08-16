#!/usr/bin/env node
/**
 * Phase 1 exit criterion: resolve a wallet's STON.fi history from live chain
 * data and print it, so decoded output can be eyeballed against tonviewer.
 *
 *   pnpm decode <wallet> [--days 30] [--json]
 *
 * Set TONAPI_KEY to raise the rate limit.
 */
import { StonRewardsError } from "@ston-rewards/core-types";
import { PoolRegistry, TonapiProvider } from "@ston-rewards/data-provider";
import { decodeEvents, normalizeAddress, reconstructPositions } from "@ston-rewards/decoder";

const DAY = 86_400;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.wallet) {
    console.error("usage: decode <wallet> [--days 30] [--limit 1000] [--json]");
    return 2;
  }

  const wallet = normalizeAddress(args.wallet);
  if (!wallet) {
    console.error(`Not a valid TON address: ${args.wallet}`);
    return 2;
  }

  const to = Math.floor(Date.now() / 1000);
  const from = to - args.days * DAY;

  const provider = new TonapiProvider({
    ...(process.env["TONAPI_KEY"] ? { apiKey: process.env["TONAPI_KEY"] } : {}),
  });
  const registrySource = new PoolRegistry();

  const registry = await registrySource.get();
  const page = await provider.getAccountEvents({ address: wallet, from, to, limit: args.limit });
  const result = decodeEvents({ events: page.events, registry, wallet });

  const known = result.actions.filter((a) => a.type !== "UNKNOWN");
  const positions = reconstructPositions(
    known as Parameters<typeof reconstructPositions>[0],
  );

  if (args.json) {
    console.log(JSON.stringify({ wallet, from, to, result, positions }, replacer, 2));
    return 0;
  }

  printTable(wallet, from, to, result, positions, page.truncated, registry.pools.size);
  // A truncated history under-counts volume; exiting non-zero keeps that from
  // being mistaken for a clean run in a script.
  return page.truncated ? 1 : 0;
}

function printTable(
  wallet: string,
  from: number,
  to: number,
  result: ReturnType<typeof decodeEvents>,
  positions: ReturnType<typeof reconstructPositions>,
  truncated: boolean,
  poolCount: number,
): void {
  console.log(`wallet   ${wallet}`);
  console.log(`window   ${iso(from)} .. ${iso(to)}`);
  console.log(`pools    ${poolCount} known STON.fi pools`);
  console.log("");

  if (result.actions.length === 0) {
    console.log("No STON.fi activity in this window.");
  }

  for (const action of result.actions) {
    const when = iso(action.occurredAt);
    switch (action.type) {
      case "SWAP":
        console.log(
          `${when}  SWAP        ${action.amountIn} ${short(action.tokenIn)} ` +
            `-> ${action.amountOut} ${short(action.tokenOut)}  ` +
            `pool=${action.pool ? short(action.pool) : "ambiguous"}`,
        );
        break;
      case "LP_ADD":
      case "LP_REMOVE":
        console.log(
          `${when}  ${action.type.padEnd(11)} lp=${action.lpAmount} pool=${short(action.pool)}  ` +
            action.assets.map((l) => `${l.amount} ${short(l.asset)}`).join(" + "),
        );
        break;
      case "UNKNOWN":
        console.log(`${when}  UNKNOWN     ${JSON.stringify(action.raw).slice(0, 90)}`);
        break;
    }
  }

  if (positions.length > 0) {
    console.log("\nLP positions");
    for (const p of positions) {
      const closed = p.closedAt === null ? "open" : `closed ${iso(p.closedAt)}`;
      console.log(`  ${short(p.pool)}  lp=${p.lpAmount}  ${iso(p.openedAt)} -> ${closed}`);
    }
  }

  // The unknown rate is the early-warning signal for a STON.fi contract change.
  const rate = result.consideredCount === 0
    ? 0
    : (result.unknownCount / result.consideredCount) * 100;
  console.log(
    `\n${result.actions.length} actions, ` +
      `${result.unknownCount}/${result.consideredCount} unknown (${rate.toFixed(1)}%)`,
  );

  if (truncated) {
    console.log(
      "\nWARNING: history was truncated by --limit. Volume totals are incomplete.",
    );
  }
}

interface Args {
  wallet: string | undefined;
  days: number;
  limit: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { wallet: undefined, days: 30, limit: 1_000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") args.json = true;
    else if (arg === "--days") args.days = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (!arg.startsWith("--")) args.wallet ??= arg;
  }
  return args;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toISOString().replace(".000Z", "Z");
}

function short(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof StonRewardsError) {
      console.error(`${err.code}: ${err.message}${err.retryable ? " (retryable)" : ""}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
