# Anti-abuse

What this system defends against, how, and — just as importantly — what it does
not.

## Defended

### Wash trading → net volume counting

**On by default.** A wallet's qualifying volume in a window is `|bought − sold|`
per asset, not gross. Swapping a token back and forth nets to roughly zero.

Evidence reports both figures, so a user who disputes the number can see
exactly why gross and net differ.

Turn it off with `netVolume: false` only if you genuinely want to reward
turnover rather than position.

### Replayed on-chain events → one event, once

An on-chain event is counted once, ever, across every rule and campaign of a
project. Enforced at two layers: deduplication during decoding, and a database
uniqueness constraint on the transaction hash.

### Replayed attestations → nonce + expiry

Every attestation carries a `nonce` and expires (one hour by default). **You
must record spent nonces.** This is the app's responsibility and the single
most common way an integration gets drained: without it, a user replays one
proof until it expires and is paid each time.

Record the nonce *before* paying, not after — otherwise a crash between the two
means a double payout.

### Double-tapped claims → server-derived idempotency

Repeated verifications inside the idempotency window return the same
verification and the same attestation. The key is derived from
`(project, campaign, wallet, ruleHash, time bucket)` rather than supplied by
the client, because a client that double-taps will happily send two different
client-generated keys.

### Rapid-fire activity → cooldowns

```ts
limits: { minInterval: "1h" }
```

Applied *before* any aggregate is computed, so a burst cannot inflate either a
count or a volume figure.

### Whales absorbing a budget → per-wallet caps

```ts
limits: { maxRewardableVolumePerWallet: "1000000000000" }
```

### Disposable wallets → age floor

```ts
limits: { minWalletAge: "30d" }
```

An *unknown* wallet age is not treated as a young wallet: refusing on missing
provider data would reject legitimate users whenever the upstream cannot
answer.

## Not defended

### Multi-wallet Sybil rings

**This is not solved.** A determined actor can split activity across many
funded wallets, each independently satisfying a rule. Nothing here detects
that.

The practical mitigation is yours: **bind rewards to an identity**, not to a
wallet. In a Telegram Mini App, that is the Telegram user id from validated
`initData`. One reward per user id makes a ring cost one Telegram account per
extra claim, which raises the price substantially without any graph analysis.

The demo Mini App does exactly this.

Graph heuristics are Phase 3 of the product roadmap, and are honestly described
as heuristics — not a solution.

### Economically rational farming

If your reward is worth more than the gas and slippage of qualifying for it,
people will qualify for it. That is a pricing problem, not a detection problem.
Net volume counting and caps bound the damage; they do not change the
incentive.

### The USD valuation window

USD thresholds use the current rate, not the rate at transaction time. Someone
watching a volatile token can time a claim when the present-day restatement
flatters their historical swap. Use token units for anything you would argue
about.

## A recommended baseline

```ts
limits: {
  minInterval: "1h",
  minWalletAge: "30d",
  maxRewardableVolumePerWallet: "<about 10× your typical user>",
}
```

…plus one reward per Telegram user id, enforced in your app.
