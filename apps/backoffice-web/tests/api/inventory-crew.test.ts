import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const listCrewMock = vi.fn();
const createCrewMock = vi.fn();
const updateCrewMock = vi.fn();
const resetCrewPinMock = vi.fn();

vi.mock("@/lib/inventory-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/inventory-api")>("@/lib/inventory-api");
  return {
    ...actual,
    inventoryApi: {
      listCrew: (...args: unknown[]) => listCrewMock(...args),
      createCrew: (...args: unknown[]) => createCrewMock(...args),
      updateCrew: (...args: unknown[]) => updateCrewMock(...args),
      resetCrewPin: (...args: unknown[]) => resetCrewPinMock(...args)
    }
  };
});

beforeEach(() => {
  listCrewMock.mockReset();
  createCrewMock.mockReset();
  updateCrewMock.mockReset();
  resetCrewPinMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const EMP = {
  id: "e1",
  name: "Ana",
  role: "Line",
  shift: "AM",
  initials: "AN",
  color: "#111111",
  active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z"
};

async function callGet() {
  const { GET } = await import("@/app/api/inventory/crew/route");
  return GET();
}

async function callPost(body: unknown) {
  const { POST } = await import("@/app/api/inventory/crew/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost:3001/api/inventory/crew", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  );
}

async function callPatch(id: string, body: unknown) {
  const { PATCH } = await import("@/app/api/inventory/crew/[id]/route");
  const { NextRequest } = await import("next/server");
  return PATCH(
    new NextRequest(`http://localhost:3001/api/inventory/crew/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function callPin(id: string, body: unknown) {
  const { POST } = await import("@/app/api/inventory/crew/[id]/pin/route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest(`http://localhost:3001/api/inventory/crew/${id}/pin`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    }),
    { params: Promise.resolve({ id }) }
  );
}

describe("GET /api/inventory/crew", () => {
  test("lists crew members", async () => {
    listCrewMock.mockResolvedValueOnce({ employees: [EMP] });
    const response = await callGet();
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { employees: unknown[] };
    expect(payload.employees).toHaveLength(1);
  });
});

describe("POST /api/inventory/crew", () => {
  test("creates a crew member with 201", async () => {
    createCrewMock.mockResolvedValueOnce({ employee: EMP });
    const response = await callPost({ name: "Ana", role: "Line", shift: "AM", pin: "123456" });
    expect(response.status).toBe(201);
    expect(createCrewMock).toHaveBeenCalledWith({ name: "Ana", role: "Line", shift: "AM", pin: "123456" });
  });

  test("returns 400 on a non-6-digit PIN without calling upstream", async () => {
    const response = await callPost({ name: "Ana", role: "Line", shift: "AM", pin: "12" });
    expect(response.status).toBe(400);
    expect(createCrewMock).not.toHaveBeenCalled();
  });

  test("maps an upstream 409 to pin_in_use", async () => {
    const { InventoryApiError } = await import("@/lib/inventory-api/client");
    createCrewMock.mockRejectedValueOnce(
      new InventoryApiError(409, "{}", "http://inventory-api/api/admin/crew")
    );
    const response = await callPost({ name: "Dup", role: "Line", shift: "AM", pin: "999999" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("pin_in_use");
  });
});

describe("PATCH /api/inventory/crew/:id", () => {
  test("forwards a disable update", async () => {
    updateCrewMock.mockResolvedValueOnce({ employee: { ...EMP, active: false } });
    const response = await callPatch("e1", { active: false });
    expect(response.status).toBe(200);
    expect(updateCrewMock).toHaveBeenCalledWith("e1", { active: false });
  });
});

describe("POST /api/inventory/crew/:id/pin", () => {
  test("resets a PIN", async () => {
    resetCrewPinMock.mockResolvedValueOnce({ employee: EMP });
    const response = await callPin("e1", { pin: "246802" });
    expect(response.status).toBe(200);
    expect(resetCrewPinMock).toHaveBeenCalledWith("e1", { pin: "246802" });
  });

  test("maps an upstream 409 to pin_in_use", async () => {
    const { InventoryApiError } = await import("@/lib/inventory-api/client");
    resetCrewPinMock.mockRejectedValueOnce(
      new InventoryApiError(409, "{}", "http://inventory-api/api/admin/crew/e1/pin")
    );
    const response = await callPin("e1", { pin: "999999" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("pin_in_use");
  });
});
