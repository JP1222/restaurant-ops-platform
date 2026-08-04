/**
 * Single dedicated stdout sink for AI observability.
 *
 * Loki / Promtail picks this up via the backoffice container's stdout. Rule
 * 16 (no `console.log`) explicitly carves out structured-logger sinks per
 * AGENTS.md guidance — this file is THE sink, do not sprinkle `console.log`
 * or raw `console.error(JSON.stringify(...))` elsewhere in the diff. Route
 * handlers should call `logErrorEvent({ scope, message, ... })` and chat
 * surfaces call `logChatEvent({...})`.
 */

import { redactSecrets } from "@/lib/redact";

export interface ChatTurnEvent {
  scope: "backoffice.api.ai.chat.turn";
  conversationId: string;
  turn: "user" | "assistant";
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCallCount?: number;
  latencyMs?: number;
  finishReason?: string;
  userId?: string;
  /** Count of reportable figures in the answer that did not trace to a tool result (0b-3b guardrail). */
  unverifiedFigureCount?: number;
}

export function logChatEvent(event: Omit<ChatTurnEvent, "scope">): void {
  // AGENTS.md rule 16 carves out structured-logger sinks like this one. If a
  // future rule wires no-console into the lint config, add the
  // `eslint-disable-next-line no-console` directive here.
  //
  // PII guard (issue #212): build the payload from an explicit allow-list of
  // metadata fields rather than spreading `...event`. Raw prompt/response
  // bodies (`messages`, `system`, `content`) live in `ai_messages.content`,
  // never in this stdout sink Loki scrapes. Spreading would let a future
  // caller (or a widened `ChatTurnEvent`) silently leak prompt text into log
  // aggregation; picking fields makes that structurally impossible.
  console.log(
    JSON.stringify({
      scope: "backoffice.api.ai.chat.turn" satisfies ChatTurnEvent["scope"],
      ts: new Date().toISOString(),
      conversationId: event.conversationId,
      turn: event.turn,
      modelId: event.modelId,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      toolCallCount: event.toolCallCount,
      latencyMs: event.latencyMs,
      finishReason: event.finishReason,
      userId: event.userId,
      unverifiedFigureCount: event.unverifiedFigureCount,
    }),
  );
}

/**
 * Structured error event for the AI surfaces.
 *
 * `scope` is a dot-namespaced identifier used by Loki dashboards to filter,
 * e.g. `backoffice.api.ai.oauth.complete` or `backoffice.api.ai.chat.stream`.
 * Pass an `unknown` from a catch block as `cause` — the helper extracts
 * `.message` if it's an Error and discards stack/internals otherwise. Any
 * extra request context (conversationId, userId, authSource, profileId) goes
 * in `context`, a free-form JSON-serializable bag.
 */
export interface ErrorEvent {
  scope: string;
  message: string;
  context?: Record<string, unknown>;
}

export function logErrorEvent(event: ErrorEvent): void {
  console.error(
    JSON.stringify({
      level: "error",
      ts: new Date().toISOString(),
      scope: event.scope,
      message: redactSecrets(event.message),
      ...(event.context ?? {}),
    }),
  );
}

/**
 * Structured change event for `app_setting` writes (issue #159).
 *
 * Emitted alongside the persisted `app_setting_audit` row so the change shows
 * up in stdout/Loki aggregation even if the DB audit write fails. NEVER carries
 * the value for `category=secret` keys — `valueRedacted: true` flags those and
 * the value fields are omitted, so key material can't leak into log shipping.
 * For non-secret keys the old/new values are small typed config strings and are
 * safe to record.
 */
export interface SettingChangeEvent {
  key: string;
  merchantId: string;
  changedBy?: string | null;
  changedByUsername?: string | null;
  fromVersion: number;
  toVersion: number;
  valueRedacted: boolean;
  oldValue?: string | null;
  newValue?: string | null;
}

export function logSettingChangeEvent(event: SettingChangeEvent): void {
  console.log(
    JSON.stringify({
      scope: "backoffice.settings.change",
      ts: new Date().toISOString(),
      key: event.key,
      merchantId: event.merchantId,
      changedBy: event.changedBy ?? null,
      changedByUsername: event.changedByUsername ?? null,
      fromVersion: event.fromVersion,
      toVersion: event.toVersion,
      // Only include value fields when they're not redacted (non-secret keys).
      ...(event.valueRedacted
        ? { valueRedacted: true }
        : { oldValue: event.oldValue ?? null, newValue: event.newValue ?? null }),
    }),
  );
}

/**
 * Success-path metric for the invoice/receipt vision parse (ADR-0538).
 *
 * The receipt-parse route only logs FAILURES (vision_timeout / parse_failed),
 * which left the real Gemini extraction latency invisible — we couldn't tell a
 * healthy 15s call from a 44s one creeping toward the timeout ceiling. This emits
 * one info row per successful parse so Loki/Grafana can chart p50/p95 latency and
 * catch drift before it becomes a cook-facing timeout. Shares the
 * `backoffice.api.inventory.receipt-parse` scope with the error log so a single
 * Loki filter sees both outcomes; `outcome` discriminates. Allow-list payload
 * (no `...event` spread): never carries the image or extracted line text.
 */
export interface VisionParseEvent {
  latencyMs: number;
  lineCount: number;
  /** Lines the model emitted that violated the contract bounds and were dropped (per-line
   *  resilience). > 0 means a partial extraction; a sustained nonzero rate is a signal the
   *  model schema bounds have drifted from the contract again. */
  droppedLines: number;
  vendorPresent: boolean;
  modelId: string;
  /** True when the primary vision model failed transiently and the configured fallback
   *  (ai.vision_fallback_model_id) produced this result. A rising rate is the signal that
   *  the primary is degrading (overload / quota) and the fallback is carrying the load. */
  fallbackUsed?: boolean;
}

export function logVisionParseEvent(event: VisionParseEvent): void {
  console.log(
    JSON.stringify({
      scope: "backoffice.api.inventory.receipt-parse",
      ts: new Date().toISOString(),
      outcome: "ok",
      latencyMs: event.latencyMs,
      lineCount: event.lineCount,
      droppedLines: event.droppedLines,
      vendorPresent: event.vendorPresent,
      modelId: event.modelId,
      fallbackUsed: event.fallbackUsed ?? false,
    }),
  );
}

/** Convenience: pull a useful message out of a catch-binding's `unknown`. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
