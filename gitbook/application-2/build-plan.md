# Build Plan — Phases 5–8

### Phase 5–8 — the build plan

| Phase | Delivers | Builds on |
|---|---|---|
| **5 — Attestation schema extension** | A second attestation kind (`subject: "asset"`), signed and verified the same way | `@tonattest/attest`, `@tonattest/rules` — additive, no rework |
| **6 — Ingestion + publishing API** | Submit a flag (source-attributed) · query current flags for an asset | `@tonattest/service` — same auth, rate-limiting, audit trail already built |
| **7 — Revocation lifecycle** | Only the original source can revoke its own flag — signed and checkable, not silent deletion | Existing attestation audit log, extended |
| **8 — Distribution & pilot** | A real consumer checking a real flag, offline — proven the way Phase 1 was proven on live mainnet | New — the end-to-end proof phase |

Each phase ends in something independently useful, the same discipline the
original four phases followed.

---

