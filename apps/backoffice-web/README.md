# Backoffice Web

Next.js 16 admin / analytics / inventory UI for owners and managers (the Backoffice product). Hosts Analytics dashboards, KDS Admin, Inventory management, and the floating AI assistant. English-only, Light + Dark mode.

See [AGENTS.md](AGENTS.md) for the full charter, hard rules, and verification checklist.

## Getting Started

Run the development server:

```bash
pnpm --filter @rop/backoffice-web dev
```

Open [http://localhost:3001](http://localhost:3001) with your browser to see the result.

The app routes live under `app/(authed)/*`; `app/(authed)/page.tsx` redirects to `/today`. There is no top-level `app/page.tsx`. Everything except `/login` and `/api/auth/*` requires auth.

Fonts are vendored Inter + JetBrains Mono via `next/font/local` — see [`app/fonts/README.md`](app/fonts/README.md).

## Deploy

Deploys run on plain docker compose + Traefik on the Oracle host, fronted at `backoffice.example.com`. Images are built by the user-gated `build-images.yml` workflow (GHCR), not Vercel. See [OPERATIONS.md](../../OPERATIONS.md) for the deploy pipeline.
