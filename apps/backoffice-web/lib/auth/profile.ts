import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { PasskeySummary } from "@rop/auth";
import type { WebAdminRole } from "@rop/contracts";
import { getBackofficeAuthService, updateSelfDisplayName } from "./service";

// Self-service profile shape returned to the logged-in operator. Role is
// READ-ONLY here (changing roles is a manage-others / RBAC concern, ADR-0029
// P3 — not self-service). There is NO email channel in the suite, so no email
// field exists. `passkeyCount` is the displayed count badge and is
// informational — the lockout invariant (can't remove your only sign-in
// method) is enforced server-side (the passkey DELETE returns 409 with human
// copy), not by disabling a button on this count alone.
export interface SelfProfile {
  id: string;
  username: string;
  displayName: string;
  role: WebAdminRole;
  passkeyCount: number;
}

// Resolve the full self-profile for the given (session-derived) account id.
// db-auth reads stay inside lib/auth/** per Iron Law #3; the route handler
// never touches @rop/db-auth directly. Returns null for an unknown id.
export async function getSelfProfile(accountId: string): Promise<SelfProfile | null> {
  const auth = getBackofficeAuthService();
  const [account, passkeyCount] = await Promise.all([
    auth.getAccountById(accountId),
    auth.getPasskeyCount(accountId)
  ]);
  if (!account) {
    return null;
  }
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role as WebAdminRole,
    passkeyCount
  };
}

// True when a Prisma write threw a unique-constraint violation (P2002). Checked
// structurally so this carve-out file does not need to import the
// `Prisma.PrismaClientKnownRequestError` class — keeping the dependency on
// @rop/db-auth confined to the auth service factory.
function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export type SaveSelfPasskeyResult =
  | { ok: true; passkey: PasskeySummary }
  | { ok: false; reason: "already_registered" };

// Persist a freshly-verified passkey for the session account, mapping the
// duplicate-credential collision to a discriminated result the route turns
// into a 409. Mirrors the kds-api self-service registration behavior.
export async function saveSelfPasskey(input: {
  accountId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: AuthenticatorTransportFuture[];
}): Promise<SaveSelfPasskeyResult> {
  try {
    const credential = await getBackofficeAuthService().savePasskeyCredential({
      accountId: input.accountId,
      credentialId: input.credentialId,
      webauthnUserId: input.accountId,
      publicKey: input.publicKey,
      counter: input.counter,
      deviceType: input.deviceType,
      backedUp: input.backedUp,
      transports: input.transports
    });
    return {
      ok: true,
      passkey: {
        credentialId: credential.credentialId,
        createdAt: credential.createdAt.toISOString(),
        lastUsedAt: credential.lastUsedAt ? credential.lastUsedAt.toISOString() : null,
        deviceType: credential.deviceType,
        backedUp: credential.backedUp,
        transports: Array.isArray(credential.transports)
          ? (credential.transports as string[])
          : []
      }
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { ok: false, reason: "already_registered" };
    }
    throw error;
  }
}

// Self-edit of displayName only. Re-reads the passkey count so the caller can
// return the same SelfProfile shape as the GET.
export async function updateSelfProfile(accountId: string, displayName: string): Promise<SelfProfile> {
  const updated = await updateSelfDisplayName(accountId, displayName);
  const passkeyCount = await getBackofficeAuthService().getPasskeyCount(accountId);
  return {
    id: updated.id,
    username: updated.username,
    displayName: updated.displayName,
    role: updated.role as WebAdminRole,
    passkeyCount
  };
}
