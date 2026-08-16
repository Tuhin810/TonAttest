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

/**
 * Addresses that all mean "native TON" depending on who is speaking.
 *
 * Three sources spell the same asset three ways: chain events name a pTON
 * (proxy-TON) jetton master, because a DEX pool can only hold jettons; the
 * STON.fi pool list uses the zero address; and this system uses the {@link
 * NATIVE_TON} sentinel. Comparing them literally means a TON leg never matches
 * the TON side of its own pool — which is why swap-to-pool attribution fails
 * without this table.
 */
const TON_EQUIVALENT_MASTERS: ReadonlySet<string> = new Set([
  // Zero address, as used by the STON.fi pool list.
  `0:${"00".repeat(32)}`,
  // pTON v1.
  "0:8cdc1d7640ad5ee326527fc1ad0514f468b30dc84b0173f0e155f451b4e11f7c",
  // pTON v2.
  "0:729c13b6df2c07cbf0a06ab63d34af454f3d320ec1bcd8fb5c6d24d0806a17c2",
]);

/**
 * Reduces an asset reference to its canonical form, collapsing every spelling
 * of native TON onto {@link NATIVE_TON}.
 *
 * Returns `null` for anything unparseable — an asset we cannot name is one we
 * must not silently treat as some other asset.
 */
export function canonicalAsset(value: string | null | undefined): string | null {
  const normalized = normalizeAddress(value);
  if (normalized === null) return null;
  return TON_EQUIVALENT_MASTERS.has(normalized) ? NATIVE_TON : normalized;
}

/** True when the address refers to native TON in any of its spellings. */
export function isNativeTon(value: string | null | undefined): boolean {
  return canonicalAsset(value) === NATIVE_TON;
}
