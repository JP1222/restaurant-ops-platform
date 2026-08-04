import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env";
import { GithubApiError } from "@/lib/github";
import { redactSecrets } from "@/lib/redact";

// Shared guards/handlers for the Operations BFF routes. Mirrors the inline
// pattern in app/api/ops/pipeline/* so all ops routes return identical error
// shapes to the client.

const MISSING_TOKEN_MESSAGE =
  "Set GITHUB_PIPELINE_TOKEN in the backoffice env to enable the Operations panel " +
  "(fine-grained PAT scopes: actions:write, administration:read, read:packages, variables:write).";

// Returns a 503 response when the GitHub token isn't configured, else null.
export function requireGithubToken(): NextResponse | null {
  const env = getServerEnv();
  if (!env.GITHUB_PIPELINE_TOKEN) {
    return NextResponse.json(
      { error: "missing_github_token", message: MISSING_TOKEN_MESSAGE },
      { status: 503 },
    );
  }
  return null;
}

// Maps an upstream error to a structured-logged JSON response. Auth failures
// upstream (401/403) surface as 503 so the UI nudges the operator to fix the
// PAT scopes; other upstream errors are 502; everything else is 500.
export function githubErrorResponse(error: unknown, scope: string): NextResponse {
  if (error instanceof GithubApiError) {
    console.error(
      JSON.stringify({
        level: "error",
        scope,
        upstreamStatus: error.status,
        message: redactSecrets(error.bodyText.slice(0, 500)),
      }),
    );
    return NextResponse.json(
      { error: "github_upstream_error", upstream_status: error.status },
      { status: error.status === 401 || error.status === 403 ? 503 : 502 },
    );
  }
  console.error(
    JSON.stringify({
      level: "error",
      scope,
      message: redactSecrets(error instanceof Error ? error.message : "unknown"),
    }),
  );
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
