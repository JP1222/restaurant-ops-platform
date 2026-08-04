import { z } from "zod";

// Suite-wide RBAC vocabulary (ADR-0029). A Role spans BOTH identity stores:
// owners/managers live in db-auth (web_admin_accounts); staff live in
// db-inventory (inventory_employees). The role string is the shared key that
// the central can() check (packages/auth/rbac) resolves to permissions.
//
// MANAGER is reserved — defined now so downstream enums/UI leave room for it,
// but it is not issued to anyone until a later phase.
export const RoleSchema = z.enum(["OWNER", "STAFF", "MANAGER"]);
export type Role = z.infer<typeof RoleSchema>;

// db-auth account roles (the `web_admin_accounts.role` + `tenant_memberships.role`
// vocabulary). OWNER/MANAGER are the active values; ADMIN is deprecated
// (ADR-0029) — existing rows migrate to OWNER. Distinct from `RoleSchema` above,
// which is the suite-wide role that also spans staff. Lives here (a leaf, not the
// index barrel) so tenant.ts can reuse it without a circular import.
export const WebAdminRoleSchema = z.enum(["OWNER", "MANAGER", "ADMIN"]);
export type WebAdminRole = z.infer<typeof WebAdminRoleSchema>;

// Granular permission catalog. Leaf keys read "<domain>.<resource>.<action>".
// This is the single source of permission vocabulary; ROLE_PERMISSIONS in
// packages/auth maps roles -> these keys. Extend here (and the map there).
export const PermissionSchema = z.enum([
  // Operational (floor) — granted to STAFF and OWNER.
  "inventory.waste.record",
  "inventory.count.record",
  "inventory.item.toggle86",
  "inventory.po.receive",
  "kds.ticket.act",
  // Back-office / privileged — OWNER (and selectively MANAGER later).
  "inventory.manage",
  "analytics.read",
  "settings.read",
  "settings.write",
  "secrets.read",
  "secrets.write",
  "users.manage",
  "integrations.manage",
  "kds.board.configure",
  "devices.manage"
]);
export type Permission = z.infer<typeof PermissionSchema>;

// The full, ordered list of permission keys — the catalog OWNER holds in whole.
export const PERMISSION_CATALOG = PermissionSchema.options;

// --- Password lifecycle (ADR-0029 P2) ---------------------------------------
// Policy is length-not-composition (NIST SP 800-63B / OWASP ASVS 5.0). 15 is
// the OWASP "no-MFA" floor; it can drop once owner TOTP ships (P4). The max is
// generous — argon2 has no practical input ceiling; we cap only to bound work.
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 128;

const NewPasswordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

// Self-service change (session-gated): prove current, choose new.
export const PasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: NewPasswordSchema,
});
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;

// Token-gated set (invite / reset redemption): no current password.
export const PasswordSetRequestSchema = z.object({
  token: z.string().min(1),
  newPassword: NewPasswordSchema,
});
export type PasswordSetRequest = z.infer<typeof PasswordSetRequestSchema>;

export const PasswordMutationResponseSchema = z.object({ ok: z.literal(true) });
export type PasswordMutationResponse = z.infer<typeof PasswordMutationResponseSchema>;

// Why a password mutation was rejected — drives inline UI feedback.
export const PasswordRejectionReasonSchema = z.enum([
  "too_short",
  "breached",
  "incorrect_current",
  "token_invalid",
  "rate_limited",
]);
export type PasswordRejectionReason = z.infer<typeof PasswordRejectionReasonSchema>;

export const PasswordRejectionSchema = z.object({
  ok: z.literal(false),
  reason: PasswordRejectionReasonSchema,
  message: z.string(),
});
export type PasswordRejection = z.infer<typeof PasswordRejectionSchema>;

// Admin create / reset hand back a one-time setup LINK (wired in P2b) instead
// of a system-generated password.
export const PasswordSetupLinkResponseSchema = z.object({
  ok: z.literal(true),
  setupUrl: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
export type PasswordSetupLinkResponse = z.infer<typeof PasswordSetupLinkResponseSchema>;
