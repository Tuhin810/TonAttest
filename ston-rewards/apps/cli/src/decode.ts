#!/usr/bin/env node
/**
 * Phase 1 exit criterion: resolve a wallet's STON.fi history from live chain
 * data and print it, so decoded output can be eyeballed against tonviewer.
 *
 *   pnpm decode <wallet> [--days 30] [--json]
 *
 * Set TONAPI_KEY to raise the rate limit.
 */
import { StonRewardsError, normalizeAddress } from "@ston-rewards/core-types";
import { PoolRegistry, TonapiProvider } from "@ston-rewards/data-provider";
import { StonFiRateProvider, resolveActivity } from "@ston-rewards/activity";

const DAY = 86_400;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.wallet) {
    console.error("usage: decode <wallet> [--days 30] [--limit 1000] [--usd] [--json]");
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
  const registry = await new PoolRegistry().get();

  const { activity, unknownCount, unknownRate } = await resolveActivity({
    provider,
    registry,
    wallet,
    from,
    to,
    limit: args.limit,
    ...(args.usd ? { rates: new StonFiRateProvider() } : {}),
  });

  if (args.json) {
    console.log(JSON.stringify({ activity, unknownCount, unknownRate }, replacer, 2));
    return 0;
  }

  printTable(activity, unknownCount, unknownRate, registry.pools.size);
  return 0;
}

function printTable(
  activity: Awaited<ReturnType<typeof resolveActivity>>["activity"],
  unknownCount: number,
  unknownRate: number,
  poolCount: number,
): void {
  const { actions, positions } = activity;
  console.log(`wallet   ${activity.wallet}`);
  console.log(`window   ${iso(activity.resolvedFrom)} .. ${iso(activity.resolvedTo)}`);
  console.log(`pools    ${poolCount} known STON.fi pools`);
  console.log("");

  if (actions.length === 0) {
    console.log("No STON.fi activity in this window.");
  }

  for (const action of actions) {
    const when = iso(action.occurredAt);
    switch (action.type) {
      case "SWAP":
        console.log(
          `${when}  SWAP        ${action.amountIn} ${short(action.tokenIn)} ` +
            `-> ${action.amountOut} ${short(action.tokenOut)}  ` +
            `pool=${action.pool ? short(action.pool) : "ambiguous"}${usdSuffix(action.usd)}`,
        );
        break;
      case "LP_ADD":
      case "LP_REMOVE":
        console.log(
          `${when}  ${action.type.padEnd(11)} lp=${action.lpAmount} pool=${short(action.pool)}  ` +
            action.assets.map((l) => `${l.amount} ${short(l.asset)}`).join(" + ") +
            usdSuffix(action.usd),
        );
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
  console.log(
    `\n${actions.length} actions, ${unknownCount} undecodable ` +
      `(${(unknownRate * 100).toFixed(1)}%)`,
  );
}

function usdSuffix(usd: { amount: number; at: number } | undefined): string {
  // The rate's observation time is shown because it is not the transaction
  // time: this is a present-day restatement, not a historical valuation.
  return usd ? `  ~$${usd.amount.toFixed(2)} @${iso(usd.at)}` : "";
}

interface Args {
  wallet: string | undefined;
  days: number;
  limit: number;
  json: boolean;
  usd: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { wallet: undefined, days: 30, limit: 1_000, json: false, usd: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") args.json = true;
    else if (arg === "--usd") args.usd = true;
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
