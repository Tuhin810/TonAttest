# Reward Verification — Overview

Define a rule in your own code. Ask whether a wallet satisfies it. Get back a signed, offline-verifiable proof — and the evidence behind the answer. **Built, tested, verified on live mainnet.**

```bash
npm install @tonattest/sdk
```

```ts
import { TonAttest, swap, all, lpHold, verifyAttestation } from "@tonattest/sdk";

const attest = new TonAttest({ apiKey: process.env.TONATTEST_API_KEY!, baseUrl });

// 1 — Define a rule. Plain JSON underneath: store it, send it, hash it.
const campaign = await attest.createCampaign({
  name: "Swap 100 TON and hold LP for a week",
  rule: all(
    swap({ minAmount: 100_000_000_000n, token: "TON" }),
    lpHold({ pool: TON_USDT, minDuration: "7d" }),
  ),
  startsAt: new Date(),
  endsAt: new Date(Date.now() + 30 * 86_400_000),
});

// 2 — Ask, from your backend, when the user claims.
const result = await attest.verify({ wallet, campaignId: campaign.id });

if (!result.eligible) {
  return render(result.evidence);   // ← show this; it explains the shortfall
}

// 3 — Verify offline against a key you pinned, then reward.
const check = await verifyAttestation(result.attestation!, PINNED_PUBLIC_KEY);
if (!check.valid) return;

const { wallet: proven, campaign: provenCampaign, nonce } = result.attestation!.payload;
if (proven !== wallet || provenCampaign !== campaign.id) return;
if (await nonceSpent(nonce)) return;

await markNonceSpent(nonce);        // before paying, never after
await awardPoints(userId, 100);
```

<details>
<summary><b>Why those four checks are not optional</b></summary>

<br>

An attestation is a **bearer artifact** — valid until it expires, for whoever
holds it. TonAttest cannot enforce single use, because only your app knows
whether it already paid.

| Check | Attack it prevents |
|---|---|
| `check.valid` | A forged or spoofed API response |
| `proven === wallet` | A real proof about *somebody else's* wallet |
| `provenCampaign === campaign.id` | A proof earned under a cheap campaign, redeemed against an expensive one |
| `nonce` unspent | Replaying one proof to be paid repeatedly — **the most common way integrations get drained** |

Record the nonce *before* paying: a crash between the two otherwise means a
double payout.

</details>

---

