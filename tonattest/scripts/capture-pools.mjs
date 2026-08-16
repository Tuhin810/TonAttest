/**
 * Captures the slice of the STON.fi pool registry that the golden fixtures
 * actually need, so fixture tests run hermetically and in milliseconds.
 *
 * The full registry is ~47,500 pools; committing it would be tens of
 * megabytes and would churn on every run. This keeps only pools whose two
 * assets both appear in the captured events.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const FIXTURES = new URL("../packages/decoder/test/fixtures/", import.meta.url);

// Every spelling of native TON. Kept in step with core-types/src/address.ts.
const TON_SPELLINGS = new Set([
  "0:0000000000000000000000000000000000000000000000000000000000000000",
  "0:8cdc1d7640ad5ee326527fc1ad0514f468b30dc84b0173f0e155f451b4e11f7c",
  "0:729c13b6df2c07cbf0a06ab63d34af454f3d320ec1bcd8fb5c6d24d0806a17c2",
]);

function rawAddress(friendly) {
  const bytes = Buffer.from(friendly.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length !== 36) return null;
  const workchain = bytes[1] === 0xff ? -1 : bytes[1];
  return `${workchain}:${bytes.subarray(2, 34).toString("hex")}`;
}

const seen = new Set(TON_SPELLINGS);
function collect(value) {
  if (typeof value === "string" && /^-?\d+:[0-9a-f]{64}$/i.test(value)) {
    seen.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    value.forEach(collect);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(collect);
  }
}

const names = readdirSync(FIXTURES).filter((f) => f.endsWith(".json") && f !== "pools.json");
for (const name of names) {
  collect(JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")));
}

const res = await fetch("https://api.ston.fi/v1/pools");
if (!res.ok) {
  console.error(`api.ston.fi returned ${res.status}`);
  process.exit(1);
}
const { pool_list: all } = await res.json();

const kept = all.filter((pool) => {
  const t0 = rawAddress(pool.token0_address);
  const t1 = rawAddress(pool.token1_address);
  return t0 && t1 && seen.has(t0) && seen.has(t1);
});

writeFileSync(
  new URL("pools.json", FIXTURES),
  `${JSON.stringify({ capturedAt: new Date().toISOString(), pool_list: kept }, null, 2)}\n`,
);
console.log(`kept ${kept.length} of ${all.length} pools across ${names.length} fixtures`);
