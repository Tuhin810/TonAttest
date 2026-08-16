import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import type {
  AttestationRecord,
  Campaign,
  Project,
  SigningKeyRecord,
  Store,
  VerificationRecord,
} from "./types.js";

const { Pool } = pg;

/**
 * Postgres-backed store.
 *
 * Deliberately thin: every behaviour worth reasoning about lives above this
 * layer and is tested against {@link MemoryStore}. What Postgres adds is
 * durability and the two uniqueness constraints that are correctness features
 * rather than hygiene — the idempotency key and the activity replay guard.
 */
export class PostgresStore implements Store {
  readonly #pool: pg.Pool;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.#pool = new Pool({
      connectionString,
      max: options.max ?? 10,
      // Fail fast rather than queueing behind a dead database: a request that
      // hangs for a minute is worse for the caller than a clean 503.
      connectionTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: 10_000,
      ...(connectionString.includes("sslmode=disable")
        ? {}
        : { ssl: { rejectUnauthorized: false } }),
    });
  }

  async getProjectById(id: string): Promise<Project | null> {
    const { rows } = await this.#pool.query(
      `SELECT id, name, api_key_hash, api_key_salt, api_key_hint, disabled_at
         FROM projects WHERE id = $1`,
      [id],
    );
    return rows[0] ? toProject(rows[0]) : null;
  }

  async listProjects(): Promise<readonly Project[]> {
    const { rows } = await this.#pool.query(
      `SELECT id, name, api_key_hash, api_key_salt, api_key_hint, disabled_at
         FROM projects WHERE disabled_at IS NULL`,
    );
    return rows.map(toProject);
  }

  async createProject(project: Project): Promise<void> {
    await this.#pool.query(
      `INSERT INTO projects (id, name, api_key_hash, api_key_salt, api_key_hint)
       VALUES ($1, $2, $3, $4, $5)`,
      [project.id, project.name, project.apiKeyHash, project.apiKeySalt, project.apiKeyHint],
    );
  }

  async createSigningKey(key: SigningKeyRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO signing_keys
         (id, project_id, public_key, private_key_ciphertext, private_key_iv, private_key_tag)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        key.id,
        key.projectId,
        key.publicKey,
        key.privateKeyCiphertext,
        key.privateKeyIv,
        key.privateKeyTag,
      ],
    );
  }

  async getActiveSigningKey(projectId: string): Promise<SigningKeyRecord | null> {
    const { rows } = await this.#pool.query(
      `SELECT * FROM signing_keys
        WHERE project_id = $1 AND retired_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? toSigningKey(rows[0]) : null;
  }

  async listSigningKeys(projectId: string): Promise<readonly SigningKeyRecord[]> {
    const { rows } = await this.#pool.query(
      `SELECT * FROM signing_keys WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    );
    return rows.map(toSigningKey);
  }

  async createCampaign(campaign: Campaign): Promise<void> {
    await this.#pool.query(
      `INSERT INTO campaigns
         (id, project_id, name, rule_json, rule_hash, limits_json, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        campaign.id,
        campaign.projectId,
        campaign.name,
        JSON.stringify(campaign.rule),
        campaign.ruleHash,
        campaign.limits ? JSON.stringify(serializeLimits(campaign.limits)) : null,
        campaign.startsAt,
        campaign.endsAt,
        campaign.status,
      ],
    );
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    const { rows } = await this.#pool.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
    return rows[0] ? toCampaign(rows[0]) : null;
  }

  async listCampaigns(projectId: string): Promise<readonly Campaign[]> {
    const { rows } = await this.#pool.query(
      `SELECT * FROM campaigns WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId],
    );
    return rows.map(toCampaign);
  }

  /**
   * Atomic by way of the UNIQUE constraint rather than a read-then-write.
   *
   * `ON CONFLICT DO NOTHING` plus a follow-up read is what makes two
   * simultaneous claims collapse to one row even across separate service
   * instances, where an application-level check would race.
   */
  async insertVerificationIfAbsent(
    record: VerificationRecord,
  ): Promise<{ record: VerificationRecord; created: boolean }> {
    const { rows } = await this.#pool.query(
      `INSERT INTO verifications
         (id, campaign_id, wallet, eligible, rule_hash, evidence_json, evidence_hash,
          evaluated_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        record.id,
        record.campaignId,
        record.wallet,
        record.eligible,
        record.ruleHash,
        JSON.stringify(record.evidence),
        record.evidenceHash,
        record.evaluatedAt,
        record.idempotencyKey,
      ],
    );

    if (rows[0]) return { record: toVerification(rows[0]), created: true };

    const existing = await this.#pool.query(
      `SELECT * FROM verifications WHERE idempotency_key = $1`,
      [record.idempotencyKey],
    );
    return { record: toVerification(existing.rows[0]), created: false };
  }

  async insertAttestation(record: AttestationRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO attestations
         (id, verification_id, signing_key_id, payload_json, signature, nonce,
          issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (verification_id) DO NOTHING`,
      [
        record.id,
        record.verificationId,
        record.signingKeyId,
        JSON.stringify(record.payload),
        record.signature,
        record.nonce,
        record.issuedAt,
        record.expiresAt,
      ],
    );
  }

  async getAttestationByVerification(
    verificationId: string,
  ): Promise<AttestationRecord | null> {
    const { rows } = await this.#pool.query(
      `SELECT * FROM attestations WHERE verification_id = $1`,
      [verificationId],
    );
    return rows[0] ? toAttestation(rows[0]) : null;
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  /**
   * Applies migrations in filename order, inside a transaction, recording what
   * has run. Idempotent, so a restarted deploy is harmless.
   */
  async migrate(directory: string): Promise<string[]> {
    const client = await this.#pool.connect();
    const applied: string[] = [];
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );

      const { rows } = await client.query(`SELECT name FROM schema_migrations`);
      const done = new Set(rows.map((row: { name: string }) => row.name));

      for (const name of readdirSync(directory).filter((f) => f.endsWith(".sql")).sort()) {
        if (done.has(name)) continue;
        const sql = readFileSync(`${directory}/${name}`, "utf8");

        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [name]);
          await client.query("COMMIT");
          applied.push(name);
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
      return applied;
    } finally {
      client.release();
    }
  }
}

