# STON Rewards

Composable, programmable reward rules over verified STON.fi activity.
See `../project/ston-rewards-technical-design.md` for the design and
`../project/ston-rewards-build-phases.md` for the phase plan.

## Status — Phases 1 and 2 complete

| Piece | State |
|---|---|
| `DataProvider` interface + tonapi client | done, tested |
| Pool/router registry (`api.ston.fi`) | done, tested |
| Address normalization (raw ↔ friendly, CRC-checked) | done, tested |
| `SWAP` decoding | done, verified against live mainnet |
| `LP_ADD` / `LP_REMOVE` decoding | done, verified against live mainnet |
| LP position reconstruction (FIFO) | done, verified on a real deposit/withdrawal pair |
| Golden mainnet fixtures | done, pinned in CI |
| Activity resolver (fails closed) | done, tested |
| USD valuation | done, with a stated limitation |
| **Phase 2** | |
| Rule DSL + typed builder | done, tested |
| Validator with path-specific errors | done, tested |
| Evaluator + evidence on both outcomes | done, tested |
| Anti-abuse: net volume, caps, cooldown, wallet age | done, tested |
| RFC 8785 canonical JSON + rule hashing | done, tested |
| Ed25519 attestations, offline verification | done, cross-verified with Node crypto |

265 tests green, including golden mainnet fixtures and a full
chain-data-to-signed-attestation integration test. `pnpm test`.

### Verified against mainnet

```
pnpm decode 0:9e0616b6ba05ff23bbcfd12cc43c168ef075c91d625efacaf634907aeadf28ce --days 365
```

resolves 20 real swaps with a 0% undecodable rate, decoding both native-TON and
jetton legs in each direction, and attributing 19 of 20 to a specific pool.

A real liquidity round trip decodes and pairs into one closed position:

```
pnpm decode 0:83d606248e51ac6cd720ff254d63ed2b023161ab50ac026b4a245d463a62fa03 --days 400 --usd
```

### Known limitations

See `../project/gap.md` for the full record. In short:

- **Pool attribution** is refused rather than guessed when a router-scoped
  token pair matches several pools (~0.3% of pairs). Those swaps keep their
  amounts; only `pool` is withheld.
- **USD valuation** uses the current rate, not the rate at transaction time.
  Every valuation records its observation time so this is visible. Token-unit
  thresholds are the dispute-proof ones.
- **LP token legs** are best-effort evidence. Pool, LP units, and timing are
  authoritative; the underlying amounts are read from sibling transfers.
- The fixture set should grow to the 30+ the phase plan calls for.

## Layout

```
packages/core-types/    shared types, address handling, error taxonomy
packages/data-provider/ tonapi client, pool registry, retry/backoff  (all IO)
packages/decoder/       raw events -> normalized actions             (pure)
packages/activity/      resolver + USD rates; fails closed on partial data
packages/rules/         DSL, validation, evaluation, evidence          (pure)
packages/attest/        canonical JSON, Ed25519 sign/verify            (pure)
apps/cli/               `pnpm decode <wallet>` — Phase 1 exit criterion
```

`decoder/`, `rules/`, and `attest/` are pure. Evaluation takes an
`ActivitySet` and never fetches, so the same `(rule, activity)` pair always
produces byte-identical evidence — the property that lets a disputed result be
re-derived offline years later. A test enforces this: those packages may not
import the IO packages, call `fetch`, or read an ambient clock.

## Commands

```
pnpm install
pnpm test          # unit suite
pnpm -r typecheck
pnpm -r build
pnpm decode <wallet> [--days 30] [--limit 1000] [--usd] [--json]
```

Set `TONAPI_KEY` to raise the rate limit.

## Writing a rule

```ts
import { all, any, evaluate, lpHold, swap, validateRule } from "@ston-rewards/rules";

const rule = all(
  swap({ minAmount: 100_000_000n, token: "TON" }),
  lpHold({ pool: TON_USDT, minDuration: "7d" }),
);

const { eligible, evidence, ruleHash, evidenceHash } = evaluate(rule, {
  activity,                       // from @ston-rewards/activity
  campaign: { from, to },
  now: Math.floor(Date.now() / 1000),
  limits: { minInterval: "1h", minWalletAge: "30d" },
});
```

Evidence is produced on failure as well as success, and names the shortfall:
`counted 62400000 of 100000000 token units`. Net volume counting is on by
default, so swapping back and forth nets to roughly zero.

## Attestations

```ts
import { signAttestation, verifyAttestation } from "@ston-rewards/attest";

const attestation = await signAttestation({ ...ids, ruleHash, evidenceHash, issuedAt, nonce }, privateKey);

// Offline — no network, no trust in the issuing service:
const result = await verifyAttestation(attestation, publicKey);
```

Signatures are Ed25519 over RFC 8785 canonical JSON, so any language can
verify them. The test suite proves this by verifying with Node's own `crypto`
rather than the library that signed, and by reproducing the signed bytes with a
hand-written canonicalizer.
