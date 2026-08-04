import { z } from "zod";

// Normalize empty-string env values to `undefined` before validation, so
// docker-compose `${VAR:-}` expansions don't crash optional fields. Mirrors
// apps/inventory-api/src/config.ts.
const ConfigSchema = z.preprocess(
  (raw) =>
    Object.fromEntries(
      Object.entries((raw as Record<string, unknown>) ?? {}).map(([k, v]) => [
        k,
        v === "" ? undefined : v
      ])
    ),
  z.object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    apiPort: z.coerce.number().int().min(1).max(65535).default(4200),
    crmDatabaseUrl: z.string().min(1),
    // Bearer token for trusted server-to-server calls (the BFF in order-web /
    // marketing-site / backoffice). Enrollment + PII reads (balance/history)
    // require it; the public reward catalog does not. In production a protected
    // call with no configured token is refused (fails closed).
    internalToken: z.string().min(16).optional(),
    // Comma-separated allowlist of browser origins permitted by CORS (the
    // customer + operator surfaces). Empty in dev trusts all origins.
    allowedOrigins: z.string().optional(),
    // The loyalty-accrual worker (src/worker.ts) consumes the
    // crm-loyalty-accrual BullMQ queue. CRM_REDIS_URL MUST point at the SAME
    // Redis kds-api produces to (the queue transport — a message bus, not a
    // shared system-of-record, so Iron Law #1 holds). Optional so the HTTP
    // server boots without Redis; the worker asserts it at startup.
    redisUrl: z.string().min(1).optional(),
    loyaltyWorkerConcurrency: z.coerce.number().int().min(1).max(64).default(4)
  })
);

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  return ConfigSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    apiPort: process.env.CRM_API_PORT,
    crmDatabaseUrl: process.env.CRM_DATABASE_URL,
    internalToken: process.env.CRM_INTERNAL_TOKEN,
    allowedOrigins: process.env.CRM_ALLOWED_ORIGINS,
    redisUrl: process.env.CRM_REDIS_URL,
    loyaltyWorkerConcurrency: process.env.CRM_LOYALTY_WORKER_CONCURRENCY
  });
}
