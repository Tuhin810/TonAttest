# STON Rewards SDK — Technical Design Document

**Version:** 0.1 (draft)
**Author:** Tuhin
**Status:** Pre-build / grant application phase
**Target:** STON.fi Grant Program (up to $10k, 6-week deliverable)

---

## 1. One-line summary

An open-source TypeScript SDK + hosted verification API that lets any TON app define **composable, programmable reward rules** over verified STON.fi actions (swap, LP add, LP remove) and receive a **signed attestation** that a wallet satisfied the rule. The app handles the actual reward itself.

## 2. Problem

TON Mini Apps and dApps that want to reward users for STON.fi activity ("swap ≥100 USDT and get in-game points", "provide liquidity for 7 days and unlock a perk") must each build the same pipeline from scratch: fetch wallet transactions, decode STON.fi contract messages, match them to their campaign logic, guard against replays and fake volume, and store eligibility state. This is 1–3 weeks of one-off work per app, and every implementation is slightly wrong in the same ways.

Quest platforms (TaskOn, Growthly, etc.) solve the *campaign website* version of this. Nothing solves the *embedded developer primitive* version — rules defined in the app's own code, verified server-side, consumed programmatically.

## 3. Goals and non-goals

### Goals (v1, grant scope)
- TypeScript SDK published to npm, MIT licensed
- Hosted verification API (also open-source, self-hostable)
- 2 committed verified STON.fi action types: `SWAP`, `LP_ADD` — plus `LP_REMOVE` as a stated stretch goal
- Composable rule engine (AND/OR combinations, volume/token/pool/duration conditions)
- Signed attestations (Ed25519) apps can verify offline
- Basic anti-abuse controls (per-wallet caps, net-volume counting, cooldowns)
- Demo Telegram Mini App + full documentation

### Non-goals (v1) — explicitly deferred
- **No smart contract, no custody, no token.** No settlement contract or custodial wallet is included in v1 — settlement is the app's job (Phase 2). The demo includes a client-side example showing how an integrating application can consume the attestation and act on it using *its own* wallet; the verification service never holds or moves funds.
- No multi-DEX support (STON.fi only; DeDust etc. later)
- No referral/attribution graphs (Phase 3)
- No ML-based Sybil detection (rule-based mitigations only in v1)
- No dashboard UI (API + docs only; dashboard is Phase 2)

## 4. Architecture overview

```
┌─────────────────┐
│    TON app       │  Mini App / dApp / bot
│  (customer code) │
└────────┬─────────┘
         │ @ston-rewards SDK (npm)
         ▼
┌──────────────────────────────────┐
│      Verification service        │  Node.js (Fastify), self-hostable
│  ┌──────────────┬─────────────┐  │
│  │ Rules engine │  Verifier   │  │
│  │ (rule DSL,   │ (activity   │  │
│  │  evaluation) │  resolution)│  │
│  └──────────────┴──────┬──────┘  │
│         Attestation signer       │
└────────────────────────┼─────────┘
                         ▼
              ┌────────────────────┐
              │ TON on-chain data  │  tonapi.io / TON Center
              │ (STON.fi events)   │  + Postgres cache
              └────────────────────┘
```

Signed attestation returns to the app; the app pays out however it wants (points, jettons, access).

## 5. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node 20+) | Existing expertise; same language as SDK consumers |
| API framework | Fastify | Fast, schema-first validation (JSON Schema), low deps |
| On-chain data | tonapi.io (primary), TON Center (fallback) | Managed indexing; avoids running a liteserver in v1 |
| STON.fi decoding | `@ston-fi/sdk` + `@ston-fi/api` | Official libraries for pool/route/tx structures |
| Database | PostgreSQL 16 | Campaigns, rules, verification cache, attestation log |
| Cache/queue | Redis | Rate limiting, wallet-activity cache, idempotency keys |
| Signing | Ed25519 via `@noble/ed25519` | Small, audited, verifiable in any language |
| SDK packaging | tsup (ESM + CJS) | Works in Mini Apps, Node backends, and edge runtimes |
| Hosting (demo) | Existing VPS (Ubuntu) + Docker Compose | Zero new infra cost during grant |
| Docs | Docusaurus or plain markdown in repo | Grant deliverable |

