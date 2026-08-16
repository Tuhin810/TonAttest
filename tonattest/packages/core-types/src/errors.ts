/**
 * Typed errors shared across packages. `retryable` drives client backoff and
 * the service's fail-closed behaviour: when activity data cannot be resolved
 * we surface a retryable error rather than evaluate against partial data.
 * A false negative is a support ticket; a false positive is a payout the
 * integrating app cannot claw back.
 */
export type TonAttestErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_MALFORMED_RESPONSE"
  | "POOL_REGISTRY_UNAVAILABLE"
  | "DECODE_FAILED"
  | "INVALID_RULE"
  | "INVALID_ADDRESS"
  | "STALE_ACTIVITY";

export class TonAttestError extends Error {
  readonly code: TonAttestErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: TonAttestErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "TonAttestError";
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE.has(code);
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

const DEFAULT_RETRYABLE = new Set<TonAttestErrorCode>([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "POOL_REGISTRY_UNAVAILABLE",
  "STALE_ACTIVITY",
]);
