import type { AuthenticatedSession } from "./types.ts";

export function normalizeReturnToPath(value: string | null | undefined, fallback = "/board") {
  if (!value || !value.startsWith("/")) {
    return fallback;
  }

  try {
    const normalized = new URL(value, "https://kds.local");
    return `${normalized.pathname}${normalized.search}${normalized.hash}` || fallback;
  } catch {
    return fallback;
  }
}

export function buildLoginHref(returnTo: string) {
  return `/login?returnTo=${encodeURIComponent(normalizeReturnToPath(returnTo))}`;
}

export function buildBoardSettingsHref(returnTo: string | null | undefined) {
  const normalizedReturnTo = normalizeReturnToPath(returnTo);
  try {
    const next = new URL(normalizedReturnTo, "https://kds.local");
    if (next.pathname !== "/board") {
      return "/board?drawer=settings";
    }

    next.searchParams.set("drawer", "settings");
    return `${next.pathname}${next.search}${next.hash}`;
  } catch {
    return "/board?drawer=settings";
  }
}

export function buildPostLoginDestination(_session: AuthenticatedSession, returnTo: string) {
  const normalizedReturnTo = normalizeReturnToPath(returnTo);
  if (normalizedReturnTo.startsWith("/setup-passkey")) {
    try {
      const setupUrl = new URL(normalizedReturnTo, "https://kds.local");
      return buildBoardSettingsHref(setupUrl.searchParams.get("returnTo"));
    } catch {
      return buildBoardSettingsHref("/board");
    }
  }

  return normalizedReturnTo;
}
