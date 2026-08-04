import { expect, test, type Page } from "@playwright/test";

// crew-web e2e — invoice-scan review MOBILE layout (phone viewport).
//
// Regression guard for the reported bug: on a phone the review line row packed a
// thumbnail + name + "new item" badge + a wide qty stepper + an include checkbox
// into one non-wrapping flex row, so the row overflowed the viewport. Because the
// scroll list is `overflow-y-auto` (which makes overflow-x compute to `auto`), the
// whole list panned left/right and the checkbox/badge collided. We render the
// review at a 390px-wide viewport and assert nothing is horizontally scrollable.
//
// The default scan-flow.spec runs at 1280x720 (desktop), so it never exercised the
// phone layout. This file pins a phone viewport (the browser executable is resolved
// by playwright.config.ts, optionally via PW_EXECUTABLE_PATH).
test.use({ viewport: { width: 390, height: 844 } });

const MAYA = {
  id: "emp-maya",
  name: "Maya Reyes",
  role: "Prep Lead",
  shift: "AM",
  initials: "MR",
  color: "#1F8A5B"
};

const CHICKEN = {
  id: "sku-001",
  sku: "CHK-THIGH",
  name: "Chicken Thigh",
  category: "food",
  unit: "case",
  on_hand: 12,
  par_min: 4,
  par_max: 20,
  cost_cents: 80,
  purchase_unit: "Case",
  pack_qty: 1,
  purchase_cost_cents: 80,
  vendor: "US Foods",
  shelf_days: 5,
  last_counted: "2026-05-27",
  flagged_86: false
};

const INVENTORY = {
  items: [CHICKEN],
  categories: [{ id: "food", name: "Proteína", color: "#ef4444" }],
  pos: [],
  waste_reasons: [],
  waste_settings: { photo_required_over_cents: 5000, manager_approval_over_cents: 10000 }
};

// A matched line (two-digit qty) + an unrecognized line with a long name — the
// new-item card is the worst case for the row width (it carries the extra badge).
const PARSE = {
  vendor: "Sam's Club",
  lines: [
    { description: "CHICKEN THIGH CASE", qty: 48, unit: "case", unit_price_cents: 88 },
    { description: "MEMBER'S MARK HEAVY WHIPPING CREAM 64 OZ", qty: 12, unit: "each", unit_price_cents: 899 }
  ]
};

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

async function stubCrewBff(page: Page): Promise<void> {
  await page.route("**/api/crew/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) })
  );
  await page.route("**/api/crew/login", async (route, request) => {
    let pin: unknown;
    try {
      pin = (request.postDataJSON() as { pin?: unknown })?.pin;
    } catch {
      pin = undefined;
    }
    await route.fulfill(
      pin === "123456"
        ? { status: 200, contentType: "application/json", body: JSON.stringify({ employee: MAYA }) }
        : { status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid" }) }
    );
  });
  await page.route("**/api/inventory", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INVENTORY) })
  );
  await page.route("**/api/inventory/scan", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PARSE) })
  );
}

async function loginMaya(page: Page): Promise<void> {
  await page.goto("/");
  for (const digit of ["1", "2", "3", "4", "5", "6"]) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await expect(page.getByText("Movimientos")).toBeVisible();
}

// Any element whose content is wider than its box AND can scroll on x (overflow-x
// auto/scroll, OR overflow-x:visible while overflow-y is auto/scroll — the CSS
// "visible→auto" used-value rule, which getComputedStyle still reports as visible)
// means the page can be panned sideways — the reported defect. We also flag any
// element whose right edge sticks out past the viewport (content cut off).
async function overflowReport(page: Page) {
  return page.evaluate(() => {
    const iw = window.innerWidth;
    const pannable: { cls: string; sw: number; cw: number; ox: string; oy: string }[] = [];
    const pastEdge: { cls: string; right: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      const yScrolls = cs.overflowY === "auto" || cs.overflowY === "scroll";
      const xScrolls =
        cs.overflowX === "auto" || cs.overflowX === "scroll" || (cs.overflowX === "visible" && yScrolls);
      if (xScrolls && el.scrollWidth - el.clientWidth > 1) {
        pannable.push({ cls: String(el.className).slice(0, 48), sw: el.scrollWidth, cw: el.clientWidth, ox: cs.overflowX, oy: cs.overflowY });
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > iw + 1) {
        pastEdge.push({ cls: String(el.className).slice(0, 48), right: Math.round(r.right) });
      }
    }
    return { iw, pannable, pastEdge: pastEdge.slice(0, 12) };
  });
}

test.describe("crew-web invoice scan — mobile layout", () => {
  test("review screen does not scroll horizontally at phone width", async ({ page }) => {
    await stubCrewBff(page);
    await loginMaya(page);

    await page.getByRole("button", { name: /Escanear factura/ }).click();
    await page.getByTestId("scan-file-input").setInputFiles({
      name: "invoice.png",
      mimeType: "image/png",
      buffer: PNG_1X1
    });

    await expect(page.getByRole("heading", { name: "Sam's Club" })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);

    // The row is fixed-width-ish, so the regression shows up on narrow phones
    // (iPhone SE/mini ≈ 375, smaller Androids ≈ 360). Assert no sideways pan at each.
    for (const width of [390, 375, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(100);
      const report = await overflowReport(page);
      expect(report.pannable, `w=${width} horizontally pannable: ${JSON.stringify(report.pannable)}`).toEqual([]);
      expect(report.pastEdge, `w=${width} content past the right edge: ${JSON.stringify(report.pastEdge)}`).toEqual([]);
    }

    await page.setViewportSize({ width: 375, height: 844 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: "test-results/scan-review-mobile.png" });
  });
});