function serializeLimits(limits: Record<string, unknown>): Record<string, unknown> {
  // bigint has no JSON representation; thresholds are stored as strings.
  return Object.fromEntries(
    Object.entries(limits).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    apiKeyHash: row.api_key_hash,
    apiKeySalt: row.api_key_salt,
    apiKeyHint: row.api_key_hint,
    disabledAt: row.disabled_at ?? null,
  };
}

function toSigningKey(row: any): SigningKeyRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    publicKey: row.public_key,
    privateKeyCiphertext: row.private_key_ciphertext,
    privateKeyIv: row.private_key_iv,
    privateKeyTag: row.private_key_tag,
    createdAt: row.created_at,
    retiredAt: row.retired_at ?? null,
  };
}

function toCampaign(row: any): Campaign {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    rule: row.rule_json,
    ruleHash: row.rule_hash,
    limits: row.limits_json
      ? {
          ...row.limits_json,
          ...(row.limits_json.maxRewardableVolumePerWallet
            ? {
                maxRewardableVolumePerWallet: BigInt(
                  row.limits_json.maxRewardableVolumePerWallet,
                ),
              }
            : {}),
        }
      : null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  };
}

function toVerification(row: any): VerificationRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    wallet: row.wallet,
    eligible: row.eligible,
    ruleHash: row.rule_hash,
    evidence: row.evidence_json,
    evidenceHash: row.evidence_hash,
    evaluatedAt: row.evaluated_at,
    idempotencyKey: row.idempotency_key,
  };
}

function toAttestation(row: any): AttestationRecord {
  return {
    id: row.id,
    verificationId: row.verification_id,
    signingKeyId: row.signing_key_id,
    payload: row.payload_json,
    signature: row.signature,
    nonce: row.nonce,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}
