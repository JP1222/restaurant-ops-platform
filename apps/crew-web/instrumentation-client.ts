// Next.js 16 client-side instrumentation hook. Replaces the legacy
// `sentry.client.config.ts` file, which the Sentry SDK warns is incompatible
// with Turbopack (Next.js 16 default bundler). This file is auto-loaded by
// Next.js for browser-side init only.
//
// No-op when NODE_ENV is not "production" or NEXT_PUBLIC_SENTRY_DSN is empty.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "@rop/contracts";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    sendDefaultPii: false,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.05,
    beforeSend: (event) => scrubEvent(event),
  });
}
