import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Closes #206 — axe-core a11y scan on /login and /today.
//
// Login + the manager dashboard are the two highest-impact pages for a11y. We
// scan each against the WCAG 2.0/2.1 A + AA rule sets and assert zero
// violations. /today is bypassed + stubbed so the scan runs against fully
// rendered content rather than skeletons.

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

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

async function stubTodayApis(page: Page) {
  const empty = (body: unknown) => (route: import("@playwright/test").Route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/today", empty(todayFixture));
  await page.route("**/api/today/top-items", empty({ window_days: 30, total_items: 0, top: [] }));
  await page.route(
    "**/api/today/hourly",
    empty({ business_date: "2026-05-19", weekday: 1, is_current_day: true, points: [], pacing: null }),
  );
  await page.route("**/api/today/insights", empty({ insights: [], all_clear: true }));
  await page.route(
    "**/api/today/wow",
    empty({ anchor_date: "2026-05-19", points: [], this_week_total_cents: 0, last_week_total_cents: 0, wow_pct: null }),
  );
}

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    { name: "__e2e_auth_bypass", value: "1", domain: "127.0.0.1", path: "/" },
  ]);
}

// axe reads computed colors synchronously. The buttons use `transition-all`, so
// if the scan lands while a transition is mid-flight axe can sample a blended
// intermediate color and report a false color-contrast violation (observed
// flakily on /login: fg #fcfcfc / bg #898989, a transient blend — not the
// resting brand color). Snapping every element to its resting state before
// scanning removes the timing nondeterminism without masking a genuine
// resting-state contrast issue.
async function freezeAnimations(page: Page) {
  await page.addStyleTag({
    content: "*, *::before, *::after { transition: none !important; animation: none !important; }",
  });
}

test("/login has no WCAG A/AA accessibility violations", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /sign in to backoffice/i })).toBeVisible();

  await freezeAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

test("/today has no WCAG A/AA accessibility violations", async ({ page }) => {
  await bypassAuth(page);
  await stubTodayApis(page);

  await page.goto("/today");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("$4,200.00")).toBeVisible();

  await freezeAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});
