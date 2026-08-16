import { createHash } from "node:crypto";

/**
 * Idempotency key for a verification.
 *
 * Derived from the request rather than supplied by the client, because the
 * failure it guards against is a double-tapped claim button — and a client
 * that double-taps will happily send two different client-generated keys.
 *
 * The rule hash is included so that editing a campaign's rule cannot silently
 * reuse a verification performed under the old rule. The time bucket bounds
 * how long a result is reused: within a bucket a retry returns the identical
 * attestation, and after it a genuine re-verification happens.
 */
export function verificationIdempotencyKey(params: {
  readonly projectId: string;
  readonly campaignId: string;
  readonly wallet: string;
  readonly ruleHash: string;
  readonly now: number;
  readonly bucketSeconds: number;
}): string {
  const bucket = Math.floor(params.now / params.bucketSeconds);
  const material = [
    params.projectId,
    params.campaignId,
    params.wallet,
    params.ruleHash,
    String(bucket),
  ].join("|");

  return createHash("sha256").update(material, "utf8").digest("hex");
}
