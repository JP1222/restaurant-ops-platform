import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { Prisma } from "@rop/db-auth";
import { z } from "zod";
import { getWebAuthnRpId, getWebAuthnRpName, WEBAUTHN_FLOW_COOKIE_NAME, WEBAUTHN_TIMEOUT_MS, WEB_SESSION_COOKIE_NAME } from "../lib/web-auth.js";
import type { AppServices } from "../lib/services.js";

const PasswordLoginBodySchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
});

const RegistrationVerifyBodySchema = z.object({
  response: z.custom<RegistrationResponseJSON>(
    (value) => typeof value === "object" && value !== null,
    "Expected a registration response."
  )
});

const AuthenticationVerifyBodySchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value) => typeof value === "object" && value !== null,
    "Expected an authentication response."
  )
});

const CredentialParamsSchema = z.object({
  credentialId: z.string().min(1)
});

function normalizeReturnToPath(value: unknown, fallback = "/login") {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return fallback;
  }

  try {
    const normalized = new URL(value, "https://kds.local");
    return `${normalized.pathname}${normalized.search}${normalized.hash}` || fallback;
  } catch {
    return fallback;
  }
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRequestOrigin(request: Pick<FastifyRequest, "headers">, appBaseUrl: string) {
  const expected = new URL(appBaseUrl).origin;
  const originHeader = firstHeaderValue(request.headers.origin);
  if (originHeader) {
    return {
      matches: originHeader === expected,
      actual: originHeader,
      expected
    };
  }

  const refererHeader = firstHeaderValue(request.headers.referer);
  if (refererHeader) {
    try {
      const refererOrigin = new URL(refererHeader).origin;
      return {
        matches: refererOrigin === expected,
        actual: refererOrigin,
        expected
      };
    } catch {
      return {
        matches: false,
        actual: refererHeader,
        expected
      };
    }
  }

  return {
    matches: false,
    actual: null,
    expected
  };
}

function clearAuthCookies(reply: FastifyReply, services: AppServices) {
  reply.clearCookie(WEB_SESSION_COOKIE_NAME, services.auth.getSessionCookieOptions());
  reply.clearCookie(WEBAUTHN_FLOW_COOKIE_NAME, services.auth.getFlowCookieOptions());
}

function buildSessionResponse(input: {
  username: string;
  displayName: string;
  hasPasskeys: boolean;
}) {
  return {
    authenticated: true as const,
    username: input.username,
    displayName: input.displayName,
    hasPasskeys: input.hasPasskeys
  };
}

async function readAuthenticatedSession(request: FastifyRequest, reply: FastifyReply, services: AppServices) {
  const sessionId = request.cookies[WEB_SESSION_COOKIE_NAME];
  if (!sessionId) {
    clearAuthCookies(reply, services);
    return null;
  }

  const session = await services.auth.readSession(sessionId);
  if (!session) {
    clearAuthCookies(reply, services);
    return null;
  }

  const account = await services.auth.getAccountById(session.accountId);
  if (!account) {
    await services.auth.destroySession(sessionId);
    clearAuthCookies(reply, services);
    return null;
  }

  return {
    sessionId,
    session,
    account
  };
}

function rejectInvalidOrigin(request: Pick<FastifyRequest, "headers">, reply: FastifyReply, services: AppServices) {
  const result = normalizeRequestOrigin(request, services.config.appBaseUrl);
  if (result.matches) {
    return null;
  }

  reply.code(403);
  return {
    error: "Untrusted origin.",
    expectedOrigin: result.expected
  };
}

// CSRF guard for the GET browser-logout redirect (GH #127). Unlike the POST
// auth routes — which demand a matching Origin — a legitimate top-level logout
// navigation (clicking a link) sends NO Origin and may send only a same-site
// Referer, so a strict same-origin check would 403 the real flow. The actual
// attack vector is a cross-site embed (`<img src=".../logout/browser">`), which
// the browser sends with the attacker's Referer. So: reject only when an Origin
// or Referer IS present and is foreign; allow a request with neither header
// (genuine same-site navigation). This blocks the forced-logout CSRF while
// preserving the existing returnTo redirect behavior.
function rejectForeignBrowserOrigin(request: Pick<FastifyRequest, "headers">, reply: FastifyReply, services: AppServices) {
  const hasOriginHeader =
    Boolean(firstHeaderValue(request.headers.origin)) || Boolean(firstHeaderValue(request.headers.referer));
  if (!hasOriginHeader) {
    return null;
  }

  return rejectInvalidOrigin(request, reply, services);
}

