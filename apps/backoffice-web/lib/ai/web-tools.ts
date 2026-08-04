/**
 * Single source of truth for "which AI tools reach the public web" (Phase 2).
 *
 * Centralized here (a plain, dependency-free module) so the three consumers that
 * MUST agree all reference the same set:
 *   - the chat route's onFinish (server) excludes web-tool results from the
 *     numeric-guardrail source set,
 *   - `lib/ai/message-figures.ts` (client/live recompute) excludes the same, and
 *   - `components/ai/sources-card.tsx` (render) keys its card on the same name.
 *
 * Why exclude web tools from the guardrail: `collectSourceNumbers` harvests every
 * number from the tool-results blob, so without this a price/stat in a web snippet
 * would let a matching answer figure pass as DB-verified. Web text is untrusted —
 * its numbers are NOT authoritative store data, so they must not count as sources.
 * Keeping the list here (not in the `"use client"` card) lets the server route and
 * the client figure-collector import it without pulling in React.
 */
export const WEB_TOOLS = new Set<string>(["web_search"]);

export function isWebSearchTool(name: string): boolean {
  return WEB_TOOLS.has(name);
}
