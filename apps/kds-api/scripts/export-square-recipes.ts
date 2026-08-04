// One-shot Square -> recipe-mirror JSON emitter (store #2; docs/square-onboarding.md).
//
// Reads the bound Square store's LIVE catalog (kds-api is where the Square token +
// catalog normalizer live), filters it to the sellable menu (selectSquareRecipes),
// and prints a SquareRecipeImport JSON array on stdout. Pipe it into inventory-api's
// import-square-recipes.ts (which owns the recipe DB) to seed/refresh InventoryRecipe
// rows keyed by square_catalog_object_id. The two services are siblings that never call
// each other, so the catalog crosses as JSON, not an HTTP call.
//
// Only the JSON goes to stdout; all human output goes to stderr so the pipe stays clean.
//
//   infisical run --env dev --path / -- \
//     pnpm --filter @rop/kds-api exec tsx scripts/export-square-recipes.ts \
//       --pos-store-id square:LV78H3YNW202D \
//   | INVENTORY_DATABASE_URL=... pnpm --filter @rop/inventory-api exec \
//       tsx scripts/import-square-recipes.ts
//
// Preview only (no DB write downstream): append `--dry-run` to the import side, or
// just inspect this script's stdout.
import { createPrismaClient } from "@rop/db-kds";

import { selectSquareRecipes } from "../src/domain/square-recipe-mirror.js";
import { SquareClient } from "../src/lib/square-client.js";
import { fetchSquareStoreCatalog, SquareStoreError } from "../src/lib/square-menu.js";

// --pos-store-id <value> wins; else SQUARE_POS_STORE_ID. The synthetic `square:{loc}` PK.
function resolvePosStoreId(): string | undefined {
  const flagIndex = process.argv.indexOf("--pos-store-id");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1];
  }
  return process.env.SQUARE_POS_STORE_ID;
}

async function main(): Promise<void> {
  const posStoreId = resolvePosStoreId();
  const dbUrl = process.env.DATABASE_URL;

  if (!posStoreId) {
    console.error("export-square-recipes: --pos-store-id <square:{location_id}> (or SQUARE_POS_STORE_ID) is required.");
    process.exit(1);
  }
  if (!dbUrl) {
    console.error("export-square-recipes: DATABASE_URL is required (the kds-api/db-kds database).");
    process.exit(1);
  }

  const prisma = createPrismaClient(dbUrl);
  try {
    // Read the RAW catalog (not the normalized menu): recipes key by the ITEM_VARIATION
    // id, which only the raw catalog exposes (see square-recipe-mirror.ts).
    const { objects, locationId } = await fetchSquareStoreCatalog(prisma, new SquareClient(), posStoreId);
    const recipes = selectSquareRecipes(objects, locationId);
    console.error(
      `export-square-recipes: ${objects.length} catalog objects -> ${recipes.length} recipe rows (per variation) for ${posStoreId}.`
    );
    process.stdout.write(JSON.stringify(recipes));
  } catch (err) {
    if (err instanceof SquareStoreError) {
      console.error(
        err.kind === "not_found"
          ? `export-square-recipes: no store found for ${posStoreId}.`
          : `export-square-recipes: ${posStoreId} is not a Square store.`
      );
      process.exit(1);
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // Never let a raw SquareError (enumerable .body) hit stdout — log a coarse message to stderr.
  console.error("export-square-recipes: failed.", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
