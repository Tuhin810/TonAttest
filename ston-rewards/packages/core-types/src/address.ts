/**
 * Address handling.
 *
 * TON addresses have three interchangeable spellings for the same account
 * (raw `0:hex`, bounceable base64, non-bounceable base64). Comparing them as
 * strings is the classic way to silently miss half a wallet's history, so
 * every address that crosses a package boundary is normalized first.
 *
 * Normalization here is deliberately format-preserving-free: we reduce to the
 * raw `workchain:hex` form, which is canonical and comparison-safe.
 */

const RAW_RE = /^(-?\d+):([0-9a-fA-F]{64})$/;
const BASE64_RE = /^[A-Za-z0-9_/+-]{48}$/;

/** The sentinel used for the native coin throughout the system. */
export const NATIVE_TON = "TON";

export function isRawAddress(value: string): boolean {
  return RAW_RE.test(value);
}

/**
 * Reduces an address to canonical raw form. Returns `null` for anything
 * unparseable — callers decide whether that is a skip or a hard error.
 */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === NATIVE_TON) return NATIVE_TON;

  const raw = RAW_RE.exec(trimmed);
  if (raw) return `${raw[1]}:${raw[2]!.toLowerCase()}`;

  if (BASE64_RE.test(trimmed)) {
    const decoded = decodeFriendly(trimmed);
    if (decoded) return decoded;
  }
  return null;
}

/**
 * Decodes a user-friendly base64 address to raw form.
 *
 * Layout: [tag:1][workchain:1][hash:32][crc16:2]. The CRC is verified — a
 * mistyped address that decodes to a *different valid-looking* account is
 * exactly the bug that would attribute one user's swaps to another.
 */
function decodeFriendly(value: string): string | null {
  const bytes = base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/"));
  if (!bytes || bytes.length !== 36) return null;

  const expected = crc16Xmodem(bytes.subarray(0, 34));
  const actual = (bytes[34]! << 8) | bytes[35]!;
  if (expected !== actual) return null;

  const workchainByte = bytes[1]!;
  const workchain = workchainByte === 0xff ? -1 : workchainByte;
  const hash = Array.from(bytes.subarray(2, 34))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${workchain}:${hash}`;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary =
      typeof atob === "function"
        ? atob(value)
        : Buffer.from(value, "base64").toString("binary");
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/** True when two addresses refer to the same account in any spelling. */
export function addressEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  return na !== null && na === nb;
}
