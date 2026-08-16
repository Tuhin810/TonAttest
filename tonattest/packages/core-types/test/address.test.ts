import { describe, expect, it } from "vitest";
import { addressEquals, normalizeAddress, NATIVE_TON } from "@tonattest/core-types";

// The STON.fi v1 router, in both spellings. A real mainnet pair, so a
// regression in the base64/CRC path shows up as a test failure rather than
// as silently-missing history in production.
const RAW = "0:779dcc815138d9500e449c5291e7f12738c23d575b5310000f6a253bd607384e";
const FRIENDLY = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";

describe("normalizeAddress", () => {
  it("passes raw addresses through, lowercased", () => {
    expect(normalizeAddress(`0:${RAW.slice(2).toUpperCase()}`)).toBe(RAW);
  });

  it("decodes a user-friendly address to raw form", () => {
    expect(normalizeAddress(FRIENDLY)).toBe(RAW);
  });

  it("treats the native-coin sentinel as its own asset", () => {
    expect(normalizeAddress(NATIVE_TON)).toBe(NATIVE_TON);
  });

  it("rejects a friendly address whose checksum does not match", () => {
    const corrupted = `${FRIENDLY.slice(0, 10)}X${FRIENDLY.slice(11)}`;
    expect(normalizeAddress(corrupted)).toBeNull();
  });

  it("rejects garbage rather than inventing an account", () => {
    expect(normalizeAddress("not-an-address")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress(null)).toBeNull();
  });

  it("handles negative workchains", () => {
    const masterchain = `-1:${"a".repeat(64)}`;
    expect(normalizeAddress(masterchain)).toBe(masterchain);
  });
});

describe("addressEquals", () => {
  it("matches the same account across spellings", () => {
    expect(addressEquals(RAW, FRIENDLY)).toBe(true);
  });

  it("does not treat two unparseable addresses as equal", () => {
    expect(addressEquals("garbage", "garbage")).toBe(false);
  });
});
