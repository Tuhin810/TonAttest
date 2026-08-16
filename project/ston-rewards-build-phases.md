# STON Rewards SDK — Architecture & 4-Phase Production Plan

**Companion to:** `ston-rewards-technical-design.md` (v0.1)
**Status:** build plan
**Goal:** four sequential phases, each ending in something deployable, that together produce a production-ready v1 (SDK + verification service + demo Mini App).

---

## 0. How the phases are cut

The design doc's six-week table is time-boxed. This document re-cuts the same scope along **risk and dependency lines** instead, because that is what determines what can actually ship:

| Phase | Theme | Risk carried | Ends with |
|---|---|---|---|
| 1 | Truth layer — chain data in, decoded actions out | **High** (decoding) | A CLI that prints a wallet's verified STON.fi actions |
| 2 | Logic layer — rules, evaluation, evidence | Low (pure functions) | A library that answers eligible/not with proof, offline |
| 3 | Service layer — API, auth, signing, persistence | Medium (ops) | A deployed, authenticated, signing API |
| 4 | Product layer — SDK, demo, docs, hardening | Low | Public npm package + live demo + runbook |

Each phase is independently useful. If funding or time stops after Phase 2, what exists is still a working open-source decoder + rule engine, not a half-built service.

**Invariant across all phases:** the service never holds keys that can move user funds, and every eligibility answer is reproducible from `(rule, activity set)` alone.

---

## 1. Target architecture (end state)

```
┌────────────────────────────────────────────────────────────┐
│ Consumer                                                    │
│  Mini App / dApp / bot   ──► @ston-rewards/sdk (npm)        │
│                                 │                           │
│                          verifyAttestation()  ← offline,    │
│                                 │                no network │
└─────────────────────────────────┼───────────────────────────┘
                                  │ HTTPS + Bearer API key
┌─────────────────────────────────▼───────────────────────────┐
│ Verification service (Fastify, Docker Compose, self-hostable)│
│                                                              │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │ HTTP layer │──►│ Rules engine │──►│ Attestation signer│  │
│  │ authn/z,   │   │ (pure, no IO)│   │ (Ed25519, KMS or  │  │
│  │ ratelimit, │   │ DSL parse,   │   │  file-backed key) │  │
│  │ idempotency│   │ eval,evidence│   └───────────────────┘  │
│  └─────┬──────┘   └──────▲───────┘                          │
│        │                 │ ActivitySet                      │
│        ▼                 │                                  │
│  ┌───────────────────────┴──────────────────────────────┐   │
│  │ Activity resolver                                     │   │
│  │  cache-first → DataProvider → decoder → normalize     │   │
│  └───────┬───────────────────────────────┬───────────────┘   │
│          │                               │                   │
│   ┌──────▼──────┐                 ┌──────▼───────┐           │
│   │ Postgres 16 │                 │ Redis        │           │
│   │ campaigns,  │                 │ freshness,   │           │
│   │ activity,   │                 │ ratelimit,   │           │
│   │ attestations│                 │ idempotency  │           │
│   └─────────────┘                 └──────────────┘           │
└──────────────────────┬───────────────────────────────────────┘
                       │ DataProvider interface (swappable)
        ┌──────────────┼───────────────┬──────────────────┐
        ▼              ▼               ▼                  ▼
    tonapi.io     TON Center     @ston-fi/api        (Phase 5+:
    (primary)     (fallback)     pool registry        self-hosted
                                 + rates              indexer)
```

### Module boundaries (enforced by package structure)

```
packages/
  core-types/      shared types: Action, ActivitySet, Rule, Evidence, Attestation
  decoder/         raw chain events → Action[]           (Phase 1)
  data-provider/   tonapi/toncenter clients + pool registry (Phase 1)
  rules/           DSL, validator, evaluator, evidence    (Phase 2)
  attest/          canonical JSON, sign, verify           (Phase 2)
  service/         Fastify app, persistence, resolver     (Phase 3)
  sdk/             public npm client + typed builder      (Phase 4)
apps/
  demo-miniapp/    Telegram Mini App                      (Phase 4)
  examples/        jetton-payout reference script         (Phase 4)
```

Rule: `rules/` and `attest/` must never import `data-provider/` or `service/`. That is what keeps evaluation deterministic and testable without network or DB.

---

## 2. Phase 1 — Truth layer

**Objective:** given a wallet address, produce a correct, deduplicated, normalized list of STON.fi actions. Nothing else.

### Scope
- `DataProvider` interface + tonapi implementation, TON Center fallback, retry/backoff, response schema validation.
- Pool/router registry from `@ston-fi/api`, refreshed hourly, cached to disk/DB so a provider outage doesn't break decoding.
- Decoder for `SWAP` and `LP_ADD` (committed) and `LP_REMOVE` (stretch), covering STON.fi v1 and v2 contracts and the Omniston routing path — decode at **settlement/pool level**, not router level, so route-shape changes don't break it.
- Normalization to a single `Action` shape: `{ type, txHash, lt, wallet, pool, tokenIn, tokenOut, amountIn, amountOut, amountUsd?, rateSource?, occurredAt }`.
- LP position reconstruction: pair `LP_ADD`/`LP_REMOVE` per pool into holding intervals so `lpHold` can be answered later.
- Golden-fixture test harness: real mainnet tx hashes committed as JSON fixtures, asserted against values cross-checked on tonviewer.

