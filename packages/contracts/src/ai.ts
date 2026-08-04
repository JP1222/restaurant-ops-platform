/**
 * Backoffice AI assistant **request** contract.
 *
 * The browser POSTs to `apps/backoffice-web/app/api/ai/chat` with the running
 * conversation plus an optional snapshot of whatever view the operator is
 * looking at. That snapshot's `data` is browser-supplied and flows into the AI
 * system prompt + tools, so it must be size-bounded and validated rather than
 * trusted as `unknown` (audit #207). This module is the single source for that
 * request shape.
 *
 * The message shape stays deliberately loose: the route hands `messages`
 * straight to the Vercel AI SDK's `streamText` as `ModelMessage[]`, whose
 * `content` is either a plain string or an array of typed parts. We validate the
 * envelope (role + presence of content, non-empty list) without re-deriving the
 * SDK's full part union — that union is the SDK's contract, not ours, and
 * mirroring it here would couple `@rop/contracts` to an app dependency.
 */
import { z } from "zod";

export const aiChatRoles = ["system", "user", "assistant", "tool"] as const;
export const AiChatRoleSchema = z.enum(aiChatRoles);

/**
 * One chat message in the AI SDK **UIMessage** shape the browser's `useChat`
 * client actually sends: a `role` plus a non-empty `parts` array (text parts,
 * tool-invocation parts, tool-approval parts). We validate only the envelope —
 * the route hands `parts` to the SDK's `convertToModelMessages`, which performs
 * the strict part-level validation and produces the `ModelMessage[]` streamText
 * needs. (Earlier this required a `content` field, which rejected every real
 * client request — `useChat` posts `parts`, never `content`.)
 */
export const AiChatMessageSchema = z.object({
  id: z.string().optional(),
  role: AiChatRoleSchema,
  parts: z.array(z.unknown()).min(1),
});

/**
 * Hard cap on the serialized size of the view snapshot's `data` payload. The
 * snapshot is browser-supplied and lands in the model context; an unbounded blob
 * is both a token-cost and a prompt-injection surface. 64 KB is comfortably
 * above any real dashboard snapshot while keeping a single turn bounded.
 */
export const AI_VIEW_SNAPSHOT_MAX_BYTES = 64 * 1024;

export const AiViewSnapshotSchema = z.object({
  view: z.string().max(200).optional(),
  url: z.string().max(2000).optional(),
  data: z
    .unknown()
    .refine(
      (value) =>
        value === undefined ||
        new TextEncoder().encode(JSON.stringify(value) ?? "").length <=
          AI_VIEW_SNAPSHOT_MAX_BYTES,
      { message: `viewSnapshot.data exceeds ${AI_VIEW_SNAPSHOT_MAX_BYTES} bytes` },
    )
    .optional(),
  capturedAt: z.string().max(64).optional(),
});

export const AiChatRequestSchema = z.object({
  messages: z.array(AiChatMessageSchema).min(1),
  viewSnapshot: AiViewSnapshotSchema.nullish(),
  conversationId: z.string().nullish(),
});

/**
 * Backoffice AI `web_search` tool contract (Phase 2).
 *
 * The read-only `web_search` tool's `execute` POSTs to the BFF route
 * `/api/ai/web-search`, which delegates to Gemini "Grounding with Google
 * Search" and returns a grounded answer plus its web sources. Both shapes live
 * here (Iron Law #2 — cross-boundary DTOs come from `packages/contracts`, never
 * hand-written in the route).
 *
 * Web content is UNTRUSTED context: web-sourced numbers are deliberately
 * excluded from the numeric guardrail's source set so they can never launder as
 * DB-verified figures (the `sources-card` renders them in muted/neutral tokens
 * so they read as external, not authoritative).
 */
export const WebSearchRequestSchema = z.object({
  query: z.string().min(1).max(200),
});
export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;

/**
 * http(s)-only URL. `z.string().url()` alone accepts `javascript:`, `data:`, and
 * `vbscript:` schemes; these source URLs become `<a href>` targets in the Sources
 * card, and React does not block dangerous-scheme hrefs. Restricting the scheme at
 * the boundary means a bad-scheme URL is dropped rather than rendered as a
 * clickable script sink.
 */
const HttpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        return ["http:", "https:"].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: "url must use http(s)" },
  );

export const WebSearchSourceSchema = z.object({
  title: z.string(),
  url: HttpUrlSchema,
});
export type WebSearchSource = z.infer<typeof WebSearchSourceSchema>;

/**
 * The grounded-search result. `available` is `false` for the clean
 * "search unavailable" payload returned when the kill switch is off or the
 * Gemini key is missing — the route never throws/500s on those paths.
 */
export const WebSearchResultSchema = z.object({
  query: z.string(),
  answer: z.string(),
  sources: z.array(WebSearchSourceSchema).max(10),
  available: z.boolean().default(true),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;
