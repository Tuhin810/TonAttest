/**
 * Captures a real mainnet event as a golden fixture.
 *
 *   node scripts/capture-fixture.mjs <eventId> <wallet> <name>
 *
 * Fixtures pin the decoder to observed chain behaviour: without them a STON.fi
 * contract change or a provider schema change fails silently in production
 * instead of failing in CI.
 */
import { writeFileSync } from "node:fs";

const [eventId, wallet, name] = process.argv.slice(2);
if (!eventId || !wallet || !name) {
  console.error("usage: capture-fixture.mjs <eventId> <wallet> <name>");
  process.exit(2);
}

const res = await fetch(`https://tonapi.io/v2/events/${eventId}`, {
  headers: process.env.TONAPI_KEY
    ? { Authorization: `Bearer ${process.env.TONAPI_KEY}` }
    : {},
});
if (!res.ok) {
  console.error(`tonapi returned ${res.status}`);
  process.exit(1);
}

const event = await res.json();
const path = new URL(`../packages/decoder/test/fixtures/${name}.json`, import.meta.url);

writeFileSync(
  path,
  `${JSON.stringify({ capturedAt: new Date().toISOString(), wallet, event }, null, 2)}\n`,
);
console.log(`wrote ${name}.json — ${event.actions.length} actions`);
