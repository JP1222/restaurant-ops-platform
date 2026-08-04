import { headers } from "next/headers";

/**
 * Same-origin fetch helper used by AI tool `execute` callbacks.
 *
 * Calls our own Next.js Route Handlers in-process by hitting 127.0.0.1:<PORT>
 * (mirrors `proxy.ts` to avoid TLS hairpin issues), and forwards the incoming
 * request's `cookie` header so the proxy's auth gate accepts the call.
 *
 * Tool callbacks run on the server inside `/api/ai/chat`, so the cookie is
 * read from `next/headers` (which is request-scoped in Route Handlers).
 *
 * Throws `InternalFetchError` on non-2xx responses. The chat route catches
 * these and surfaces a structured error back to the model.
 */
export class InternalFetchError extends Error {
  constructor(
    public readonly status: number,
    public readonly bodyText: string,
    public readonly path: string,
  ) {
    super(`Internal fetch failed: ${status} ${path}`);
    this.name = "InternalFetchError";
  }
}

interface FetchInternalApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: string;
  signal?: AbortSignal;
}

export async function fetchInternalApi<T = unknown>(
  path: string,
  options: FetchInternalApiOptions = {},
): Promise<T> {
  const port = process.env.PORT ?? "3001";
  const url = `http://127.0.0.1:${port}${path}`;

  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie") ?? "";

  const init: RequestInit = {
    method: options.method ?? "GET",
    cache: "no-store",
    headers: {
      cookie,
      "Content-Type": "application/json",
    },
  };
  if (options.body !== undefined) init.body = options.body;
  if (options.signal) init.signal = options.signal;

  const response = await fetch(url, init);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new InternalFetchError(response.status, text.slice(0, 500), path);
  }

  return (await response.json()) as T;
}
