import {
  convertToModelMessages,
  isTextUIPart,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AiChatRequestSchema } from "@rop/contracts";
import {
  createChatModel,
  createVisionChatModel,
  providerSupportsVision,
} from "@/lib/ai/chat-provider";
import { appendMessage, createConversation, touchConversation } from "@/lib/ai/db";
import { errorMessage, logChatEvent, logErrorEvent } from "@/lib/ai/log";
import { checkAiRateLimit } from "@/lib/ai/rate-limit";
import { findUnverifiedFigures } from "@/lib/ai/numeric-guardrail";
import { getAiSessionUser } from "@/lib/ai/session";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { recordAiUsage } from "@/lib/ai/usage";
import { aiTools } from "@/lib/ai/tools";
import { isWebSearchTool } from "@/lib/ai/web-tools";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// streamText defaults to stepCountIs(1): the model emits a tool call, the tool
// runs, and the stream STOPS — leaving the tool "Completed" with no answer. The
// agent must take another step to read the tool result and reply, so allow a
// short bounded chain (tool -> answer, or a few chained tools, then summarize).
// Also covers the write-approval resume: after an approved tool executes, the
// model needs a further step to confirm the result. Bounded to avoid a runaway
// tool loop.
const MAX_AGENT_STEPS = 8;

type ModelMessages = Awaited<ReturnType<typeof convertToModelMessages>>;

// The tool set handed to the model this turn. When web search is disabled (the
// fail-closed default), omit `web_search` entirely so the model never sees it —
// cleaner than registering it and rejecting the call. Stays fully typed (no `any`).
type AiToolSet = typeof aiTools | Omit<typeof aiTools, "web_search">;

function toolsetFor(webSearchEnabled: boolean): AiToolSet {
  if (webSearchEnabled) return aiTools;
  // Drop web_search by key without binding it (avoids an unused-var lint).
  const rest: Omit<typeof aiTools, "web_search"> = { ...aiTools };
  delete (rest as Partial<typeof aiTools>).web_search;
  return rest;
}

// Shown in place of a dropped image when the operator turned the vision fallback
// off — keeps the user message non-empty so the text model still gets a valid turn
// and can say it can't view images, rather than the request silently losing content.
const VISION_DISABLED_NOTE =
  "[An image was attached, but image understanding is turned off for the current AI provider.]";

// Does the latest user turn carry a file (image or PDF)? The browser posts image and
// PDF attachments alike as `file` parts, so this is the single signal for "this turn
// needs a model that can see files."
function latestUserTurnHasFile(messages: UIMessage[]): boolean {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return (lastUser?.parts ?? []).some((part) => part.type === "file");
}

// Strip image/PDF content parts from user messages (the text-only-provider path when
// the vision fallback is off). A message left with no content gets a short note so the
// turn stays valid for streamText.
function stripAttachmentParts(messages: ModelMessages): ModelMessages {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    const content = message.content.filter(
      (part) => part.type !== "file" && part.type !== "image",
    );
    return {
      ...message,
      content: content.length > 0 ? content : [{ type: "text", text: VISION_DISABLED_NOTE }],
    };
  });
}

function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((msg) => msg.role === "user");
  if (!firstUser) return "Untitled";
  const text = firstUser.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join(" ")
    .trim();
  return text.slice(0, 80) || "Untitled";
}

