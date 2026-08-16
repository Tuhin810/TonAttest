#!/usr/bin/env node
/**
 * Reference integration: attestation → offline verification → jetton payout.
 *
 * The point of this example is the boundary it draws. The verification service
 * proves what a wallet did on STON.fi and signs that statement. It never holds
 * a key that can move funds, never custodies anything, and is not trusted at
 * payout time — the transfer below is built and signed by *the app's own
 * wallet*, after checking the attestation offline against a pinned key.
 *
 * That ordering is the whole security model:
 *
 *   verify offline  →  check nonce is unspent  →  then, and only then, pay
 *
 * Run it:
 *   STON_REWARDS_API_KEY=... STON_REWARDS_CAMPAIGN_ID=... \
 *   STON_REWARDS_PUBLIC_KEY=... APP_WALLET_MNEMONIC="..." \
 *   pnpm --filter @ston-rewards/examples jetton-payout <wallet>
 *
 * Without APP_WALLET_MNEMONIC it runs in dry-run mode and prints the transfer
 * it *would* send, which is how you should try it first.
 */
import { StonRewards, verifyAttestation } from "@ston-rewards/sdk";

const API_KEY = requireEnv("STON_REWARDS_API_KEY");
const CAMPAIGN_ID = requireEnv("STON_REWARDS_CAMPAIGN_ID");
// Pinned at deploy time. Fetching this from the service you are verifying
// would make the offline check meaningless.
const PUBLIC_KEY = requireEnv("STON_REWARDS_PUBLIC_KEY");
const BASE_URL = process.env["STON_REWARDS_BASE_URL"] ?? "http://127.0.0.1:8080";

const PAYOUT_JETTON = process.env["PAYOUT_JETTON_MASTER"] ?? "<jetton master address>";
const PAYOUT_AMOUNT = BigInt(process.env["PAYOUT_AMOUNT"] ?? "1000000");
const DRY_RUN = !process.env["APP_WALLET_MNEMONIC"];

/**
 * Nonces already paid out.
 *
 * In a real app this is a database table with a unique constraint, not a Set.
 * An attestation is a bearer artifact valid until it expires: without this
 * check a user can present the same proof repeatedly and be paid each time.
 * This is the app's responsibility, and it is the single most common way an
 * integration gets drained.
 */
const spentNonces = new Set<string>();

async function main(): Promise<number> {
  const wallet = process.argv[2];
  if (!wallet) {
    console.error("usage: jetton-payout <wallet>");
    return 2;
  }

  const ston = new StonRewards({ apiKey: API_KEY, baseUrl: BASE_URL });

  console.log(`Verifying ${wallet} against ${CAMPAIGN_ID}…`);
  const result = await ston.verify({ wallet, campaignId: CAMPAIGN_ID });

  if (!result.eligible || !result.attestation) {
    console.log("\nNot eligible. Evidence:");
    printEvidence(result.evidence);
    return 1;
  }

  // 1. Verify offline. Nothing about this call touches the network: a spoofed
  //    or replayed API response cannot get past a signature check against a
  //    key we pinned ourselves.
  const check = await verifyAttestation(result.attestation, PUBLIC_KEY);
  if (!check.valid) {
    console.error(`\nAttestation failed verification: ${check.reason} — ${check.detail}`);
    return 1;
  }

  const payload = result.attestation.payload;

  // 2. Confirm the proof is about the wallet we are paying. A valid signature
  //    over a *different* wallet is still not a statement about this one.
  if (payload.wallet !== wallet && payload.wallet !== normalizeGuess(wallet)) {
    console.error("\nAttestation is for a different wallet; refusing to pay.");
    return 1;
  }

  // 3. Confirm the campaign matches, so a proof earned under a cheap campaign
  //    cannot be redeemed against an expensive one.
  if (payload.campaign !== CAMPAIGN_ID) {
    console.error("\nAttestation is for a different campaign; refusing to pay.");
    return 1;
  }

  // 4. Spend the nonce before sending anything. Recording after payment leaves
  //    a window where a crash means a double payout.
  if (spentNonces.has(payload.nonce)) {
    console.log("\nThis attestation was already redeemed.");
    return 1;
  }
  spentNonces.add(payload.nonce);

  console.log("\nAttestation verified offline ✓");
  console.log(`  wallet   ${payload.wallet}`);
  console.log(`  campaign ${payload.campaign}`);
  console.log(`  rule     ${payload.rule_hash}`);
  console.log(`  expires  ${new Date(payload.expires_at * 1_000).toISOString()}`);

  await sendJettonPayout({ to: payload.wallet, amount: PAYOUT_AMOUNT });
  return 0;
}

/**
 * The payout itself, executed by the app's own wallet.
 *
 * Left as a documented sketch rather than a live transfer: wiring a real
 * mnemonic into an example invites someone to paste a funded one into a
 * terminal. The shape is what matters — `@ton/ton` + `@ton/crypto`, an
 * internal message carrying a jetton `transfer` body, signed locally.
 */
async function sendJettonPayout(params: { to: string; amount: bigint }): Promise<void> {
  console.log("\nPayout");
  console.log(`  jetton ${PAYOUT_JETTON}`);
  console.log(`  amount ${params.amount} units`);
  console.log(`  to     ${params.to}`);

  if (DRY_RUN) {
    console.log("\n  DRY RUN — set APP_WALLET_MNEMONIC to send for real.");
    console.log(`
  The live version is roughly:

    import { TonClient, WalletContractV4, internal, beginCell, toNano } from "@ton/ton";
    import { mnemonicToPrivateKey } from "@ton/crypto";

    const keys   = await mnemonicToPrivateKey(process.env.APP_WALLET_MNEMONIC.split(" "));
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey });
    const client = new TonClient({ endpoint: "https://toncenter.com/api/v2/jsonRPC" });
    const opened = client.open(wallet);

    // The jetton wallet OF THE APP, not the jetton master.
    const body = beginCell()
      .storeUint(0x0f8a7ea5, 32)      // op: transfer
      .storeUint(0, 64)               // query id
      .storeCoins(${params.amount}n)  // jetton units
      .storeAddress(Address.parse("${params.to}"))
      .storeAddress(wallet.address)   // excess refund
      .storeBit(0)                    // no custom payload
      .storeCoins(toNano("0.000000001"))
      .storeBit(0)
      .endCell();

    await opened.sendTransfer({
      seqno: await opened.getSeqno(),
      secretKey: keys.secretKey,
      messages: [internal({ to: appJettonWallet, value: toNano("0.05"), body })],
    });

  Note what is absent: the verification service is not involved. It cannot
  move these funds, and a compromise of it cannot cause a payout that the
  offline check above would not catch.`);
    return;
  }

  console.error(
    "\n  Live payout is intentionally not wired up in this example. " +
      "Copy the sketch above into your own service, where your key management lives.",
  );
}

function printEvidence(evidence: { root: unknown; disqualified?: string }): void {
  if (evidence.disqualified) console.log(`  wallet: ${evidence.disqualified}`);
  const walk = (node: Record<string, unknown>): void => {
    if (Array.isArray(node["children"])) {
      for (const child of node["children"]) walk(child as Record<string, unknown>);
      return;
    }
    console.log(`  ${node["satisfied"] ? "✓" : "✗"} ${node["kind"]}: ${node["detail"]}`);
  };
  walk(evidence.root as Record<string, unknown>);
}

function normalizeGuess(wallet: string): string {
  return wallet.trim();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required. See the header of this file.`);
    process.exit(2);
  }
  return value;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
