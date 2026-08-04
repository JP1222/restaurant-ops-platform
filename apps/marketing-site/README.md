# EXAMPLE KITCHEN Marketing Site

Static customer-facing site served at **https://www.example.com**, designed to live alongside the Clover App Market listing and Google / Yelp / Instagram links.

Source design: handoff bundle from Claude Design ("v3 Scoop Shop" direction). Berry palette, "You only ROLL once." slogan, twelve scrolling sections.

## Local development

```bash
pnpm --filter @rop/marketing-site build     # writes dist/
pnpm --filter @rop/marketing-site preview   # http://localhost:8081
```

The build script has **zero npm dependencies** — it just stages `src/` (HTML, CSS, JS, images) into `dist/` so nginx has a clean tree to serve. You can run it with stock Node 22+ even outside the monorepo.

## How it deploys

Same model as the other Example Kitchen apps:

```
git push main
    │
    ▼  .github/workflows/build-images.yml (path-filtered on apps/marketing-site/**, manual-only dispatch)
GHA self-hosted runner builds linux/arm64 image
    │
    ▼  docker push
ghcr.io/example-org/rop-marketing-site:main
    │
    ▼  SSH to Oracle host → scripts/deploy-stack.sh marketing
host git-syncs to origin/main, docker compose pull && up -d
    │
    ▼  Traefik labels on the container
https://www.example.com  (wildcard cert reused — no new ACME)
```

Container: `nginx:alpine` serving the static files; clean URLs handled by `nginx.conf` `try_files`. Security headers (CSP `script-src 'self'`, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) are emitted by nginx.

The compose file at [`compose/marketing.yml`](../../compose/marketing.yml) carries the Traefik routing labels (``Host(`www.example.com`)``, `tls.certresolver=production`). Because Traefik already holds a `*.example.com` wildcard cert (DNS-01 + Cloudflare API token), no ACME issuance is needed on first deploy.

## One-time host + GitHub setup

The build-and-deploy pipeline is wired but inert until the Oracle host can reach GHCR and the cross-stack bridge exists. Do this once:

1. **Prep the Oracle host**
   - Ensure the host has a `~/restaurant-ops-platform` git checkout tracking `origin/main` (`scripts/deploy-stack.sh` git-syncs it before each deploy).
   - Create the external bridge network once (shared by all app stacks): `docker network create rop-net`. The marketing stack single-homes on it like every other stack — Traefik reaches the static site via its `traefik.docker.network=rop-net` label ([ADR-0527](../../docs/decisions/0527-collapse-to-single-app-network.md)).
   - A static site needs no secrets; a per-stack `compose/marketing.env` (gitignored, template `.env.prod.example`) is optional and only relevant if you ever add env-driven config.

2. **Confirm the deploy secrets exist**

   At https://github.com/example-org/restaurant-ops-platform/settings/secrets/actions, `ORACLE_SSH_KEY` and `ORACLE_SSH_HOST` should already exist from the other apps; `build-images.yml` reuses them to SSH in and run `scripts/deploy-stack.sh marketing`.

3. **Add the DNS record**

   In Cloudflare, add `www.example.com` → A record → Oracle host IP, **DNS only** (gray cloud). The wildcard cert already covers it; no per-subdomain ACME work.

4. **Trigger the first build**

   `build-images.yml` is manual-only (ADR-0014). Run the **Build and push images (GHCR)** workflow via the Actions tab → **Run workflow** with `force_all: true`, or run `bash ~/restaurant-ops-platform/scripts/deploy-stack.sh marketing` directly on the host once the image is in GHCR.

5. **Verify**
   ```bash
   curl -I https://www.example.com/
   # Expect: HTTP/2 200, content-type: text/html, valid TLS, CSP header present.
   ```

That's it. Subsequent dispatches that pick up changes under `apps/marketing-site/` will rebuild and redeploy.

## Editing the site

The site is twelve hand-written HTML sections in `src/index.html`. To change content:

| Want to change | File |
| --- | --- |
| Headline, copy, hours, address | `src/index.html` |
| Brand colors, fonts, spacing | `src/styles.css` (CSS custom properties in `:root`) |
| Menu tabs, gift card amounts, scroll behavior | `src/script.js` |
| Signature product photo | encode the new file as WebP at the same filename under `src/public/signatures/` |
| Storefront photo | replace `src/public/storefront-photo.webp` (encode with `cwebp -q 80 new.jpg -o storefront-photo.webp`) |
| Mall map | replace `src/public/mall-map.webp` |

Pricing and menu items are presently hard-coded into `src/index.html`. If they start changing weekly, move them into a small JSON file the build step reads — but until then, in-source is fine.

## Why static HTML and not Next.js / Astro

- The site has no auth, no DB, no API, no per-user content. Every visitor sees the same twelve sections. There is nothing for a framework to do.
- Lighthouse / Core Web Vitals matter for SEO. Pre-gzipped static HTML served by nginx beats any framework's SSR by a healthy margin and ships <5 KB of JS for the entire site.
- `apps/legal-site` already proves the nginx + docker compose + Traefik pattern on this repo. Reuse beats novelty.
- If we later want a blog, a CMS, or content collections, migrating to Astro is an afternoon — the design is component-shaped already.
