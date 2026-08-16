# STON Rewards

Composable, programmable reward rules over verified STON.fi activity.
See `../project/ston-rewards-technical-design.md` for the design and
`../project/ston-rewards-build-phases.md` for the phase plan.

## Status — Phase 1 (truth layer), in progress

| Piece | State |
|---|---|
| `DataProvider` interface + tonapi client | done, tested |
| Pool/router registry (`api.ston.fi`) | done, tested |
| Address normalization (raw ↔ friendly, CRC-checked) | done, tested |
| `SWAP` decoding | **done, verified against live mainnet** |
| `LP_ADD` / `LP_REMOVE` decoding | **not working on real data — see below** |
| LP position reconstruction (FIFO) | done, tested (unit-level) |
| Golden mainnet fixtures | not yet committed |

65 unit tests green. `pnpm test`.

### Verified against mainnet

```
pnpm decode 0:9e0616b6ba05ff23bbcfd12cc43c168ef075c91d625efacaf634907aeadf28ce --days 365
```

resolves 20 real swaps with a 0% unknown rate, decoding both native-TON and
jetton legs in each direction.

### Known gaps

**LP decoding does not fire on real data.** The implementation expects the
provider to emit semantic `DepositLiquidity` / `WithdrawLiquidity` actions.
tonapi does not: a survey of 100 router events returns only `JettonSwap`,
`JettonTransfer`, `SmartContractExec`, and `TonTransfer`. Liquidity operations
arrive as `SmartContractExec` with an `operation` label (e.g.
`StonfiPaymentRequest`) and a raw BOC payload, so real LP support needs
op-code-level decoding of that payload. Until then LP events are recorded as
`UNKNOWN` rather than being dropped.

**Pool attribution is often absent for swaps.** Providers report swaps at
router level and do not name the pool. The decoder resolves a pool only when
the token pair matches exactly one registry entry, and leaves `pool` undefined
otherwise. Pool-scoped rules will not match those swaps — deliberately, since
guessing would let a swap satisfy a rule for a pool it never touched. Roughly
half the swaps in the live sample above fall in this bucket, so a pool-level
attribution strategy is required before pool-scoped rules can be advertised.

## Layout

```
packages/core-types/    shared types, address handling, error taxonomy
packages/data-provider/ tonapi client, pool registry, retry/backoff  (all IO)
packages/decoder/       raw events -> normalized actions             (pure)
apps/cli/               `pnpm decode <wallet>` — Phase 1 exit criterion
```

`decoder/` is pure: `(events, registry, wallet) => actions`. That is what makes
golden-fixture tests possible and every eligibility answer reproducible offline.

## Commands

```
pnpm install
pnpm test          # unit suite
pnpm -r typecheck
pnpm -r build
pnpm decode <wallet> [--days 30] [--limit 1000] [--json]
```

Set `TONAPI_KEY` to raise the rate limit.
