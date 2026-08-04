import { getServerEnv } from "@/lib/env";
import type {
  AdminUserCreateRequest,
  AdminUserCreateResponse,
  AdminUserListResponse,
  AdminUserPasskeyListResponse,
  AdminUserPasswordResetResponse,
  AdminUserUpdateRequest,
  AdminUserUpdateResponse,
  CloverIntegrationResponse,
  DailyResetStatusResponse,
  DailyResetTriggerResponse,
  DeliverectIntegrationConfig,
  DeliverectIntegrationUpdateRequest,
  KdsDeviceCreateRequest,
  KdsDeviceCreateResponse,
  KdsDeviceListResponse,
  KdsDevicePairCreateRequest,
  KdsDevicePairCreateResponse,
  KitchenBoardSettings,
  PasswordMutationResponse,
  PasswordRejection,
  PasswordSetRequest,
  CatalogImportResult,
  SquareConnectRequest,
  SquareConnectResponse,
  SquareImportCatalogRequest,
  SquareTestConnectionResponse,
} from "@rop/contracts";

export interface BoardSettingsResponse {
  merchantId: string;
  settings: KitchenBoardSettings;
}

export class KdsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly url: string,
    public readonly requestId?: string
  ) {
    super(`kds-api ${status}: ${bodyText.slice(0, 200)}`);
    this.name = "KdsApiError";
  }
}

export class KdsApiNotConfiguredError extends Error {
  constructor(public readonly missing: string[]) {
    super(`kds-api admin not configured (missing: ${missing.join(", ")})`);
    this.name = "KdsApiNotConfiguredError";
  }
}

interface RequestOptions {
  signal?: AbortSignal;
  // Correlation id forwarded as `x-request-id`; kds-api adopts it as its
  // request.id so this BFF call and the upstream logs share one id in Loki.
  // Generated per call when omitted.
  requestId?: string;
}

