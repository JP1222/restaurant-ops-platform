# Backoffice Web Agents

`apps/backoffice-web` hosts Analytics dashboards, KDS Admin migration, Inventory management (overview, items, waste, counts, recipes, vendors, receiving, 86), and the floating AI assistant. Modern Fintech aesthetic, English-only UI, Light + Dark mode, port 3001.

Use these checks when relevant:

- `pnpm --filter @rop/backoffice-web build`
- `pnpm --filter @rop/backoffice-web typecheck`
- `pnpm --filter @rop/backoffice-web lint`
- `pnpm --filter @rop/backoffice-web dev` # http://localhost:3001

## Hard rules - DO NOT VIOLATE

### Components

1. Never hand-write a component if shadcn/ui has it. Run `pnpm dlx shadcn@latest add <name>` first, then customize.
2. Never hand-write SVG charts. Always use `<ChartContainer>` from `@/components/ui/chart`.
3. Never hand-write a sidebar, dialog, sheet, dropdown, command palette, or table.
4. Never introduce a second component library (Tremor, MUI, Ant, Chakra). shadcn only. (Carve-out: single-purpose generator utilities that aren't UI kits — e.g. `qrcode.react`, used for the device-pairing QR in `components/admin/add-device-dialog.tsx` — are fine; they render one thing and don't compete with shadcn for components.)

### Design tokens

5. All colors via CSS variables exposed by `globals.css`. Never hardcode hex/rgb except in `globals.css` itself.
6. All spacing via Tailwind `space-N` (4px grid). Avoid arbitrary `p-[13px]` values.
7. All numbers `tabular-nums`. All money via shared `lib/format.ts` helpers.
8. All chart colors via `chart-1..6` tokens.
9. Trend up = `var(--trend-up)` (green), trend down = `var(--trend-down)` (red). Never reverse.

### Data

10. All data fetching via TanStack Query hooks under `hooks/use-*.ts`. Never call `fetch` directly in components.
11. All analytics API calls go through BFF Route Handlers and `lib/analytics-api/*`. Browser code never talks to analytics-api or kds-api directly.
12. All shared zod schemas live in `packages/contracts`.

### AI

13. AI tool definitions ONLY in `lib/ai/tools.ts` (Phase 7). Each tool requires both a backend typed endpoint AND a tool definition.
14. Never call AI provider SDK from the browser. All AI calls go through `/api/ai/chat` Route Handler.

### Settings

15. Runtime-tunable config (model id, rate limits, kill switches, future Clover thresholds) lives in `app_setting` rows. Every new key must be registered in `packages/contracts/src/settings.ts` with a zod schema, default, and category. See [ADR-0016](../../docs/decisions/0016-app-setting-table.md).
16. Operator-rotatable secrets (AI provider API keys, future Clover OAuth tokens — anything an operator might rotate without a redeploy) live in `app_setting` rows with `category=secret`. Values are AES-GCM encrypted at rest (PR #251) with the master key in `APP_SETTING_ENCRYPTION_KEY`, masked in the BFF list response, and revealed via the audited per-key GET. Consumers should read via `lib/settings` (which decrypts transparently) and cache with a short TTL; PUT `/api/settings` invalidates the cache for the key (see `lib/ai/deepseek-provider.ts` for the canonical pattern). The list of envs that STAY in env is the bootstrap set only: `DATABASE_URL`, `APP_SETTING_ENCRYPTION_KEY`, `KDS_INTERNAL_ADMIN_TOKEN`, `SESSION_SECRET`, and the Infisical machine-identity secret-zero (`INFISICAL_MACHINE_CLIENT_ID` / `INFISICAL_MACHINE_CLIENT_SECRET`). Layer-1 runtime secrets (`ANALYTICS_ADMIN_TOKEN`, `INVENTORY_INTERNAL_TOKEN`, `REDIS_URL`) now arrive via the with-infisical entrypoint at runtime, not as static compose env, per ADR-0020 §3. New env-shaped secrets should land in `app_setting` from day one. (Supersedes ADR-0017 §6 for `ai.deepseek_api_key`.)
17. `app_setting.merchantId` is a *scope id* for the multi-location model ([ADR-0018](../../docs/decisions/0018-multi-location-architecture.md)). Each registered key declares a `tier`: **brand**-tier keys share `BRAND_SCOPE_ID` (`"default-merchant"`, preserved from schema V2); **location**-tier keys are scoped by a `Location.id`. The scope resolver in `lib/settings/db.ts` is the single chokepoint; no code outside `lib/settings/**` should reference `BRAND_SCOPE_ID`. Location reads go through `lib/location/**` (a db-kds carve-out, same bounded-exception pattern as `lib/settings/**`).

### Code style

18. No inline comments unless the WHY is non-obvious.
19. No `console.log` in committed code.
20. No emojis in UI text. (Carve-out: the **item icon** is operator-chosen catalog data — a sibling to the item photo — not UI chrome. The curated emoji catalog in `lib/item-icons.ts` and the emoji a merchant picks for an item are data, not interface copy, so they're exempt from this rule. Don't sprinkle emojis into labels, buttons, headings, or toasts.)
21. No TypeScript `any`. Use `unknown` + narrow.

### Performance

22. Default `staleTime: 60_000` for TanStack Query (mart MVs refresh every 5min, no point hammering).

## Auth

- Backoffice uses `@rop/auth` for all auth logic. No password hashing or WebAuthn server verification in UI components.
- Routes under `app/api/auth/*` are the BFF. They wrap `@rop/auth/server` helpers. Browser code never imports `@rop/auth/server`.
- Cookie name: `BACKOFFICE_SESSION_COOKIE_NAME` env var. It is distinct from KDS's cookie so local dev on ports 3000 and 3001 does not collide.
- Proxy in `proxy.ts` redirects unauthenticated page requests to `/login?from=<path>` and returns 401 JSON for protected `/api/*` requests.
- New protected routes should move under an authenticated route group when the sidebar layout lands. For now everything except `/login` and `/api/auth/*` requires auth.
- **Multi-tenant analytics claim (ADR-0818 Phase 2c):** `lib/analytics-api/client.ts` attaches a signed `AnalyticsTenantClaim` (`x-tenant-claim` header) on authenticated analytics calls, minted by `lib/analytics-api/tenant-claim.ts` from the session's tenant (the session carries `tenantId` since Phase 2b) using the shared HMAC secret `ANALYTICS_TENANT_SIGNING_KEY` via `@rop/auth/tenant-claim`. **Dormant by default** — when the key is unset the minter returns null and no header is sent (analytics stays in off-mode), so it never reads the session on the default path. analytics-api verifies the claim + checks the merchant against its own `sync_targets.tenant_id`. See `apps/analytics-api/src/lib/tenant-auth.ts`.

## Verification before "done"

- `pnpm typecheck` clean
- `pnpm lint` clean
- `pnpm test` clean
- `pnpm test:e2e` clean
- `pnpm dev` -> http://localhost:3001 renders the page
