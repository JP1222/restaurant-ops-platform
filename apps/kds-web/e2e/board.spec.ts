import { expect, test } from "@playwright/test";

test("home page enters the real auth gate", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fboard/);
  await expect(page.getByRole("heading", { name: "Sign in to the kitchen console" })).toBeVisible();
});

test("login page opens", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in to the kitchen console" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
});

test("public display opens", async ({ page }) => {
  await page.goto("/display");
  await expect(page.getByText("Pickup Orders")).toBeVisible();
});

test("board redirects unauthenticated visitors to login", async ({ page }) => {
  await page.goto("/board?merchantId=local-dev");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fboard%3FmerchantId%3Dlocal-dev/);
  await expect(page.getByRole("heading", { name: "Sign in to the kitchen console" })).toBeVisible();
});
