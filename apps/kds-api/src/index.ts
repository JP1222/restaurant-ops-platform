import "./lib/sentry-init.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertAiTokenEncryptionKey } from "./lib/crypto/encryption.js";

const config = loadConfig();
// Fail fast at boot if the at-rest master key is missing/malformed, instead of
// crash-looping deep inside the first encrypt (the 2026-06-18 incident).
assertAiTokenEncryptionKey();
const app = await buildApp();

try {
  await app.listen({
    port: config.apiPort,
    host: "0.0.0.0"
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

