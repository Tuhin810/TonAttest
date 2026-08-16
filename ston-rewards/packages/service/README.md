# Verification service

Fastify API over the rules engine. Self-hostable; the hosted instance is a
convenience, not a dependency — attestations verify offline against a pinned
public key.

## Running it

```bash
cp .env.example .env          # then fill DATABASE_URL, REDIS_URL, MASTER_KEY
pnpm --filter @ston-rewards/service migrate
pnpm --filter @ston-rewards/service provision "My Mini App"   # prints the API key once
pnpm --filter @ston-rewards/service start
```

Or the whole stack, including Postgres and Redis:

```bash
docker compose up --build
docker compose run --rm api pnpm --filter @ston-rewards/service migrate
```

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/campaigns` | Create a campaign from a rule |
| `GET` | `/v1/campaigns` | List this project's campaigns |
| `GET` | `/v1/campaigns/:id` | Campaign, rule, and rule hash |
| `POST` | `/v1/verify` | `{ wallet, campaignId }` → verification + attestation |
| `GET` | `/v1/keys` | Public keys for offline verification |
| `GET` | `/healthz` `/readyz` `/metrics` | Unauthenticated ops endpoints |

Auth is `Authorization: Bearer <api_key>`, per project.

## The guarantees this layer adds

**Fails closed.** If a wallet's history cannot be resolved completely — provider
down, rate-limited, or truncated by the fetch cap — the request returns `503`
with a typed code. It never evaluates a partial history. A partial history
under-counts volume, which produces a confident *wrong* answer; a false
negative is a support ticket, but a false positive is a payout the integrating
app cannot claw back.

**One attestation per claim.** The idempotency key is derived from
`(project, campaign, wallet, ruleHash, time bucket)` rather than supplied by
the client, because the failure it guards against is a double-tapped claim
button — and a client that double-taps will happily send two different
client-generated keys. Including the rule hash means editing a campaign's rule
cannot silently reuse a verification made under the old one.

**One upstream fetch per wallet.** Concurrent verifications collapse into a
single resolution. Tested at 100 simultaneous requests → 1 provider fetch, 1
verification, 1 signature.

**Signing keys are never stored in the clear.** Ed25519 private keys are
sealed with AES-256-GCM under a master key held in the environment, so a
database backup on its own cannot forge attestations. Retired keys stay
published so attestations already in the wild keep verifying.

**Errors are typed, and internals stay internal.** Every failure carries a
stable `code` and an explicit `retryable` flag. Unrecognised errors become a
generic `INTERNAL` — connection strings and stack traces go to the log, never
the response.

## Deliberate choices worth knowing

- **Unknown request fields are rejected, not stripped.** Fastify strips them by
  default; here a mistyped `limits` field would mean a campaign silently
  running without the protection its operator believes it has.
- **Another project's campaign returns `404`, not `403`.** Distinguishing them
  would let the endpoint be used to probe for valid campaign ids.
- **Redis failure does not fail readiness.** It is coordination only — losing
  it costs throughput and duplicate work, never correctness. Postgres failure
  does fail readiness.
- **The rate limiter fails open.** It protects capacity, not correctness;
  refusing every request because Redis blinked would turn a safeguard into an
  outage.
- **`/v1/wallets/:wallet/activity` returns `501`.** Returning an empty list
  would read as "this wallet has no activity" — the worst possible answer for
  someone debugging a failed claim. Use the `decode` CLI meanwhile.
