import { TonAttestError } from "@tonattest/core-types";

export interface RetryOptions {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  attempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/**
 * Fetch with bounded exponential backoff and full jitter.
 *
 * Retries only on transport errors and 429/5xx. A 4xx other than 429 is a
 * request bug on our side and retrying it just burns the provider's rate
 * budget, so it fails immediately.
 */
export async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  retry: RetryOptions = DEFAULT_RETRY,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt < retry.attempts; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt, retry));

    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (cause) {
      lastError = new TonAttestError(
        "PROVIDER_UNAVAILABLE",
        `Request to ${redact(url)} failed`,
        { cause },
      );
      continue;
    }

    if (res.status === 429) {
      lastError = new TonAttestError(
        "PROVIDER_RATE_LIMITED",
        `Rate limited by ${redact(url)}`,
      );
      continue;
    }

    if (res.status >= 500) {
      lastError = new TonAttestError(
        "PROVIDER_UNAVAILABLE",
        `${redact(url)} returned ${res.status}`,
      );
      continue;
    }

    if (!res.ok) {
      throw new TonAttestError(
        "PROVIDER_MALFORMED_RESPONSE",
        `${redact(url)} returned ${res.status}`,
        { retryable: false },
      );
    }

    try {
      return await res.json();
    } catch (cause) {
      throw new TonAttestError(
        "PROVIDER_MALFORMED_RESPONSE",
        `${redact(url)} returned unparseable JSON`,
        { retryable: false, cause },
      );
    }
  }

  throw lastError ??
    new TonAttestError("PROVIDER_UNAVAILABLE", `${redact(url)} exhausted retries`);
}

function backoffDelay(attempt: number, retry: RetryOptions): number {
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strips query strings so API keys never reach a log line. */
function redact(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}
