import { ipMatchesAllowlist, parseIpAllowlist } from "@rop/contracts";

import { inventoryApiUrl } from "./inventory-api";

// Crew-login IP gate. inventory-api is internal-only, so it no longer sees the
// cook's real IP — crew-web (terminated by Traefik) is the only tier that does,
// via X-Forwarded-For. The allowlist is stored in inventory-api and edited from
// Backoffice; we poll it here and reject a login attempt from a non-allowlisted IP
// BEFORE forwarding the PIN. An EMPTY allowlist means allow-all (opt-in gate).

const TTL_MS = 30_000;
let cache: { entries: string[]; at: number } | null = null;

async function loadAllowlist(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return cache.entries;
  }
  try {
    const res = await fetch(inventoryApiUrl("/api/inventory/security-settings"), {
      cache: "no-store"
    });
    if (res.ok) {
      const data = (await res.json()) as { crew_ip_allowlist?: string };
      const entries = parseIpAllowlist(data.crew_ip_allowlist ?? "");
      cache = { entries, at: Date.now() };
      return entries;
    }
  } catch {
    // fall through to the stale cache / allow-all
  }
  // Read failed: don't lock the floor out over a transient blip — reuse the last
  // known list, or allow-all if we've never loaded one.
  return cache?.entries ?? [];
}

// The cook's IP as seen by our Traefik: the RIGHTMOST X-Forwarded-For entry (the
// one the closest trusted proxy appended). A client can prepend spoofed entries,
// but not append after Traefik, so the last hop is the trustworthy one. Falls back
// to X-Real-Ip. null when neither is present (e.g. local dev with no proxy).
export function clientIpFrom(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1]!;
    }
  }
  return req.headers.get("x-real-ip");
}

// May this request attempt a crew login? Allow-all when the list is empty; fail
// OPEN when the client IP can't be determined (no proxy headers — dev, or a
// misconfigured ingress) so a setting can never hard-lock the floor by accident.
export async function crewIpAllowed(req: Request): Promise<boolean> {
  const entries = await loadAllowlist();
  if (entries.length === 0) {
    return true;
  }
  const ip = clientIpFrom(req);
  if (!ip) {
    return true;
  }
  return ipMatchesAllowlist(ip, entries);
}
