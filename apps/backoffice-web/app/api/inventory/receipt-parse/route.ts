import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { MissingVisionKeyError } from "@/lib/ai/vision-provider";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { checkAiRateLimit } from "@/lib/ai/rate-limit";
import { parseReceiptImage, VisionTimeoutError } from "@/lib/ai/receipt-parse";
import { getAiSessionUser } from "@/lib/ai/session";
import { getSetting } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Browser-supplied invoice photo as base64. Capped so a giant upload can't pin the
// node runtime; ~8M base64 chars ≈ ~6 MB binary, comfortably above a phone JPEG.
const ReceiptParseRequestSchema = z.object({
  image_base64: z.string().min(1).max(8_000_000),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

// Invoice-scan parse (ADR-0538 D3). Reuses the AI kill-switch + rate limit + the
// fail-closed 503 contract from the chat route, since it's a metered vision call.
// The browser never calls the model directly (Iron Law) — the key stays server-side.
export async function POST(request: NextRequest): Promise<Response> {
  const killSwitch = await getSetting("ai.kill_switch");
  if (killSwitch) {
    return NextResponse.json({ error: "ai_disabled" }, { status: 503 });
  }

  // Auth: a backoffice operator session, OR a trusted internal service caller.
  // crew-web's scan BFF proxies here (the Floor app has no AI provider — ADR-0538 —
  // so it forwards the invoice image with a shared INTERNAL_AI_TOKEN instead of
  // duplicating the DeepSeek key). The kill-switch + rate-limit + fail-closed 503
  // apply to both. Read the token straight from process.env so this route stays
  // free of the full server-env schema (it has no other env dependency).
  const internalToken = process.env.INTERNAL_AI_TOKEN;
  const isInternal =
    Boolean(internalToken) && request.headers.get("authorization") === `Bearer ${internalToken}`;
  if (!isInternal && !(await getAiSessionUser(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Floor invoice-scan has its OWN bucket (ai.scan_rate_limit_per_minute),
  // separate from the chat assistant, so a manager working the chat can't
  // exhaust the shared budget and 429 a cook's scan.
  const rpm = await getSetting("ai.scan_rate_limit_per_minute");
  const rateLimit = await checkAiRateLimit("scan", rpm);
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) } },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = ReceiptParseRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const result = await parseReceiptImage(parsed.data.image_base64, parsed.data.mime_type);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MissingVisionKeyError) {
      return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
    }
    // Distinct from parse_failed so the scan UIs (intake sheet + crew-web proxy,
    // which passes status through) can offer "try again" instead of a dead end.
    if (error instanceof VisionTimeoutError) {
      logErrorEvent({
        scope: "backoffice.api.inventory.receipt-parse",
        message: errorMessage(error, "vision_timeout"),
        context: { latencyMs: error.durationMs },
      });
      return NextResponse.json({ error: "vision_timeout" }, { status: 504 });
    }
    logErrorEvent({
      scope: "backoffice.api.inventory.receipt-parse",
      message: errorMessage(error, "parse_failed"),
    });
    return NextResponse.json({ error: "parse_failed" }, { status: 502 });
  }
}
