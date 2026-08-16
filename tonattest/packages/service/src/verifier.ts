import { TonAttestError } from "@tonattest/core-types";
import type { DataProvider, PoolRegistrySnapshot } from "@tonattest/data-provider";
import { resolveActivity, type RateProvider } from "@tonattest/activity";
import { evaluate, type EvaluationResult } from "@tonattest/rules";
import {
  signAttestation,
  type Attestation,
  DEFAULT_TTL_SECONDS,
} from "@tonattest/attest";
import type { Cache } from "./cache.js";
import { newId, newNonce, unseal } from "./crypto.js";
import { ApiError } from "./errors.js";
import { verificationIdempotencyKey } from "./idempotency.js";
import { SingleFlight } from "./singleflight.js";
import type { Campaign, Store, VerificationRecord } from "./store/types.js";

export interface VerifierOptions {
  readonly store: Store;
  readonly cache: Cache;
  readonly provider: DataProvider;
  readonly registry: () => Promise<PoolRegistrySnapshot>;
  readonly masterKey: Uint8Array;
  readonly maxEventsPerWallet: number;
  /** How long a verification result is reused for an identical request. */
  readonly idempotencyBucketSeconds?: number;
  readonly rates?: RateProvider;
  readonly now?: () => number;
}

export interface VerifyRequest {
  readonly projectId: string;
  readonly campaign: Campaign;
  readonly wallet: string;
}

export interface VerifyResponse {
  readonly eligible: boolean;
  readonly verificationId: string;
  readonly ruleHash: string;
  readonly evidence: EvaluationResult["evidence"];
  readonly evidenceHash: string;
  readonly attestation?: Attestation;
  /** True when this response replayed a stored result rather than re-evaluating. */
  readonly cached: boolean;
}

/**
 * The verification path.
 *
 * Three properties hold here regardless of load or upstream health:
 *
 *  1. **Fail closed.** If activity cannot be resolved completely, this throws.
 *     It never evaluates against a partial history, because a partial history
 *     under-counts volume and produces a confident wrong answer.
 *  2. **One attestation per claim.** An idempotency key derived from the
 *     request collapses retries — a double-tapped claim button cannot mint two
 *     attestations.
 *  3. **One upstream fetch per wallet.** Concurrent verifications for the same
 *     wallet share a single resolution.
 */
export class Verifier {
  readonly #options: VerifierOptions;
  readonly #inflight = new SingleFlight<VerifyResponse>();
  readonly #now: () => number;

