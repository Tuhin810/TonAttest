/**
 * Minimal Prometheus-format metrics.
 *
 * Hand-rolled rather than pulled in as a dependency: the surface needed is
 * four counters and one histogram, and the exposition format is stable. What
 * matters is that the numbers exist from the first deploy — instrumentation
 * retrofitted is instrumentation never done.
 */
export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #histograms = new Map<string, number[]>();

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = seriesKey(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + by);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = seriesKey(name, labels);
    const samples = this.#histograms.get(key) ?? [];
    samples.push(value);
    // Bounded so a long-running process cannot grow without limit.
    if (samples.length > 10_000) samples.shift();
    this.#histograms.set(key, samples);
  }

  /** Convenience for the one number the team will actually be asked about. */
  quantile(name: string, q: number, labels: Record<string, string> = {}): number | null {
    const samples = this.#histograms.get(seriesKey(name, labels));
    if (!samples || samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[index]!;
  }

  render(): string {
    const lines: string[] = [];

    for (const [key, value] of this.#counters) {
      lines.push(`${key} ${value}`);
    }

    for (const [key, samples] of this.#histograms) {
      const sorted = [...samples].sort((a, b) => a - b);
      const sum = sorted.reduce((total, sample) => total + sample, 0);
      const { name, labelPart } = splitKey(key);

      for (const q of [0.5, 0.95, 0.99]) {
        const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
        lines.push(`${name}${withQuantile(labelPart, q)} ${sorted[index] ?? 0}`);
      }
      lines.push(`${name}_sum${labelPart} ${sum}`);
      lines.push(`${name}_count${labelPart} ${sorted.length}`);
    }

    return `${lines.join("\n")}\n`;
  }
}

function seriesKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return name;
  const rendered = entries.map(([k, v]) => `${k}="${escape(v)}"`).join(",");
  return `${name}{${rendered}}`;
}

function splitKey(key: string): { name: string; labelPart: string } {
  const brace = key.indexOf("{");
  return brace === -1
    ? { name: key, labelPart: "" }
    : { name: key.slice(0, brace), labelPart: key.slice(brace) };
}

function withQuantile(labelPart: string, q: number): string {
  if (labelPart === "") return `{quantile="${q}"}`;
  return `${labelPart.slice(0, -1)},quantile="${q}"}`;
}

function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export const METRIC = {
  verifyDuration: "ston_verify_duration_seconds",
  verifyTotal: "ston_verify_total",
  attestationsIssued: "ston_attestations_issued_total",
  providerErrors: "ston_provider_errors_total",
  unknownActions: "ston_unknown_actions_total",
  rateLimited: "ston_rate_limited_total",
  httpRequests: "ston_http_requests_total",
} as const;
