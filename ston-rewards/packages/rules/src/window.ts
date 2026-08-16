import { StonRewardsError } from "@ston-rewards/core-types";
import type { Window } from "./types.js";

/**
 * Durations are written the way people say them — "7d", "12h", "30m" — because
 * a rule is read far more often than it is written, and `604800` is a support
 * ticket waiting to happen.
 */
const DURATION_RE = /^(\d+)(s|m|h|d|w)$/;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
};

/** The literal window meaning "since the campaign started". */
export const CAMPAIGN_WINDOW = "campaign";

export function parseDuration(value: string): number {
  const match = DURATION_RE.exec(value);
  const unit = match?.[2];
  if (!match || !unit) {
    throw new StonRewardsError(
      "INVALID_RULE",
      `Not a duration: ${JSON.stringify(value)}. Expected a number followed by ` +
        `s, m, h, d, or w — for example "7d".`,
      { retryable: false },
    );
  }
  return Number(match[1]) * UNIT_SECONDS[unit]!;
}

export function isDuration(value: string): boolean {
  return DURATION_RE.test(value);
}

export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

/**
 * Resolves a condition's window against the campaign's.
 *
 * A relative window is measured back from `now`, never from the campaign end:
 * "swapped $100 in the last 7 days" has to mean the 7 days leading up to the
 * moment of verification, or a user could satisfy it and then let it lapse.
 * The result is always clamped to the campaign, so no condition can reach
 * back to activity that predates it.
 */
export function resolveWindow(
  window: Window | undefined,
  campaign: TimeWindow,
  now: number,
): TimeWindow {
  const to = Math.min(now, campaign.to);
  if (window === undefined || window === CAMPAIGN_WINDOW) {
    return { from: campaign.from, to };
  }
  return { from: Math.max(campaign.from, to - parseDuration(window)), to };
}

export function withinWindow(occurredAt: number, window: TimeWindow): boolean {
  return occurredAt >= window.from && occurredAt <= window.to;
}
