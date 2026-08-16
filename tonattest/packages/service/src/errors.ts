import { TonAttestError, type TonAttestErrorCode } from "@tonattest/core-types";

/**
 * Typed API errors.
 *
 * Every failure the client can see carries a stable `code` and an explicit
 * `retryable` flag, so an integrator can branch on the failure rather than
 * pattern-matching on prose. Nothing here ever degrades into a wrong answer:
 * the service fails loudly instead of issuing an attestation it cannot stand
 * behind.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    opts: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = opts.retryable ?? statusCode >= 500;
    this.details = opts.details;
  }

  static unauthorized(message = "Missing or invalid API key"): ApiError {
    return new ApiError(401, "UNAUTHORIZED", message, { retryable: false });
  }

  static notFound(what: string): ApiError {
    return new ApiError(404, "NOT_FOUND", `${what} not found`, { retryable: false });
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, "BAD_REQUEST", message, { retryable: false, details });
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message, { retryable: false });
  }

  static rateLimited(retryAfterSeconds: number): ApiError {
    return new ApiError(429, "RATE_LIMITED", "Too many requests", {
      retryable: true,
      details: { retryAfterSeconds },
    });
  }
}

/**
 * Maps a domain error onto HTTP.
 *
 * The important case is data resolution: when activity cannot be resolved
 * completely, this becomes a 503, never a 200 with `eligible: false`. A false
 * negative is a support ticket; a false positive is a payout the integrating
 * app cannot claw back, and silently evaluating partial data eventually
 * produces both.
 */
const STATUS_BY_CODE: Record<TonAttestErrorCode, number> = {
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_RATE_LIMITED: 503,
  PROVIDER_MALFORMED_RESPONSE: 502,
  POOL_REGISTRY_UNAVAILABLE: 503,
  DECODE_FAILED: 502,
  INVALID_RULE: 400,
  INVALID_ADDRESS: 400,
  STALE_ACTIVITY: 503,
};

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof TonAttestError) {
    return new ApiError(STATUS_BY_CODE[error.code] ?? 500, error.code, error.message, {
      retryable: error.retryable,
    });
  }

  // Anything unrecognised is a bug in this service. The client gets a stable
  // shape and no internals; the log gets the original.
  return new ApiError(500, "INTERNAL", "Internal server error", { retryable: true });
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: unknown;
  };
}

export function errorBody(error: ApiError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
