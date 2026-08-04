// One-shot importer for the owner-filled BOM template (ADR-0028).
// Usage: INVENTORY_DATABASE_URL=... pnpm --filter @rop/inventory-api exec tsx scripts/import-bom.ts <bom.csv>
// Idempotent — safe to re-run after editing the CSV. The parse/import logic lives
// in src/lib/bom-import.ts (built + unit/integration tested); this is a thin runner.
import { readFileSync } from "node:fs";

import { createPrismaClient } from "@rop/db-inventory";

import { buildBomPlan, importBom, parseCsv } from "../src/lib/bom-import.js";

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  const dbUrl = process.env.INVENTORY_DATABASE_URL;
  if (!csvPath) {
    console.error("usage: INVENTORY_DATABASE_URL=... tsx scripts/import-bom.ts <bom.csv>");
    process.exit(1);
  }
  if (!dbUrl) {
    console.error("INVENTORY_DATABASE_URL is required");
    process.exit(1);
  }
  const plan = buildBomPlan(parseCsv(readFileSync(csvPath, "utf8")));
  const prisma = createPrismaClient(dbUrl);
  try {
    const result = await importBom(prisma, plan);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
