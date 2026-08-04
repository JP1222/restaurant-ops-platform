"use client";

import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON
} from "@simplewebauthn/browser";
import type { AuthSession, PasskeySummary } from "../shared/types.ts";

type JsonBody = Record<string, unknown> | undefined;
type JsonPayload = Record<string, unknown>;
type PasskeyAuthenticationOptions = {
  optionsPath?: string;
  verifyPath?: string;
  optionsBody?: JsonBody;
};
type PasskeyAuthenticationOptionsResponse =
  | PublicKeyCredentialRequestOptionsJSON
  | {
      challengeId?: string;
      options: PublicKeyCredentialRequestOptionsJSON;
    };

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

function hasRequestBody(body: BodyInit | null | undefined) {
  return body !== undefined && body !== null;
}

function buildJsonRequestHeaders(headers: HeadersInit | undefined, body: BodyInit | null | undefined) {
  const next = new Headers(headers);

  if (hasRequestBody(body) && !next.has("content-type")) {
    next.set("content-type", "application/json");
  }

  return next;
}

async function readJsonResponse(response: Response): Promise<JsonPayload | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  return (await response.json()) as JsonPayload;
}

function extractJsonError(payload: JsonPayload | null, fallback: string) {
  if (payload && typeof payload.error === "string") {
    return payload.error;
  }

  if (payload && typeof payload.message === "string") {
    return payload.message;
  }

  return fallback;
}

function getApiBaseUrl() {
  return API_BASE_URL;
}

function buildUrl(path: string) {
  return `${getApiBaseUrl()}${path}`;
}

async function requestJson<T>(path: string, init?: RequestInit, body?: JsonBody): Promise<T> {
  const requestInit: RequestInit = {
    ...init,
    credentials: "include"
  };

  if (body) {
    requestInit.body = JSON.stringify(body);
  } else if (init?.body !== undefined) {
    requestInit.body = init.body;
  }

  requestInit.headers = buildJsonRequestHeaders(init?.headers, requestInit.body);

  const response = await fetch(buildUrl(path), requestInit);

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(extractJsonError(payload, `Request failed with status ${response.status}.`));
  }

  return payload as T;
}

export async function loginWithPassword(username: string, password: string) {
  return requestJson<{ ok: true; session: Extract<AuthSession, { authenticated: true }> }>(
    "/api/auth/login/password",
    { method: "POST" },
    {
      username,
      password
    }
  );
}

export function buildBrowserLogoutHref(returnTo = "/login") {
  return `${buildUrl("/api/auth/logout/browser")}?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function authenticateWithPasskey(options: PasskeyAuthenticationOptions = {}) {
  const optionsPath = options.optionsPath ?? "/api/auth/passkeys/authentication/options";
  const verifyPath = options.verifyPath ?? "/api/auth/passkeys/authentication/verify";
  const authOptionsPayload = await requestJson<PasskeyAuthenticationOptionsResponse>(
    optionsPath,
    { method: "POST" },
    options.optionsBody ?? {}
  );
  const authOptions =
    "options" in authOptionsPayload ? authOptionsPayload.options : authOptionsPayload;
  const response = await startAuthentication({
    optionsJSON: authOptions
  });

  return requestJson<{ ok: true; session: Extract<AuthSession, { authenticated: true }> }>(
    verifyPath,
    { method: "POST" },
    {
      challengeId: "options" in authOptionsPayload ? authOptionsPayload.challengeId : undefined,
      response
    }
  );
}

export async function registerPasskey() {
  const options = await requestJson<PublicKeyCredentialCreationOptionsJSON>(
    "/api/auth/passkeys/registration/options",
    { method: "POST" },
    {}
  );
  const response = await startRegistration({
    optionsJSON: options
  });

  return requestJson<{ ok: true; passkey: PasskeySummary }>(
    "/api/auth/passkeys/registration/verify",
    { method: "POST" },
    {
      response
    }
  );
}

export async function deletePasskeyCredential(credentialId: string) {
  return requestJson<{ ok: true }>(`/api/auth/passkeys/${encodeURIComponent(credentialId)}`, {
    method: "DELETE"
  });
}
