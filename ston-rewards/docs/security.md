# Threat model

What an attacker can try, what stops them, and what does not. Written to be
useful rather than reassuring — the unsolved section is the important one.

## Trust boundaries

```
  User's wallet ──┐ (on-chain, public, not trusted — it is the subject)
                  ▼
  Chain data provider ── not trusted for completeness, trusted for accuracy
                  ▼
  Verification service ── holds signing keys; trusted to sign honestly
                  ▼
  Integrating app ── holds the treasury; makes the final decision
```

The load-bearing property: **the app does not have to trust the service's live
response**, only its signature, against a key the app pinned. That is what
turns a compromise of the service into a bounded problem.

## Attacks and defences

### Forging an attestation

Requires the project's Ed25519 private key. Those are stored sealed with
AES-256-GCM under a master key held in the environment, so a database
disclosure alone is not enough — an attacker needs the database *and* the
secret manager.

Signatures cover RFC 8785 canonical JSON, so no key-ordering or whitespace
trick changes the signed bytes without changing the signature.

**Residual:** an attacker with both the database and `MASTER_KEY` can forge
freely. Keep backups of the two separate.

### Replaying an attestation

Every attestation carries a `nonce` and expires in one hour.

**This defence is only as good as the integrating app.** The service cannot
enforce it: the attestation is a bearer artifact, and only the app knows
whether it already paid. Apps must record spent nonces *before* paying.

Called out in the quickstart, the anti-abuse guide, the spec, and both example
integrations, because it is the most likely way an integration gets drained.

### Tampering with a payload

AES-GCM and Ed25519 are both authenticated. A modified payload fails signature
verification — and verification checks the signature *before* expiry, so
extending `expires_at` cannot downgrade the failure to a mere "expired".

### Presenting someone else's proof

A valid signature over a different wallet is still a valid signature. The app
must compare `payload.wallet` against the wallet it is about to reward, and
`payload.campaign` against the campaign being claimed — otherwise a proof
earned under a cheap campaign redeems against an expensive one.

Both examples do this explicitly.

### Wash trading

Net volume counting, on by default: `|bought − sold|` per asset. A round trip
nets to roughly zero. Evidence reports gross alongside net so the number is
explainable.

### Double-counting on-chain events

An event counts once, ever, per project. Enforced twice: deduplicated during
decoding, and a database uniqueness constraint on the transaction hash.

### Double-tapped claims

Server-derived idempotency keys, plus in-process single-flight. Verified at 100
simultaneous requests: one upstream fetch, one verification, one signature.

### Stealing an API key

Keys are stored as scrypt hashes with per-key salts and compared in constant
time, so a database dump does not yield working credentials and response timing
does not leak the hash.

Keys are shown once at provisioning and never stored recoverably.

**Residual:** a key in a client bundle is public. Documented repeatedly:
`verify` is a backend call.

### Denial of service

Per-project token-bucket rate limits, a hard cap on events fetched per wallet,
bounded retries with jittered backoff, and single-flight collapse.

The rate limiter **fails open** if Redis is unavailable — it protects capacity,
not correctness, and refusing every request because Redis blinked would turn a
safeguard into an outage.

### Poisoning results with partial data

The most dangerous attack is also the most boring one: an upstream that returns
*less* than the truth. Under-counted volume produces a confident "not eligible"
for a user who qualified.

The service fails closed. Truncated history, provider outage, rate limiting,
and malformed responses all return `503`/`502` with a typed code — never a
`200` carrying a guess.

### Leaking internals through errors

Unrecognised errors become a generic `INTERNAL`. Connection strings, stack
traces, and upstream details go to logs, never to responses. Covered by a test
that asserts a database password never appears in a response body.

## Not solved

### Multi-wallet Sybil rings

**Unsolved, by design in v1.** Nothing here detects one person operating twenty
funded wallets that each genuinely satisfy a rule.

The practical mitigation belongs to the app: bind rewards to an identity rather
than a wallet. In a Mini App, one reward per Telegram user id makes a ring cost
one Telegram account per extra claim.

Graph heuristics are a later phase, and will be heuristics — not a solution.

### Economically rational farming

If the reward exceeds the cost of qualifying, people will qualify. That is a
pricing problem. Caps and net-volume bound the damage; they do not change the
incentive.

### Historical USD valuation

USD figures use the current rate, not the rate at transaction time, so a claim
can be timed when a present-day restatement flatters an old swap. Token-unit
thresholds are unaffected and are what any disputed campaign should use.

### A compromised verification service

An attacker with the signing keys can issue attestations for wallets that did
nothing. Offline verification does not help — the signature is genuine.

What bounds it: attestations expire in an hour, every issuance is recorded in
an audit trail, and key rotation is supported with old keys staying published
so honest historical proofs keep verifying.

## Dependency surface

Deliberately small — every dependency is a supply-chain risk that outlives the
decision to add it.

| Package | External runtime dependencies |
|---|---|
| `core-types`, `data-provider`, `decoder`, `activity` | none |
| `rules` | `@noble/hashes` |
| `attest` | `@noble/ed25519` |
| `sdk` | none of its own |
| `service` | `fastify`, `pg`, `ioredis` |

The SDK's shipped bundle contains no Node built-ins, so it runs unchanged in
browsers, Telegram Mini Apps, and edge runtimes — enforced by a test rather
than by convention.

`pnpm audit --prod`: no known vulnerabilities.

## Reporting

Security issues should go to the maintainer privately rather than a public
issue tracker.
