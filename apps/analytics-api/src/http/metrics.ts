import type { ServerResponse } from "node:http";
import client from "prom-client";

// Prometheus scrapes `analytics-api:3100/metrics` (see
// observability/prometheus/prometheus.yml). We expose prom-client's default
// series — process CPU, RSS/heap, event-loop lag, GC pauses,
// process_start_time_seconds (restart detection) and nodejs_version_info — plus
// the domain rop_backfill_* gauges registered on this same default registry by
// src/metrics/backfill-gauges.ts (populated out-of-band by
// BackfillMetricsUpdater, never inside this scrape handler). That turns the
// `analytics-api` target from up=0 into a liveness + resource + backfill-stall
// feed without this route needing to know about the gauges.
const register = client.register;

// collectDefaultMetrics throws if the same series are registered twice (happens
// under `tsx watch` reloads and repeated imports), so guard on a series it
// always emits. Lazy (first-scrape) rather than import-time so merely importing
// the module — e.g. in a unit test — has no side effects.
function ensureDefaultMetrics() {
  if (!register.getSingleMetric("process_start_time_seconds")) {
    client.collectDefaultMetrics({ register });
  }
}

export async function handleMetrics(res: ServerResponse): Promise<void> {
  ensureDefaultMetrics();
  res.statusCode = 200;
  res.setHeader("content-type", register.contentType);
  res.end(await register.metrics());
}
