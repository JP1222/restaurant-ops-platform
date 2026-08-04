# Traefik Configuration

This directory holds Traefik **dynamic** configuration files that ship alongside
the monorepo but are deployed out-of-band into the existing Traefik instance on
the production host (currently `oracle:~/restaurant-ops-platform/`).

Per-service routing (KDS, analytics-api, backoffice) lives as **Docker labels**
inside the respective `docker-compose*.yml` files at the repo root, picked up
via Traefik's Docker provider. Files in this directory are for routes that
**cannot** be expressed as labels on a single container — e.g. the Clover
webhook fan-out, which mirrors one request to two backends across two
compose projects.

---

## Files

| File | Purpose |
|---|---|
| [`dynamic/clover-webhook-fanout.yml`](dynamic/clover-webhook-fanout.yml) | Fan-out router that mirrors `https://webhooks.example.com/clover` to both kds-api and analytics-api. See `HANDOFF-clover-webhook-fanout.md` for the deployment runbook. |

---

## Deploying a dynamic file

1. `scp infrastructure/traefik/dynamic/<file>.yml oracle:/etc/traefik/dynamic/`
   (or wherever your Traefik static config's `providers.file.directory` points)
2. Traefik watches that directory by default; the config is hot-reloaded.
3. Verify by hitting the Traefik dashboard or API:
   ```
   curl -s http://127.0.0.1:8080/api/http/routers | jq '.[].name'
   curl -s http://127.0.0.1:8080/api/http/services | jq '.[].name'
   ```

If your Traefik instance does not have a file provider configured yet, add to
its static config (usually `traefik.yml`):

```yaml
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
```

---

## Why fan-out lives here and not in compose labels

Traefik `mirroring` services reference **other services by name**. With the
Docker provider, service names are auto-generated as `<labelname>@docker` and
scoped to the container that defines them. Defining a mirroring service that
points at backends across **two different compose projects** (rop-kds
and rop-intelligence) is awkward via labels and clean via the file
provider — so the fan-out router and its mirror service definition live here.
