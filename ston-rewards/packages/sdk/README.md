# @ston-rewards/sdk

Composable, verifiable reward rules over STON.fi activity.

Define a rule, ask whether a wallet satisfies it, get back a **signed
attestation** you can verify yourself plus **evidence** explaining the answer.
What the reward is — points, a jetton, access — is entirely your app's
business. This never holds or moves funds.

Runs in Node, browsers, Telegram Mini Apps, and edge runtimes. No Node
built-ins anywhere in the shipped bundle.

```bash
npm install @ston-rewards/sdk
```

## Use

```ts
import { StonRewards, swap, verifyAttestation } from "@ston-rewards/sdk";

const ston = new StonRewards({ apiKey: process.env.API_KEY!, baseUrl });

const campaign = await ston.createCampaign({
  name: "Swap 100 TON",
  rule: swap({ minAmount: 100_000_000_000n, token: "TON" }),
  startsAt: new Date(),
  endsAt: new Date(Date.now() + 30 * 86_400_000),
});

const result = await ston.verify({ wallet, campaignId: campaign.id });

if (!result.eligible) {
  // Show this — "you swapped 62 of the required 100 TON" is actionable.
  return render(result.evidence);
}

// Verify offline against a key you pinned: a spoofed response cannot
// mint rewards from your treasury.
const check = await verifyAttestation(result.attestation!, PINNED_PUBLIC_KEY);
if (!check.valid) return;

const { wallet: proven, campaign: provenCampaign, nonce } = result.attestation!.payload;
if (proven !== wallet || provenCampaign !== campaign.id) return;
if (await nonceSpent(nonce)) return;

await markNonceSpent(nonce);   // before paying, not after
await award(userId, 100);
```

Those last checks are not optional. An attestation is a bearer artifact valid
until it expires; recording spent nonces is what stops a user replaying one
proof to be paid repeatedly.

## Errors

Every failure carries `retryable`. The service fails closed, so a transient
problem means "we could not check" — never "you do not qualify".

```ts
try {
  await ston.verify({ wallet, campaignId });
} catch (err) {
  if (err.retryable) return showRetryLater();
  throw err;
}
```

`ApiResponseError` (the API said no, with a stable `code`), `NetworkError`
(no answer at all), `InvalidInputError` (rejected locally, no round trip).

## Docs

Quickstart, rule cookbook, anti-abuse guide, attestation spec, and self-hosting
notes live in the repository's `docs/`.

MIT.
