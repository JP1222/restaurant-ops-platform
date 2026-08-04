import { expect, test, type Page } from "@playwright/test";

// The SSE wire format here matches v6's JsonToSseTransformStream
// (`data: ${JSON.stringify(chunk)}\n\n` per UIMessageChunk + `data: [DONE]\n\n`).
function buildSseBody(chunks: Array<Record<string, unknown>>): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-vercel-ai-ui-message-stream": "v1",
  "x-conversation-id": "test-conv-1",
};

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    {
      name: "__e2e_auth_bypass",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
}

test.beforeEach(async ({ page }) => {
  await bypassAuth(page);
});

test("FAB sends a message and renders a streaming response", async ({ page }) => {
  await page.route("**/api/ai/chat", (route) => {
    const body = buildSseBody([
      { type: "start", messageId: "asst-1" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Net sales were " },
      { type: "text-delta", id: "t1", delta: "$4,200 today." },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      { type: "finish" },
    ]);
    return route.fulfill({ status: 200, headers: SSE_HEADERS, body });
  });

  await page.goto("/inventory");
  await page.getByRole("button", { name: /open ai assistant/i }).click();

  const textbox = page.getByRole("textbox", { name: /chat message/i });
  await expect(textbox).toBeVisible();
  await textbox.fill("What does today look like?");

  await page.getByRole("button", { name: /send message/i }).click();

  await expect(page.getByText("Net sales were", { exact: false })).toBeVisible();
  await expect(page.getByText("$4,200 today.", { exact: false })).toBeVisible();
});

test("FAB renders a collapsible tool-call card that expands on click", async ({ page }) => {
  await page.route("**/api/ai/chat", (route) => {
    const body = buildSseBody([
      { type: "start", messageId: "asst-2" },
      { type: "start-step" },
      {
        type: "tool-input-start",
        toolCallId: "call-1",
        toolName: "get_today_overview",
      },
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "get_today_overview",
        input: { business_date: "2026-05-19" },
      },
      {
        type: "tool-output-available",
        toolCallId: "call-1",
        output: { net_sales_cents: 420_000, orders: 124 },
      },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "Today: 124 orders, $4,200 in net sales." },
      { type: "text-end", id: "t2" },
      { type: "finish-step" },
      { type: "finish" },
    ]);
    return route.fulfill({ status: 200, headers: SSE_HEADERS, body });
  });

  await page.goto("/inventory");
  await page.getByRole("button", { name: /open ai assistant/i }).click();

  await page.getByRole("textbox", { name: /chat message/i }).fill("Show today overview");
  await page.getByRole("button", { name: /send message/i }).click();

  const toolCard = page.getByTestId("tool-call-card").first();
  await expect(toolCard).toBeVisible();
  await expect(toolCard).not.toHaveAttribute("open", /.*/);

  await toolCard.locator("summary").click();
  await expect(toolCard).toHaveAttribute("open", "");
  await expect(toolCard.getByText("get_today_overview")).toBeVisible();
  await expect(toolCard.getByText("Today: 124 orders", { exact: false })).toHaveCount(0);
});