### Key decisions to lock here
- **Amounts are bigint token units everywhere.** USD is a decorated, optional field carrying `rateSource` + `rateAt`. Never let USD into the primary path.
- **`lt` (logical time), not timestamp, is the ordering key.** Timestamps collide.
- **Decoder is pure:** `(rawEvents, poolRegistry) → Action[]`. All IO lives in `data-provider/`. This is what makes the fixtures possible.
- **Unknown-op policy:** an event that matches a STON.fi address but not a known op-code is recorded as `UNKNOWN` with the raw payload, never silently dropped. Counted in metrics — a rising `UNKNOWN` rate is the early-warning signal that STON.fi shipped a contract change.

### Exit criteria
- ≥30 committed mainnet fixtures (mix of v1/v2, simple + multi-hop routes, LP add/remove) decode with zero diffs.
- 20 test wallets' full histories match tonviewer on action count, type, and token amounts.
- `UNKNOWN` rate on a 1,000-event sample is measured and documented (a number, not a hope).
- CLI: `pnpm decode <wallet>` prints the action table.

### Kill/adjust signals
If multi-hop or Omniston swaps can't be attributed to a single pool reliably, narrow v1 to direct pool swaps and document the limitation explicitly rather than shipping wrong numbers. Drop `LP_REMOVE` first, per the design doc.

---

## 3. Phase 2 — Logic layer

**Objective:** deterministic eligibility. Pure functions over Phase 1's output.

### Scope
- Rule DSL: JSON schema + typed builder (`swap()`, `lpAdd()`, `lpHold()`, `all()`, `any()`), depth ≤3 enforced at parse time.
- Validator with human-readable errors (rejects unknown fields, bad windows, impossible thresholds) — this is a real developer-experience surface, not an afterthought.
- Evaluator: condition tree → `{ eligible, evidence }` where evidence lists, per leaf, the contributing tx hashes and the computed aggregate vs. threshold.
- Anti-abuse primitives as evaluator inputs, not bolt-ons: net-volume counting (default on), per-wallet caps, cooldown `minInterval`, wallet-age floor, replay set.
- `ruleHash` = sha256 of canonicalized rule JSON. Stable across key order and formatting.
- Attestation module: RFC 8785 canonicalization, Ed25519 sign/verify, `expires_at` + `nonce`.

### Key decisions to lock here
- **Evaluation takes an `ActivitySet` argument; it never fetches.** Same input always yields the same output — this is the dispute-resolution property the whole product's credibility rests on.
- **Evidence is generated on both outcomes.** A failed verification must explain the shortfall ("needed 100 USDT, counted 62.4 across 3 swaps"). This is the single highest-leverage feature for adoption; support burden without it is brutal.
- **Net-volume is computed per token pair per window**, and the evidence shows both gross and net so the user can see why they were shorted.
- **Canonicalization is tested against the RFC 8785 test vectors** — a signature scheme that only your own implementation can verify is worthless.

### Exit criteria
- 60+ unit tests (design doc targets 40; the anti-abuse combinatorics need more) covering each condition type, each combinator, nesting depth, window boundaries, empty activity, and every anti-abuse rule.
- Property test: evaluating the same `(rule, activitySet)` 1,000× yields byte-identical evidence hashes.
- Cross-language signature check: an attestation signed by the TS code verifies with an independent Ed25519 implementation (e.g. a Python or Go one-liner in CI).
- Zero imports from `data-provider/` or `service/` — enforced by a lint rule in CI.

---

## 4. Phase 3 — Service layer

**Objective:** a deployable, authenticated, observable API. This is where production-readiness is actually earned.

### Scope
- Fastify app with JSON-Schema validation on every route; endpoints per design doc §10.
- Postgres schema + migrations (a real migration tool, not hand-run SQL). `tx_hash UNIQUE` replay guard, `idempotency_key UNIQUE` on verifications.
- Activity resolver: Redis freshness marker (60s TTL/wallet) → provider pull → decode → upsert → evaluate. Single-flight lock so 50 concurrent claims for one wallet cause one upstream fetch.
- Auth: API key hashed with argon2id, `Bearer` header, per-project Redis token-bucket rate limits, per-project quotas.
- Key management: per-project Ed25519 keypair; private keys encrypted at rest with a service master key from env/secret store, **never** in the DB in plaintext. Key rotation supported with an overlap window; `GET /v1/keys` serves all currently-valid public keys.
- Ops: structured JSON logs with request IDs, `/healthz` + `/readyz`, Prometheus metrics (verify latency, provider latency/errors, cache hit rate, `UNKNOWN` decode rate, attestations issued), Sentry-style error capture.
- Docker Compose stack (api + postgres + redis) with one-command deploy, `.env.example`, and a documented backup procedure for Postgres.

