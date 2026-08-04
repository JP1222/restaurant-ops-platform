import { expect, test, type Page } from "@playwright/test";

// Raw BFF response shape — see hooks/use-menu-engineering.ts. The hook returns
// the per-item inputs unchanged; classifyMenu() runs client-side, so the stub
// returns MenuEngineeringInputRow payloads (units + realized revenue + plate cost).
const engineeringFixture = {
  days: 30,
  items: [
    {
      clover_item_id: "clv-rop-burrito",
      item_fingerprint: "fp-rop-burrito",
      item_name: "Example Kitchen Burrito",
      units: 420,
      gross_sales_cents: 504_000,
      plate_cost_cents: 700
    },
    {
      clover_item_id: "clv-combo-bowl",
      item_fingerprint: "fp-combo-bowl",
      item_name: "Combo Bowl",
      units: 280,
      gross_sales_cents: 364_000,
      plate_cost_cents: 600
    },
    {
      clover_item_id: "clv-chips-guac",
      item_fingerprint: "fp-chips-guac",
      item_name: "Chips & Guac",
      units: 95,
      gross_sales_cents: 47_500,
      plate_cost_cents: 150
    }
  ]
};

const hourlyFixture = {
  item_fingerprint: "fp-rop-burrito",
  days: 56,
  rows: [
    { business_date: "2026-05-04", local_hour: 11, quantity: 12, gross_sales_cents: 14_400, line_count: 12 },
    { business_date: "2026-05-04", local_hour: 12, quantity: 30, gross_sales_cents: 36_000, line_count: 30 },
    { business_date: "2026-05-04", local_hour: 13, quantity: 18, gross_sales_cents: 21_600, line_count: 18 },
    { business_date: "2026-05-11", local_hour: 11, quantity: 10, gross_sales_cents: 12_000, line_count: 10 },
    { business_date: "2026-05-11", local_hour: 12, quantity: 28, gross_sales_cents: 33_600, line_count: 28 },
    { business_date: "2026-05-11", local_hour: 18, quantity: 15, gross_sales_cents: 18_000, line_count: 15 }
  ]
};

const modifiersFixture = {
  item_fingerprint: "fp-rop-burrito",
  days: 30,
  line_count: 410,
  modifiers: [
    {
      modifier_name: "Extra Guac",
      modifier_count: 180,
      modifier_total_cents: 27_000,
      attach_rate: 0.44
    },
    {
      modifier_name: "Salsa Verde",
      modifier_count: 90,
      modifier_total_cents: 0,
      attach_rate: 0.22
    },
    {
      modifier_name: "No Cilantro",
      modifier_count: 30,
      modifier_total_cents: 0,
      attach_rate: 0.07
    }
  ]
};

async function stubMenuApis(page: Page) {
  await page.route("**/api/menu/engineering**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(engineeringFixture)
    })
  );
  await page.route("**/api/menu/items/*/hourly**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hourlyFixture) })
  );
  await page.route("**/api/menu/items/*/modifiers**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(modifiersFixture) })
  );
}

async function bypassAuth(page: Page) {
  await page.context().addCookies([
    {
      name: "__e2e_auth_bypass",
      value: "1",
      domain: "127.0.0.1",
      path: "/"
    }
  ]);
}

test("menu page renders quadrant chart and items table", async ({ page }) => {
  await bypassAuth(page);
  await stubMenuApis(page);

  await page.goto("/menu");

  await expect(page.getByRole("heading", { name: "Menu engineering" })).toBeVisible();
  await expect(page.getByText("Example Kitchen Burrito")).toBeVisible();
  await expect(page.getByText("Combo Bowl")).toBeVisible();
  await expect(page.getByText("Chips & Guac")).toBeVisible();
});

test("clicking an item row opens the detail sheet with gross-sales legend", async ({ page }) => {
  await bypassAuth(page);
  await stubMenuApis(page);

  await page.goto("/menu");
  await expect(page.getByRole("cell", { name: "Example Kitchen Burrito" })).toBeVisible();

  await page.getByRole("row", { name: /Example Kitchen Burrito/ }).click();

  await expect(
    page
      .getByRole("heading", { name: "Example Kitchen Burrito" })
      .or(page.getByText("Example Kitchen Burrito"))
      .first()
  ).toBeVisible();
  await expect(page.getByText(/gross sales for this item/i)).toBeVisible();
  await expect(page.getByText("Extra Guac")).toBeVisible();
});
