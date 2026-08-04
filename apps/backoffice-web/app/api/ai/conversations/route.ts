import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { listConversations } from "@/lib/ai/db";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limitParsed = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  const limit = Number.isFinite(limitParsed)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limitParsed)))
    : DEFAULT_LIMIT;

  try {
    const conversations = await listConversations(user.id, limit);
    return NextResponse.json({ conversations });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.conversations.list",
      message: errorMessage(error, "list_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
