# Introduction

**A signed, offline-verifiable attestation layer for TON.**

Take any fact about the chain — a wallet satisfied a reward rule, an asset
was flagged as malicious — and turn it into a proof anyone can check
themselves, without trusting a live server.

## Two things, one primitive

TonAttest signs facts about the TON chain so anyone can verify them offline.
Everything in this documentation is one of two applications of that single
mechanism.

|                  | **Reward verification**                              | **Asset trust layer**                                    |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| The fact signed  | *"wallet X satisfied rule Y"*                           | *"asset X was flagged Z, by source W"*                     |
| Who asks         | Your app, checking a claim                              | Any wallet, bot, or explorer                                |
| Status           | ✅ **Built.** 360 tests, verified on live mainnet        | 🟡 **Proposed.** Requested by STON.fi                       |
| Start here       | [Quickstart](get-started/quickstart.md)                 | [Overview](application-2/overview.md)                      |

Same signer. Same canonical JSON. Same offline verification. The only thing
that changes between the two is **what fact is being attested**.

## No custody. No smart contract. No token.

TonAttest proves what happened on-chain and signs that statement. It never
holds funds and never makes the underlying judgment call on its own — every
attestation names the source that made the claim.

## Where to go next

* New to TonAttest? Start with [Architecture](get-started/architecture.md), then [Quickstart](get-started/quickstart.md).
* Integrating reward campaigns? Go straight to [Reward Verification](application-1/overview.md).
* Here about the token trust layer STON.fi asked for? Start at [Asset Trust Layer](application-2/overview.md).
* Self-hosting? See [Self-Hosting](operate/self-hosting.md).
* Want the unvarnished list of what isn't finished yet? [Known Limitations](reference/known-limitations.md).

---

360 tests passing · 0 known vulnerabilities · MIT licensed · open source
