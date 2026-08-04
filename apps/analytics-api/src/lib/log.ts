// Minimal structured logger for analytics-api (audit-2026-05-27 #196).
//
// Emits one JSON object per line — {level, scope, message, context?} — so Loki
// can parse it (`|= "analytics.service.clover" | json level`) and Grafana
// queries stop failing on bare console.log text. Deliberately NO pino/winston:
// the rest of the package is minimal-deps (native http, raw pg), and a JSON
// envelope on top of console.* is all the log pipeline needs.
//
// Scope is always namespaced `analytics.service.<subsystem>`. Every message is
// run through redactSecrets() so an upstream error echoing a token or
// connection string can't leak into the log line (#157).

import { redactSecrets } from "./redact.js";
import { currentRequestId } from "./request-context.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

const SCOPE_PREFIX = "analytics.service.";

export type Logger = {
  readonly scope: string;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
};

/**
 * Create a logger bound to a subsystem. Pass the bare subsystem name
 * (e.g. "clover", "scheduler.heartbeat"); the `analytics.service.` prefix is
 * added here so every line shares the namespace the Loki queries expect.
 */
export function createLogger(subsystem: string): Logger {
  const scope = subsystem.startsWith(SCOPE_PREFIX) ? subsystem : `${SCOPE_PREFIX}${subsystem}`;
  return {
    scope,
    debug: (message, context) => emit("debug", scope, message, context),
    info: (message, context) => emit("info", scope, message, context),
    warn: (message, context) => emit("warn", scope, message, context),
    error: (message, context) => emit("error", scope, message, context)
  };
}

function emit(level: LogLevel, scope: string, message: string, context?: LogContext): void {
  // Correlation id from the active request scope (set in src/http/server.ts).
  // Spread conditionally so non-request logs (workers, startup) keep the bare
  // {level, scope, message} envelope.
  const requestId = currentRequestId();
  const envelope: Record<string, unknown> = {
    level,
    scope,
    ...(requestId ? { requestId } : {}),
    message: redactSecrets(message)
  };
  if (context && Object.keys(context).length > 0) {
    envelope.context = context;
  }
  const line = JSON.stringify(envelope);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Normalize an unknown thrown value into a string suitable for `message`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