export async function registerAuthRoutes(app: FastifyInstance, services: AppServices) {
  app.get("/api/auth/session", async (request, reply) => {
    const authenticated = await readAuthenticatedSession(request, reply, services);
    if (!authenticated) {
      return {
        authenticated: false
      };
    }

    const hasPasskeys = (await services.auth.getPasskeyCount(authenticated.account.id)) > 0;
    reply.setCookie(WEB_SESSION_COOKIE_NAME, authenticated.sessionId, services.auth.getSessionCookieOptions());

    return buildSessionResponse({
      username: authenticated.account.username,
      displayName: authenticated.account.displayName,
      hasPasskeys
    });
  });

  app.post<{ Body: z.infer<typeof PasswordLoginBodySchema> }>("/api/auth/login/password", async (request, reply) => {
    const invalidOrigin = rejectInvalidOrigin(request, reply, services);
    if (invalidOrigin) {
      return invalidOrigin;
    }

    const body = PasswordLoginBodySchema.parse(request.body);
    const rateLimit = await services.auth.getPasswordRateLimit(request.ip, body.username);
    if (rateLimit.blocked) {
      reply.code(429);
      return {
        error: "Too many login attempts.",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      };
    }

    const account = await services.auth.verifyPassword(body.username, body.password);
    if (!account) {
      const failure = await services.auth.registerFailedPasswordAttempt(request.ip, body.username);
      reply.code(failure.blocked ? 429 : 401);
      return failure.blocked
        ? {
            error: "Too many login attempts.",
            retryAfterSeconds: failure.retryAfterSeconds
          }
        : {
            error: "Invalid username or password."
          };
    }

    await services.auth.clearPasswordAttempts(request.ip, body.username);
    // GH #476: destroy any pre-existing (possibly fixated) session before minting
    // a new one. Sessions are keyed by sessionId only, so an attacker-planted id
    // would otherwise stay valid after the victim authenticates. No-op when the
    // request carries no session cookie.
    await services.auth.destroySession(request.cookies[WEB_SESSION_COOKIE_NAME]);
    const { sessionId } = await services.auth.createSession(account);
    reply.setCookie(WEB_SESSION_COOKIE_NAME, sessionId, services.auth.getSessionCookieOptions());
    reply.clearCookie(WEBAUTHN_FLOW_COOKIE_NAME, services.auth.getFlowCookieOptions());

    const hasPasskeys = (await services.auth.getPasskeyCount(account.id)) > 0;
    return {
      ok: true,
      session: buildSessionResponse({
        username: account.username,
        displayName: account.displayName,
        hasPasskeys
      })
    };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const invalidOrigin = rejectInvalidOrigin(request, reply, services);
    if (invalidOrigin) {
      return invalidOrigin;
    }

    await services.auth.destroySession(request.cookies[WEB_SESSION_COOKIE_NAME]);
    clearAuthCookies(reply, services);
    return { ok: true };
  });

  app.get("/api/auth/logout/browser", async (request, reply) => {
    // GH #127: block forced-logout CSRF from a cross-site embed while still
    // allowing a genuine same-site logout link (which carries no Origin header).
    const foreignOrigin = rejectForeignBrowserOrigin(request, reply, services);
    if (foreignOrigin) {
      return foreignOrigin;
    }

    await services.auth.destroySession(request.cookies[WEB_SESSION_COOKIE_NAME]);
    clearAuthCookies(reply, services);

    const query = request.query as { returnTo?: unknown } | undefined;
    reply.redirect(normalizeReturnToPath(query?.returnTo, "/login"));
  });

  app.post("/api/auth/passkeys/registration/options", async (request, reply) => {
    const invalidOrigin = rejectInvalidOrigin(request, reply, services);
    if (invalidOrigin) {
      return invalidOrigin;
    }

    const authenticated = await readAuthenticatedSession(request, reply, services);
    if (!authenticated) {
      reply.code(401);
      return { error: "Authentication required." };
    }

    const passkeys = await services.auth.listPasskeys(authenticated.account.id);
    const options = await generateRegistrationOptions({
      rpName: getWebAuthnRpName(services.config),
      rpID: getWebAuthnRpId(services.config),
      userName: authenticated.account.username,
      userID: new TextEncoder().encode(authenticated.account.id),
      userDisplayName: authenticated.account.displayName,
      attestationType: "none",
      timeout: WEBAUTHN_TIMEOUT_MS,
      excludeCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      }
    });

    const flowId = await services.auth.createWebAuthnFlow({
      challenge: options.challenge,
      flowType: "registration",
      accountId: authenticated.account.id
    });
    reply.setCookie(WEBAUTHN_FLOW_COOKIE_NAME, flowId, services.auth.getFlowCookieOptions());
    reply.setCookie(WEB_SESSION_COOKIE_NAME, authenticated.sessionId, services.auth.getSessionCookieOptions());

    return options;
  });

  app.post<{ Body: z.infer<typeof RegistrationVerifyBodySchema> }>("/api/auth/passkeys/registration/verify", async (request, reply) => {
    const invalidOrigin = rejectInvalidOrigin(request, reply, services);
    if (invalidOrigin) {
      return invalidOrigin;
    }

    const authenticated = await readAuthenticatedSession(request, reply, services);
    if (!authenticated) {
      reply.code(401);
      return { error: "Authentication required." };
    }

    const body = RegistrationVerifyBodySchema.parse(request.body);
    const flow = await services.auth.consumeWebAuthnFlow(request.cookies[WEBAUTHN_FLOW_COOKIE_NAME]);
    reply.clearCookie(WEBAUTHN_FLOW_COOKIE_NAME, services.auth.getFlowCookieOptions());

    if (!flow || flow.flowType !== "registration" || flow.accountId !== authenticated.account.id) {
      reply.code(400);
      return { error: "Registration challenge expired." };
    }

    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: flow.expectedOrigin,
      expectedRPID: flow.expectedRPID,
      requireUserVerification: true
    });

    if (!verification.verified || !verification.registrationInfo) {
      reply.code(400);
      return { error: "Passkey registration could not be verified." };
    }

    try {
      const credential = await services.auth.savePasskeyCredential({
        accountId: authenticated.account.id,
        credentialId: verification.registrationInfo.credential.id,
        webauthnUserId: authenticated.account.id,
        publicKey: verification.registrationInfo.credential.publicKey,
        counter: verification.registrationInfo.credential.counter,
        deviceType: verification.registrationInfo.credentialDeviceType,
        backedUp: verification.registrationInfo.credentialBackedUp,
        transports: body.response.response.transports ?? []
      });

      return {
        ok: true,
        passkey: {
          credentialId: credential.credentialId,
          createdAt: credential.createdAt.toISOString(),
          lastUsedAt: credential.lastUsedAt ? credential.lastUsedAt.toISOString() : null,
          deviceType: credential.deviceType,
          backedUp: credential.backedUp,
          transports: Array.isArray(credential.transports) ? credential.transports : []
        }
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        reply.code(409);
        return { error: "Passkey already registered." };
      }

      throw error;
    }
  });

  app.post("/api/auth/passkeys/authentication/options", async (request, reply) => {
    const invalidOrigin = rejectInvalidOrigin(request, reply, services);
    if (invalidOrigin) {
      return invalidOrigin;
    }

    const rateLimit = await services.auth.getPasskeyRateLimit(request.ip);
    if (rateLimit.blocked) {
      reply.code(429);
      reply.header("retry-after", String(rateLimit.retryAfterSeconds));
      return {
        error: "Too many passkey attempts.",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      };
    }

    const options = await generateAuthenticationOptions({
      rpID: getWebAuthnRpId(services.config),
      allowCredentials: [],
      userVerification: "required",
      timeout: WEBAUTHN_TIMEOUT_MS
    });

    const flowId = await services.auth.createWebAuthnFlow({
      challenge: options.challenge,
      flowType: "authentication"
    });
    reply.setCookie(WEBAUTHN_FLOW_COOKIE_NAME, flowId, services.auth.getFlowCookieOptions());

    return options;
  });

  app.post<{ Body: z.infer<typeof AuthenticationVerifyBodySchema> }>("/api/auth/passkeys/authentication/verify", async (request, reply) => {
    const invalidOrigin = rejectInvalidOrigin(request, reply, services);
    if (invalidOrigin) {
      return invalidOrigin;
    }

    const rateLimit = await services.auth.getPasskeyRateLimit(request.ip);
    if (rateLimit.blocked) {
      reply.code(429);
      reply.header("retry-after", String(rateLimit.retryAfterSeconds));
      return {
        error: "Too many passkey attempts.",
        retryAfterSeconds: rateLimit.retryAfterSeconds
      };
    }

    const body = AuthenticationVerifyBodySchema.parse(request.body);
    const flow = await services.auth.consumeWebAuthnFlow(request.cookies[WEBAUTHN_FLOW_COOKIE_NAME]);
    reply.clearCookie(WEBAUTHN_FLOW_COOKIE_NAME, services.auth.getFlowCookieOptions());

    if (!flow || flow.flowType !== "authentication") {
      await services.auth.registerFailedPasskeyAttempt(request.ip);
      reply.code(400);
      return { error: "Authentication challenge expired." };
    }

    const credentialRecord = await services.auth.findCredentialByCredentialId(body.response.id);
    const credential = services.auth.toWebAuthnCredential(credentialRecord);
    if (!credentialRecord || !credential) {
      await services.auth.registerFailedPasskeyAttempt(request.ip);
      reply.code(401);
      return { error: "Unknown passkey." };
    }

    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: flow.expectedOrigin,
      expectedRPID: flow.expectedRPID,
      credential,
      requireUserVerification: true
    });

    if (!verification.verified) {
      await services.auth.registerFailedPasskeyAttempt(request.ip);
      reply.code(401);
      return { error: "Passkey authentication failed." };
    }

    await services.auth.clearPasskeyAttempts(request.ip);
    await services.auth.updateCredentialUsage(credentialRecord.credentialId, {
      counter: verification.authenticationInfo.newCounter,
      deviceType: verification.authenticationInfo.credentialDeviceType,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date()
    });

    // GH #476: invalidate any pre-existing (possibly fixated) session before
    // minting the new one (see password login above). No-op without a cookie.
    await services.auth.destroySession(request.cookies[WEB_SESSION_COOKIE_NAME]);
    const { sessionId } = await services.auth.createSession(credentialRecord.account);
    reply.setCookie(WEB_SESSION_COOKIE_NAME, sessionId, services.auth.getSessionCookieOptions());

    const hasPasskeys = (await services.auth.getPasskeyCount(credentialRecord.account.id)) > 0;
    return {
      ok: true,
      session: buildSessionResponse({
        username: credentialRecord.account.username,
        displayName: credentialRecord.account.displayName,
        hasPasskeys
      })
    };
  });

  app.get("/api/auth/passkeys", async (request, reply) => {
    const authenticated = await readAuthenticatedSession(request, reply, services);
    if (!authenticated) {
      reply.code(401);
      return { error: "Authentication required." };
    }

    reply.setCookie(WEB_SESSION_COOKIE_NAME, authenticated.sessionId, services.auth.getSessionCookieOptions());
    return {
      passkeys: await services.auth.listPasskeys(authenticated.account.id)
    };
  });

  app.delete<{ Params: z.infer<typeof CredentialParamsSchema> }>("/api/auth/passkeys/:credentialId", async (request, reply) => {
    const invalidOrigin = rejectInvalidOrigin(request, reply, services);
    if (invalidOrigin) {
      return invalidOrigin;
    }

    const authenticated = await readAuthenticatedSession(request, reply, services);
    if (!authenticated) {
      reply.code(401);
      return { error: "Authentication required." };
    }

    const params = CredentialParamsSchema.parse(request.params);

    // Self-service removal goes through the shared transactional, existence-first
    // guard (packages/auth deletePasskeyGuarded): one Serializable transaction
    // checks existence, re-reads the lockout invariant, and deletes — closing the
    // check-then-act TOCTOU. Existence is checked FIRST, so a stale credentialId
    // is a 404, never a 409 masking it (review LOCKOUT-03). Recovery from a
    // genuine last-method block is an OWNER-issued reset link.
    const result = await services.auth.deletePasskeyGuarded(authenticated.account.id, params.credentialId);
    if (!result.ok) {
      if (result.reason === "not_found") {
        reply.code(404);
        return { error: "Passkey not found." };
      }
      reply.code(409);
      return {
        error: "last_login_method",
        message: "You can't remove your only sign-in method. Set a password first."
      };
    }

    reply.setCookie(WEB_SESSION_COOKIE_NAME, authenticated.sessionId, services.auth.getSessionCookieOptions());
    return { ok: true };
  });
}
