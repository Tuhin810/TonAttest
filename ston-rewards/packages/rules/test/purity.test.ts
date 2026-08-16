import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The rules engine and the attestation module must not reach the network or a
 * database, directly or transitively.
 *
 * This is what makes evaluation deterministic and a disputed result
 * re-derivable offline: the same (rule, activity) pair always produces the
 * same evidence, because there is nothing else it could depend on. Enforced
 * here rather than by convention, because the failure is silent — an import
 * added in a hurry would not break any other test.
 */
const FORBIDDEN = [
  "@ston-rewards/data-provider",
  "@ston-rewards/activity",
  "@ston-rewards/decoder",
  "node:http",
  "node:https",
  "node:fs",
  "node:net",
];

const PACKAGES = ["rules", "attest"];

function sourceFiles(pkg: string): { path: string; body: string }[] {
  const dir = new URL(`../../${pkg}/src/`, import.meta.url);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      path: `${pkg}/src/${name}`,
      body: readFileSync(new URL(name, dir), "utf8"),
    }));
}

describe("purity of the evaluation path", () => {
  it.each(PACKAGES)("%s imports nothing that does IO", (pkg) => {
    const offenders: string[] = [];

    for (const file of sourceFiles(pkg)) {
      for (const forbidden of FORBIDDEN) {
        if (file.body.includes(`"${forbidden}"`)) {
          offenders.push(`${file.path} imports ${forbidden}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it.each(PACKAGES)("%s never calls fetch", (pkg) => {
    const offenders = sourceFiles(pkg)
      .filter((file) => /\bfetch\s*\(/.test(file.body))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it.each(PACKAGES)("%s reads no ambient clock", (pkg) => {
    // Evaluation time arrives as an argument. A hidden Date.now() would make
    // the same inputs produce different evidence on a later run.
    //
    // One documented exception: attestation verification defaults `now` to the
    // wall clock when the caller does not supply one. That is a freshness
    // check on an already-signed artifact, not an input to evaluation, and the
    // caller can always pass `now` explicitly to keep it deterministic.
    const offenders = sourceFiles(pkg)
      .filter((file) => /Date\.now\(\)/.test(file.body))
      .filter((file) => !file.path.endsWith("attestation.ts"))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });
});
