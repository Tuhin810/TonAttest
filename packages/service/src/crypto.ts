import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * API keys.
 *
 * The key is shown once, at creation, and only its hash is stored — so a
 * database disclosure does not hand over the ability to act as every project.
 * scrypt is used rather than a plain SHA: an API key is a secret a human may
 * have reused, and cheap hashing turns a dump into an offline attack.
 */
const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 2 ** 14;

export interface GeneratedApiKey {
  readonly apiKey: string;
  readonly hash: string;
  readonly salt: string;
  /** Enough to recognise a key in a list without revealing it. */
  readonly hint: string;
}

export function generateApiKey(): GeneratedApiKey {
  const apiKey = `sk_${randomBytes(24).toString("base64url")}`;
  const salt = randomBytes(16).toString("hex");
  return {
    apiKey,
    salt,
    hash: hashApiKey(apiKey, salt),
    hint: `${apiKey.slice(0, 7)}…${apiKey.slice(-4)}`,
  };
}

export function hashApiKey(apiKey: string, salt: string): string {
  return scryptSync(apiKey, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST }).toString("hex");
}

/**
 * Compares in constant time. A timing-variable comparison here would leak the
 * stored hash a byte at a time to anyone able to measure responses.
 */
export function apiKeyMatches(apiKey: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(apiKey, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Envelope encryption for signing keys.
 *
 * Private keys never touch the database in the clear: the master key lives in
 * the environment, so a database backup on its own cannot forge attestations.
 * AES-256-GCM is authenticated, so a tampered ciphertext fails to decrypt
 * rather than yielding a subtly wrong key.
 */
export interface SealedSecret {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export function seal(plaintext: Uint8Array, masterKey: Uint8Array): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

export function unseal(sealed: SealedSecret, masterKey: Uint8Array): Uint8Array {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey,
    Buffer.from(sealed.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  return new Uint8Array(
    Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "hex")),
      decipher.final(),
    ]),
  );
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
