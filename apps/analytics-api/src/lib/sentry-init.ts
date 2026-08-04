// Side-effect module: initialize Sentry before any other import so its
// OpenTelemetry instrumentation can hook http/pg/etc. MUST be the first import
// in src/service.ts.
//
// No-op when NODE_ENV is not "production" or SENTRY_DSN is empty.
import * as Sentry from "@sentry/node";
import { scrubEvent } from "@rop/contracts";

// CPU profiling (`@sentry/profiling-node`) intentionally deferred — see
// apps/kds-api/src/lib/sentry-init.ts for the rationale.
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
