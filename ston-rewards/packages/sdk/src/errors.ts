/**
 * Error taxonomy.
 *
 * Every failure an integrator can hit is one of these, and each says plainly
 * whether retrying could help. The alternative — pattern-matching on message
 * text — is the thing that makes SDKs miserable to build on.
 */
export class StonRewardsSdkError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "StonRewardsSdkError";
    this.retryable = retryable;
  }
}

/** The API answered, and said no. `code` is stable; branch on it. */
export class ApiResponseError extends StonRewardsSdkError {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  }) {
    super(params.message, params.retryable);
    this.name = "ApiResponseError";
    this.status = params.status;
    this.code = params.code;
    this.details = params.details;
  }

  /** The wallet has more history than the service could fetch, or upstream is down. */
  get isTransient(): boolean {
    return this.retryable;
  }
}

/** The request never got an answer: DNS, TLS, timeout, offline device. */
export class NetworkError extends StonRewardsSdkError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, true, options);
    this.name = "NetworkError";
  }
}

/** The caller passed something this SDK can reject without a round trip. */
export class InvalidInputError extends StonRewardsSdkError {
  constructor(message: string) {
    super(message, false);
    this.name = "InvalidInputError";
  }
}
