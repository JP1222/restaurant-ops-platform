# apps/marketing-site

Static marketing site for the EXAMPLE KITCHEN ice-cream shop at Anytown Mall, served at https://www.example.com. Customer-facing — menu, gift cards, hours, mall map, photos. Different audience from `apps/backoffice-web` (owner/manager admin) and `apps/kds-web` (kitchen Floor).

## Stack

- Plain HTML + CSS + a single static JavaScript file (`src/script.js`). No framework, no bundler, no Node at runtime.
- Build step: a tiny zero-dependency copy script (`src/build.mjs`) that mirrors `src/` into `dist/` so nginx can serve it. The HTML is hand-written, not generated — the script just stages assets.
- Runtime: `nginx:alpine` container serving the static files; clean URLs handled by `try_files` in `nginx.conf`.
- Deployed as a plain `docker compose` stack on the existing Oracle host. Traefik labels in [`compose/marketing.yml`](../../compose/marketing.yml) reuse the wildcard `*.example.com` cert.

## What the site has

- **Hero** with the slogan "You only ROLL once." (the three lines have different sizes — 88/180/124px clamp scales — keep the rhythm).
- **Scrolling marquee** strip.
- **How we roll** five-step explainer.
- **Menu** with three tabs (Rolled Ice Cream / Bubble Tea / Smoothies). Tab switch is client-side JS.
- **Signature Series** — three feature products.
- **Reviews** card grid.
- **Gallery** — photo wall.
- **Gift cards** — amount picker is client-side JS; "send card" link is a placeholder until a real gift card processor is wired up.
- **Visit** — address, hours, storefront photo, mall map with a "you are here" pin.
- **Order CTA** + **Footer**.

## Source of truth

This app is self-contained: HTML, CSS, JS, and the image assets all live under `apps/marketing-site/src/`. Nothing under `docs/` or other apps feeds into the build, unlike `apps/legal-site` which reads from `docs/legal/`.

Brand palette is **Berry** (the prototype had three options, we shipped one). Hex values are in `src/styles.css` under `:root`. If marketing requests a palette change, edit those vars; don't add a runtime theme switcher.

## Commands

```bash
pnpm --filter @rop/marketing-site build     # regenerate dist/
pnpm --filter @rop/marketing-site preview   # serve dist/ on http://localhost:8081
pnpm --filter @rop/marketing-site clean     # rm -rf dist/
```

The build script reads only its own `src/`, so an empty/missing `node_modules` is fine — no deps are required.

## Deployment

`.github/workflows/build-images.yml` builds the `linux/arm64` image on a self-hosted runner, pushes to `ghcr.io/example-org/rop-marketing-site:main`, then SSHes to the Oracle host (`ORACLE_SSH_KEY` + `ORACLE_SSH_HOST`) and runs `scripts/deploy-stack.sh marketing`, which git-syncs the host checkout to `origin/main` and runs `docker compose -f compose/marketing.yml pull && up -d`. See [README.md](README.md) for the one-time host + GitHub-secret setup. Recorded in the Dokploy-removal ADR (supersedes ADR-0005 + ADR-0007).

The on-disk [`compose/marketing.yml`](../../compose/marketing.yml) is the source of truth, pulled directly by the SSH deploy — there is no separate sync step.

## Rules

- **No tracking, no analytics, no third-party scripts.** A storefront marketing site that ships pixels back to ad networks is both creepy and a Privacy Policy problem. If we want product analytics later, do it server-side from access logs.
- **No backend integrations on this surface.** Order CTA links to the (eventual) ordering site; gift card CTA is a stub. If/when a real gift card processor or POS integration lands, it lives in another app and this site links to it.
- **One Dockerfile, one nginx, no Node runtime in production.** Adding a JS framework here means owning a build cache and a runtime container — overkill for 12 sections.
- **CSP is strict.** `script-src 'self'` only — our own `/script.js` runs the tabs, gift card amount picker, and scroll-aware nav. Inline scripts are blocked. If a new interaction needs more JS, add it to `script.js`; don't loosen CSP.
- **No customer PII processed here.** No forms, no email capture, no cookies. Newsletter signup (if ever added) goes through a separate hosted service.
- **Iron Law boundary**: this is a Floor-and-public-adjacent product, not Backoffice. Don't bolt analytics widgets, inventory views, or internal admin onto this surface — that belongs in `apps/backoffice-web`.

## Image assets

The `src/public/` directory holds the signature product photos, the storefront photo, and the mall map — all as WebP at quality 80 (converted from the original PNG/JPG with `cwebp`, ~92% size reduction vs the prototype's raw PNGs). Total under 1.5 MB. They are committed to the repo because they're product brand assets.

When you replace a photo, encode the new file as WebP at the same filename:

```bash
cwebp -q 80 path/to/new-photo.png -o apps/marketing-site/src/public/signatures/signature_1.webp
```

If you want a different quality / lossless / AVIF, change the encoder call — nothing in the build script cares about the encoder, just that the file at the referenced path exists.
