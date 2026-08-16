import type { Rule } from "@tonattest/rules";
import type { AntiAbuseLimits, Evidence } from "@tonattest/rules";

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly apiKeyHash: string;
  readonly apiKeySalt: string;
  readonly apiKeyHint: string;
  readonly disabledAt: Date | null;
}

export interface SigningKeyRecord {
  readonly id: string;
  readonly projectId: string;
  readonly publicKey: string;
  readonly privateKeyCiphertext: string;
  readonly privateKeyIv: string;
  readonly privateKeyTag: string;
  readonly createdAt: Date;
  readonly retiredAt: Date | null;
}

export interface Campaign {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly rule: Rule;
  readonly ruleHash: string;
  readonly limits: AntiAbuseLimits | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly status: "active" | "paused" | "ended";
}

export interface VerificationRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly wallet: string;
  readonly eligible: boolean;
  readonly ruleHash: string;
  readonly evidence: Evidence;
  readonly evidenceHash: string;
  readonly evaluatedAt: Date;
  readonly idempotencyKey: string;
}

export interface AttestationRecord {
  readonly id: string;
  readonly verificationId: string;
  readonly signingKeyId: string;
  readonly payload: Record<string, unknown>;
  readonly signature: string;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Persistence boundary.
 *
 * Everything above this interface — idempotency, replay protection, the audit
 * trail — is logic that must behave identically whichever store backs it, so
 * it is written against this and tested against an in-memory implementation.
 */
export interface Store {
  getProjectById(id: string): Promise<Project | null>;
  listProjects(): Promise<readonly Project[]>;
  createProject(project: Project): Promise<void>;

  createSigningKey(key: SigningKeyRecord): Promise<void>;
  /** The key currently used for signing: newest non-retired. */
  getActiveSigningKey(projectId: string): Promise<SigningKeyRecord | null>;
  /** All keys still worth publishing, including retired ones. */
  listSigningKeys(projectId: string): Promise<readonly SigningKeyRecord[]>;

  createCampaign(campaign: Campaign): Promise<void>;
  getCampaign(id: string): Promise<Campaign | null>;
  listCampaigns(projectId: string): Promise<readonly Campaign[]>;

  /**
   * Records a verification, or returns the one already stored under the same
   * idempotency key. Must be atomic: two concurrent claims for the same wallet
   * have to collapse to one row.
   */
  insertVerificationIfAbsent(
    record: VerificationRecord,
  ): Promise<{ record: VerificationRecord; created: boolean }>;

  insertAttestation(record: AttestationRecord): Promise<void>;
  getAttestationByVerification(verificationId: string): Promise<AttestationRecord | null>;

  ping(): Promise<void>;
  close(): Promise<void>;
}
