/**
 * Client-readable env values for the kds-web Floor surfaces.
 *
 * Next.js inlines `NEXT_PUBLIC_*` variables at build time, so these helpers
 * are safe to call from both the browser and server components. The trailing
 * slash on `NEXT_PUBLIC_BACKOFFICE_BASE_URL` is normalized away so callers can
 * concatenate paths like `/admin/board` without producing double slashes.
 *
 * Why a helper instead of inlining `process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL`
 * at the call site:
 *   - Single source of truth for the default URL when the env is unset (used
 *     by the "Manage in Backoffice" affordance and Deliverect status card).
 *   - Mirrors `apps/backoffice-web/lib/env.ts` (server-side zod) — same
 *     intent, but client-side envs only need light normalization, not zod.
 *
 * Phase 4.5.3 (Iron Law #4 — Floor vs Backoffice): operator-config and
 * Deliverect credentials are managed in Backoffice; the Floor's "Manage in
 * Backoffice" links route through this base URL.
 */

const DEFAULT_BACKOFFICE_BASE_URL = "https://backoffice.example.com";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

export function getBackofficeBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_BACKOFFICE_BASE_URL;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return stripTrailingSlash(raw.trim());
  }
  return DEFAULT_BACKOFFICE_BASE_URL;
}

export function getBackofficeAdminUrl(path: string): string {
  const base = getBackofficeBaseUrl();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}
