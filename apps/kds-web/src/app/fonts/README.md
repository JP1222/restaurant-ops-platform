# Vendored fonts

These `.woff2` files are self-hosted via `next/font/local` (see `../layout.tsx`) so
that `next build` never reaches out to `fonts.googleapis.com` / `fonts.gstatic.com`.
The self-hosted Mac CI runners intermittently can't reach Google at build time, which
turned font fetching into a flaky, non-hermetic build step. Switching from
`next/font/google` to vendored files makes the build deterministic.

Same family, weights, and CSS variables as before — purely a build-infra change, no
visual difference.

| Font | File | Type | Weight axis | Source | License |
| --- | --- | --- | --- | --- | --- |
| Bagel Fat One | `bagel-fat-one-latin-400-normal.woff2` | static | `400` | `@fontsource/bagel-fat-one@5.2.7` | OFL-1.1 (`bagel-fat-one.LICENSE`) |
| Nunito | `nunito-latin-wght-normal.woff2` | variable | `200 1000` | `@fontsource-variable/nunito@5.2.7` | OFL-1.1 (`nunito.LICENSE`) |

Files are the `latin` subset, copied verbatim from the published Fontsource packages
(which mirror Google Fonts). To refresh: `npm pack <pkg>`, extract, and copy
`files/<name>-latin-{wght-normal,400-normal}.woff2` plus `LICENSE` here.
