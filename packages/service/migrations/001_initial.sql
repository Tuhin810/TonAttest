-- Initial schema.
--
-- Two constraints in here are correctness features, not hygiene:
--   * activity_cache.tx_hash UNIQUE  — an on-chain event counts once, ever
--   * verifications.idempotency_key UNIQUE — a double-tapped claim button
--     cannot mint two attestations

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- scrypt(api_key, salt). The key itself is shown once, at creation, and
  -- never stored.
  api_key_hash  TEXT NOT NULL,
  api_key_salt  TEXT NOT NULL,
  -- Prefix of the key, for identifying it in a UI without revealing it.
  api_key_hint  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at   TIMESTAMPTZ
);

-- Signing keys, encrypted at rest with the service master key. Rotation keeps
-- old keys verifiable: `retired_at` marks a key as no longer signing, while it
-- stays published so attestations already in the wild still verify.
CREATE TABLE IF NOT EXISTS signing_keys (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,
  private_key_ciphertext TEXT NOT NULL,
  private_key_iv         TEXT NOT NULL,
  private_key_tag        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS signing_keys_project_idx ON signing_keys(project_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  rule_json     JSONB NOT NULL,
  -- Binds every attestation to the exact rule that produced it. A campaign
  -- whose rule changes gets a new row, so attestations already issued stay
  -- bound to the rule they were evaluated under.
  rule_hash     TEXT NOT NULL,
  limits_json   JSONB,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_window CHECK (ends_at > starts_at),
  CONSTRAINT campaigns_status CHECK (status IN ('active', 'paused', 'ended'))
);

CREATE INDEX IF NOT EXISTS campaigns_project_idx ON campaigns(project_id);

CREATE TABLE IF NOT EXISTS verifications (
  id              TEXT PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  wallet          TEXT NOT NULL,
  eligible        BOOLEAN NOT NULL,
  rule_hash       TEXT NOT NULL,
  evidence_json   JSONB NOT NULL,
  evidence_hash   TEXT NOT NULL,
  evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS verifications_campaign_wallet_idx
  ON verifications(campaign_id, wallet);

-- Every issued attestation is recorded before it is returned. This table is
-- the audit trail for any dispute.
CREATE TABLE IF NOT EXISTS attestations (
  id              TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  signing_key_id  TEXT NOT NULL REFERENCES signing_keys(id),
  payload_json    JSONB NOT NULL,
  signature       TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS attestations_verification_idx
  ON attestations(verification_id);

-- Decoded STON.fi activity. The UNIQUE constraint on (wallet, tx_hash, type)
-- is the replay guard: one on-chain event can never be counted twice, across
-- any rule or campaign of any project.
CREATE TABLE IF NOT EXISTS activity_cache (
  wallet        TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  pool          TEXT,
  router        TEXT,
  token_in      TEXT,
  token_out     TEXT,
  amount_in     NUMERIC(78, 0),
  amount_out    NUMERIC(78, 0),
  lp_amount     NUMERIC(78, 0),
  amount_usd    DOUBLE PRECISION,
  usd_source    TEXT,
  usd_at        BIGINT,
  lt            NUMERIC(78, 0) NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  raw_json      JSONB,
  PRIMARY KEY (wallet, tx_hash, action_type)
);

CREATE INDEX IF NOT EXISTS activity_cache_wallet_time_idx
  ON activity_cache(wallet, occurred_at DESC);