**Key decision — no self-run indexer in v1.** Running a TON indexer is weeks of work and permanent ops burden. tonapi's REST API exposes account events including Jetton transfers and DEX activity, sufficient for the three v1 actions. Abstract behind a `DataProvider` interface so a self-hosted indexer can replace it in Phase 2 without touching the rules engine.

## 6. Core concepts and data model

### 6.1 Entities

```
Project      — an integrating app (API key, signing keypair reference)
Campaign     — a named container of rules with start/end time and status
Rule         — a composable condition tree evaluated against wallet activity
Verification — one evaluation of (wallet, rule) → eligible/ineligible + evidence
Attestation  — signed proof of a successful verification
```

### 6.2 Postgres schema (simplified)

```sql
projects      (id, name, api_key_hash, created_at)
campaigns     (id, project_id, name, rule_json, starts_at, ends_at, status)
verifications (id, campaign_id, wallet, eligible, evidence_json,
               evaluated_at, idempotency_key UNIQUE)
attestations  (id, verification_id, payload_json, signature, expires_at)
activity_cache(wallet, action_type, tx_hash UNIQUE, pool, token_in, token_out,
               amount_usd, lt, occurred_at)
```

`tx_hash UNIQUE` in the activity cache is the replay guard: one on-chain event can never count twice, across any rule or campaign of the same project.

## 7. Rule DSL — the differentiating layer

Rules are JSON (SDK provides a typed builder). Grammar:

```
Rule       := Condition | Combinator
Combinator := { all: Rule[] } | { any: Rule[] }
Condition  := SwapCond | LpAddCond | LpHoldCond
```

### 7.1 Conditions (v1)

```typescript
swap({
  minAmount?: bigint,         // token units — primary mode (see §15.1)
  minVolumeUsd?: number,      // optional USD mode (per-tx or cumulative)
  token?: string,             // jetton address or "TON"
  pool?: string,              // restrict to a pool
  count?: number,             // at least N qualifying swaps
  window?: string,            // "7d", "30d", "campaign"
  netVolume?: boolean         // default true — see anti-abuse
})

lpAdd({ minAmountUsd?, pool?, window? })

lpHold({ minAmountUsd?, pool?, minDuration: string })  // e.g. "7d"
```

### 7.2 Examples

```typescript
// Simple: swapped at least $50 during campaign
rule(swap({ minVolumeUsd: 50 }))

// Composite: swapped $100+ AND held LP for 7 days
rule(all(
  swap({ minVolumeUsd: 100, token: "USDT" }),
  lpHold({ pool: TON_USDT, minDuration: "7d" })
))

// Either path qualifies
rule(any(
  swap({ count: 5, window: "30d" }),
  lpAdd({ minAmountUsd: 500 })
))
```

### 7.3 Evaluation semantics

- Conditions evaluate against the wallet's activity within `[campaign.starts_at, now]` unless a `window` narrows it.
- `all`/`any` nest to max depth 3 (enforced) — keeps evaluation bounded and rules explainable.
- Every evaluation returns `evidence`: the tx hashes and computed aggregates that satisfied (or failed) each leaf condition. This makes results disputable and debuggable — a deliberate trust feature.

## 8. Verification flow

```
1. App calls sdk.verify({ wallet, campaignId })          [idempotency key derived]
2. API authenticates project (API key), loads rule
3. Verifier resolves wallet activity:
   a. Check activity_cache freshness (Redis marker, TTL 60s per wallet)
   b. If stale → pull events from tonapi, decode STON.fi ops, upsert cache
4. Rules engine evaluates condition tree against cached activity
5. If eligible → build attestation payload, sign (Ed25519), store, return
6. If not → return { eligible: false, evidence } (no attestation)
```

**Decoding STON.fi events.** Swaps and LP operations on STON.fi are Jetton transfers to/from router and pool contracts with specific op-codes. v1 approach: match events against the known STON.fi router/pool addresses (fetched from `@ston-fi/api` pool list, refreshed hourly) and decode payloads with the official SDK types. USD values come from STON.fi's own rates endpoint at event time when available, else a price cache. **This decoding module is the highest-risk component — see §13.**

## 9. Attestation format

```json
{
  "v": 1,
  "project": "prj_abc",
  "campaign": "cmp_xyz",
  "wallet": "EQ...",
  "rule_hash": "sha256:...",
  "eligible": true,
  "evidence_hash": "sha256:...",
  "issued_at": 1755300000,
  "expires_at": 1755303600,
  "nonce": "..."
}
```