### Key decisions to lock here
- **Idempotency key = hash of `(projectId, campaignId, wallet, ruleHash, time-bucket)`.** A double-tapped claim button must not mint two attestations.
- **Provider failure is explicit, never silent.** If tonapi is down and the cache is stale, return `503` with a typed error code rather than evaluating against partial data and issuing a wrong attestation. Issuing a false negative is a support ticket; issuing a false positive is a payout the app can't claw back.
- **Attestations are logged before being returned** — the attestation table is the audit trail for every dispute.
- **Campaign rules are immutable once a campaign is active.** Editing a live rule silently invalidates already-issued attestations. Edits create a new version; old attestations stay bound to their `ruleHash`.

### Exit criteria
- End-to-end `POST /v1/verify` p95 < 2s with warm cache, < 6s cold (measured under a load test, not a single curl).
- Chaos checks pass: provider 500s, provider timeout, Redis down, Postgres connection loss — each degrades to a correct typed error, never to a wrong attestation.
- Concurrency test: 100 parallel verifies, same wallet → 1 upstream fetch, ≤1 attestation.
- Fresh-clone deploy: `docker compose up` → working service in under 10 minutes on a clean VPS, following only the README.

---

## 5. Phase 4 — Product layer

**Objective:** something a stranger can adopt in 15 minutes without talking to you.

### Scope
- `@ston-rewards/sdk` on npm, MIT, tsup dual ESM/CJS + `.d.ts`, working in Node, browsers/Mini Apps, and edge runtimes. Zero heavy deps in the offline-verify path.
- `StonRewards.verifyAttestation(attestation, publicKey)` — pure, no network, no Node built-ins, so it runs anywhere.
- Typed rule builder mirroring Phase 2's DSL with full inference.
- Error taxonomy: typed error classes, retryable vs. terminal clearly marked.
- Demo Telegram Mini App: connect wallet (TON Connect) → swap on STON.fi → claim → verify → points awarded, with the evidence panel shown to the user (the evidence view is the demo's actual selling point).
- Reference example: app-side wallet sends a jetton payout after offline-verifying an attestation. Clearly labelled as app-executed, service-never-custodial.
- Docs site: quickstart, rule cookbook, anti-abuse guide with honest limits, self-hosting guide, attestation verification spec (so other languages can implement it), API reference generated from the JSON schemas.
- Security pass: dependency audit, rate-limit review, secrets scan, and a written threat model covering replay, forged attestations, wash trading, and Sybil rings — including what is explicitly *not* solved.

### Exit criteria
- Cold-start test with a developer who has not seen the project: npm install → working integration in <15 min using docs alone. Timed, and their friction points fixed.
- Demo live on a public URL, repo public, CI green (lint, typecheck, unit, integration, fixtures).
- CHANGELOG + semver policy + a documented "what breaks when STON.fi changes contracts" response plan.
- Grant final report written against the exit criteria above.

---

## 6. Cross-cutting requirements (every phase)

| Concern | Standing rule |
|---|---|
| Testing | Fixtures for decoding, unit for rules, integration for service, one full E2E. No phase exits without its tier green in CI. |
| Determinism | Any eligibility answer must be reproducible from `(ruleHash, activitySet)` offline. |
| Observability | Every phase adds its metrics as it's built; instrumentation retrofitted is instrumentation never done. |
| Secrets | Never in the repo, never in the DB unencrypted, never in logs. |
| Backwards compat | Attestation `v` field is bumped on any payload change; verifiers accept the versions they know and reject unknown ones loudly. |
| Docs | Each phase updates the docs it invalidates, in the same PR. |

---

## 7. Sequencing against the six-week grant window

The phases map onto the design doc's weeks without changing the commitment:

- **Week 0** — Phase 1 spike (the PoC decoder), de-risks before submission
- **Weeks 1–2** — Phase 1 complete
- **Week 3** — Phase 2 complete
- **Week 4** — Phase 3 complete
- **Weeks 5–6** — Phase 4 complete

Cut order under schedule pressure, strictly in this sequence: `LP_REMOVE` → jetton payout example → hosted-tier onboarding polish → dashboard-ish demo extras. Committed scope (`SWAP`, `LP_ADD`, rules engine, signed attestations, SDK, docs, demo) is never cut.

---

## 8. What "production ready" means here

Concretely, at the end of Phase 4:
1. A wrong attestation cannot be issued from stale or partial data — the service fails closed.
2. One on-chain event can never be counted twice, across any rule or campaign of a project.
3. Anyone can verify an attestation without trusting the service, in any language, from a written spec.
4. Any eligibility decision can be explained to an end user with tx-level evidence.
5. The service can be redeployed from a clean machine in under 10 minutes, and restored from backup.
6. The known gaps (multi-wallet Sybil rings, USD valuation disputes, multi-hop attribution limits) are documented, not hidden.