  constructor(options: VerifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async verify(request: VerifyRequest): Promise<VerifyResponse> {
    const campaign = request.campaign;
    const nowSeconds = Math.floor(this.#now() / 1_000);

    assertCampaignOpen(campaign, nowSeconds);

    const idempotencyKey = verificationIdempotencyKey({
      projectId: request.projectId,
      campaignId: campaign.id,
      wallet: request.wallet,
      ruleHash: campaign.ruleHash,
      now: nowSeconds,
      bucketSeconds: this.#options.idempotencyBucketSeconds ?? 60,
    });

    // Same key, same answer — including for callers arriving concurrently,
    // which the store's uniqueness constraint alone would let race on the
    // signing step.
    return this.#inflight.run(idempotencyKey, () =>
      this.#verifyOnce(request, idempotencyKey, nowSeconds),
    );
  }

  async #verifyOnce(
    request: VerifyRequest,
    idempotencyKey: string,
    nowSeconds: number,
  ): Promise<VerifyResponse> {
    const { store } = this.#options;
    const campaign = request.campaign;

    const registry = await this.#options.registry();

    // Fails closed on truncation or provider outage — see resolveActivity.
    const { activity } = await resolveActivity({
      provider: this.#options.provider,
      registry,
      wallet: request.wallet,
      from: Math.floor(campaign.startsAt.getTime() / 1_000),
      to: nowSeconds,
      limit: this.#options.maxEventsPerWallet,
      ...(this.#options.rates ? { rates: this.#options.rates } : {}),
    });

    const result = evaluate(campaign.rule, {
      activity,
      campaign: {
        from: Math.floor(campaign.startsAt.getTime() / 1_000),
        to: Math.floor(campaign.endsAt.getTime() / 1_000),
      },
      now: nowSeconds,
      ...(campaign.limits ? { limits: campaign.limits } : {}),
    });

    const candidate: VerificationRecord = {
      id: newId("ver"),
      campaignId: campaign.id,
      wallet: activity.wallet,
      eligible: result.eligible,
      ruleHash: result.ruleHash,
      evidence: result.evidence,
      evidenceHash: result.evidenceHash,
      evaluatedAt: new Date(nowSeconds * 1_000),
      idempotencyKey,
    };

    const { record, created } = await store.insertVerificationIfAbsent(candidate);

    // A replayed request returns the attestation already issued, rather than
    // signing a second one over the same verification.
    if (!created) {
      const existing = await store.getAttestationByVerification(record.id);
      return {
        eligible: record.eligible,
        verificationId: record.id,
        ruleHash: record.ruleHash,
        evidence: record.evidence,
        evidenceHash: record.evidenceHash,
        ...(existing
          ? {
              attestation: {
                payload: existing.payload as never,
                signature: existing.signature,
              },
            }
          : {}),
        cached: true,
      };
    }

    if (!result.eligible) {
      // No attestation for a negative result: a signed "not eligible" would be
      // a durable, transferable statement about someone's wallet with no
      // upside — the caller already has the evidence.
      return {
        eligible: false,
        verificationId: record.id,
        ruleHash: record.ruleHash,
        evidence: record.evidence,
        evidenceHash: record.evidenceHash,
        cached: false,
      };
    }

    const attestation = await this.#sign(request.projectId, campaign, record, nowSeconds);

    return {
      eligible: true,
      verificationId: record.id,
      ruleHash: record.ruleHash,
      evidence: record.evidence,
      evidenceHash: record.evidenceHash,
      attestation,
      cached: false,
    };
  }

  async #sign(
    projectId: string,
    campaign: Campaign,
    record: VerificationRecord,
    nowSeconds: number,
  ): Promise<Attestation> {
    const key = await this.#options.store.getActiveSigningKey(projectId);
    if (!key) {
      throw new ApiError(
        500,
        "NO_SIGNING_KEY",
        `Project ${projectId} has no active signing key`,
        { retryable: false },
      );
    }

    const privateKey = unseal(
      {
        ciphertext: key.privateKeyCiphertext,
        iv: key.privateKeyIv,
        tag: key.privateKeyTag,
      },
      this.#options.masterKey,
    );

    const nonce = newNonce();
    const attestation = await signAttestation(
      {
        project: projectId,
        campaign: campaign.id,
        wallet: record.wallet,
        ruleHash: record.ruleHash,
        evidenceHash: record.evidenceHash,
        issuedAt: nowSeconds,
        nonce,
      },
      privateKey,
    );

    // Recorded before it is returned: the attestation table is the audit trail
    // for every dispute, and an attestation in a user's hands that this
    // service has no record of is unanswerable.
    await this.#options.store.insertAttestation({
      id: newId("att"),
      verificationId: record.id,
      signingKeyId: key.id,
      payload: attestation.payload as unknown as Record<string, unknown>,
      signature: attestation.signature,
      nonce,
      issuedAt: new Date(nowSeconds * 1_000),
      expiresAt: new Date((nowSeconds + DEFAULT_TTL_SECONDS) * 1_000),
    });

    return attestation;
  }
}

function assertCampaignOpen(campaign: Campaign, nowSeconds: number): void {
  if (campaign.status !== "active") {
    throw ApiError.conflict(
      "CAMPAIGN_NOT_ACTIVE",
      `Campaign ${campaign.id} is ${campaign.status}`,
    );
  }

  const now = nowSeconds * 1_000;
  if (now < campaign.startsAt.getTime()) {
    throw ApiError.conflict(
      "CAMPAIGN_NOT_STARTED",
      `Campaign ${campaign.id} starts at ${campaign.startsAt.toISOString()}`,
    );
  }
  if (now > campaign.endsAt.getTime()) {
    throw ApiError.conflict(
      "CAMPAIGN_ENDED",
      `Campaign ${campaign.id} ended at ${campaign.endsAt.toISOString()}`,
    );
  }
}

export { TonAttestError };
