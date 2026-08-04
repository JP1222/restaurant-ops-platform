// One-shot Clover -> inventory recipe mirror (ADR-0028).
//
// Pulls the live Clover catalog, filters it to the sellable menu (see
// shouldMirrorAsRecipe in src/lib/clover-menu.ts), and upserts one recipe per
// menu item keyed by clover_item_id. Idempotent: re-running refreshes
// name/category/price and leaves BOM lines untouched. BOMs are filled later
// (editor, or the packaging-BOM importer).
//
// Preview from anywhere with prod Clover creds (no DB needed):
//   infisical run --env prod --path / -- \
//     pnpm --filter @rop/inventory-api exec tsx scripts/import-clover-recipes.ts --dry-run
//
// Apply where the prod inventory DB is reachable (Oracle host / deployed env):
//   CLOVER_TOKEN=... CLOVER_MERCHANT_ID=... INVENTORY_DATABASE_URL=... \
//     pnpm --filter @rop/inventory-api exec tsx scripts/import-clover-recipes.ts
import { createPrismaClient } from "@rop/db-inventory";

import { fetchCloverCatalog, selectRecipes } from "../src/lib/clover-menu.js";
import { syncRecipesFromClover } from "../src/lib/inventory-store.js";

async function main(): Promise<void> {
  const token = process.env.CLOVER_TOKEN;
  const merchantId = process.env.CLOVER_MERCHANT_ID;
  const baseUrl = process.env.CLOVER_BASE_URL ?? "https://api.clover.com";
  const dbUrl = process.env.INVENTORY_DATABASE_URL;
  const dryRun = process.argv.includes("--dry-run");
  // --json: emit the selected recipes as JSON on stdout and exit (no DB write).
  // Lets the fetch run where CLOVER_TOKEN lives and the write run elsewhere (the
  // prod DB is only reachable on the host), piping the plan between them.
  const asJson = process.argv.includes("--json");

  if (!token || !merchantId) {
    console.error("CLOVER_TOKEN and CLOVER_MERCHANT_ID are required.");
    process.exit(1);
  }

  const catalog = await fetchCloverCatalog({ baseUrl, merchantId, token });
  const recipes = selectRecipes(catalog);

  if (asJson) {
    process.stdout.write(JSON.stringify(recipes));
    return;
  }

  console.log(`Fetched ${catalog.length} Clover items -> ${recipes.length} selected as recipes:`);
  for (const r of recipes) {
    console.log(`  [${r.category}] ${r.name} — $${(r.priceCents / 100).toFixed(2)}`);
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
    const result = await syncRecipesFromClover(prisma, recipes);
    console.log(`\nDone. recipes created=${result.created} updated=${result.updated}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
