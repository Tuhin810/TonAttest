# Rule cookbook

Rules are plain JSON. The builders in the SDK produce exactly that JSON — there
is no second representation — so a rule can be stored, sent over the wire, and
re-evaluated years later by code that never imports this package.

```
Rule       := Condition | Combinator
Combinator := { all: Rule[] } | { any: Rule[] }
Condition  := swap | lpAdd | lpHold
```

Nesting is capped at three levels, which keeps evaluation bounded and rules
explainable to the person who has to read the result.

## Conditions

### `swap`

| Field | Meaning |
|---|---|
| `minAmount` | Volume threshold in **token units** |
| `minVolumeUsd` | Volume threshold in USD — see [caveat](#token-units-versus-usd) |
| `token` | Restrict to swaps involving this asset, on either side. `"TON"` or a jetton master |
| `pool` | Restrict to one pool — see [pool caveat](#pool-scoped-rules) |
| `count` | At least N qualifying swaps |
| `window` | `"7d"`, `"30d"`, or `"campaign"` (default) |
| `netVolume` | Count `\|bought − sold\|` per asset. **Default `true`** |

### `lpAdd`

`minLpAmount`, `minAmountUsd`, `pool`, `count`, `window`.

### `lpHold`

`minDuration` (required, e.g. `"7d"`), `minLpAmount`, `pool`.

Holding time is measured **within the campaign window**, so a position opened
a year before the campaign does not arrive already satisfying a 7-day hold.

## Worked examples

```ts
import { all, any, lpAdd, lpHold, swap } from "@ston-rewards/sdk";

// Swapped at least 100 TON during the campaign.
swap({ minAmount: 100_000_000_000n, token: "TON" })

// Five or more swaps in the last 30 days.
swap({ count: 5, window: "30d" })

// Swapped 100 USDT AND held liquidity for a week.
all(
  swap({ minAmount: 100_000_000n, token: USDT }),
  lpHold({ pool: TON_USDT, minDuration: "7d" }),
)

// Either path qualifies: active trader, or committed LP.
any(
  swap({ count: 5, window: "30d" }),
  lpAdd({ minLpAmount: 1_000_000n }),
)

// Traded and provided liquidity, in either order, in the same week.
all(
  swap({ count: 1, window: "7d" }),
  lpAdd({ count: 1, window: "7d" }),
)
```

## Token units versus USD

**Use token units.** They are on-chain truth: deterministic, replayable, and
impossible to dispute.

`minVolumeUsd` exists because marketing-led campaigns genuinely need "swap $50
of anything". But it carries a real limitation, stated plainly: the rate source
serves the **current** price, not the price at the moment of the transaction.
For an old swap in a volatile token, the USD figure is a present-day
restatement. Every valuation records its own observation time in evidence so
this is visible rather than implied.

So: USD thresholds are marketing-grade. Token-unit thresholds are the ones you
can defend when a user disagrees.

## Pool-scoped rules

Chain data reports swaps at *router* level and does not name the pool. The pool
is recovered by matching the token pair within that router, which is
unambiguous about 99.7% of the time. When several pools share a pair, the swap
is recorded **without** a pool.

A swap with no pool will not satisfy a `pool`-scoped rule. That is deliberate:
guessing would let a swap satisfy a rule for a pool the user never touched,
which is a false positive — and a false positive is a payout you cannot claw
back. If your campaign is pool-scoped, test it against real wallets first.

## Windows

- Omitted, or `"campaign"` — from the campaign start to now.
- `"7d"` — the 7 days **before verification**, not before the campaign end.
  "Swapped in the last 7 days" has to keep meaning that, or a user could
  satisfy it once and let it lapse.
- Always clamped to the campaign, so no condition reaches back to activity that
  predates it.

## Evidence

Every evaluation returns evidence, on failure as well as success:

```json
{
  "kind": "swap",
  "satisfied": false,
  "detail": "counted 62400000 of 100000000 token units",
  "measured": {
    "qualifyingSwaps": 3,
    "volumeTokenUnits": "62400000",
    "grossVolumeTokenUnits": "184000000",
    "netVolume": 1
  },
  "txHashes": ["…", "…", "…"]
}
```

Show it to your users. `grossVolumeTokenUnits` next to `volumeTokenUnits` is
what makes "but I swapped way more than that" answerable in one screenshot.

Evidence is byte-identical for identical inputs, and its hash is bound into the
attestation — so a disputed result can be re-derived offline and checked
against the signature.

## Validation

`validateRule` rejects unknown fields rather than ignoring them, so a typo like
`minAmmount` fails loudly instead of producing a rule that matches everything.
Errors name the exact path:

```
$.all[1].any[0].lpHold.minDuration: required, and must be a duration such as "7d"
```

Validate locally before you ship a campaign — it is the same function the
service runs.
