import type { AuthenticatedSession } from "../shared/types.ts";

export type AuthBypassEnv = Record<string, string | undefined>;

export const DEV_AUTH_BYPASS_SESSION: AuthenticatedSession = {
  authenticated: true,
  username: "dev-ui-review",
  displayName: "Dev Kitchen Admin",
  hasPasskeys: false
};

export function getDevAuthBypassSession(env: AuthBypassEnv = process.env): AuthenticatedSession | null {
  if (env.NODE_ENV !== "development") {
    return null;
  }

  if (env.WEB_AUTH_DEV_BYPASS !== "true") {
    return null;
  }

  return DEV_AUTH_BYPASS_SESSION;
}
