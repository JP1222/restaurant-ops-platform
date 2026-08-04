# Vendored fonts

These `.woff2` files are self-hosted via `next/font/local` (see `../layout.tsx`) so
that `next build` never reaches out to `fonts.googleapis.com` / `fonts.gstatic.com`.
The self-hosted Mac CI runners intermittently can't reach Google at build time, which
turned font fetching into a flaky, non-hermetic build step. Switching from
`next/font/google` to vendored files makes the build deterministic.

The four families ARE the "Berry" brand (Claude Design handoff) — Bagel Fat One
(wordmark), Caprasimo (display/headings), DM Sans (body/UI/buttons), Geist Mono
(eyebrows/meta). Vendoring is a build-infra choice only; `next/font/local` keeps
`next build` hermetic.

| Font | File | Type | Weight axis | Source | License |
| --- | --- | --- | --- | --- | --- |
| Bagel Fat One | `bagel-fat-one-latin-400-normal.woff2` | static | `400` | `@fontsource/bagel-fat-one@5.2.7` | OFL-1.1 (`bagel-fat-one.LICENSE`) |
| Caprasimo | `caprasimo-latin-400-normal.woff2` | static | `400` | `@fontsource/caprasimo` | OFL-1.1 (`caprasimo.LICENSE`) |
| DM Sans | `dm-sans-latin-wght-normal.woff2` | variable | `100 1000` | `@fontsource-variable/dm-sans@5.2.8` | OFL-1.1 (`dm-sans.LICENSE`) |
| Geist Mono | `geist-mono-latin-wght-normal.woff2` | variable | `100 900` | `@fontsource-variable/geist-mono@5.2.8` | OFL-1.1 (`geist-mono.LICENSE`) |

Files are the `latin` subset, copied verbatim from the published Fontsource packages
(which mirror Google Fonts). To refresh: `npm pack <pkg>`, extract, and copy
`files/<name>-latin-{wght-normal,400-normal}.woff2` plus `LICENSE` here.
