/**
 * Settings scope ids for the multi-location model (ADR-0018).
 *
 * Every `app_setting` row is keyed by `(merchantId, key)`, where `merchantId`
 * is really a *scope id*. Brand-tier keys (the default) share one scope —
 * `BRAND_SCOPE_ID`, whose value stays `"default-merchant"` so rows written
 * under the pre-multi-location schema (V2 / issue #245) are preserved without
 * a backfill. Location-tier keys are scoped by a `Location.id` instead; the
 * scope resolver in `./db.ts` picks the right one per key via its registered
 * `tier` (see `packages/contracts/src/settings.ts`).
 *
 * No code outside `lib/settings/**` should reference `BRAND_SCOPE_ID`.
 */
export const BRAND_SCOPE_ID = "default-merchant";
