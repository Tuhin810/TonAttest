# TonAttest — monorepo

Implementation of the TonAttest verification service, rule engine, and SDK.
**Start with the [root README](../README.md)** for what this is and how to use
it; this file covers working in the codebase.

## Commands

```bash
pnpm install
pnpm test            # 360 tests
pnpm -r typecheck
pnpm -r build

pnpm decode <wallet> [--days 30] [--usd] [--json]   # inspect real activity
```

Set `TONAPI_KEY` to raise the upstream rate limit.

## Packages

| Package | Role | IO? |
|---|---|---|
| `@tonattest/core-types` | Shared types, address handling, error taxonomy | no |
| `@tonattest/data-provider` | tonapi client, pool registry, retry/backoff | **yes** |
| `@tonattest/decoder` | Raw events → normalized actions | no |
| `@tonattest/activity` | Resolver + USD rates; fails closed on partial data | **yes** |
| `@tonattest/rules` | DSL, validation, evaluation, evidence | no |
| `@tonattest/attest` | Canonical JSON, Ed25519 sign/verify | no |
| `@tonattest/service` | Fastify API, persistence, auth, metrics | **yes** |
| `@tonattest/sdk` | The published client | no |

### The purity rule

`decoder`, `rules`, `attest`, and `sdk` must not import the IO packages, call
`fetch`, or read an ambient clock. A test in `packages/rules/test/purity.test.ts`
enforces this, and a second test asserts the SDK's shipped graph contains no
`node:` imports.

Both matter for real reasons: purity is what makes a disputed eligibility
answer re-derivable offline, and the absence of Node built-ins is what lets the
SDK run in a Telegram Mini App at all.

## Running the service

```bash
cp .env.example .env    # fill DATABASE_URL, REDIS_URL, MASTER_KEY
pnpm --filter @tonattest/service migrate
pnpm --filter @tonattest/service provision "My App"
pnpm --filter @tonattest/service start
```

See [`packages/service/README.md`](packages/service/README.md) for the API
surface and the guarantees that layer adds.

## Fixtures

Golden mainnet events live in `packages/decoder/test/fixtures/`. To add one:

```bash
node scripts/capture-fixture.mjs <eventId> <wallet> <name>
node scripts/capture-pools.mjs      # refresh the trimmed pool registry
```

Fixtures are how a STON.fi contract change fails in CI rather than silently in
production.

## Docs

[Quickstart](docs/quickstart.md) · [Rules](docs/rules.md) ·
[Anti-abuse](docs/anti-abuse.md) · [Attestation spec](docs/attestation-spec.md) ·
[Self-hosting](docs/self-hosting.md) · [Threat model](docs/security.md)
