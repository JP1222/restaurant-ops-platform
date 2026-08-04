import { beforeEach, describe, expect, test } from "vitest";
import { useAiAssistantStore } from "@/stores/ai-assistant";

beforeEach(() => {
  useAiAssistantStore.setState({
    isOpen: false,
    prefilledPrompt: null,
    openSource: null,
    viewSnapshot: null,
    conversationId: null,
  });
});

describe("ai-assistant store · view snapshot", () => {
  test("setViewSnapshot preserves data when payload is small", () => {
    const small = {
      view: "today" as const,
      url: "/today",
      data: { netSales: 4200 },
      capturedAt: "2026-05-19T18:00:00.000Z",
    };
    useAiAssistantStore.getState().setViewSnapshot(small);
    const snap = useAiAssistantStore.getState().viewSnapshot;
    expect(snap?.data).toEqual({ netSales: 4200 });
    expect(snap?.truncated).toBeUndefined();
    expect(snap?.view).toBe("today");
    expect(snap?.url).toBe("/today");
  });

  test("setViewSnapshot drops data and sets truncated when payload exceeds 2KB", () => {
    const big = {
      view: "menu" as const,
      url: "/menu?days=30",
      data: {
        items: Array.from({ length: 200 }, (_, i) => ({
          id: `item-${i}`,
          name: `Item ${i} with a reasonably long descriptive name`,
          revenue: 1234.56,
        })),
      },
      capturedAt: "2026-05-19T18:00:00.000Z",
    };
    useAiAssistantStore.getState().setViewSnapshot(big);
    const snap = useAiAssistantStore.getState().viewSnapshot;
    expect(snap?.data).toBeNull();
    expect(snap?.truncated).toBe(true);
    expect(snap?.view).toBe("menu");
    expect(snap?.url).toBe("/menu?days=30");
    expect(snap?.capturedAt).toBe("2026-05-19T18:00:00.000Z");
  });

  test("clearConversation resets conversationId and viewSnapshot", () => {
    useAiAssistantStore.getState().setConversationId("conv-abc");
    useAiAssistantStore.getState().setViewSnapshot({
      view: "today",
      url: "/today",
      data: null,
      capturedAt: "2026-05-19T18:00:00.000Z",
    });
    expect(useAiAssistantStore.getState().conversationId).toBe("conv-abc");
    expect(useAiAssistantStore.getState().viewSnapshot).not.toBeNull();

    useAiAssistantStore.getState().clearConversation();
    expect(useAiAssistantStore.getState().conversationId).toBeNull();
    expect(useAiAssistantStore.getState().viewSnapshot).toBeNull();
  });
});
