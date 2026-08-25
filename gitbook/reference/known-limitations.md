# Known Limitations

**Scope:** open gaps only. Phase 1 (truth layer).
**Last updated:** 2026-08-17.

The five gaps found during the Phase 1 build (LP decoding, pool attribution,
missing fixtures, unconsumed truncation, no USD source) are all closed and have
been removed from this document. What remains below is what is still open.

Verification state: 103 tests green, typecheck clean, decoding verified against
live mainnet for swaps and for a full liquidity round trip.

---

## G6 — Fixture set is below the Phase 1 bar

**Severity:** blocks the Phase 1 exit criterion.

The phase plan calls for **≥30** committed mainnet fixtures. There are
currently **5**: a native-TON-in swap, a jetton-to-pTON swap, a multi-action
router swap, an LP deposit, and an LP withdrawal.

Missing coverage, in rough priority order:

| Case | Why it matters |
|---|---|
| v2 routers | Only v1 router traffic is pinned; v2 is live and shaped differently |
| Jetton-to-jetton swaps | Neither leg is TON, so the pTON canonicalization path is untested on real data |
| Multi-hop / Omniston routes | The §13 risk the design doc flags; unproven either way |
| **Partial LP withdrawal** | The only case that exercises FIFO slicing, which is currently unit-tested against synthetic data alone |
| A genuinely ambiguous pool pair | Pins the refusal behaviour so a future change cannot silently start guessing |

Capture is scripted (`scripts/capture-fixture.mjs`, then
`scripts/capture-pools.mjs`), so this is finding the right transactions rather
than writing code. The partial-withdrawal case is the one worth hunting for
deliberately — everything else can be swept from router history.

---

## G7 — USD valuation is not historical

**Severity:** limits what USD rules can honestly promise. Not blocking.

`StonFiRateProvider` values actions from STON.fi's asset list, which serves the
**current** price. For a swap from weeks ago in a volatile token, the resulting
figure is a present-day restatement, not the value at the time of the trade.

This is disclosed rather than hidden: every valuation records `source` and the
rate's observation time `at`, and the CLI prints that timestamp beside the
figure. USD is opt-in, so with no rate provider supplied `usd` is absent
everywhere rather than defaulted to a guess.

**Consequence today.** USD thresholds are marketing-grade; token-unit
thresholds are the dispute-proof ones. This matches design doc §15.1, which
already makes token units the recommended mode — but it means a
`minVolumeUsd` rule cannot yet be defended in a dispute.

**Closing it** needs a historical rate source keyed on the event timestamp.
That belongs with the Phase 3 evidence work, where the rate and its timestamp
become part of a signed attestation and therefore have to be reproducible.

---

## G8 — Pool attribution refuses on ~0.3% of swaps

**Severity:** accepted limitation. Documented so it is a decision, not a
surprise.

Pools are resolved from `(router, canonical token pair)`. Measured across the
full live registry, **0.28%** of router-scoped pairs match more than one pool
and are left unattributed; a single live pool among deprecated ones breaks the
tie, anything else does not.

Those swaps keep their amounts, tokens, and timing — only `pool` is withheld,
so a pool-scoped rule will not match them.

**Why this stays as-is.** Guessing would let a swap satisfy a rule for a pool
the user never touched: a false positive, which becomes a payout the
integrating app cannot claw back. The residual rate is small enough that a
correlation strategy (matching against jetton transfers in the same event) is
not worth its complexity yet.

**Would reopen it:** an integrator whose campaign is pool-scoped on a pair that
lands in the ambiguous set.

---

## G9 — LP token legs are best-effort

**Severity:** cosmetic in v1. Would matter if a rule ever depends on them.

The underlying token amounts attached to an `LP_ADD` / `LP_REMOVE` are read
from transfers in the same event, filtered to the pool's own two assets, taking
the largest transfer per asset rather than the sum — a withdrawal is
accompanied by gas change in TON, and summing folded that refund into the
reported TON leg.

Two known imprecisions:
- Where a deposit's legs were paid in an earlier event, they come back empty
  (observed on real mainnet data).
- A payout split across several transfers of the same asset would report only
  the largest.

**Why it is tolerable.** Nothing in v1 depends on these. Pool, LP units, and
timing — everything the `lpAdd` and `lpHold` conditions actually evaluate —
come from the mint/burn/transfer itself and are authoritative. The legs are
evidence for a human reading a verification result.

**Would escalate it:** a rule expressed in underlying token amounts rather than
LP units, or USD-denominated LP rules, since those would multiply a best-effort
figure by a rate and present the product as fact.

---

## Not blocked by any of the above

Phase 2 — rules engine, evidence output, attestation signing. It evaluates
against an `ActivitySet` and can be built and fully tested against synthetic
activity while G6–G9 are worked in parallel.
