import * as ed from "@noble/ed25519";
import { canonicalize } from "@ston-rewards/rules";

/**
 * Signed attestations.
 *
 * The design stance is that an integrating app should never have to trust a
 * live response: an attestation is verifiable offline, against a public key
 * the app can pin, using only canonical JSON and Ed25519. Both are specified
 * in ways any language can implement, so nothing here is reachable only from
 * TypeScript.
 */

export const ATTESTATION_VERSION = 1;

export interface AttestationPayload {
  /** Format version. Verifiers reject versions they do not know, loudly. */
  readonly v: number;
  readonly project: string;
  readonly campaign: string;
  readonly wallet: string;
  readonly rule_hash: string;
  readonly eligible: true;
  readonly evidence_hash: string;
  readonly issued_at: number;
  readonly expires_at: number;
  /** Single-use marker. The consuming app records spent nonces. */
  readonly nonce: string;
}

export interface Attestation {
  readonly payload: AttestationPayload;
  /** Hex-encoded Ed25519 signature over the payload's canonical JSON. */
  readonly signature: string;
}

export interface SignOptions {
  readonly project: string;
  readonly campaign: string;
  readonly wallet: string;
  readonly ruleHash: string;
  readonly evidenceHash: string;
  /** Unix seconds. */
  readonly issuedAt: number;
  /** Lifetime in seconds. Short by default — see {@link DEFAULT_TTL_SECONDS}. */
  readonly ttlSeconds?: number;
  readonly nonce: string;
}

/**
 * One hour. Long enough for a user to finish a claim flow, short enough that a
 * leaked attestation is not a standing licence to collect a reward.
 */
export const DEFAULT_TTL_SECONDS = 3_600;

/**
 * Attestations are only ever issued for a positive result.
 *
 * A signed "not eligible" would be a durable, transferable statement about
 * someone's wallet, with no upside: an app that needs to know about a failure
 * already has the evidence in the verification response.
 */
export async function signAttestation(
  options: SignOptions,
  privateKey: Uint8Array,
): Promise<Attestation> {
  const payload: AttestationPayload = {
    v: ATTESTATION_VERSION,
    project: options.project,
    campaign: options.campaign,
    wallet: options.wallet,
    rule_hash: options.ruleHash,
    eligible: true,
    evidence_hash: options.evidenceHash,
    issued_at: options.issuedAt,
    expires_at: options.issuedAt + (options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    nonce: options.nonce,
  };

  const signature = await ed.signAsync(signingBytes(payload), privateKey);
  return { payload, signature: toHex(signature) };
}

export interface VerifyOptions {
  /** Unix seconds; defaults to now. Expiry is checked unless disabled. */
  readonly now?: number;
  /**
   * Skip the expiry check. Only for re-verifying a historical attestation
   * during a dispute — never on a live claim path.
   */
  readonly ignoreExpiry?: boolean;
}

export type VerifyFailure =
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "expired";

export type VerifyResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: VerifyFailure; readonly detail: string };

/**
 * Verifies an attestation offline. No network, no clock authority beyond the
 * caller's own `now`, no dependency on the issuing service being reachable.
 */
export async function verifyAttestation(
  attestation: unknown,
  publicKey: Uint8Array | string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const parsed = parseAttestation(attestation);
  if (!parsed) {
    return { valid: false, reason: "malformed", detail: "not a well-formed attestation" };
  }

  if (parsed.payload.v !== ATTESTATION_VERSION) {
    // Never accept an unknown version by guessing. A future format may mean
    // something materially different by the same field names.
    return {
      valid: false,
      reason: "unsupported_version",
      detail: `attestation version ${parsed.payload.v} is not supported by this verifier ` +
        `(expected ${ATTESTATION_VERSION})`,
    };
  }

  const key = typeof publicKey === "string" ? fromHex(publicKey) : publicKey;

  let signatureOk: boolean;
  try {
    signatureOk = await ed.verifyAsync(
      fromHex(parsed.signature),
      signingBytes(parsed.payload),
      key,
    );
  } catch {
    signatureOk = false;
  }

  if (!signatureOk) {
    return { valid: false, reason: "bad_signature", detail: "signature does not verify" };
  }

  // Signature is checked before expiry so a tampered payload can never be
  // reported as merely stale.
  if (!options.ignoreExpiry) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (now > parsed.payload.expires_at) {
      return {
        valid: false,
        reason: "expired",
        detail: `expired at ${parsed.payload.expires_at}, now ${now}`,
      };
    }
  }

  return { valid: true };
}

/** The exact bytes that are signed: canonical JSON of the payload, as UTF-8. */
export function signingBytes(payload: AttestationPayload): Uint8Array {
  return new TextEncoder().encode(canonicalize(payload));
}

export interface Keypair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export async function generateKeypair(): Promise<Keypair> {
  const privateKey = ed.utils.randomPrivateKey();
  return { privateKey, publicKey: await ed.getPublicKeyAsync(privateKey) };
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new TypeError("Not a hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function parseAttestation(value: unknown): Attestation | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof record["signature"] !== "string") return null;
  if (typeof payload !== "object" || payload === null) return null;

  const p = payload as Record<string, unknown>;
  const shapeOk =
    typeof p["v"] === "number" &&
    typeof p["project"] === "string" &&
    typeof p["campaign"] === "string" &&
    typeof p["wallet"] === "string" &&
    typeof p["rule_hash"] === "string" &&
    p["eligible"] === true &&
    typeof p["evidence_hash"] === "string" &&
    typeof p["issued_at"] === "number" &&
    typeof p["expires_at"] === "number" &&
    typeof p["nonce"] === "string";

  return shapeOk ? (value as Attestation) : null;
}
