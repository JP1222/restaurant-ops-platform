// Per-request correlation id, propagated through the async call tree via
// AsyncLocalStorage so every structured log line emitted while handling a
// request carries the same `requestId`. analytics-api is raw node:http (no
// Fastify request.id), so this is the equivalent shim: the HTTP server sets the
// id from the incoming `x-request-id` header (or generates one) and runs the
// route inside requestContext.run(); the logger reads it back. One id then ties
// a backoffice BFF call and these analytics-api logs together in Loki.

import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The current request's correlation id, or undefined outside a request scope. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Read a caller-supplied `x-request-id` header value (first if repeated). */
export function headerRequestId(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
