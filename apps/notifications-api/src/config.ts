import { z } from "zod";

// Normalize empty-string env values to `undefined` before validation, so
// docker-compose `${VAR:-}` expansions don't crash optional fields. Mirrors
// apps/crm-api/src/config.ts.
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
    apiPort: z.coerce.number().int().min(1).max(65535).default(4400),
    notificationsDatabaseUrl: z.string().min(1),
    // Bearer token for the trusted server-to-server caller (the backoffice BFF).
    // Every /api/notifications route requires it; a production call with no token
    // configured is refused (fails closed). The operator identity travels
    // separately in the `x-operator-id` header the BFF stamps from its session.
    internalToken: z.string().min(16).optional(),
    // Comma-separated CORS allowlist. Notifications-api is internal-only
    // (BFF → service), so this stays empty in practice; kept for parity.
    allowedOrigins: z.string().optional()
  })
);

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AppConfig {
  return ConfigSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    apiPort: process.env.NOTIFICATIONS_API_PORT,
    notificationsDatabaseUrl: process.env.NOTIFICATIONS_DATABASE_URL,
    internalToken: process.env.NOTIFICATIONS_INTERNAL_TOKEN,
    allowedOrigins: process.env.NOTIFICATIONS_ALLOWED_ORIGINS
  });
}
