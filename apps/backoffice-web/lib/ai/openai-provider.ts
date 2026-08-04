import { getSetting } from "@/lib/settings";

/**
 * OpenAI provider key resolver — first-class OpenAI as a chat/matcher provider.
 *
 * The connection is a stored API key (BYOK), billed against the operator's OpenAI
 * account. Resolution mirrors the Gemini/DeepSeek resolvers (operator-rotatable,
 * AGENTS rule 16):
 *   1. `ai.openai_api_key` AppSetting (category=secret, AES-GCM at rest) — set via
 *      /settings/ai, decrypted transparently by lib/settings.
 *   2. `process.env.OPENAI_API_KEY` — transition fallback for env-injected setups.
 *   3. Otherwise throw MissingOpenAiKeyError → the route maps it to a 503.
 *
 * Distinct from `openai-compatible`: that points at an arbitrary OpenAI-style
 * endpoint (self-hosted / proxy) via ai.chat_base_url; this one is api.openai.com
 * with first-party defaults.
 */
export class MissingOpenAiKeyError extends Error {
  constructor() {
    super(
      "OpenAI API key not configured — set ai.openai_api_key in /settings/ai or via OPENAI_API_KEY env",
    );
    this.name = "MissingOpenAiKeyError";
  }
}

export async function resolveOpenAiApiKey(): Promise<string> {
  const fromDb = await getSetting("ai.openai_api_key");
  const dbKey = typeof fromDb === "string" ? fromDb.trim() : "";
  if (dbKey.length > 0) return dbKey;

  const envKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (envKey.length > 0) return envKey;

  throw new MissingOpenAiKeyError();
}