Signature: Ed25519 over the canonical JSON (RFC 8785 canonicalization). Apps verify with the project's public key — fetchable from the API or pinned locally — so **attestations are verifiable offline and the app never has to trust a live response**. `expires_at` (default 1h) plus `nonce` prevent long-lived proofs being replayed into the app's reward handler; the app is instructed to record consumed nonces.

## 10. API surface (v1)

```
POST /v1/campaigns                  create campaign with rule JSON
GET  /v1/campaigns/:id              campaign + rule + status
POST /v1/verify                     { wallet, campaignId } → verification + attestation
GET  /v1/wallets/:wallet/activity   decoded STON.fi activity (debugging/UI)
GET  /v1/keys                       project public keys for offline verification
```

Verification is on-demand ("verify-on-claim", see §15.3). Webhooks and a duration-rule scheduler are Phase 2.

Auth: `Authorization: Bearer <api_key>` per project. Rate limits per project via Redis token bucket.

### SDK surface

```typescript
const ston = new StonRewards({ apiKey, baseUrl? });

const campaign = await ston.createCampaign({ name, rule, startsAt, endsAt });
const result   = await ston.verify({ wallet, campaignId });
// result: { eligible, attestation?, evidence }

// Offline verification helper (no network):
StonRewards.verifyAttestation(attestation, publicKey); // → boolean
```

## 11. Anti-abuse (v1, rule-based)

Reviewers will ask "what stops wash trading?" — the answer is layered, configurable, and honest about limits:

1. **Net-volume counting (default on).** A wallet's qualifying swap volume in a window is `|buys − sells|` per token pair, not gross. Back-and-forth washing nets to ~0.
2. **Per-wallet caps.** `maxRewardableVolumePerWallet` per campaign.
3. **Cooldowns.** Minimum time between qualifying actions (`minInterval: "1h"`).
4. **Replay guard.** `tx_hash UNIQUE` — an event counts once, ever.
5. **Wallet-age floor (optional).** Ignore wallets younger than N days.
6. **Not solved in v1:** multi-wallet Sybil rings. Stated openly; Phase 2 adds graph heuristics. Apps are advised to combine attestations with their own user identity (Telegram user ID in Mini Apps) which raises Sybil cost substantially.

## 12. Six-week build plan

| Week | Deliverable | Exit criterion |
|---|---|---|
| 0 (pre-submission) | Proof-of-concept decoder — no framework, one script | 5–10 known mainnet STON.fi txs (swap + LP add) correctly resolved to action / token / amount / pool, cross-checked against tonviewer |
| 1 | Data layer: tonapi integration, STON.fi event decoding for SWAP | Decoded swap history for 20 known test wallets matches tonviewer |
| 2 | LP_ADD decoding (+ LP_REMOVE if on schedule) + activity cache + Postgres schema | LP positions with durations reconstructed correctly on testnet + mainnet samples |
| 3 | Rules engine: DSL, validation, evaluation, evidence output | Unit test suite covering all condition types and combinators (target 40+ cases) |
| 4 | API: auth, campaigns, verify, rate limits; attestation signing | End-to-end verify call < 2s p95 with warm cache |
| 5 | SDK: typed builder, verify client, offline attestation check; docs | `npm install` → working integration in < 15 minutes following docs alone |
| 6 | Demo Mini App ("swap on STON.fi → earn points"), deployment, polish | Public demo live; repo public; grant final report |

Buffer strategy: weeks 1–2 carry the risk (decoding), but the week-0 PoC de-risks it before any grant commitment is made. If decoding still overruns, the `LP_REMOVE` stretch goal is abandoned first; committed scope (`SWAP`, `LP_ADD`) is protected.

## 13. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| STON.fi op-code decoding harder than expected (v1 vs v2 contracts, edge-case routes) | **High** | Week-0 PoC decoder proves feasibility before submission; official `@ston-fi/sdk` types; validate against tonviewer; `LP_REMOVE` is stretch-only |
| tonapi rate limits / cost at scale | Medium | Redis caching, 60s freshness TTL, `DataProvider` abstraction for later self-hosted indexer |
| Omniston migration changes event shapes (STON.fi routes all swaps through Omniston now) | Medium | Decode at settlement level (pool contracts) not router level where possible; pin tests to real mainnet txs |
| Nobody integrates it | Medium | Pre-validated via developer outreach (in progress); demo Mini App doubles as marketing; STON.fi co-promotion ask in grant |
| Price/USD valuation disputes | Low | Evidence includes rate source + timestamp; apps can set rules in token units instead of USD |

