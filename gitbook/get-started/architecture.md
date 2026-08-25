# Architecture

The same mechanism either application runs on: TonAttest reads a fact, signs it, and hands back a proof your app checks itself.

```mermaid
flowchart LR
    A["Your app<br/><i>defines a rule</i>"] -->|"verify(wallet, campaign)"| B["TonAttest"]
    B -->|"reads"| C["TON chain<br/><i>STON.fi events</i>"]
    B -->|"signed attestation<br/>+ evidence"| A
    A -->|"pays out from<br/><b>its own</b> wallet"| D["User"]

    style A fill:#7651e8,color:#fff,stroke:none
    style B fill:#16805c,color:#fff,stroke:none
    style C fill:#4a4840,color:#fff,stroke:none
    style D fill:#9a6212,color:#fff,stroke:none
```

> **No custody. No smart contract. No token.**
> TonAttest proves *what happened on-chain* and signs that statement.
> Your app decides what the reward is and pays it from its own wallet.


## How it works

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant A as Your backend
    participant S as TonAttest
    participant T as TON / STON.fi

    U->>A: taps "Claim"
    A->>S: POST /v1/verify { wallet, campaignId }

    Note over S: authenticate · rate limit · derive idempotency key

    S->>T: fetch account events
    T-->>S: raw events

    alt history incomplete or upstream down
        S-->>A: 503 typed error — fails closed
        A-->>U: "Couldn't check right now — try again"
        Note over A,U: never "you don't qualify"
    else history complete
        Note over S: decode → normalize → evaluate rule
        alt rule satisfied
            S->>S: sign attestation · record in audit log
            S-->>A: { eligible: true, attestation, evidence }
            A->>A: verify signature OFFLINE against pinned key
            A->>A: check wallet · campaign · nonce unspent
            A-->>U: reward granted
        else rule not satisfied
            S-->>A: { eligible: false, evidence }
            A-->>U: "You swapped 62 of the required 100 TON"
        end
    end
```

**Step 9 is the one that matters.** Your app checks the signature itself,
against a public key it pinned at deploy time. A spoofed response, a hijacked
DNS record, or a fully compromised TonAttest instance cannot mint rewards from
your treasury — which is also why hosted and self-hosted have the same security
story.

### Failure is never a wrong answer

If a wallet's history cannot be resolved completely — upstream outage, rate
limit, or a history larger than the fetch cap — TonAttest returns a typed `503`
rather than evaluating partial data. An under-counted history produces a
confident *"you don't qualify"* for someone who did.

> A false negative is a support ticket. A **false positive is a payout you
> cannot claw back.** Every ambiguous case in this system resolves toward the
> former.

---

