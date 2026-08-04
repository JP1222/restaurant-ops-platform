import { getSetting } from "@/lib/settings";

/**
 * Anthropic provider key resolver — first-class Claude as a chat/matcher provider.
 *
 * The connection is a stored API key (BYOK), billed against the operator's
 * Anthropic account. Resolution mirrors the Gemini/DeepSeek resolvers
 * (operator-rotatable, AGENTS rule 16):
 *   1. `ai.anthropic_api_key` AppSetting (category=secret, AES-GCM at rest) — set
 *      via /settings/ai, decrypted transparently by lib/settings.
 *   2. `process.env.ANTHROPIC_API_KEY` — transition fallback for env-injected setups.
 *   3. Otherwise throw MissingAnthropicKeyError → the route maps it to a 503.
 */
export class MissingAnthropicKeyError extends Error {
  constructor() {
    super(
      "Anthropic API key not configured — set ai.anthropic_api_key in /settings/ai or via ANTHROPIC_API_KEY env",
    );
    this.name = "MissingAnthropicKeyError";
  }
}

export async function resolveAnthropicApiKey(): Promise<string> {
  const fromDb = await getSetting("ai.anthropic_api_key");
  const dbKey = typeof fromDb === "string" ? fromDb.trim() : "";
  if (dbKey.length > 0) return dbKey;

  const envKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (envKey.length > 0) return envKey;

  throw new MissingAnthropicKeyError();
}