## 14. Phase roadmap (post-grant)

- **Phase 2:** on-chain settlement contract (optional escrow payout in jettons), webhook push + duration-rule scheduler, dashboard UI, self-hosted indexer, DeDust support → second grant / TON Foundation
- **Phase 3 (internal roadmap only):** attribution graphs (referral trees as a configurable primitive), reputation scoring, Sybil heuristics → the original ContributionOS vision, earned one primitive at a time. **Grant-facing materials stop at Phase 2** — attribution/referral framing stays out of the application entirely unless a reviewer explicitly asks about long-term expansion.

## 15. Resolved design decisions

Formerly open questions — resolved with reasoned defaults so the build is unblocked. Each notes the outreach signal that would overturn it.

### 15.1 Rule thresholds: token units primary, USD optional

**Decision:** `minAmount` in token units is the default and recommended mode; `minVolumeUsd` is optional sugar.

**Rationale:** Token amounts are on-chain truth — deterministic, replayable, and dispute-free. USD thresholds require a price source, which introduces the valuation-dispute risk already flagged in §13 and makes the same rule evaluate differently depending on rate timing. TON-native teams also think in TON/jetton terms for their own pools. USD mode stays in because marketing-led campaigns ("swap $50 worth of anything") genuinely need it, but it carries the evidence burden: rate source + timestamp recorded per evaluation.

**Would overturn it:** multiple target apps saying their campaigns are always cross-token USD-denominated.

### 15.2 Hosting: self-hostable first-class, hosted API as convenience

**Decision:** The verification service ships as an open-source Docker Compose stack (API + Postgres + Redis) with a documented one-command deploy. The hosted instance exists for demos and small Mini Apps that don't want infra.

**Rationale:** This isn't really a choice for a grant project — "open-source, self-hostable" is what makes the funding pitch credible, and serious teams in a trust-minimized ecosystem will not gate reward eligibility on a solo developer's uptime. The hosted instance costs nothing extra (existing VPS) and removes friction for the long tail of Mini App builders, who are the most likely early adopters. Offline-verifiable attestations (§9) make the hosted option safer than it would otherwise be: even hosted users don't have to trust live responses.

**Would overturn it:** nothing realistically; outreach only tunes how much effort the hosted tier's onboarding gets.

### 15.3 Verification model: verify-on-claim (poll), webhooks deferred

**Decision:** v1 is on-demand only — the app calls `/v1/verify` when the user acts (taps "claim", opens the rewards screen). Webhooks and a scheduler move to Phase 2.

**Rationale:** Reward UX is user-initiated in practice: a claim button is the natural checkpoint, and verifying at that moment guarantees freshness of both the activity data and the attestation window (§9 expiry). Push-style webhooks are only genuinely needed for duration rules (`lpHold 7d`) completing in the background — but supporting that properly means a persistent scheduler tracking every pending (wallet, rule) pair, which is real scope and real ops burden for a marginal UX gain the demo doesn't need. Apps can handle the duration case in v1 by re-verifying on the user's next visit, which is what most Mini Apps do anyway. Cutting this also directly de-risks week 4.

**Would overturn it:** a committed early integrator whose reward flow is genuinely server-driven (e.g. airdrop batches) rather than user-initiated.

### 15.4 Demo reward: points in-app, plus an app-side jetton payout example

**Decision:** The demo Mini App awards points (its own DB) on successful attestation. The repo additionally includes a documented example script where the *app's own wallet* sends a small jetton payout after verifying an attestation offline.

**Rationale:** Points-only keeps the demo custody-free and instantly runnable by anyone cloning the repo. But a grant reviewer's implicit question is "does this actually connect to value on TON?" — the jetton example answers it end-to-end (attestation → offline verify → app-signed transfer) while preserving the core design stance: the payout is executed by the app from the app's wallet, never by the verification service. It also doubles as the reference implementation integrators will copy, and it previews Phase 2's settlement contract without committing to one. Cost: ~a day of work, well inside the week-6 buffer.

**Would overturn it:** nothing — this is strictly additive; it would only be cut under schedule pressure, after `LP_REMOVE` (§12).
