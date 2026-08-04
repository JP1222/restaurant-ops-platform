import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from "@ai-sdk/google";

import { getSetting } from "@/lib/settings";

/**
 * Vision provider — Google Gemini, for invoice-scan image extraction (ADR-0538).
 *
 * DeepSeek's API has no image-capable model: the `@ai-sdk/deepseek` provider drops
 * image parts ("user message part type: file is not supported"), so a DeepSeek call
 * silently receives a text-only request and returns zero line items. The receipt
 * parser therefore routes the photo to Gemini. DeepSeek stays the text chat brain
 * (`lib/ai/deepseek-provider.ts`); this is the eyes.
 *
 * Key resolution mirrors the DeepSeek resolver (operator-rotatable, AGENTS rule 16):
 *   1. `ai.vision_api_key` AppSetting (category=secret, AES-GCM at rest) — set via
 *      /settings/ai, decrypted transparently by lib/settings.
 *   2. `process.env.GEMINI_API_KEY` — transition fallback for env-injected setups.
 *   3. Otherwise throw MissingVisionKeyError → the route maps it to a 503.
 *
 * `getSetting` already caches ~5s, so there's no extra provider-level key cache here
 * (unlike the chat provider, which is on the request-spiky hot path).
 */
export class MissingVisionKeyError extends Error {
  constructor() {
    super(
      "Vision API key not configured — set ai.vision_api_key in /settings/ai or via GEMINI_API_KEY env",
    );
    this.name = "MissingVisionKeyError";
  }
}

export async function resolveVisionApiKey(): Promise<string> {
  const fromDb = await getSetting("ai.vision_api_key");
  const dbKey = typeof fromDb === "string" ? fromDb.trim() : "";
  if (dbKey.length > 0) return dbKey;

  const envKey = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (envKey.length > 0) return envKey;

  throw new MissingVisionKeyError();
}

export async function createVisionProvider(): Promise<GoogleGenerativeAIProvider> {
  const apiKey = await resolveVisionApiKey();
  return createGoogleGenerativeAI({ apiKey });
}
