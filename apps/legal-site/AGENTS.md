# apps/legal-site

Static site that hosts the Example Kitchen End User License Agreement, Privacy Policy, and Support page at https://legal.example.com, referenced by the Clover App Market listing.

## Stack

- Plain HTML + CSS, no JavaScript at runtime.
- Build step: a tiny zero-dependency markdown -> HTML converter (`src/build.mjs`) renders `docs/legal/*.md` into `dist/`.
- Runtime: `nginx:alpine` container serving the rendered files; clean URLs (`/eula`, `/privacy`, `/support`) handled by `try_files` in `nginx.conf`.
- Deployed as a plain `docker compose` stack on the existing Oracle host. Traefik labels in [`compose/legal.yml`](../../compose/legal.yml) reuse the wildcard `*.example.com` cert.

## Source of truth

The legal text lives in [docs/legal/](../../docs/legal/), not here. This app is presentation + delivery only. If a clause needs to change, edit the markdown — including its `**Last Updated:**` header line — and commit. The build parses that line per page, so there is no date constant in `src/build.mjs` to keep in sync.

## Commands

```bash
pnpm --filter @rop/legal-site build     # regenerate dist/
pnpm --filter @rop/legal-site preview   # serve dist/ on http://localhost:8080
pnpm --filter @rop/legal-site clean     # rm -rf dist/
```

The build script reads `../../docs/legal/*.md`, so an empty/missing `node_modules` is fine — no deps are required.

## Deployment

`.github/workflows/build-images.yml` builds the `linux/arm64` image on a self-hosted runner, pushes to `ghcr.io/example-org/rop-legal-site:main`, then SSHes to the Oracle host (`ORACLE_SSH_KEY` + `ORACLE_SSH_HOST`) and runs `scripts/deploy-stack.sh legal`, which git-syncs the host checkout to `origin/main` and runs `docker compose -f compose/legal.yml pull && up -d`. See [README.md](README.md) for the one-time host + GitHub-secret setup. Recorded in the Dokploy-removal ADR (supersedes ADR-0005 + ADR-0007).

The on-disk [`compose/legal.yml`](../../compose/legal.yml) is the source of truth, pulled directly by the SSH deploy — there is no separate sync step.

## Rules

- Do not put product UI here. This site is read-only legal/support documents only.
- Do not add tracking, analytics, cookies, or runtime JavaScript. A legal docs site that tracks visitors creates a recursive disclosure problem with its own Privacy Policy.
- Do not introduce npm dependencies unless the markdown subset needs to grow. The custom converter in `src/build.mjs` covers headings, bold, italic, links, ordered/unordered lists, GFM tables, horizontal rules, and inline code; that is the agreed scope.
- The `nginx.conf` ships strict CSP (`script-src 'none'`). Anything that would require relaxing CSP probably belongs on a different site.
- Do not give the container any env vars, mounts, or extra network access beyond the single `rop-net` bridge every stack shares ([ADR-0527](../../docs/decisions/0527-collapse-to-single-app-network.md)). A static site that can phone home is a future leak waiting to happen.

## Effective-date discipline

When you change a clause:

1. Edit the markdown in `docs/legal/`.
2. Update the `Effective Date` and `Last Updated` lines at the top of that file.
3. Append a row to that doc's `## Revision history` table summarizing the change.
4. Commit. GHA rebuilds the image (~1-2 min) and the SSH deploy step restarts the compose stack (~30 s).

The build parses the `**Last Updated:**` line from each markdown: the per-page footer shows that page's date, and the landing page shows the newest across all three. Because the date is sourced from the body there is no constant to drift — but a doc that is *missing* a `**Last Updated:**` line fails the build loudly. Clover audit reviewers do compare the footer date against the body, so keep the header line accurate.
