import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { errorMessage, logErrorEvent } from "@/lib/ai/log";
import { getAiSessionUser } from "@/lib/ai/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SqlRequestBody {
  sql?: unknown;
  question?: unknown;
}

export async function POST(request: NextRequest): Promise<Response> {
  const user = await getAiSessionUser(request);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: SqlRequestBody;
  try {
    body = (await request.json()) as SqlRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { sql, question } = body;
  if (typeof sql !== "string" || sql.length < 20 || sql.length > 2000) {
    return NextResponse.json({ error: "invalid_sql_length" }, { status: 400 });
  }
  if (question !== undefined && (typeof question !== "string" || question.length > 500)) {
    return NextResponse.json({ error: "invalid_question" }, { status: 400 });
  }

  const env = getServerEnv();
  let upstream: Response;
  try {
    upstream = await fetch(`${env.INTERNAL_ANALYTICS_API_URL}/admin/api/ai-sql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ANALYTICS_ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, question, user_id: user.id }),
      cache: "no-store",
    });
  } catch (error) {
    logErrorEvent({
      scope: "backoffice.api.ai.sql",
      message: errorMessage(error, "upstream_fetch_failed"),
    });
    return NextResponse.json({ error: "analytics_upstream_unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const upstreamText = await upstream.text().catch(() => "");
    logErrorEvent({
      scope: "backoffice.api.ai.sql",
      message: upstreamText.slice(0, 500),
      context: { upstreamStatus: upstream.status },
    });
    return NextResponse.json(
      { error: "analytics_upstream_error", upstream_status: upstream.status },
      { status: upstream.status === 400 ? 400 : 502 },
    );
  }

  const payload = await upstream.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "analytics_invalid_payload" }, { status: 502 });
  }
  return NextResponse.json(payload);
}
