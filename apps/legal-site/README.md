# Example Kitchen Legal & Support Site

Static site served at **https://legal.example.com**, hosting the EULA, Privacy Policy, and Support page referenced by the Clover App Market listing.

## Local development

```bash
pnpm --filter @rop/legal-site build
pnpm --filter @rop/legal-site preview   # http://localhost:8080
```

The build script has **zero npm dependencies** — it only reads the markdown in `docs/legal/`, converts it inline, and writes the result to `dist/`. You can run it with stock Node 22+ even outside the monorepo.

Source markdown lives at:

- [docs/legal/EULA.md](../../docs/legal/EULA.md)
- [docs/legal/PRIVACY_POLICY.md](../../docs/legal/PRIVACY_POLICY.md)
- [docs/legal/SUPPORT.md](../../docs/legal/SUPPORT.md)

## How it deploys

Same model as the other Example Kitchen apps:

```
git push main
    │
    ▼  .github/workflows/build-images.yml (path-filtered, manual-only dispatch)
GHA self-hosted runner builds linux/arm64 image
    │
    ▼  docker push
ghcr.io/example-org/rop-legal-site:main
    │
    ▼  SSH to Oracle host → scripts/deploy-stack.sh legal
host git-syncs to origin/main, docker compose pull && up -d
    │
    ▼  Traefik labels on the container
https://legal.example.com  (wildcard cert reused — no new ACME)
```

Container: `nginx:alpine` serving the rendered HTML; clean URLs (`/eula`, `/privacy`, `/support`) are handled by `nginx.conf` `try_files`. Security headers (CSP `script-src 'none'`, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) are emitted by nginx.

The compose file at [`compose/legal.yml`](../../compose/legal.yml) carries the Traefik routing labels (`Host(\`legal.example.com\`)`, `tls.certresolver=production`). Because Traefik already holds a `*.example.com` wildcard cert (DNS-01 + Cloudflare API token), no ACME issuance is needed on first deploy.

## One-time host + GitHub setup

The build-and-deploy pipeline is wired but inert until the Oracle host can reach GHCR and the cross-stack bridge exists. Do this once:

1. **Prep the Oracle host**
   - Ensure the host has a `~/restaurant-ops-platform` git checkout tracking `origin/main` (`scripts/deploy-stack.sh` git-syncs it before each deploy).
   - Create the external bridge network once (shared by all app stacks): `docker network create rop-net`. The legal stack single-homes on it like every other stack — Traefik reaches the static site via its `traefik.docker.network=rop-net` label ([ADR-0527](../../docs/decisions/0527-collapse-to-single-app-network.md)).
   - A static site needs no secrets; a per-stack `compose/legal.env` (gitignored, template `.env.prod.example`) is optional and only relevant if you ever add env-driven config.

2. **Confirm the deploy secrets exist**

   At https://github.com/example-org/restaurant-ops-platform/settings/secrets/actions, `ORACLE_SSH_KEY` and `ORACLE_SSH_HOST` should already exist from the other apps; `build-images.yml` reuses them to SSH in and run `scripts/deploy-stack.sh legal`.

3. **Trigger the first build**

   `build-images.yml` is manual-only (ADR-0014). Run the **Build and push images (GHCR)** workflow via the Actions tab → **Run workflow** with `force_all: true`, or run `bash ~/restaurant-ops-platform/scripts/deploy-stack.sh legal` directly on the host once the image is in GHCR.

4. **Verify**
   ```bash
   curl -I https://legal.example.com/eula
   # Expect: HTTP/2 200, content-type: text/html, valid TLS, CSP header present.
   ```

That's it. Subsequent dispatches that pick up changes under `apps/legal-site/` or `docs/legal/` will rebuild and redeploy.

## Updating the legal text

1. Edit `docs/legal/{EULA,PRIVACY_POLICY,SUPPORT}.md`.
2. Update the `Effective Date` and `Last Updated` lines at the top of the file. The build parses each page's `**Last Updated:**` line (`parseLastUpdated()` in `src/build.mjs`); the footer shows that page's date and the landing page shows the newest across all three. There is no date constant in `src/build.mjs` to keep in sync.
3. Commit and push to `main`. GHA rebuilds the image (~1–2 min on the Mac Mini runner), the SSH deploy step restarts the compose stack (~30 s), and the new content is live.

For substantive changes (sub-processor list, retention windows, data categories), open a PR first so CI runs and you can review the diff.

## Submitting to the Clover App Market

Paste these URLs into the Clover Developer Dashboard:

- **End User License Agreement**: `https://legal.example.com/eula`
- **Privacy Policy**: `https://legal.example.com/privacy`
- **Support Website**: `https://legal.example.com/support`

All three return clean HTTP 200 with HTML content, no client-side redirects, strict-mode CSP — the four checks Clover's automated reviewer runs.

## Why Traefik on Oracle and not Cloudflare Pages

Both work. Traefik on the existing Oracle host won out because:

- Reuses the existing wildcard `*.example.com` cert — no DNS gymnastics around the wildcard CNAME conflicting with a specific subdomain CNAME.
- One deployment pipeline (GHCR + the SSH compose deploy) instead of two.
- No new SaaS dependency to remember when rotating CF tokens or auditing third-party sub-processors.

The CF Pages route stays viable if Oracle ever gets crowded — just stop the compose stack, remove the Traefik labels, and point `legal.example.com` at a Pages project.
