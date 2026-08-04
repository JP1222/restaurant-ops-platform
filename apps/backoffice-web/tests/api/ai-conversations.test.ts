import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sessionMock = vi.fn();
const listMock = vi.fn();
const getMock = vi.fn();
const deleteMock = vi.fn();

vi.mock("@/lib/ai/session", () => ({
  getAiSessionUser: (...args: unknown[]) => sessionMock(...args),
}));

vi.mock("@/lib/ai/db", () => ({
  listConversations: (...args: unknown[]) => listMock(...args),
  getConversation: (...args: unknown[]) => getMock(...args),
  deleteConversation: (...args: unknown[]) => deleteMock(...args),
}));

beforeEach(() => {
  sessionMock.mockReset();
  listMock.mockReset();
  getMock.mockReset();
  deleteMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function callList(url: string) {
  const { GET } = await import("@/app/api/ai/conversations/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(url));
}

async function callGet(id: string) {
  const { GET } = await import("@/app/api/ai/conversations/[id]/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(
    `http://localhost:3001/api/ai/conversations/${encodeURIComponent(id)}`,
  );
  return GET(request, { params: Promise.resolve({ id }) });
}

async function callDelete(id: string) {
  const { DELETE } = await import("@/app/api/ai/conversations/[id]/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest(
    `http://localhost:3001/api/ai/conversations/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  return DELETE(request, { params: Promise.resolve({ id }) });
}

describe("GET /api/ai/conversations", () => {
  test("returns the user's last 50 conversations sorted by updatedAt desc", async () => {
    sessionMock.mockResolvedValueOnce({ id: "user-a", username: "a", displayName: "A" });
    const fixture = [
      {
        id: "c1",
        title: "Newer",
        createdAt: "2026-05-19T08:00:00.000Z",
        updatedAt: "2026-05-19T12:00:00.000Z",
      },
      {
        id: "c2",
        title: "Older",
        createdAt: "2026-05-18T08:00:00.000Z",
        updatedAt: "2026-05-18T20:00:00.000Z",
      },
    ];
    listMock.mockResolvedValueOnce(fixture);

    const response = await callList("http://localhost:3001/api/ai/conversations");
    const payload = (await response.json()) as { conversations: typeof fixture };

    expect(response.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith("user-a", 50);
    expect(payload.conversations).toEqual(fixture);
  });
});

describe("GET /api/ai/conversations/[id]", () => {
  test("returns the conversation with messages in createdAt asc order", async () => {
    sessionMock.mockResolvedValueOnce({ id: "user-b", username: "b", displayName: "B" });
    const fixture = {
      id: "c1",
      title: "Demo",
      createdAt: "2026-05-19T08:00:00.000Z",
      updatedAt: "2026-05-19T12:00:00.000Z",
      messages: [
        { id: "m1", createdAt: "2026-05-19T08:00:00.000Z", role: "user", content: "hi" },
        {
          id: "m2",
          createdAt: "2026-05-19T08:00:05.000Z",
          role: "assistant",
          content: "hello",
        },
      ],
    };
    getMock.mockResolvedValueOnce(fixture);

    const response = await callGet("c1");
    const payload = (await response.json()) as { conversation: typeof fixture };

    expect(response.status).toBe(200);
    expect(getMock).toHaveBeenCalledWith("c1", "user-b");
    expect(payload.conversation.messages[0]!.id).toBe("m1");
    expect(payload.conversation.messages[1]!.id).toBe("m2");
  });
});

describe("DELETE /api/ai/conversations/[id]", () => {
  test("deletes and returns ok:true; cascade is enforced by the schema", async () => {
    sessionMock.mockResolvedValueOnce({ id: "user-c", username: "c", displayName: "C" });
    deleteMock.mockResolvedValueOnce({ id: "c1" });

    const response = await callDelete("c1");
    const payload = (await response.json()) as { ok: true };

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith("c1", "user-c");
  });
});

describe("cross-user isolation", () => {
  test("user A reading user B's conversation returns 404 (existence not leaked)", async () => {
    sessionMock.mockResolvedValueOnce({ id: "user-a", username: "a", displayName: "A" });
    getMock.mockResolvedValueOnce(null);

    const response = await callGet("conv-belonging-to-b");
    const payload = (await response.json()) as { error: string };

    expect(response.status).toBe(404);
    expect(payload.error).toBe("not_found");

    sessionMock.mockResolvedValueOnce({ id: "user-a", username: "a", displayName: "A" });
    deleteMock.mockResolvedValueOnce(null);

    const deleteResponse = await callDelete("conv-belonging-to-b");
    expect(deleteResponse.status).toBe(404);
    const deletePayload = (await deleteResponse.json()) as { error: string };
    expect(deletePayload.error).toBe("not_found");
  });
});
