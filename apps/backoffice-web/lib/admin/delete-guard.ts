import type { AdminUser } from "@rop/contracts";

// When `disabled`, the Delete action in the admin users table is suppressed and
// `reason` is shown as a disabled menu item. Two cases disable it: you can't
// delete your own account, and the last Owner can't be removed.
//
// This is a UI-only guard. The real invariants are enforced server-side by
// admin-user-service (last_admin / last_owner), so a stale client never bricks
// the system; disabling here just avoids a pointless round-trip and explains
// why. Kept pure + free of React/UI imports so it is unit-testable on its own.
export type DeleteGuard = { disabled: true; reason: string } | { disabled: false };

export function deleteGuardFor(
  user: Pick<AdminUser, "id" | "role">,
  context: { currentUserId?: string; ownerCount: number }
): DeleteGuard {
  if (context.currentUserId && user.id === context.currentUserId) {
    return { disabled: true, reason: "you can't delete your own account" };
  }
  if (user.role === "OWNER" && context.ownerCount <= 1) {
    return { disabled: true, reason: "the last Owner can't be removed" };
  }
  return { disabled: false };
}
