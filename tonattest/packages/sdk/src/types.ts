import type { Attestation } from "@tonattest/attest";
import type { Evidence, Rule } from "@tonattest/rules";

export interface CampaignLimits {
  /** Ceiling on rewardable volume per wallet, in token units, as a string. */
  readonly maxRewardableVolumePerWallet?: string;
  /** Minimum gap between two actions that both count, e.g. "1h". */
  readonly minInterval?: string;
  /** Ignore wallets younger than this, e.g. "30d". */
  readonly minWalletAge?: string;
}

export interface CreateCampaignInput {
  readonly name: string;
  readonly rule: Rule;
  readonly limits?: CampaignLimits;
  readonly startsAt: Date | string;
  readonly endsAt: Date | string;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly rule: Rule;
  /** Binds attestations to the exact rule that produced them. */
  readonly ruleHash: string;
  readonly limits: CampaignLimits | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: "active" | "paused" | "ended";
}

export interface VerifyInput {
  readonly wallet: string;
  readonly campaignId: string;
}

export interface VerifyResult {
  readonly eligible: boolean;
  readonly verificationId: string;
  readonly ruleHash: string;
  /** Present only when eligible. Verify it offline before acting on it. */
  readonly attestation?: Attestation;
  /**
   * Why the answer is what it is, down to contributing transactions. Produced
   * on failure as well as success — show it to the user.
   */
  readonly evidence: Evidence;
  readonly evidenceHash: string;
  /** True when the service replayed a stored result rather than re-evaluating. */
  readonly cached: boolean;
}

export interface PublicKeyInfo {
  readonly id: string;
  readonly publicKey: string;
  readonly algorithm: "ed25519";
  readonly createdAt: string;
  /** Non-null for rotated keys, which stay published so old proofs verify. */
  readonly retiredAt: string | null;
}
