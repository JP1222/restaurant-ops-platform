import { expect, test, type Page } from "@playwright/test";

// Bundled /api/costs response shape — see hooks/use-costs.ts. Values are
// registry-resolved server-side; the page only applies presentation (NRA band,
// coverage gate).
type MetricValue = { value: number; unit: string; definition: string; label: string };

function costsFixture(opts: {
  foodCost: number;
  coverage: number;
  labor?: number;
  prime?: number;
}) {
  const metrics: Record<string, MetricValue> = {
    food_cost_pct: {
      value: opts.foodCost,
      unit: "ratio",
      definition: "Σ(units × plate_cost) ÷ net sales",
      label: "Food Cost %"
    },
    cost_coverage_pct: {
      value: opts.coverage,
      unit: "ratio",
      definition: "costed item sales ÷ total item sales",
      label: "Recipe Cost Coverage"
    },
    gross_margin_pct: {
      value: 1 - opts.foodCost,
      unit: "ratio",
      definition: "(net sales − theoretical COGS) ÷ net sales",
      label: "Gross Margin %"
    },
    food_cost_cents: {
      value: 50_000,
      unit: "cents",
      definition: "Σ(units × plate_cost)",
      label: "Food Cost"
    },
    net_sales_cents: {
      value: 160_000,
      unit: "cents",
      definition: "payments − refunds",
      label: "Net Sales"
    }
  };
  if (opts.labor != null) {
    metrics.labor_cost_pct = {
      value: opts.labor,
      unit: "ratio",
      definition: "configured labor cost ÷ net sales",
      label: "Labor Cost %"
    };
    metrics.labor_cost_cents = {
      value: 40_000,
      unit: "cents",
      definition: "Σ modeled labor cost",
      label: "Labor Cost"
    };
  }
  if (opts.prime != null) {
    metrics.prime_cost_pct = {
      value: opts.prime,
      unit: "ratio",
      definition: "(theoretical COGS + labor) ÷ net sales",
      label: "Prime Cost %"
    };
  }
  return {
    days: 30,
    metrics,
    marginTrend: [
      { business_date: "2026-05-01", value: 0.66 },
      { business_date: "2026-05-15", value: 0.7 },
      { business_date: "2026-06-01", value: 1 - opts.foodCost }
    ]
  };
}

async function stubCosts(
  page: Page,
  opts: { foodCost: number; coverage: number; labor?: number; prime?: number }
) {
  await page.route("**/api/costs**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(costsFixture(opts))
    })
  );
}

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "127.0.0.1", path: "/" }
  ]);
}

test("costs page renders the food-cost band and honest deferred states", async ({ page }) => {
  await bypassAuth(page);
  // 31% food cost at 95% coverage -> band shows, lands "On target" (<= 32.4%).
  await stubCosts(page, { foodCost: 0.31, coverage: 0.95 });

  await page.goto("/costs");

  await expect(page.getByRole("heading", { name: "Cost & prime cost" })).toBeVisible();
  await expect(page.getByText("On target")).toBeVisible();
  // Labor + yield variance are honest "not connected" states, not fake numbers.
  await expect(page.getByText("Not connected").first()).toBeVisible();
  await expect(page.getByText("How these figures are measured")).toBeVisible();
});

test("food-cost band is suppressed (provisional) when recipe coverage is low", async ({
  page
}) => {
  await bypassAuth(page);
  // 60% coverage is below the 90% gate -> band hidden, shows "Provisional".
  await stubCosts(page, { foodCost: 0.19, coverage: 0.6 });

  await page.goto("/costs");

  await expect(page.getByText("Provisional")).toBeVisible();
  await expect(page.getByText("On target")).toHaveCount(0);
  await expect(page.getByText(/floor until recipe coverage/i)).toBeVisible();
});

test("labor and prime cost light up once labor is configured", async ({ page }) => {
  await bypassAuth(page);
  // 30% food at 95% coverage + 25% labor -> prime 55% (both land "On target").
  await stubCosts(page, { foodCost: 0.3, coverage: 0.95, labor: 0.25, prime: 0.55 });

  await page.goto("/costs");

  await expect(page.getByRole("heading", { name: "Cost & prime cost" })).toBeVisible();
  // Prime resolves -> the deferred "awaiting labor" copy is gone.
  await expect(page.getByText("awaiting labor")).toHaveCount(0);
  // Labor card is no longer in its "not set" deferred state.
  await expect(page.getByText("Labor cost isn't set yet")).toHaveCount(0);
  // Bands render for the lit cards.
  await expect(page.getByText("On target").first()).toBeVisible();
});
