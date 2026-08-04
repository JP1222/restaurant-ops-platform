import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { AiChatProvider } from "@rop/contracts";
import { getSetting } from "@/lib/settings";
import { MissingAnthropicKeyError, resolveAnthropicApiKey } from "@/lib/ai/anthropic-provider";
import { MissingDeepSeekKeyError, resolveDeepSeekApiKey } from "@/lib/ai/deepseek-provider";
import { MissingOpenAiKeyError, resolveOpenAiApiKey } from "@/lib/ai/openai-provider";
import { MissingVisionKeyError, resolveVisionApiKey } from "@/lib/ai/vision-provider";

/**
 * Provider resolver — neither the chat brain nor the receipt matcher is locked to
 * DeepSeek. Both build their model through `resolveLanguageModel(provider, modelId)`
 * below; they just read DIFFERENT settings (chat: ai.chat_provider/ai.model_id;
 * matcher: ai.match_provider/ai.match_model_id), so you can run them on different
 * providers and switching one never disturbs the other.
 *
 * Each provider resolves its own credentials, reusing what already lives in settings
 * so you don't re-enter a key you've already saved:
 *
 *   - `deepseek`           → `ai.deepseek_api_key` (text only; the original brain).
 *   - `gemini`             → REUSES `ai.vision_api_key`, the Gemini key the
 *                            invoice scanner already uses. Multimodal-capable.
 *   - `openai-compatible`  → `ai.chat_base_url` + `ai.chat_api_key`, for any
 *                            OpenAI-style endpoint (OpenAI, a local model, a proxy).
 *
 * Model ids are free-form so each provider's own ids fit. A missing/unconfigured
 * credential throws one of the Missing*…Error types; the routes map any of them to a
 * 503 `auth_not_configured` via `isMissingAiConfigError`.
 */
export interface ChatModel {
  model: LanguageModel;
  provider: AiChatProvider;
  modelId: string;
}

export class MissingChatProviderConfigError extends Error {
  constructor(missing: string) {
    super(`OpenAI-compatible provider not configured — set ${missing} in /settings/ai`);
    this.name = "MissingChatProviderConfigError";
  }
}

// True when an error means "this provider has no usable credential yet" — i.e. the
// operator hasn't configured the selected provider. Routes map this to 503
// auth_not_configured (a real failure stays 502). Covers every provider.
export function isMissingAiConfigError(error: unknown): boolean {
  return (
    error instanceof MissingDeepSeekKeyError ||
    error instanceof MissingVisionKeyError ||
    error instanceof MissingOpenAiKeyError ||
    error instanceof MissingAnthropicKeyError ||
    error instanceof MissingChatProviderConfigError
  );
}

/**
 * Can this chat provider read image/PDF parts itself?
 *
 *   - `gemini`            → yes (multimodal).
 *   - `openai`            → yes (GPT-4o-class models read images).
 *   - `anthropic`         → yes (Claude reads images).
 *   - `deepseek`          → no (the API drops file parts; see vision-provider.ts).
 *   - `openai-compatible` → conservatively NO. The endpoint is operator-defined and
 *                           may be a text-only local model; we can't probe it, so we
 *                           assume text-only and let the vision fallback handle images.
 *                           A multimodal OpenAI endpoint still gets its image answered
 *                           (by Gemini) — just not by itself.
 *
 * Used by the chat route to decide whether an image-bearing turn needs the
 * `ai.vision_fallback_enabled` swap to `createVisionChatModel()`.
 */
export function providerSupportsVision(provider: AiChatProvider): boolean {
  return provider === "gemini" || provider === "openai" || provider === "anthropic";
}

/**
 * Gemini chat model for the vision fallback — used when the selected chat provider
 * can't see images but the operator left `ai.vision_fallback_enabled` on. Unlike the
 * `gemini` case of `createChatModel`, this reads `ai.vision_model_id` (the operator is
 * still on e.g. DeepSeek, so `ai.model_id` holds a DeepSeek alias Gemini would reject)
 * and reuses the invoice-scan key (`ai.vision_api_key`). Gemini does text + tools, so
 * the whole turn — tools and all — can run on it. Throws MissingVisionKeyError → 503.
 */
export async function createVisionChatModel(): Promise<ChatModel> {
  const [apiKey, modelId] = await Promise.all([
    resolveVisionApiKey(),
    getSetting("ai.vision_model_id"),
  ]);
  const google = createGoogleGenerativeAI({ apiKey });
  return { model: google(modelId), provider: "gemini", modelId };
}

// Build a LanguageModel for the given provider + model id, resolving that provider's
// credentials. Shared by the chat brain and the receipt matcher / emoji suggester.
export async function resolveLanguageModel(
  provider: AiChatProvider,
  modelId: string,
): Promise<LanguageModel> {
  switch (provider) {
    case "gemini": {
      const google = createGoogleGenerativeAI({ apiKey: await resolveVisionApiKey() });
      return google(modelId);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: await resolveOpenAiApiKey() });
      return openai(modelId);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: await resolveAnthropicApiKey() });
      return anthropic(modelId);
    }
    case "openai-compatible": {
      const [baseURL, apiKey] = await Promise.all([
        getSetting("ai.chat_base_url"),
        getSetting("ai.chat_api_key"),
      ]);
      if (!baseURL.trim()) throw new MissingChatProviderConfigError("ai.chat_base_url");
      if (!apiKey.trim()) throw new MissingChatProviderConfigError("ai.chat_api_key");
      const openaiCompatible = createOpenAICompatible({
        name: "chat",
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
      });
      return openaiCompatible(modelId);
    }
    case "deepseek":
    default: {
      const deepseek = createDeepSeek({ apiKey: await resolveDeepSeekApiKey() });
      return deepseek.chat(modelId);
    }
  }
}

// The chat brain: ai.chat_provider + ai.model_id.
export async function createChatModel(): Promise<ChatModel> {
  const [provider, modelId] = await Promise.all([
    getSetting("ai.chat_provider"),
    getSetting("ai.model_id"),
  ]);
  return { model: await resolveLanguageModel(provider, modelId), provider, modelId };
}

// The provider + model id for the invoice/receipt line matcher AND the emoji-icon
// suggester (both text-only): ai.match_provider + ai.match_model_id. Independent of the
// chat brain so you can point receipt matching at any provider you've configured without
// touching chat, and vice-versa. Returned as a target (not a built model) so the caller
// can run it through `withTextFallback` — which needs the provider + id to escalate to
// ai.text_fallback_model_id on the SAME provider.
export async function resolveMatcherTarget(): Promise<{ provider: AiChatProvider; modelId: string }> {
  const [provider, modelId] = await Promise.all([
    getSetting("ai.match_provider"),
    getSetting("ai.match_model_id"),
  ]);
  return { provider, modelId };
}
