import type { NextRequest } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/auth/session-user";

export type AiSessionUser = SessionUser;

/**
 * Resolve the AI-route operator. Returns null when no valid session is found.
 *
 * AI routes need the underlying `accountId` (to scope `ai_conversations.userId`),
 * which `getSessionUser` exposes as `id`. Thin alias kept for call-site clarity.
 */
export function getAiSessionUser(request: NextRequest): Promise<AiSessionUser | null> {
  return getSessionUser(request);
}
