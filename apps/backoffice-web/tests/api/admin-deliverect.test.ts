import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getDeliverectIntegrationMock = vi.fn();
const updateDeliverectIntegrationMock = vi.fn();
const deleteDeliverectIntegrationMock = vi.fn();

vi.mock("@/lib/kds-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kds-api")>("@/lib/kds-api");
  return {
    ...actual,
    kdsApi: {
      getDeliverectIntegration: (...args: unknown[]) => getDeliverectIntegrationMock(...args),
      updateDeliverectIntegration: (...args: unknown[]) =>
        updateDeliverectIntegrationMock(...args),
      deleteDeliverectIntegration: (...args: unknown[]) =>
        deleteDeliverectIntegrationMock(...args)
    }
  };
});

beforeEach(() => {
  getDeliverectIntegrationMock.mockReset();
  updateDeliverectIntegrationMock.mockReset();
  deleteDeliverectIntegrationMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callGet() {
  const { GET } = await import("@/app/api/admin/integrations/deliverect/route");
  return GET();
}

async function callPut(body: unknown) {
  const { PUT } = await import("@/app/api/admin/integrations/deliverect/route");
  const { NextRequest } = await import("next/server");
  return PUT(
    new NextRequest("http://localhost:3001/api/admin/integrations/deliverect", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  );
}

async function callDelete() {
  const { DELETE } = await import("@/app/api/admin/integrations/deliverect/route");
  return DELETE();
}

const SAMPLE_CONFIG = {
  enabled: true,
  environment: "production" as const,
  externalLocationId: "LOC-1",
  providerLocationId: "PLOC-1",
  channelLinkId: "CH-1",
  apiTokenMask: "••••wxyz",
  hmacSecretMask: "••••",
  registerWebhookStatus: "registered",
  ordersWebhookStatus: "healthy",
  lastRegisterWebhookAt: "2026-04-21T18:45:00.000Z",
  lastOrderWebhookAt: "2026-04-21T19:00:00.000Z"
};

describe("GET /api/admin/integrations/deliverect", () => {
  test("returns 401 when upstream kds-api rejects the bearer", async () => {
    const { KdsApiError } = await import("@/lib/kds-api/client");
    getDeliverectIntegrationMock.mockRejectedValueOnce(
      new KdsApiError(
        401,
        JSON.stringify({ error: "invalid_bearer" }),
        "http://kds-api/api/admin/kds/integrations/deliverect"
      )
    );
    const response = await callGet();
    expect(response.status).toBe(401);
    const payload = (await response.json()) as { upstream_status?: number };
    expect(payload.upstream_status).toBe(401);
  });

  test("returns 404 when no Deliverect row exists yet", async () => {
    const { KdsApiError } = await import("@/lib/kds-api/client");
    getDeliverectIntegrationMock.mockRejectedValueOnce(
      new KdsApiError(
        404,
        JSON.stringify({ error: "not_configured" }),
        "http://kds-api/api/admin/kds/integrations/deliverect"
      )
    );
    const response = await callGet();
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toBe("not_configured");
  });

  test("returns masked secrets on success", async () => {
    getDeliverectIntegrationMock.mockResolvedValueOnce({
      merchantId: "m-1",
      config: SAMPLE_CONFIG
    });
    const response = await callGet();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { config: typeof SAMPLE_CONFIG };
    expect(payload.config).toEqual(SAMPLE_CONFIG);
    // Sanity: the secret-shaped fields never contain the real token. Mask
    // strings start with bullet characters.
    expect(payload.config.apiTokenMask?.startsWith("••••")).toBe(true);
    expect(payload.config.hmacSecretMask).toBe("••••");
  });
});

describe("PUT /api/admin/integrations/deliverect", () => {
  test("forwards full payload incl. secrets to kds-api when both tokens are present", async () => {
    updateDeliverectIntegrationMock.mockResolvedValueOnce({
      merchantId: "m-1",
      config: SAMPLE_CONFIG
    });
    const response = await callPut({
      enabled: true,
      environment: "production",
      externalLocationId: "LOC-1",
      providerLocationId: "PLOC-1",
      channelLinkId: "CH-1",
      apiToken: "fresh-api-token",
      hmacSecret: "fresh-hmac-secret"
    });
    expect(response.status).toBe(200);
    expect(updateDeliverectIntegrationMock).toHaveBeenCalledWith({
      enabled: true,
      environment: "production",
      externalLocationId: "LOC-1",
      providerLocationId: "PLOC-1",
      channelLinkId: "CH-1",
      apiToken: "fresh-api-token",
      hmacSecret: "fresh-hmac-secret"
    });
  });

  test("omits token fields from upstream call when body omits them (preserve-existing semantics)", async () => {
    updateDeliverectIntegrationMock.mockResolvedValueOnce({
      merchantId: "m-1",
      config: SAMPLE_CONFIG
    });
    const response = await callPut({
      enabled: true,
      environment: "staging",
      externalLocationId: "LOC-2",
      providerLocationId: "PLOC-2",
      channelLinkId: "CH-2"
      // apiToken and hmacSecret intentionally omitted
    });
    expect(response.status).toBe(200);
    const upstreamCall = updateDeliverectIntegrationMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(upstreamCall.apiToken).toBeUndefined();
    expect(upstreamCall.hmacSecret).toBeUndefined();
    expect(upstreamCall.environment).toBe("staging");
  });

  test("returns 400 on invalid body (bad environment enum)", async () => {
    const response = await callPut({
      enabled: true,
      environment: "qa",
      externalLocationId: ""
    });
    expect(response.status).toBe(400);
    expect(updateDeliverectIntegrationMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/integrations/deliverect", () => {
  test("returns 204 on successful soft-delete", async () => {
    deleteDeliverectIntegrationMock.mockResolvedValueOnce(undefined);
    const response = await callDelete();
    expect(response.status).toBe(204);
    expect(deleteDeliverectIntegrationMock).toHaveBeenCalledOnce();
  });
});
