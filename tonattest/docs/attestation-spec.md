# Attestation specification

An attestation is a signed statement that a wallet satisfied a rule. It is
designed to be verified **without this SDK, in any language**, so that an
integrator is never locked into TypeScript and never has to trust a live
response.

This document is the complete specification.

## Format

```json
{
  "payload": {
    "v": 1,
    "project": "prj_abc",
    "campaign": "cmp_xyz",
    "wallet": "0:83d6…fa03",
    "rule_hash": "sha256:…",
    "eligible": true,
    "evidence_hash": "sha256:…",
    "issued_at": 1800000000,
    "expires_at": 1800003600,
    "nonce": "5f3a…"
  },
  "signature": "<128 hex characters>"
}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | integer | Format version. Reject versions you do not know |
| `project` | string | Which project's key signed this |
| `campaign` | string | Which campaign it was earned under |
| `wallet` | string | Canonical raw-form TON address (`workchain:hex`) |
| `rule_hash` | string | `sha256:` over the rule's canonical JSON |
| `eligible` | `true` | Always true — negative results are never signed |
| `evidence_hash` | string | `sha256:` over the evidence's canonical JSON |
| `issued_at` | integer | Unix seconds |
| `expires_at` | integer | Unix seconds. Default lifetime one hour |
| `nonce` | string | Single-use marker. The consuming app records spent nonces |

`eligible` is always `true` because a signed *negative* would be a durable,
transferable statement about someone's wallet with no upside. A failed check
returns evidence instead.

## Signature

**Ed25519** over the **UTF-8 bytes of the payload's RFC 8785 canonical JSON**.
The signature is lowercase hex, 64 bytes.

RFC 8785 (JCS) in the part that matters here:

- object keys sorted by UTF-16 code unit
- no insignificant whitespace
- numbers in their shortest round-trippable form
- strings escaped minimally, as JSON requires

For the payload above, the exact signed bytes are:

```
{"campaign":"cmp_xyz","eligible":true,"evidence_hash":"sha256:…","expires_at":1800003600,"issued_at":1800000000,"nonce":"5f3a…","project":"prj_abc","rule_hash":"sha256:…","v":1,"wallet":"0:83d6…fa03"}
```

Since every value in the payload is a string, an integer, or `true`, a
conforming implementation needs only: sort the keys, serialize with no
whitespace, and escape strings as JSON.

## Verifying

### Any language

1. Reject unknown `v`.
2. Canonicalize `payload` per RFC 8785 → UTF-8 bytes.
3. Verify the Ed25519 signature against the project's public key.
4. Check `expires_at` against your own clock.
5. Check `wallet` and `campaign` are the ones you expect.
6. Check `nonce` has not been spent, and record it before acting.

Steps 5 and 6 are not optional. A valid signature over a *different* wallet is
still not a statement about the user in front of you, and an unspent-nonce
check is what stops replay.

### Python

```python
import json
from nacl.signing import VerifyKey

def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")

VerifyKey(bytes.fromhex(public_key)).verify(
    canonical(attestation["payload"]),
    bytes.fromhex(attestation["signature"]),
)
```

### Go

```go
payload, _ := json.Marshal(att.Payload) // encoding/json sorts map keys
ok := ed25519.Verify(pubKey, payload, sig)
```

### TypeScript

```ts
import { verifyAttestation } from "@tonattest/sdk";
const result = await verifyAttestation(attestation, pinnedPublicKey);
```

## Public keys

Fetch from `GET /v1/keys`, then **pin them**. Fetching the key from the same
service you are verifying, at verification time, means a compromise of that
service defeats the check entirely.

Retired keys stay published, so attestations issued before a rotation keep
verifying.

## Versioning

Any change to the payload shape bumps `v`. Verifiers must reject versions they
do not know rather than interpreting unknown fields — a future format may mean
something materially different by the same field names.

The canonicalization and signature scheme are fixed for `v: 1`. Changing them
would invalidate every attestation in the wild, so they will not change within
a version.
