import { getToolName, isTextUIPart, isToolUIPart, type UIMessage, type UIMessagePart } from "ai";
import { findUnverifiedFigures, type UnverifiedFigure } from "./numeric-guardrail";
import { isWebSearchTool } from "./web-tools";

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

/**
 * Re-runs the numeric guardrail (ADR-0030, Phase 0b-3b) client-side over a
 * rendered assistant message, so the UI can badge unsourced figures live.
 *
 * The server computes the same thing in onFinish and persists it, but the flags
 * never ride the stream back; the client already holds the answer text and the
 * tool outputs in `message.parts`, and `findUnverifiedFigures` extracts source
 * numbers from any JSON shape, so a client-side recompute matches the server.
 *
 * Only meaningful once the message is complete — call after streaming settles.
 */
export function unverifiedFiguresForMessage(message: UIMessage): UnverifiedFigure[] {
  if (message.role !== "assistant") return [];

  const parts = (message.parts ?? []) as AnyPart[];
  let answer = "";
  const toolOutputs: unknown[] = [];

  for (const part of parts) {
    if (isTextUIPart(part)) {
      answer += part.text;
    } else if (
      isToolUIPart(part) &&
      // Mirror the server exclusion (route.ts onFinish): web_search outputs are
      // untrusted external content, so their numbers are NOT a verified source —
      // skip them here too, or the live/reload badge would disagree with the server.
      !isWebSearchTool(getToolName(part)) &&
      "output" in part &&
      part.output !== undefined
    ) {
      toolOutputs.push(part.output);
    }
  }

  if (!answer) return [];
  return findUnverifiedFigures(answer, toolOutputs);
}
