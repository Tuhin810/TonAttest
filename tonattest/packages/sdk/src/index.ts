/**
 * @tonattest/sdk
 *
 * Define reward rules over verified STON.fi activity, and receive a signed
 * attestation that a wallet satisfied one. Your app decides what the reward
 * is — this never holds or moves funds.
 *
 * Runs in Node, browsers, Telegram Mini Apps, and edge runtimes: nothing in
 * here reaches for a Node built-in.
 */
export { TonAttest, type TonAttestOptions } from "./client.js";

export {
  ApiResponseError,
  InvalidInputError,
  NetworkError,
  TonAttestSdkError,
} from "./errors.js";

export type {
  Campaign,
  CampaignLimits,
  CreateCampaignInput,
  PublicKeyInfo,
  VerifyInput,
  VerifyResult,
} from "./types.js";

/**
 * Rule builders. These produce plain JSON, so a rule can be stored, sent, and
 * re-evaluated years later by something that never imports this package.
 */
export {
  all,
  any,
  lpAdd,
  lpHold,
  swap,
  ruleHash,
  validateRule,
  isValidRule,
  type Rule,
  type Evidence,
  type EvidenceNode,
} from "@tonattest/rules";

/**
 * Offline attestation verification. No network, no trust in the service that
 * issued it — check the signature against a public key you pinned.
 */
export {
  verifyAttestation,
  ATTESTATION_VERSION,
  type Attestation,
  type AttestationPayload,
  type VerifyResult as AttestationVerifyResult,
} from "@tonattest/attest";
