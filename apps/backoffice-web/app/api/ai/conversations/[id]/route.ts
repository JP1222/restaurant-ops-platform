import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { deleteConversation, getConversation } from "@/lib/ai/db";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const conversation = await getConversation(id, user.id);
    if (!conversation) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ conversation });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.conversations.get",
      message: errorMessage(error, "get_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const deleted = await deleteConversation(id, user.id);
    if (!deleted) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.conversations.delete",
      message: errorMessage(error, "delete_failed"),
    });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
