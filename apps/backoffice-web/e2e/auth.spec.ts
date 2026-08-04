import { expect, test } from "@playwright/test";

test("unauthenticated visit to / redirects to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(\?.*)?$/);
});

test("login page renders title and primary actions", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /sign in to backoffice/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /passkey/i })).toBeVisible();
  await expect(page.getByLabel(/password/i)).toBeVisible();
});
