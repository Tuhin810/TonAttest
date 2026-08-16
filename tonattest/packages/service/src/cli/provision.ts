#!/usr/bin/env node
/**
 * Creates a project with an API key and a signing keypair.
 *
 *   pnpm --filter @tonattest/service provision "My Mini App"
 *
 * The API key is printed once and never stored in recoverable form.
 */
import { generateKeypair, toHex } from "@tonattest/attest";
import { loadConfig, loadDotEnv } from "../config.js";
import { generateApiKey, newId, seal } from "../crypto.js";
import { PostgresStore } from "../store/postgres.js";

loadDotEnv(new URL("../../../../.env", import.meta.url).pathname);
const config = loadConfig();

const name = process.argv[2];
if (!name) {
  console.error('usage: provision "<project name>"');
  process.exit(2);
}

const store = new PostgresStore(config.databaseUrl);

try {
  const credentials = generateApiKey();
  const projectId = newId("prj");

  await store.createProject({
    id: projectId,
    name,
    apiKeyHash: credentials.hash,
    apiKeySalt: credentials.salt,
    apiKeyHint: credentials.hint,
    disabledAt: null,
  });

  const keypair = await generateKeypair();
  const sealed = seal(keypair.privateKey, config.masterKey);

  await store.createSigningKey({
    id: newId("key"),
    projectId,
    publicKey: toHex(keypair.publicKey),
    privateKeyCiphertext: sealed.ciphertext,
    privateKeyIv: sealed.iv,
    privateKeyTag: sealed.tag,
    createdAt: new Date(),
    retiredAt: null,
  });

  console.log(`\nProject:    ${projectId}`);
  console.log(`Name:       ${name}`);
  console.log(`Public key: ${toHex(keypair.publicKey)}`);
  console.log(`\nAPI key (shown once — store it now):\n  ${credentials.apiKey}\n`);
} catch (err) {
  console.error("Provisioning failed:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await store.close();
}
