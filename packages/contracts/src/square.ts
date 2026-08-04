import { z } from "zod";

// Square POS onboarding contracts (store #2). The connect flow is POS-neutral at
// the data layer (see docs/square-onboarding.md): an operator pastes a Square
// access token (a PAT today; an OAuth-exchanged token later — same shape) and
// picks the environment; the backend validates it, lists the seller's locations,
// and persists one PosAccount + one PosStore per location. The token is a
// WRITE-ONLY secret — the response schemas here NEVER carry it (only a masked
// last-4 echo). `square` is already in the `orderProviders` tuple (index.ts).

export const squareEnvironments = ["sandbox", "production"] as const;
export const SquareEnvironmentSchema = z.enum(squareEnvironments);
export type SquareEnvironment = z.infer<typeof SquareEnvironmentSchema>;

// Browser -> BFF -> kds-api body for BOTH /api/square/test-connection and
// /api/square/connect. `accessToken` is the operator-pasted secret (write-only);
// `environment` is the sandbox/production toggle.
export const SquareConnectRequestSchema = z.object({
  accessToken: z.string().min(1),
  environment: SquareEnvironmentSchema
});
export type SquareConnectRequest = z.infer<typeof SquareConnectRequestSchema>;

// One Square location, summarised for the wizard's location-select step.
export const SquareLocationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  currency: z.string()
});
export type SquareLocationSummary = z.infer<typeof SquareLocationSummarySchema>;

// Validate-only result (persists nothing) the wizard shows after "Test
// connection": the merchant display name + the location list. Never the token.
export const SquareTestConnectionResponseSchema = z.object({
  merchantId: z.string(),
  merchantName: z.string(),
  environment: SquareEnvironmentSchema,
  locations: z.array(SquareLocationSummarySchema)
});
export type SquareTestConnectionResponse = z.infer<typeof SquareTestConnectionResponseSchema>;

// A PosStore created by /api/square/connect. `posStoreId` is the synthetic
// `square:{location_id}` PK the bind step POSTs as `merchantId` to the existing
// POS-agnostic bind route; `locationId` is null until that bind happens.
export const SquareConnectStoreSchema = z.object({
  posStoreId: z.string(),
  providerStoreId: z.string(),
  name: z.string(),
  timezone: z.string(),
  currency: z.string(),
  locationId: z.string().nullable()
});
export type SquareConnectStore = z.infer<typeof SquareConnectStoreSchema>;

// Result of the persisting /api/square/connect. `tokenLast4` is a masked echo
// only — the token itself is never returned (write-only secret).
export const SquareConnectResponseSchema = z.object({
  posAccountId: z.string(),
  merchantId: z.string(),
  merchantName: z.string(),
  environment: SquareEnvironmentSchema,
  tokenLast4: z.string(),
  stores: z.array(SquareConnectStoreSchema)
});
export type SquareConnectResponse = z.infer<typeof SquareConnectResponseSchema>;

// Catalog / menu import (wizard step 4). `posStoreId` is the synthetic
// `square:{location_id}` PK of the (already connected + bound) store to import
// for; the token is resolved server-side from its PosAccount — the browser never
// re-sends it. Like the menu read, "import" reads the LIVE Square catalog and
// returns counts (ADR-0027: menu = POS inventory, nothing is persisted here).
export const SquareImportCatalogRequestSchema = z.object({
  posStoreId: z.string().min(1)
});
export type SquareImportCatalogRequest = z.infer<typeof SquareImportCatalogRequestSchema>;

// Counts surfaced after a catalog import ("imported N items, M modifiers"). The
// shape is provider-neutral so a future Clover re-import can reuse it. `durationMs`
// is the server-measured fetch+normalize time (UX: "took 1.2s").
export const CatalogImportResultSchema = z.object({
  itemCount: z.number().int().min(0),
  modifierCount: z.number().int().min(0),
  categoryCount: z.number().int().min(0),
  durationMs: z.number().int().min(0)
});
export type CatalogImportResult = z.infer<typeof CatalogImportResultSchema>;

// One flat recipe-mirror row in the kds-api -> inventory-api seeding pipe (store #2;
// docs/square-onboarding.md). kds-api holds the Square token + normalizes the live
// catalog (scripts/export-square-recipes.ts); inventory-api owns the recipe DB
// (scripts/import-square-recipes.ts -> syncRecipesFromSquare). The two are siblings
// that never call each other, so the catalog crosses as validated JSON, not an HTTP
// call — and as a cross-app DTO it lives here (Iron Law 2), validated on the inventory
// side as the trust boundary. `squareCatalogObjectId` is the bare Square ITEM_VARIATION
// CatalogObject id — the id an order line references (`catalogObjectId`) and the one the
// analytics sold-items feed carries (on its wire field `square_catalog_item_id`), so the
// depletion join matches on it. Named "object" not "item" because orders reference the
// variation, NOT the parent ITEM id, so one recipe is seeded per variation. Inventory
// namespaces the recipe PK as `square:{id}`.
export const SquareRecipeImportRowSchema = z.object({
  squareCatalogObjectId: z.string().min(1),
  name: z.string().min(1),
  category: z.string(),
  priceCents: z.number().int().nonnegative()
});
export const SquareRecipeImportSchema = z.array(SquareRecipeImportRowSchema);
export type SquareRecipeImportRow = z.infer<typeof SquareRecipeImportRowSchema>;
export type SquareRecipeImport = z.infer<typeof SquareRecipeImportSchema>;
