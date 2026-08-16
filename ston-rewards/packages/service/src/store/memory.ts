import type {
  AttestationRecord,
  Campaign,
  Project,
  SigningKeyRecord,
  Store,
  VerificationRecord,
} from "./types.js";

/**
 * In-memory store.
 *
 * Not a toy: it is the reference implementation the persistence contract is
 * tested against, so any behaviour the Postgres adapter is expected to provide
 * is pinned here first — particularly the atomicity of
 * {@link Store.insertVerificationIfAbsent}.
 */
export class MemoryStore implements Store {
  readonly #projects = new Map<string, Project>();
  readonly #signingKeys = new Map<string, SigningKeyRecord>();
  readonly #campaigns = new Map<string, Campaign>();
  readonly #verifications = new Map<string, VerificationRecord>();
  readonly #verificationsByIdempotency = new Map<string, VerificationRecord>();
  readonly #attestations = new Map<string, AttestationRecord>();

  async getProjectById(id: string): Promise<Project | null> {
    return this.#projects.get(id) ?? null;
  }

  async listProjects(): Promise<readonly Project[]> {
    return [...this.#projects.values()];
  }

  async createProject(project: Project): Promise<void> {
    this.#projects.set(project.id, project);
  }

  async createSigningKey(key: SigningKeyRecord): Promise<void> {
    this.#signingKeys.set(key.id, key);
  }

  async getActiveSigningKey(projectId: string): Promise<SigningKeyRecord | null> {
    const active = [...this.#signingKeys.values()]
      .filter((key) => key.projectId === projectId && key.retiredAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return active[0] ?? null;
  }

  async listSigningKeys(projectId: string): Promise<readonly SigningKeyRecord[]> {
    return [...this.#signingKeys.values()]
      .filter((key) => key.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async createCampaign(campaign: Campaign): Promise<void> {
    this.#campaigns.set(campaign.id, campaign);
  }

  async getCampaign(id: string): Promise<Campaign | null> {
    return this.#campaigns.get(id) ?? null;
  }

  async listCampaigns(projectId: string): Promise<readonly Campaign[]> {
    return [...this.#campaigns.values()].filter((c) => c.projectId === projectId);
  }

  async insertVerificationIfAbsent(
    record: VerificationRecord,
  ): Promise<{ record: VerificationRecord; created: boolean }> {
    // JavaScript's single-threaded turn is the atomicity here: no await
    // between the check and the write, so two concurrent callers cannot both
    // observe an empty slot.
    const existing = this.#verificationsByIdempotency.get(record.idempotencyKey);
    if (existing) return { record: existing, created: false };

    this.#verifications.set(record.id, record);
    this.#verificationsByIdempotency.set(record.idempotencyKey, record);
    return { record, created: true };
  }

  async insertAttestation(record: AttestationRecord): Promise<void> {
    this.#attestations.set(record.verificationId, record);
  }

  async getAttestationByVerification(
    verificationId: string,
  ): Promise<AttestationRecord | null> {
    return this.#attestations.get(verificationId) ?? null;
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
