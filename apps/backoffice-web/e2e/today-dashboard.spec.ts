import { expect, test, type Page } from "@playwright/test";

// Closes #137 — login -> /today dashboard renders sales metrics.
//
// The page reads five BFF routes (use-today + four panel hooks). Only /api/today
// and /api/today/top-items carry the load-bearing assertions; the secondary
// panels (insights / hourly / wow) are stubbed with valid fixtures so nothing
// errors and the ChartContainer mounts. Shapes mirror lib/analytics-api/*-shape.ts
// and the InsightsResponse contract.

const todayFixture = {
  business_date: "2026-05-19",
  weekday: 1,
  is_current_day: true,
  kpis: {
    net_sales: { value: 420_000, unit: "cents", baseline: 380_000, wow_pct: 10.5, baseline_sample_size: 4 },
    orders: { value: 124, unit: "count", baseline: 110, wow_pct: 12.7, baseline_sample_size: 4 },
    avg_ticket: { value: 3_387, unit: "cents", baseline: 3_454, wow_pct: -1.9, baseline_sample_size: 4 },
    refunds: { value: 1_200, unit: "cents", baseline: 1_500, wow_pct: -20, baseline_sample_size: 4 },
    refund_rate: { value: 0.0029, unit: "rate", baseline: 0.004, wow_pct: -27.5, baseline_sample_size: 4 },
  },
};

const topItemsFixture = {
  window_days: 30,
  total_items: 3,
  top: [
    {
      rank: 1,
      item_fingerprint: "fp-rop-burrito",
      item_name: "Example Kitchen Burrito",
      alternate_name: null,
      quantity: 420,
      gross_sales_cents: 504_000,
      modifier_total_cents: 27_000,
      line_count: 410,
      modifier_line_count: 180,
      share_of_top: 0.55,
    },
    {
      rank: 2,
      item_fingerprint: "fp-combo-bowl",
      item_name: "Combo Bowl",
      alternate_name: null,
      quantity: 280,
      gross_sales_cents: 364_000,
      modifier_total_cents: 12_000,
      line_count: 275,
      modifier_line_count: 90,
      share_of_top: 0.30,
    },
  ],
};

const hourlyFixture = {
  business_date: "2026-05-19",
  weekday: 1,
  is_current_day: true,
  points: [
    {
      hour: 11,
      today_cumulative: 90_000,
      baseline_mean: 85_000,
      baseline_stddev: 5_000,
      baseline_lower: 75_000,
      baseline_upper: 95_000,
      baseline_sample_size: 4,
      today_orders: 24,
    },
    {
      hour: 12,
      today_cumulative: 240_000,
      baseline_mean: 220_000,
      baseline_stddev: 8_000,
      baseline_lower: 204_000,
      baseline_upper: 236_000,
      baseline_sample_size: 4,
      today_orders: 58,
    },
  ],
  pacing: null,
};

const insightsFixture = { insights: [], all_clear: true };

const wowFixture = {
  anchor_date: "2026-05-19",
  points: [],
  this_week_total_cents: 0,
  last_week_total_cents: 0,
  wow_pct: null,
};

async function stubTodayApis(page: Page) {
  await page.route("**/api/today", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(todayFixture) }),
  );
  await page.route("**/api/today/top-items", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(topItemsFixture) }),
  );
  await page.route("**/api/today/hourly", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hourlyFixture) }),
  );
  await page.route("**/api/today/insights", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(insightsFixture) }),
  );
  await page.route("**/api/today/wow", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(wowFixture) }),
  );
}

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "127.0.0.1", path: "/" },
  ]);
}

test("today dashboard renders KPI tiles from the BFF fixture", async ({ page }) => {
  await bypassAuth(page);
  await stubTodayApis(page);

  await page.goto("/today");

  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

  // Net sales / orders / avg ticket tiles render formatted money + counts.
  // KPI labels live in card-description nodes; exact match keeps them off the
  // longer chart/panel descriptions that also contain "net sales".
  await expect(page.getByText("Net Sales", { exact: true })).toBeVisible();
  await expect(page.getByText("$4,200.00")).toBeVisible();
  await expect(page.getByText("Orders", { exact: true })).toBeVisible();
  await expect(page.getByText("Avg Ticket", { exact: true })).toBeVisible();
  await expect(page.getByText("$33.87")).toBeVisible();
  // The orders count renders as a tabular-nums title, not the raw value alone.
  await expect(page.getByText("124", { exact: true })).toBeVisible();
});

test("today dashboard renders the top-items panel and the hourly chart", async ({ page }) => {
  await bypassAuth(page);
  await stubTodayApis(page);

  await page.goto("/today");

  await expect(page.getByText("Top 5 Items")).toBeVisible();
  await expect(page.getByText("Example Kitchen Burrito")).toBeVisible();
  await expect(page.getByText("Combo Bowl")).toBeVisible();
  // Money rendered via lib/format helpers — never the raw cents integer.
  await expect(page.getByText("$5,040.00")).toBeVisible();
  await expect(page.getByText("504000")).toHaveCount(0);

  // ChartContainer mounts (data-slot="chart") — proves the hourly pulse renders.
  await expect(page.locator('[data-slot="chart"]').first()).toBeVisible();
});
