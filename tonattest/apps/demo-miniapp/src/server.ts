#!/usr/bin/env node
/**
 * Demo Mini App backend.
 *
 * Shows the intended integration shape end to end:
 *
 *   1. The API key lives here, on the server, never in the Mini App.
 *   2. The server verifies the wallet against a campaign.
 *   3. It checks the returned attestation *offline*, against a pinned public
 *      key — so a compromised or spoofed API response cannot mint rewards.
 *   4. It records the nonce and awards points from its own ledger.
 *
 * The verification service never holds funds and never awards anything.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { TonAttest, verifyAttestation, type Attestation } from "@tonattest/sdk";
import { PointsLedger } from "./points.js";

const API_KEY = process.env["TONATTEST_API_KEY"];
const CAMPAIGN_ID = process.env["TONATTEST_CAMPAIGN_ID"];
const BASE_URL = process.env["TONATTEST_BASE_URL"] ?? "http://127.0.0.1:8080";
// Pinned at deploy time. Fetching the key from the same service you are
// verifying makes the offline check theatre rather than a safeguard.
const PUBLIC_KEY = process.env["TONATTEST_PUBLIC_KEY"];
const POINTS_PER_CLAIM = 100;
const PORT = Number(process.env["PORT"] ?? 3000);

if (!API_KEY || !CAMPAIGN_ID || !PUBLIC_KEY) {
  console.error(
    "Set TONATTEST_API_KEY, TONATTEST_CAMPAIGN_ID and TONATTEST_PUBLIC_KEY.\n" +
      "Get all three from: pnpm --filter @tonattest/service provision \"Demo\"",
  );
  process.exit(2);
}

const ston = new TonAttest({ apiKey: API_KEY, baseUrl: BASE_URL });
const ledger = new PointsLedger();
const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }

    if (req.method === "POST" && req.url === "/api/claim") {
      const body = await readJson(req);
      await handleClaim(body, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
});

async function handleClaim(
  body: { wallet?: string; telegramUserId?: string },
  res: import("node:http").ServerResponse,
): Promise<void> {
  const wallet = body.wallet?.trim();
  // In a real Mini App this comes from validated Telegram initData, not the
  // request body. Binding rewards to a Telegram identity is what makes
  // multi-wallet Sybil rings expensive — see the anti-abuse docs.
  const telegramUserId = body.telegramUserId?.trim();

  if (!wallet || !telegramUserId) {
    return send(res, 400, { error: "wallet and telegramUserId are required" });
  }

  let result;
  try {
    result = await ston.verify({ wallet, campaignId: CAMPAIGN_ID! });
  } catch (err) {
    // The SDK marks transient failures. Telling a user "you don't qualify"
    // when the truth is "we couldn't check" is the one thing worth avoiding.
    const retryable = (err as { retryable?: boolean }).retryable === true;
    return send(res, retryable ? 503 : 400, {
      error: retryable
        ? "Could not check your activity just now. Please try again shortly."
        : (err as Error).message,
      retryable,
      balance: ledger.balanceOf(telegramUserId),
    });
  }

  if (!result.eligible || !result.attestation) {
    // Evidence is shown to the user, not swallowed. "You swapped 62 of the
    // required 100 USDT" is actionable; "not eligible" is not.
    return send(res, 200, {
      eligible: false,
      evidence: result.evidence,
      balance: ledger.balanceOf(telegramUserId),
    });
  }

  const attestation = result.attestation as Attestation;
  const check = await verifyAttestation(attestation, PUBLIC_KEY!);
  if (!check.valid) {
    // Reaching here means the response did not come from the project whose
    // key we pinned. Award nothing.
    console.error("attestation failed offline verification", check);
    return send(res, 502, { error: "Proof failed verification" });
  }

  if (attestation.payload.wallet !== wallet) {
    // A valid signature over somebody else's wallet is still not a proof
    // about this user.
    return send(res, 400, { error: "Proof does not match the submitted wallet" });
  }

  const award = ledger.award({
    telegramUserId,
    wallet,
    nonce: attestation.payload.nonce,
    points: POINTS_PER_CLAIM,
    now: Math.floor(Date.now() / 1_000),
  });

  return send(res, 200, {
    eligible: true,
    awarded: award.awarded,
    reason: award.reason,
    points: award.awarded ? POINTS_PER_CLAIM : 0,
    balance: award.balance,
    evidence: result.evidence,
  });
}

function send(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // A body this large is not a legitimate claim.
      if (raw.length > 10_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw === "" ? {} : JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`Demo Mini App on http://127.0.0.1:${PORT}`);
});