async function request<T>(
  path: string,
  init: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = { method: "GET" },
  opts: RequestOptions = {}
): Promise<T> {
  const env = getServerEnv();
  const missing: string[] = [];
  if (!env.INTERNAL_KDS_API_URL) missing.push("INTERNAL_KDS_API_URL");
  if (!env.KDS_INTERNAL_ADMIN_TOKEN) missing.push("KDS_INTERNAL_ADMIN_TOKEN");
  if (missing.length > 0) {
    throw new KdsApiNotConfiguredError(missing);
  }

  const url = new URL(path, env.INTERNAL_KDS_API_URL).toString();
  const requestId = opts.requestId ?? crypto.randomUUID();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${env.KDS_INTERNAL_ADMIN_TOKEN}`,
    "x-request-id": requestId
  };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: opts.signal,
    credentials: "omit",
    cache: "no-store"
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new KdsApiError(res.status, bodyText, url, requestId);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export const kdsApi = {
  listDevices(merchantId: string | undefined, opts: RequestOptions = {}) {
    const qs = merchantId ? `?merchantId=${encodeURIComponent(merchantId)}` : "";
    return request<KdsDeviceListResponse>(`/api/admin/kds/devices${qs}`, { method: "GET" }, opts);
  },

  createDevice(body: KdsDeviceCreateRequest, opts: RequestOptions = {}) {
    return request<KdsDeviceCreateResponse>(`/api/admin/kds/devices`, { method: "POST", body }, opts);
  },

  // Mint a short-lived pairing claim for a store. The durable device token is
  // created only when the device redeems the claim (kds-api side), so this call
  // never returns the long-lived token — just the one-time code + pairUrl.
  createPairing(body: KdsDevicePairCreateRequest, opts: RequestOptions = {}) {
    return request<KdsDevicePairCreateResponse>(
      `/api/admin/kds/devices/pair`,
      { method: "POST", body },
      opts
    );
  },

  revokeDevice(deviceId: string, opts: RequestOptions = {}) {
    return request<{ ok: true }>(`/api/admin/kds/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" }, opts);
  },

  getBoardSettings(merchantId: string | undefined, opts: RequestOptions = {}) {
    const qs = merchantId ? `?merchantId=${encodeURIComponent(merchantId)}` : "";
    return request<BoardSettingsResponse>(`/api/admin/kds/board-settings${qs}`, { method: "GET" }, opts);
  },

  updateBoardSettings(
    body: KitchenBoardSettings,
    merchantId: string | undefined,
    opts: RequestOptions = {}
  ) {
    const qs = merchantId ? `?merchantId=${encodeURIComponent(merchantId)}` : "";
    return request<BoardSettingsResponse>(
      `/api/admin/kds/board-settings${qs}`,
      { method: "PUT", body },
      opts
    );
  },

  listUsers(opts: RequestOptions = {}) {
    return request<AdminUserListResponse>(`/api/admin/kds/users`, { method: "GET" }, opts);
  },

  createUser(body: AdminUserCreateRequest, opts: RequestOptions = {}) {
    return request<AdminUserCreateResponse>(`/api/admin/kds/users`, { method: "POST", body }, opts);
  },

  updateUser(userId: string, body: AdminUserUpdateRequest, opts: RequestOptions = {}) {
    return request<AdminUserUpdateResponse>(
      `/api/admin/kds/users/${encodeURIComponent(userId)}`,
      { method: "PATCH", body },
      opts
    );
  },

  deleteUser(userId: string, opts: RequestOptions = {}) {
    return request<{ ok: true }>(
      `/api/admin/kds/users/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      opts
    );
  },

  resetUserPassword(userId: string, opts: RequestOptions = {}) {
    return request<AdminUserPasswordResetResponse>(
      `/api/admin/kds/users/${encodeURIComponent(userId)}/password`,
      { method: "POST" },
      opts
    );
  },

  setPassword(body: PasswordSetRequest, opts: RequestOptions = {}) {
    return request<PasswordMutationResponse | PasswordRejection>(
      "/api/admin/kds/password/set",
      { method: "POST", body },
      opts
    );
  },

  listUserPasskeys(userId: string, opts: RequestOptions = {}) {
    return request<AdminUserPasskeyListResponse>(
      `/api/admin/kds/users/${encodeURIComponent(userId)}/passkeys`,
      { method: "GET" },
      opts
    );
  },

  revokeUserPasskey(userId: string, credentialId: string, opts: RequestOptions = {}) {
    return request<{ ok: true }>(
      `/api/admin/kds/users/${encodeURIComponent(userId)}/passkeys/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
      opts
    );
  },

  getCloverIntegration(opts: RequestOptions = {}) {
    return request<CloverIntegrationResponse>(
      `/api/admin/kds/integrations/clover`,
      { method: "GET" },
      opts
    );
  },

  getDeliverectIntegration(opts: RequestOptions = {}) {
    return request<{ merchantId: string; config: DeliverectIntegrationConfig }>(
      `/api/admin/kds/integrations/deliverect`,
      { method: "GET" },
      opts
    );
  },

  updateDeliverectIntegration(
    body: DeliverectIntegrationUpdateRequest,
    opts: RequestOptions = {}
  ) {
    return request<{ merchantId: string; config: DeliverectIntegrationConfig }>(
      `/api/admin/kds/integrations/deliverect`,
      { method: "PUT", body },
      opts
    );
  },

  deleteDeliverectIntegration(opts: RequestOptions = {}) {
    return request<undefined>(
      `/api/admin/kds/integrations/deliverect`,
      { method: "DELETE" },
      opts
    );
  },

  getDailyResetStatus(opts: RequestOptions = {}) {
    return request<DailyResetStatusResponse>(`/api/admin/kds/daily-reset`, { method: "GET" }, opts);
  },

  triggerDailyReset(opts: RequestOptions = {}) {
    return request<DailyResetTriggerResponse>(
      `/api/admin/kds/daily-reset`,
      { method: "POST", body: {} },
      opts
    );
  },

  testSquareConnection(body: SquareConnectRequest, opts: RequestOptions = {}) {
    return request<SquareTestConnectionResponse>(
      `/api/square/test-connection`,
      { method: "POST", body },
      opts
    );
  },

  connectSquare(body: SquareConnectRequest, opts: RequestOptions = {}) {
    return request<SquareConnectResponse>(
      `/api/square/connect`,
      { method: "POST", body },
      opts
    );
  },

  importSquareCatalog(body: SquareImportCatalogRequest, opts: RequestOptions = {}) {
    return request<CatalogImportResult>(
      `/api/square/import-catalog`,
      { method: "POST", body },
      opts
    );
  },
};