export async function POST(request: NextRequest): Promise<Response> {
  const killSwitch = await getSetting("ai.kill_switch");
  if (killSwitch) {
    return NextResponse.json({ error: "ai_disabled" }, { status: 503 });
  }

  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rateLimitPerMinute = await getSetting("ai.rate_limit_per_minute");
  const rateLimit = await checkAiRateLimit("chat", rateLimitPerMinute);
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: rateLimit.retryAfterSeconds },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) },
      },
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = AiChatRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;
  // The schema validates the UIMessage envelope (role + non-empty parts). The
  // browser's useChat client posts UIMessages (`parts`), so convert them to the
  // ModelMessage[] streamText needs via the SDK's convertToModelMessages — which
  // also does the strict part-level validation. A malformed payload 400s here,
  // before any conversation/message is persisted.
  const uiMessages = body.messages as unknown as UIMessage[];
  const turnHasFile = latestUserTurnHasFile(uiMessages);
  let modelMessages: ModelMessages;
  try {
    modelMessages = await convertToModelMessages(uiMessages, {
      tools: aiTools,
      ignoreIncompleteToolCalls: true,
    });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.chat.convert",
      message: errorMessage(error, "convert_failed"),
    });
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const [thinkingMode, maxOutputTokens, systemPromptAppend, webSearchEnabled] = await Promise.all([
    getSetting("ai.thinking_mode"),
    getSetting("ai.max_output_tokens"),
    getSetting("ai.system_prompt_append"),
    getSetting("ai.web_search_enabled"),
  ]);

  // Gate web search on the fail-closed kill switch: when off (default), the model
  // never sees the tool. convertToModelMessages keeps the full catalog so a prior
  // turn's web_search part in history still rehydrates; only the live tool set
  // handed to streamText is gated.
  const tools = toolsetFor(webSearchEnabled);

  let conversationId = body.conversationId ?? null;
  try {
    if (!conversationId) {
      const created = await createConversation(user.id, deriveTitle(uiMessages));
      conversationId = created.id;
    }

    const lastUserMessage = [...uiMessages].reverse().find((msg) => msg.role === "user");
    if (lastUserMessage) {
      await appendMessage(conversationId, "user", lastUserMessage);
    }
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.chat",
      message: errorMessage(error, "persist_user_message_failed"),
    });
    return NextResponse.json({ error: "persistence_failed" }, { status: 500 });
  }

  const system = buildSystemPrompt({
    viewSnapshot: body.viewSnapshot ?? null,
    systemPromptAppend,
  });
  const startedAt = Date.now();
  const finalConversationId: string = conversationId;

  let chat: Awaited<ReturnType<typeof createChatModel>>;
  try {
    chat = await createChatModel();
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.chat.provider",
      message: errorMessage(error, "provider_init_failed"),
    });
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }

  // Vision fallback (Phase 2): a text-only chat brain can't read an attached image/PDF.
  // When the operator leaves the fallback on, route THIS turn to the Gemini vision model
  // (reusing ai.vision_api_key); when off, drop the attachment so the text model still
  // answers the caption (the original images-never-reach-chat behavior). A multimodal
  // provider (gemini) sees the file itself, so no swap is needed there.
  let messagesForModel = modelMessages;
  if (turnHasFile && !providerSupportsVision(chat.provider)) {
    const visionFallbackEnabled = await getSetting("ai.vision_fallback_enabled");
    if (visionFallbackEnabled) {
      try {
        chat = await createVisionChatModel();
      } catch (error) {
        logErrorEvent({
          scope: "backoffice.api.ai.chat.provider",
          message: errorMessage(error, "vision_fallback_init_failed"),
        });
        return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
      }
    } else {
      messagesForModel = stripAttachmentParts(modelMessages);
    }
  }

  try {
    const result = streamText({
      model: chat.model,
      tools,
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      system,
      messages: messagesForModel,
      maxOutputTokens,
      // Thinking mode is a DeepSeek-specific provider option — only send it when the
      // DeepSeek brain is active. Other providers ignore the `deepseek` namespace,
      // but gating keeps the request clean and the intent obvious.
      ...(thinkingMode && chat.provider === "deepseek"
        ? { providerOptions: { deepseek: { thinking: { type: "enabled" } } } }
        : {}),
      onError: (event) => {
        const error = event.error;
        logErrorEvent({
          scope: "backoffice.api.ai.chat.stream",
          message: errorMessage(error, "stream_error"),
          context: {
            provider: chat.provider,
            modelId: chat.modelId,
            thinkingMode,
            conversationId: finalConversationId,
          },
        });
      },
      onFinish: async (event) => {
        // Post-hoc numeric guardrail (0b-3b): flag reported figures that don't
        // trace to a tool result this turn. Non-blocking — the stream is already
        // out; we persist the flags so the UI can badge them and log a count.
        //
        // Governance: web_search outputs are UNTRUSTED external content, so we drop
        // them from the guardrail's DB-verified source set (a price/stat in a web
        // snippet must NOT let a matching answer figure pass as verified). Mirrors
        // the client exclusion in lib/ai/message-figures.ts so the badge agrees
        // between live stream and reload.
        const groundedToolResults = event.toolResults.filter(
          (toolResult) => !isWebSearchTool(toolResult.toolName),
        );
        const unverifiedFigures = findUnverifiedFigures(event.text, groundedToolResults);
        try {
          await appendMessage(
            finalConversationId,
            "assistant",
            {
              role: "assistant",
              content: event.text,
              toolCalls: event.toolCalls,
              unverifiedFigures,
            },
            {
              inputTokens: event.totalUsage.inputTokens,
              outputTokens: event.totalUsage.outputTokens,
              toolCallCount: event.toolCalls.length,
              latencyMs: Date.now() - startedAt,
            },
          );
          await touchConversation(finalConversationId);
        } catch (persistError) {
          logErrorEvent({
            scope: "backoffice.api.ai.chat.onFinish",
            message: errorMessage(persistError, "persist_assistant_failed"),
          });
        }

        logChatEvent({
          conversationId: finalConversationId,
          turn: "assistant",
          modelId: chat.modelId,
          inputTokens: event.totalUsage.inputTokens,
          outputTokens: event.totalUsage.outputTokens,
          toolCallCount: event.toolCalls.length,
          latencyMs: Date.now() - startedAt,
          finishReason: event.finishReason,
          userId: user.id,
          unverifiedFigureCount: unverifiedFigures.length,
        });

        // Usage & cost ledger (fire-and-forget). chat.modelId reflects the model
        // that actually ran this turn (incl. a vision-fallback swap above).
        recordAiUsage({
          feature: "chat",
          modelId: chat.modelId,
          inputTokens: event.totalUsage.inputTokens,
          cachedInputTokens: event.totalUsage.cachedInputTokens,
          outputTokens: event.totalUsage.outputTokens,
        });
      },
    });

    return result.toUIMessageStreamResponse({
      headers: { "X-Conversation-Id": finalConversationId },
    });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.chat",
      message: errorMessage(error, "stream_construction_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
