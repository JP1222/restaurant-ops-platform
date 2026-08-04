// One-shot Square recipe-mirror importer (store #2; docs/square-onboarding.md).
//
// Reads a SquareRecipeImport JSON array on stdin (produced by kds-api's
// export-square-recipes.ts) and upserts one InventoryRecipe per row, keyed by
// square_catalog_object_id, via syncRecipesFromSquare. Idempotent: re-running refreshes
// name/category/price and leaves BOM lines untouched (those are filled later in the
// editor). The synced recipe id is namespaced `square:{id}` so it never collides with
// a Clover recipe.
//
// inventory-api never holds a Square token (Iron Law 1) — the catalog is fetched
// upstream by kds-api and piped here as JSON, validated against the shared contract on
// read (the trust boundary).
//
//   ... export-square-recipes.ts | INVENTORY_DATABASE_URL=... \
//     pnpm --filter @rop/inventory-api exec tsx scripts/import-square-recipes.ts [--dry-run]
import { SquareRecipeImportSchema } from "@rop/contracts";
import { createPrismaClient } from "@rop/db-inventory";

import { syncRecipesFromSquare } from "../src/lib/inventory-store.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const raw = (await readStdin()).trim();
  if (raw === "") {
    console.error("import-square-recipes: no JSON on stdin (pipe export-square-recipes.ts into this).");
    process.exit(1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    console.error("import-square-recipes: stdin is not valid JSON.");
    process.exit(1);
  }

  // Trust boundary (Iron Law 2): validate the cross-app payload before any DB write.
  const recipes = SquareRecipeImportSchema.parse(parsedJson);
  console.log(`Parsed ${recipes.length} Square recipe rows:`);
  for (const r of recipes) {
    console.log(`  [${r.category}] ${r.name} — $${(r.priceCents / 100).toFixed(2)}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: no database writes.");
    return;
  }

  const dbUrl = process.env.INVENTORY_DATABASE_URL;
  if (!dbUrl) {
    console.error("\nINVENTORY_DATABASE_URL is required to apply (omit only with --dry-run).");
    process.exit(1);
  }

  const prisma = createPrismaClient(dbUrl);
  try {
    const result = await syncRecipesFromSquare(prisma, recipes);
    console.log(`\nSynced: ${result.created} created, ${result.updated} updated.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("import-square-recipes: failed.", err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
