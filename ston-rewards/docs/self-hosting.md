# Self-hosting

The verification service is open source and meant to be run by whoever depends
on it. Serious teams should not gate reward eligibility on someone else's
uptime, and offline-verifiable attestations mean you do not have to.

## Requirements

- Node 20+ (or Docker)
- PostgreSQL 16
- Redis 7

## Docker

```bash
git clone <repo> && cd ston-rewards
cp .env.example .env

# MASTER_KEY is the one value you must generate yourself.
echo "MASTER_KEY=$(openssl rand -hex 32)" >> .env

docker compose up --build -d
docker compose run --rm api pnpm --filter @ston-rewards/service migrate
docker compose run --rm api pnpm --filter @ston-rewards/service provision "My App"
```

The compose stack brings up Postgres and Redis alongside the API and waits for
both to be healthy before starting.

## Without Docker

```bash
pnpm install
pnpm -r build

# Point DATABASE_URL and REDIS_URL at your instances, set MASTER_KEY.
pnpm --filter @ston-rewards/service migrate
pnpm --filter @ston-rewards/service provision "My App"
pnpm --filter @ston-rewards/service start
```

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres |
| `REDIS_URL` | yes | Redis |
| `MASTER_KEY` | yes | 32 bytes hex. Encrypts signing keys at rest |
| `TONAPI_KEY` | no | Raises the upstream rate limit. Get one for anything real |
| `PORT` / `HOST` | no | Default `8080` / `0.0.0.0` |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_PER_SECOND` | no | Per-project budget |
| `MAX_EVENTS_PER_WALLET` | no | Cost cap. Exceeding it fails closed |

### About `MASTER_KEY`

It encrypts every project's Ed25519 private key.

- **Lose it** and every stored signing key is unrecoverable. Attestations
  already issued still verify, but you cannot sign new ones — provision new
  keys and re-pin them.
- **Leak it**, together with a database dump, and attestations become
  forgeable.

It belongs in a secret manager, never in the database and never in the image.
Back it up separately from your database backups — a single backup containing
both defeats the point of encrypting at rest.

## Operations

| Endpoint | Purpose |
|---|---|
| `/healthz` | Liveness. Touches no dependencies, so a database blip cannot get every instance killed |
| `/readyz` | Readiness. Postgres failure removes the instance from rotation; Redis failure does not |
| `/metrics` | Prometheus |

Metrics worth alerting on:

- `ston_verify_duration_seconds{quantile="0.95"}` — target under 2s warm
- `ston_provider_errors_total` — upstream trouble; expect matching 503s
- `ston_unknown_actions_total` — **the early warning that STON.fi shipped a
  contract change we do not decode yet.** A rising rate here means eligibility
  answers are quietly degrading. Alert on it.
- `ston_rate_limited_total` — an integrator hitting their budget

## Scaling

Run several instances behind a load balancer. Postgres holds all state;
per-instance memory is only caches. The single-flight collapse is per-instance,
so N instances mean at most N upstream fetches for the same wallet — Redis
carries the shared freshness marker.

## Backups

Back up Postgres — it holds campaigns, the verification log, and the
attestation audit trail used to settle disputes. Redis holds nothing that
cannot be rebuilt.

Restore drill, in full:

```bash
pg_restore -d "$DATABASE_URL" backup.dump
pnpm --filter @ston-rewards/service migrate    # idempotent
```

## When STON.fi changes its contracts

This is the failure mode most likely to hit you, and it is quiet: decoding
silently stops recognising some activity, and users start being told they do
not qualify.

1. `ston_unknown_actions_total` rises. That is the signal.
2. Undecoded events are retained with their raw payloads, so nothing is lost —
   they can be re-decoded once support lands.
3. Update the decoder, add a golden fixture for the new shape, re-run.

Do not silence this alert.
