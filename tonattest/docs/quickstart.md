# Quickstart

Reward users for what they actually did on STON.fi, in about fifteen minutes.

## What this is

You define a rule. You ask whether a wallet satisfies it. You get back a
**signed attestation** you can verify yourself, plus **evidence** explaining
the answer. What the reward *is* — points, a jetton, access to a feature — is
entirely your business. This never holds or moves funds.

## 1. Install

```bash
npm install @tonattest/sdk
```

## 2. Get credentials

Against a self-hosted service:

```bash
pnpm --filter @tonattest/service provision "My Mini App"
```

That prints three things. Keep all of them:

```
Project:    prj_…
Public key: 3f1c…            ← pin this in your app
API key (shown once):
  sk_…                        ← server-side only, never ship to a client
```

The API key is never stored in recoverable form. If you lose it, provision
again.

## 3. Create a campaign

```ts
import { TonAttest, swap } from "@tonattest/sdk";

const ston = new TonAttest({
  apiKey: process.env.TONATTEST_API_KEY!,
  baseUrl: "https://your-service.example.com",
});

const campaign = await ston.createCampaign({
  name: "Swap 100 TON, earn points",
  rule: swap({ minAmount: 100_000_000_000n, token: "TON" }),
  startsAt: new Date(),
  endsAt: new Date(Date.now() + 30 * 86_400_000),
});

console.log(campaign.id); // cmp_…
```

Amounts are **token units**, not decimals: 100 TON is `100_000_000_000n`
(9 decimals). Token units are on-chain truth — see
[thresholds](./rules.md#token-units-versus-usd).

## 4. Verify a wallet

From your **backend**, when the user taps "claim":

```ts
const result = await ston.verify({ wallet, campaignId: campaign.id });

if (!result.eligible) {
  // Show this. "You swapped 62 of the required 100 TON" is actionable;
  // "not eligible" is not.
  return render(result.evidence);
}
```

## 5. Verify the attestation offline, then reward

```ts
import { verifyAttestation } from "@tonattest/sdk";

const check = await verifyAttestation(result.attestation!, PINNED_PUBLIC_KEY);
if (!check.valid) return; // award nothing

const { wallet: provenWallet, nonce, campaign: provenCampaign } = result.attestation!.payload;

if (provenWallet !== wallet) return;             // proof about someone else
if (provenCampaign !== campaign.id) return;      // proof from another campaign
if (await nonceAlreadySpent(nonce)) return;      // already redeemed

await markNonceSpent(nonce);   // before paying, not after
await awardPoints(userId, 100);
```

Those four checks are not optional. An attestation is a bearer artifact valid
until it expires; the nonce check in particular is what stops a user replaying
one proof to be paid repeatedly.

## Why verify offline at all?

Because then you are not trusting the verification service's live response —
only its signature, against a key you pinned. A spoofed API response, a
hijacked DNS record, or a compromised host cannot mint rewards from your
treasury. It is also why you should **pin** the public key rather than fetch it
from `/v1/keys` at claim time: fetching the key from the service you are
checking makes the check theatre.

## Handling failures honestly

```ts
try {
  result = await ston.verify({ wallet, campaignId });
} catch (err) {
  if (err.retryable) {
    // "We couldn't check right now" — NOT "you don't qualify".
    return showRetry();
  }
  throw err;
}
```

The service **fails closed**: if it cannot resolve a wallet's full history it
returns `503` rather than guessing. Telling a user who genuinely qualified that
they did not is the failure worth avoiding, so surface transient errors as
transient.

## Next

- [Rule cookbook](./rules.md) — every condition, with worked examples
- [Anti-abuse](./anti-abuse.md) — what is defended, and what is not
- [Attestation spec](./attestation-spec.md) — verify in any language
- [Self-hosting](./self-hosting.md)
