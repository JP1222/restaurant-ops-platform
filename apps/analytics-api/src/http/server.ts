import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { DbPool } from "../db.js";
import { createLogger, errorMessage } from "../lib/log.js";
import { headerRequestId, requestContext } from "../lib/request-context.js";
import type { SyncTargetsRepository } from "../sync-targets/repository.js";
import { handleAdminSyncTargets, handleAdminWebhookVerifications } from "./admin.js";
import { handleAdminDashboard } from "./dashboard.js";
import { handleHealth, handleReady, respondJson } from "./health.js";
import { handleInventorySoldItems } from "./inventory-feed.js";
import { handleMetrics } from "./metrics.js";
import { handleCloverWebhook } from "./webhooks.js";

const log = createLogger("http");

export function startHttpServer(
  pool: DbPool,
  config: AppConfig,
  syncTargets: SyncTargetsRepository
): Server {
  const server = createServer((req, res) => {
    // Adopt a caller-supplied x-request-id (or generate one), echo it back, and
    // run the route inside the request scope so every log line carries it.
    const requestId = headerRequestId(req.headers["x-request-id"]) ?? randomUUID();
    res.setHeader("x-request-id", requestId);
    const startedAt = Date.now();
    const path = (req.url ?? "/").split("?", 1)[0]!;
    // Skip the high-frequency liveness/scrape endpoints so the access log can't
    // flood Loki (Prometheus hits /metrics every 30s; probes hit /healthz,/readyz).
    const accessLogged = path !== "/healthz" && path !== "/readyz" && path !== "/metrics";
    res.on("finish", () => {
      if (!accessLogged) return;
      requestContext.run({ requestId }, () => {
        log.info("request", {
          method: req.method,
          path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt
        });
      });
    });
    requestContext.run({ requestId }, () => {
      void route(req, res, pool, config, syncTargets).catch((error) => {
        log.error(`HTTP handler failed: ${errorMessage(error)}`);
        respondJson(res, 500, { error: "internal error" });
      });
    });
  });

  server.listen(config.healthPort, () => {
    log.info(`Service HTTP server listening on :${config.healthPort}`, { port: config.healthPort });
  });

  return server;
}

async function route(
  req: Parameters<typeof handleCloverWebhook>[0],
  res: Parameters<typeof handleCloverWebhook>[1],
  pool: DbPool,
  config: AppConfig,
  syncTargets: SyncTargetsRepository
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    return handleHealth(res);
  }
  if (req.method === "GET" && url.pathname === "/readyz") {
    return handleReady(res, pool);
  }
  // Unauthenticated like /healthz: Prometheus scrapes this over the internal
  // network without a token.
  if (req.method === "GET" && url.pathname === "/metrics") {
    return handleMetrics(res);
  }
  if (req.method === "GET" && url.pathname === "/admin/webhook-verifications") {
    return handleAdminWebhookVerifications(req, res, pool, config);
  }
  // Registered before the generic /admin/ catch below so the dashboard handler
  // doesn't swallow it.
  if (req.method === "POST" && url.pathname === "/admin/api/sync-targets") {
    return handleAdminSyncTargets(req, res, config, syncTargets);
  }
  // Sold-items feed consumed by inventory-api's depletion poll (ADR-0028).
  // Registered before the /admin/ dashboard catch so it isn't swallowed.
  if (req.method === "GET" && url.pathname === "/admin/api/inventory/sold-items") {
    return handleInventorySoldItems(req, res, pool, config, url);
  }
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    return handleAdminDashboard(req, res, pool, config, url, syncTargets);
  }
  if (req.method === "POST" && url.pathname === "/webhooks/clover") {
    return handleCloverWebhook(req, res, pool, config);
  }
  return respondJson(res, 404, { error: "not found" });
}
