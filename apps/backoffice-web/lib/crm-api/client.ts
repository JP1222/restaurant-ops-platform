import type { LoyaltyCohortsResponse } from "@rop/contracts";
import { getServerEnv } from "@/lib/env";

export class CrmApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly url: string
  ) {
    super(`crm-api ${status}: ${bodyText.slice(0, 200)}`);
    this.name = "CrmApiError";
  }
}

export class CrmApiNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`crm-api not configured (missing: ${missing.join(", ")})`);
    this.name = "CrmApiNotConfiguredError";
  }
}

async function request<T>(path: string, opts: { signal?: AbortSignal } = {}): Promise<T> {
  const env = getServerEnv();
  if (!env.INTERNAL_CRM_API_URL) {
    throw new CrmApiNotConfiguredError(["INTERNAL_CRM_API_URL"]);
  }

  const url = new URL(path, env.INTERNAL_CRM_API_URL).toString();
  const headers: Record<string, string> = { Accept: "application/json" };
  // crm-api bearer-guards every /api/loyalty route except the public reward
  // catalog; attach the token whenever configured.
  if (env.CRM_INTERNAL_TOKEN) {
    headers.Authorization = `Bearer ${env.CRM_INTERNAL_TOKEN}`;
  }

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: opts.signal,
    credentials: "omit",
    cache: "no-store"
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new CrmApiError(res.status, bodyText, url);
  }

  return res.json() as Promise<T>;
}

export const crmApi = {
  cohorts: (opts?: { signal?: AbortSignal }) =>
    request<LoyaltyCohortsResponse>("/api/loyalty/cohorts", opts)
};
