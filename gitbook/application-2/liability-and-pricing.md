# Liability & Pricing

## Attribution, not adjudication

Every attestation says **"source X claims Y,"** never **"Y is true."** That
`source` field isn't decoration — it's the entire liability boundary. We
never independently decide whether a token is malicious; we sign and publish
a decision someone else already made, with their name attached to it.

That boundary holds on the way out too: **only the source that issued a flag
can revoke it.** TonAttest never unilaterally decides a flag was wrong —
doing so would mean making a second independent judgment call, which is
exactly the liability this design is built to avoid. We stay the courier
going in and coming out, never the judge.

This must be enforced technically — revocation requests authenticated
against the original issuer, checked by the service itself — not merely
stated as policy. See [How It Works](how-it-works.md) for the mechanism.

## Why it can be affordable

The expensive part — reading a contract's bytecode and mathematically
proving it's a trap — only has to happen **once, ever, per token.** After
that, "is this token flagged" is a database lookup, not an analysis. We
never re-run anyone's detection; we serve a result someone already paid to
compute once. That's the entire reason a trading bot priced out of a direct
Esprito relationship could afford this: they'd be paying for lookups, not
for symbolic execution.

| | Esprito, per token analyzed | TonAttest, per lookup |
|---|---|---|
| What happens | Symbolic execution over bytecode | A database read |
| Cost | Real, per-analysis compute | Near-zero |
| What you're paying for | The analysis itself | Bandwidth and lookup |

**What this deliberately is not:** a cheaper way to detect honeypots
ourselves. Esprito's technology is genuinely hard and already exists; the
gap Michael named is that STON.fi's own already-computed findings — using
Esprito or otherwise — have nowhere to go beyond STON.fi's own UI.

## Next

* [Build Plan](build-plan.md)
* [Grant Reapplication (Full Document)](../reference/grant-reapplication.md)
