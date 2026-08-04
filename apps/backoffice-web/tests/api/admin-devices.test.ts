import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const listDevicesMock = vi.fn();
const createDeviceMock = vi.fn();
const createPairingMock = vi.fn();
const revokeDeviceMock = vi.fn();

vi.mock("@/lib/kds-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/kds-api")>("@/lib/kds-api");
  return {
    ...actual,
    kdsApi: {
      listDevices: (...args: unknown[]) => listDevicesMock(...args),
      createDevice: (...args: unknown[]) => createDeviceMock(...args),
      createPairing: (...args: unknown[]) => createPairingMock(...args),
      revokeDevice: (...args: unknown[]) => revokeDeviceMock(...args)
    }
  };
});

beforeEach(() => {
  listDevicesMock.mockReset();
  createDeviceMock.mockReset();
  createPairingMock.mockReset();
  revokeDeviceMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callList() {
  const { GET } = await import("@/app/api/admin/devices/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost:3001/api/admin/devices"));
}

async function callCreate(body: unknown) {
  const { POST } = await import("@/app/api/admin/devices/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost:3001/api/admin/devices", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  );
}

async function callPair(body: unknown) {
  const { POST } = await import("@/app/api/admin/devices/pair/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost:3001/api/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  );
}

async function callDelete(deviceId: string) {
  const { DELETE } = await import("@/app/api/admin/devices/[deviceId]/route");
  return DELETE(
    new Request(`http://localhost:3001/api/admin/devices/${deviceId}`, { method: "DELETE" }),
    { params: Promise.resolve({ deviceId }) }
  );
}

describe("GET /api/admin/devices", () => {
  test("returns the device list on success", async () => {
    listDevicesMock.mockResolvedValueOnce({ devices: [] });
    const res = await callList();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ devices: [] });
  });

  test("passes an upstream 4xx through instead of masking it as 502", async () => {
    const { KdsApiError } = await import("@/lib/kds-api/client");
    listDevicesMock.mockRejectedValueOnce(
      new KdsApiError(
        409,
        JSON.stringify({ error: "device_name_taken" }),
        "http://kds-api/api/admin/kds/devices"
      )
    );
    const res = await callList();
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error?: string; upstream_status?: number };
    expect(payload.error).toBe("upstream_error");
    expect(payload.upstream_status).toBe(409);
  });

  test("maps an upstream 5xx to 502", async () => {
    const { KdsApiError } = await import("@/lib/kds-api/client");
    listDevicesMock.mockRejectedValueOnce(
      new KdsApiError(503, "upstream down", "http://kds-api/api/admin/kds/devices")
    );
    const res = await callList();
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { upstream_status?: number };
    expect(payload.upstream_status).toBe(503);
  });

  test("maps a not-configured error to 503", async () => {
    const { KdsApiNotConfiguredError } = await import("@/lib/kds-api/client");
    listDevicesMock.mockRejectedValueOnce(
      new KdsApiNotConfiguredError(["KDS_INTERNAL_ADMIN_TOKEN"])
    );
    const res = await callList();
    expect(res.status).toBe(503);
  });
});

describe("POST /api/admin/devices", () => {
  test("rejects an invalid body with 400 before calling upstream", async () => {
    const res = await callCreate({ not: "a valid device" });
    expect(res.status).toBe(400);
    expect(createDeviceMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/devices/pair", () => {
  test("returns the pairing claim on success", async () => {
    const claim = {
      label: "Kitchen pad 1",
      role: "KDS",
      claimCode: "ABCD-2345",
      pairUrl: "https://kds.example.com/pair?code=ABCD2345",
      expiresInSeconds: 600
    };
    createPairingMock.mockResolvedValueOnce(claim);
    const res = await callPair({ merchantId: "m_1", label: "Kitchen pad 1", role: "KDS" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(claim);
    expect(createPairingMock).toHaveBeenCalledWith({
      merchantId: "m_1",
      label: "Kitchen pad 1",
      role: "KDS"
    });
  });

  test("defaults role to KDS when omitted (schema default)", async () => {
    createPairingMock.mockResolvedValueOnce({
      label: "Pad",
      role: "KDS",
      claimCode: "WXYZ-6789",
      pairUrl: "https://kds.example.com/pair?code=WXYZ6789",
      expiresInSeconds: 600
    });
    const res = await callPair({ merchantId: "m_1", label: "Pad" });
    expect(res.status).toBe(200);
    expect(createPairingMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "KDS" })
    );
  });

  test("rejects an invalid body with 400 before calling upstream", async () => {
    const res = await callPair({ merchantId: "", label: "" });
    expect(res.status).toBe(400);
    expect(createPairingMock).not.toHaveBeenCalled();
  });

  test("rejects an unknown role with 400 before calling upstream", async () => {
    const res = await callPair({ merchantId: "m_1", label: "Pad", role: "PRINTER" });
    expect(res.status).toBe(400);
    expect(createPairingMock).not.toHaveBeenCalled();
  });

  test("maps a not-configured error to 503", async () => {
    const { KdsApiNotConfiguredError } = await import("@/lib/kds-api/client");
    createPairingMock.mockRejectedValueOnce(
      new KdsApiNotConfiguredError(["KDS_INTERNAL_ADMIN_TOKEN"])
    );
    const res = await callPair({ merchantId: "m_1", label: "Pad", role: "DISPLAY" });
    expect(res.status).toBe(503);
  });
});

describe("DELETE /api/admin/devices/:deviceId", () => {
  test("passes an upstream 404 through so the UI can show 'device already gone'", async () => {
    const { KdsApiError } = await import("@/lib/kds-api/client");
    revokeDeviceMock.mockRejectedValueOnce(
      new KdsApiError(
        404,
        JSON.stringify({ error: "device_not_found" }),
        "http://kds-api/api/admin/kds/devices/dev_x"
      )
    );
    const res = await callDelete("dev_missing");
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { upstream_status?: number };
    expect(payload.upstream_status).toBe(404);
  });

  test("returns 400 when deviceId is missing", async () => {
    const res = await callDelete("");
    expect(res.status).toBe(400);
    expect(revokeDeviceMock).not.toHaveBeenCalled();
  });
});
