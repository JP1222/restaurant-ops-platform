# Contracts Agents

`packages/contracts` owns shared Zod schemas and TypeScript contracts that generate client-facing DTOs.

Use these checks when relevant:

- `pnpm --filter @rop/contracts build`
- `pnpm --filter @rop/contracts lint`
- `pnpm --filter @rop/contracts test`

Do:

- Treat this package as the source for network DTO changes.
- Regenerate downstream native contracts when schema changes affect `ios/Packages/YRCore`.
- Keep provider-neutral app-facing shapes separate from provider-specific webhook payloads.
- Coordinate API, web, and native updates when changing public contract fields.

Do not:

- Patch generated Swift contracts by hand.
- Add UI-only convenience fields unless the backend contract intentionally exposes them.
- Hide breaking schema changes without tests and migration notes.
