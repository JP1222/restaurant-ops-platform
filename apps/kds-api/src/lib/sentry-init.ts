// Side-effect module that wires Sentry up before anything else in the Node
// process. MUST be the first import in src/index.ts and src/worker.ts so that
// Sentry's OpenTelemetry instrumentation hooks fastify/http/pg/redis before
// those packages are loaded.
//
// No-op when NODE_ENV is not "production" or SENTRY_DSN is empty. This is the
// runtime kill-switch: clearing SENTRY_DSN in the stack env and restarting the
// container silences Sentry without a code change.
import * as Sentry from "@sentry/node";
import { scrubEvent } from "@rop/contracts";

// NOTE: `@sentry/profiling-node` (CPU profiling) is deliberately omitted in
// this first integration PR. Its native .node binding requires an approved
// build script (pnpm v10 ignores postinstall builds unless allowlisted),
// which breaks `pnpm test` until configured. Profiling is a follow-up;
// error capture (the primary value) works without it.
const dsn = process.env.SENTRY_DSN;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
    beforeSend: (event) => scrubEvent(event),
  });
}
