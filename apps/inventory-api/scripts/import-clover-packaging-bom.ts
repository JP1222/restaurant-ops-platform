// One-shot Clover -> inventory packaging-BOM importer (ADR-0028).
//
// Builds on the recipe mirror (scripts/import-clover-recipes.ts): for each mirrored
// menu item it writes the reliable packaging slice of the BOM (cup/spoon/straw/lid),
// so sales-driven depletion moves real stock. Additive + idempotent — re-running
// refreshes only the packaging lines and never wipes ingredient lines.
//
// Preview from anywhere with prod Clover creds (no DB):
//   infisical run --env prod --path / -- \
//     pnpm --filter @rop/inventory-api exec tsx scripts/import-clover-packaging-bom.ts --dry-run
//
// Apply where the inventory DB is reachable:
//   CLOVER_TOKEN=... CLOVER_MERCHANT_ID=... INVENTORY_DATABASE_URL=... \
//     pnpm --filter @rop/inventory-api exec tsx scripts/import-clover-packaging-bom.ts
import { createPrismaClient } from "@rop/db-inventory";

import { fetchCloverCatalog, selectRecipes } from "../src/lib/clover-menu.js";
import {
  applyPackagingBom,
  planPackaging,
  ARCHIVE_ITEM_IDS,
  PACKAGING_CATEGORY_ID,
  PACKAGING_ITEMS_TO_CREATE,
  PACKAGING_SKUS
} from "../src/lib/packaging-bom.js";

async function main(): Promise<void> {
  const token = process.env.CLOVER_TOKEN;
  const merchantId = process.env.CLOVER_MERCHANT_ID;
  const baseUrl = process.env.CLOVER_BASE_URL ?? "https://api.clover.com";
  const dbUrl = process.env.INVENTORY_DATABASE_URL;
  const dryRun = process.argv.includes("--dry-run");
  const asJson = process.argv.includes("--json");

  if (!token || !merchantId) {
    console.error("CLOVER_TOKEN and CLOVER_MERCHANT_ID are required.");
    process.exit(1);
  }

  const catalog = await fetchCloverCatalog({ baseUrl, merchantId, token });
  const recipes = selectRecipes(catalog);
  const plan = planPackaging(recipes);

  if (asJson) {
    // Full plan for an out-of-band apply (e.g. piped to the prod container runner).
    process.stdout.write(
      JSON.stringify({
        categoryId: PACKAGING_CATEGORY_ID,
        itemsToCreate: PACKAGING_ITEMS_TO_CREATE,
        archiveItemIds: ARCHIVE_ITEM_IDS,
        packagingSkus: [...PACKAGING_SKUS],
        recipes: plan.matched.map((m) => ({ recipeId: m.recipeId, name: m.name, type: m.type, lines: m.lines })),
        skipped: plan.skipped
      })
    );
    return;
  }

  console.log(`Packaging plan: ${plan.matched.length} recipes get packaging, ${plan.skipped.length} skipped.`);
  for (const m of plan.matched) {
    console.log(`  [${m.type}] ${m.name}: ${m.lines.map((l) => `${l.sku} x${l.qty}`).join(", ")}`);
  }
  if (plan.skipped.length > 0) {
    console.log(`  skipped (no packaging rule): ${plan.skipped.map((s) => `${s.name} (${s.category})`).join("; ")}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no database writes.");
    return;
  }

  if (!dbUrl) {
    console.error("\nINVENTORY_DATABASE_URL is required to apply (omit only with --dry-run).");
    process.exit(1);
  }

  const prisma = createPrismaClient(dbUrl);
  try {
    const result = await applyPackagingBom(prisma, plan);
    console.log(`\nDone. ${JSON.stringify(result)}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
