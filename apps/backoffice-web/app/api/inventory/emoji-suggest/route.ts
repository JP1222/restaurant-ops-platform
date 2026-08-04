import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { InventoryEmojiSuggestRequestSchema } from "@rop/contracts";

import { isMissingAiConfigError } from "@/lib/ai/chat-provider";
import { suggestEmojis } from "@/lib/ai/emoji-suggest";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI emoji-icon suggestion. Gating contract: kill-switch, session OR internal-token auth
// (crew-web's Floor app has no AI provider and proxies here with INTERNAL_AI_TOKEN),
// fail-closed 503 unkeyed. The model only proposes a glyph and the caller fills it only on
// an icon-less item — nothing here writes to the catalog.
//
// NOT rate-limited (like its match-suggest sibling): a cosmetic best-effort assist whose
// failure every caller swallows silently. In the scan flow it fires only after a parse that
// already passed the `scan` limit, so that ceiling bounds it upstream; the kill switch is the
// spend brake. Counting it here is what starved the user-visible parse in the shared bucket.
export async function POST(request: NextRequest): Promise<Response> {
  const killSwitch = await getSetting("ai.kill_switch");
  if (killSwitch) {
    return NextResponse.json({ error: "ai_disabled" }, { status: 503 });
  }

  // Feature toggle (operator-tunable, /settings/ai). Distinct from the kill switch: emoji
  // suggestion is a cosmetic enhancement, so a disabled feature returns an EMPTY suggestion
  // set (200) rather than a 503 — every caller already treats empty as "no suggestion", so
  // the item simply keeps its category-glyph fallback with no error noise.
  const emojiEnabled = await getSetting("ai.emoji_suggest_enabled");
  if (!emojiEnabled) {
    return NextResponse.json({ suggestions: [] });
  }

  const internalToken = process.env.INTERNAL_AI_TOKEN;
  const isInternal =
    Boolean(internalToken) && request.headers.get("authorization") === `Bearer ${internalToken}`;
  if (!isInternal && !(await getAiSessionUser(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = InventoryEmojiSuggestRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const suggestions = await suggestEmojis(parsed.data);
    return NextResponse.json({ suggestions });
  } catch (error) {
    if (isMissingAiConfigError(error)) {
      return NextResponse.json({ error: "ai_not_configured" }, { status: 503 });
    }
    logErrorEvent({
      scope: "backoffice.api.inventory.emoji-suggest",
      message: errorMessage(error, "emoji_suggest_failed"),
    });
    return NextResponse.json({ error: "emoji_suggest_failed" }, { status: 502 });
  }
}
