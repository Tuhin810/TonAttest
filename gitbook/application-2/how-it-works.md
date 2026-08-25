# How It Works

## The same primitive, a second fact shape

The signer, the canonicalization, and offline verification are **already
built and already proven** — this reuses them without modification. Only the
*subject* of the attestation changes:

```json
{
  "v": 1,
  "subject": "asset",
  "address": "0:8cdc1d76…",
  "flag": "honeypot",
  "severity": "high",
  "source": "stonfi",
  "issued_at": 1755300000,
  "revoked_at": null
}
```

Same Ed25519 signature. Same `verifyAttestation()`. Same "check it yourself,
offline, no live trust required" guarantee that already exists for campaigns
— just pointed at a different kind of fact.

## How a flag actually gets published

```mermaid
sequenceDiagram
    autonumber
    participant Src as Source<br/><i>e.g. STON.fi</i>
    participant T as TonAttest
    participant W as Any wallet or bot

    Note over Src: Already has a finding —<br/>from Esprito, manual review, or otherwise

    Src->>T: POST /v1/flags<br/>{ asset, flag, severity, evidence }<br/>authenticated as "stonfi"
    T->>T: verify the source's own credentials
    T->>T: sign { subject: asset, flag, source: "stonfi", … }
    T-->>Src: attestation id + signature

    Note over W: Later — any consumer,<br/>no relationship with the source required

    W->>T: GET /v1/assets/:address/flags
    T-->>W: current signed attestation(s)
    W->>W: verify signature OFFLINE, no call back to TonAttest

    Note over Src,T: Revocation — same source, same auth
    Src->>T: POST /v1/flags/:id/revoke<br/>authenticated as the ORIGINAL issuer
    T->>T: reject if requester ≠ original source
    T->>T: sign a revocation record
```

Two things this makes concrete rather than implied: **submitting a flag
requires being authenticated as a real, named source** — nobody can flag an
asset anonymously or on TonAttest's own authority — and **revoking one
requires being authenticated as that *same* source**, enforced by the
service, not left as a policy anyone has to trust.

## Next

* [Liability & Pricing](liability-and-pricing.md)
* [Build Plan](build-plan.md)
