// Side-effect module that wires Sentry up before anything else in the Node
// process. MUST be the first import in src/index.ts so that Sentry's
// OpenTelemetry instrumentation hooks fastify/http/pg before those packages are
// loaded.
//
// No-op when NODE_ENV is not "production" or SENTRY_DSN is empty. This is the
// runtime kill-switch: clearing SENTRY_DSN in the stack env and restarting the
// container silences Sentry without a code change. Mirrors apps/kds-api.
import * as Sentry from "@sentry/node";
import { scrubEvent } from "@rop/contracts";

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
