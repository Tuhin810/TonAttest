import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_VERSION,
  DEFAULT_TTL_SECONDS,
  fromHex,
  generateKeypair,
  signAttestation,
  signingBytes,
  toHex,
  verifyAttestation,
  type Attestation,
} from "../src/attestation.js";

const NOW = 1_800_000_000;

const BASE = {
  project: "prj_abc",
  campaign: "cmp_xyz",
  wallet: `0:${"cc".repeat(32)}`,
  ruleHash: `sha256:${"a".repeat(64)}`,
  evidenceHash: `sha256:${"b".repeat(64)}`,
  issuedAt: NOW,
  nonce: "nonce-1",
};

async function issue(overrides: Partial<typeof BASE> = {}) {
  const keys = await generateKeypair();
  const attestation = await signAttestation({ ...BASE, ...overrides }, keys.privateKey);
  return { keys, attestation };
}

describe("signAttestation", () => {
  it("produces a payload matching the documented format", async () => {
    const { attestation } = await issue();
    expect(attestation.payload).toEqual({
      v: ATTESTATION_VERSION,
      project: "prj_abc",
      campaign: "cmp_xyz",
      wallet: BASE.wallet,
      rule_hash: BASE.ruleHash,
      eligible: true,
      evidence_hash: BASE.evidenceHash,
      issued_at: NOW,
      expires_at: NOW + DEFAULT_TTL_SECONDS,
      nonce: "nonce-1",
    });
  });

  it("defaults to a one-hour lifetime", async () => {
    // Long enough to finish a claim, short enough that a leaked attestation is
    // not a standing licence to collect a reward.
    const { attestation } = await issue();
    expect(attestation.payload.expires_at - attestation.payload.issued_at).toBe(3_600);
  });

  it("honours an explicit TTL", async () => {
    const keys = await generateKeypair();
    const attestation = await signAttestation({ ...BASE, ttlSeconds: 60 }, keys.privateKey);
    expect(attestation.payload.expires_at).toBe(NOW + 60);
  });

  it("emits a hex signature of the right length", async () => {
    const { attestation } = await issue();
    expect(attestation.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it("produces different signatures for different nonces", async () => {
    const keys = await generateKeypair();
    const a = await signAttestation({ ...BASE, nonce: "one" }, keys.privateKey);
    const b = await signAttestation({ ...BASE, nonce: "two" }, keys.privateKey);
    expect(a.signature).not.toBe(b.signature);
  });
});

describe("verifyAttestation", () => {
  it("accepts a freshly signed attestation", async () => {
    const { keys, attestation } = await issue();
    await expect(verifyAttestation(attestation, keys.publicKey, { now: NOW })).resolves.toEqual({
      valid: true,
    });
  });

  it("accepts a hex-encoded public key, for keys pinned as text", async () => {
    const { keys, attestation } = await issue();
    const result = await verifyAttestation(attestation, toHex(keys.publicKey), { now: NOW });
    expect(result.valid).toBe(true);
  });

  it("rejects a signature from the wrong key", async () => {
    const { attestation } = await issue();
    const other = await generateKeypair();
    await expect(
      verifyAttestation(attestation, other.publicKey, { now: NOW }),
    ).resolves.toMatchObject({ valid: false, reason: "bad_signature" });
  });

  it.each([
    ["wallet", `0:${"dd".repeat(32)}`],
    ["campaign", "cmp_other"],
    ["evidence_hash", `sha256:${"c".repeat(64)}`],
    ["expires_at", NOW + 999_999],
  ])("rejects a payload with a tampered %s", async (field, value) => {
    const { keys, attestation } = await issue();
    const tampered = {
      ...attestation,
      payload: { ...attestation.payload, [field]: value },
    };
    await expect(
      verifyAttestation(tampered, keys.publicKey, { now: NOW }),
    ).resolves.toMatchObject({ valid: false, reason: "bad_signature" });
  });

  it("reports a tampered payload as a bad signature, never as merely stale", async () => {
    // Extending expiry must not downgrade the failure to "expired".
    const { keys, attestation } = await issue();
    const tampered = {
      ...attestation,
      payload: { ...attestation.payload, expires_at: 1 },
    };
    const result = await verifyAttestation(tampered, keys.publicKey, { now: NOW });
    expect(result).toMatchObject({ reason: "bad_signature" });
  });

  it("rejects an expired attestation", async () => {
    const { keys, attestation } = await issue();
    await expect(
      verifyAttestation(attestation, keys.publicKey, { now: NOW + 7_200 }),
    ).resolves.toMatchObject({ valid: false, reason: "expired" });
  });

  it("accepts an attestation exactly at its expiry second", async () => {
    const { keys, attestation } = await issue();
    const result = await verifyAttestation(attestation, keys.publicKey, {
      now: attestation.payload.expires_at,
    });
    expect(result.valid).toBe(true);
  });

  it("can ignore expiry when re-checking a historical attestation", async () => {
    const { keys, attestation } = await issue();
    const result = await verifyAttestation(attestation, keys.publicKey, {
      now: NOW + 999_999,
      ignoreExpiry: true,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an unknown version rather than guessing at its meaning", async () => {
    const { keys, attestation } = await issue();
    const future = { ...attestation, payload: { ...attestation.payload, v: 99 } };
    await expect(
      verifyAttestation(future, keys.publicKey, { now: NOW }),
    ).resolves.toMatchObject({ valid: false, reason: "unsupported_version" });
  });

  it.each([
    null,
    "not an attestation",
    {},
    { payload: {}, signature: "aa" },
    { payload: { v: 1 }, signature: 42 },
  ])("rejects malformed input %s without throwing", async (input) => {
    const keys = await generateKeypair();
    await expect(verifyAttestation(input, keys.publicKey, { now: NOW })).resolves.toMatchObject({
      valid: false,
      reason: "malformed",
    });
  });

  it("rejects a non-hex signature without throwing", async () => {
    const { keys, attestation } = await issue();
    const broken: Attestation = { ...attestation, signature: "zzzz" };
    await expect(
      verifyAttestation(broken, keys.publicKey, { now: NOW }),
    ).resolves.toMatchObject({ valid: false, reason: "bad_signature" });
  });
});

describe("cross-implementation verification", () => {
  it("verifies with Node's own crypto, not just @noble/ed25519", async () => {
    // The whole point of signing canonical JSON with Ed25519 is that any
    // language can verify it. If only our own library agrees, the guarantee
    // we advertise to integrators does not exist.
    const { keys, attestation } = await issue();

    // Wrap the raw public key as SPKI so Node's crypto will accept it.
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(keys.publicKey),
    ]);
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });

    const ok = nodeVerify(
      null,
      Buffer.from(signingBytes(attestation.payload)),
      publicKey,
      Buffer.from(fromHex(attestation.signature)),
    );

    expect(ok).toBe(true);
  });

  it("signs bytes that an independent canonicalizer can reproduce", async () => {
    const { attestation } = await issue();
    const p = attestation.payload;

    // Hand-written canonical JSON: keys in sorted order, no whitespace.
    const expected =
      `{"campaign":${JSON.stringify(p.campaign)},"eligible":true,` +
      `"evidence_hash":${JSON.stringify(p.evidence_hash)},` +
      `"expires_at":${p.expires_at},"issued_at":${p.issued_at},` +
      `"nonce":${JSON.stringify(p.nonce)},"project":${JSON.stringify(p.project)},` +
      `"rule_hash":${JSON.stringify(p.rule_hash)},"v":${p.v},` +
      `"wallet":${JSON.stringify(p.wallet)}}`;

    expect(new TextDecoder().decode(signingBytes(p))).toBe(expected);
  });

  it("keeps the signed digest stable for a fixed payload", async () => {
    // Pins the byte layout: any change to canonicalization breaks this,
    // which is the point — it would invalidate every attestation in the wild.
    const keys = await generateKeypair();
    const attestation = await signAttestation(BASE, keys.privateKey);
    const digest = createHash("sha256")
      .update(signingBytes(attestation.payload))
      .digest("hex");

    expect(digest).toBe(
      createHash("sha256")
        .update(
          '{"campaign":"cmp_xyz","eligible":true,"evidence_hash":"sha256:' +
            "b".repeat(64) +
            '","expires_at":1800003600,"issued_at":1800000000,"nonce":"nonce-1",' +
            '"project":"prj_abc","rule_hash":"sha256:' +
            "a".repeat(64) +
            '","v":1,"wallet":"0:' +
            "cc".repeat(32) +
            '"}',
        )
        .digest("hex"),
    );
  });
});

describe("hex helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 15, 16, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("rejects odd-length or non-hex input", () => {
    expect(() => fromHex("abc")).toThrow(/hex/);
    expect(() => fromHex("zz")).toThrow(/hex/);
  });
});
