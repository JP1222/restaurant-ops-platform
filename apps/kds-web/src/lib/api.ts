const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";
const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_BASE_URL?.replace(/\/$/, "") ?? "";

type JsonPayload = Record<string, unknown>;

function hasRequestBody(body: BodyInit | null | undefined) {
  return body !== undefined && body !== null;
}

export function buildJsonRequestHeaders(headers: HeadersInit | undefined, body: BodyInit | null | undefined) {
  const next = new Headers(headers);

  if (hasRequestBody(body) && !next.has("content-type")) {
    next.set("content-type", "application/json");
  }

  return next;
}

export async function readJsonResponse(response: Response): Promise<JsonPayload | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  return (await response.json()) as JsonPayload;
}

export function extractJsonError(payload: JsonPayload | null, fallback: string) {
  if (payload && typeof payload.error === "string") {
    return payload.error;
  }

  if (payload && typeof payload.message === "string") {
    return payload.message;
  }

  return fallback;
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}

export function getWsBaseUrl() {
  if (WS_BASE_URL) {
    return WS_BASE_URL;
  }

  if (API_BASE_URL) {
    return API_BASE_URL.replace(/^http/, "ws");
  }

  if (typeof window !== "undefined") {
    return window.location.origin.replace(/^http/, "ws");
  }

  return "";
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const body = init?.body;
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers: buildJsonRequestHeaders(init?.headers, body),
    cache: "no-store"
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(extractJsonError(payload, `API request failed: ${response.status}`));
  }

  return payload as T;
}
