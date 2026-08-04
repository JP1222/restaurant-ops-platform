"use client";

import { useState } from "react";
import type { AdminUser, AdminUserPasswordResetResponse } from "@rop/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useDeleteAdminUser,
  useResetAdminUserPassword,
  useRevokeUserPasskey,
  useUpdateAdminUser,
  useUserPasskeys
} from "@/hooks/use-admin-users";
import { RelativeTime } from "@/components/ops/relative-time";
import { LinkShareBlock } from "@/components/settings/account/link-share-block";
import type { DeleteGuard } from "@/lib/admin/delete-guard";

type Mode = "none" | "rename" | "reset-password" | "delete" | "passkeys";

interface UserRowActionsProps {
  user: AdminUser;
  deleteGuard?: DeleteGuard;
}

export function UserRowActions({ user, deleteGuard = { disabled: false } }: UserRowActionsProps) {
  const [mode, setMode] = useState<Mode>("none");
  const close = () => setMode("none");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setMode("rename")}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMode("reset-password")}>Reset password</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMode("passkeys")}>View passkeys</DropdownMenuItem>
          <DropdownMenuSeparator />
          {deleteGuard.disabled ? (
            <DropdownMenuItem disabled className="text-muted-foreground">
              Delete — {deleteGuard.reason}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onSelect={() => setMode("delete")}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog open={mode === "rename"} onClose={close} user={user} />
      <ResetPasswordDialog open={mode === "reset-password"} onClose={close} user={user} />
      <DeleteDialog open={mode === "delete"} onClose={close} user={user} />
      <PasskeysDialog open={mode === "passkeys"} onClose={close} user={user} />
    </>
  );
}

function RenameDialog({
  open,
  onClose,
  user
}: {
  open: boolean;
  onClose: () => void;
  user: AdminUser;
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const update = useUpdateAdminUser(user.id);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          setDisplayName(user.displayName);
          update.reset();
        }
      }}
    >
      <DialogContent>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const trimmed = displayName.trim();
            if (!trimmed) return;
            await update.mutateAsync({ displayName: trimmed });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {user.username}</DialogTitle>
            <DialogDescription>Update the display name shown across the suite.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="rename-displayname">Display name</Label>
            <Input
              id="rename-displayname"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={120}
              required
              autoFocus
            />
          </div>
          {update.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not save</AlertTitle>
              <AlertDescription>
                {update.error instanceof Error ? update.error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  open,
  onClose,
  user
}: {
  open: boolean;
  onClose: () => void;
  user: AdminUser;
}) {
  const [result, setResult] = useState<AdminUserPasswordResetResponse | null>(null);
  const reset = useResetAdminUserPassword(user.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          setResult(null);
          reset.reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? "Reset link ready" : `Reset password for ${user.username}?`}</DialogTitle>
          <DialogDescription>
            {result
              ? "Share this one-time link with the user. They set their own password — no password is shown here."
              : "Sends a one-time link so the user can set a new password. Their current sign-in stays active until they finish."}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <LinkShareBlock url={result.setupUrl} expiresInSeconds={result.expiresInSeconds} />
        ) : reset.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not reset password</AlertTitle>
            <AlertDescription>
              {reset.error instanceof Error ? reset.error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    const response = await reset.mutateAsync();
                    setResult(response);
                  } catch {
                    // Surfaced via reset.isError + the Alert above; keep the dialog open.
                  }
                }}
                disabled={reset.isPending}
              >
                {reset.isPending ? "Generating..." : "Generate reset link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  open,
  onClose,
  user
}: {
  open: boolean;
  onClose: () => void;
  user: AdminUser;
}) {
  const del = useDeleteAdminUser(user.id);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          del.reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {user.username}?</DialogTitle>
          <DialogDescription>
            Permanently removes this admin account and revokes all of their passkeys. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {del.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not delete</AlertTitle>
            <AlertDescription>
              {del.error instanceof Error ? del.error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              try {
                await del.mutateAsync();
                onClose();
              } catch {
                // Surfaced via del.isError + the Alert above; keep the dialog open.
              }
            }}
            disabled={del.isPending}
          >
            {del.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasskeysDialog({
  open,
  onClose,
  user
}: {
  open: boolean;
  onClose: () => void;
  user: AdminUser;
}) {
  const query = useUserPasskeys(open ? user.id : null);
  const revoke = useRevokeUserPasskey(user.id);
  const [pendingId, setPendingId] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Passkeys for {user.username}</DialogTitle>
          <DialogDescription>
            Devices the user has registered for password-less login. Revoking a passkey forces that device to re-enroll.
          </DialogDescription>
        </DialogHeader>
        {revoke.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not revoke passkey</AlertTitle>
            <AlertDescription>
              {revoke.error instanceof Error ? revoke.error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        ) : null}
        {query.isLoading ? (
          <Skeleton className="h-[180px] w-full" />
        ) : query.isError ? (
          <p className="text-sm text-destructive">
            Could not load passkeys: {query.error instanceof Error ? query.error.message : "unknown"}
          </p>
        ) : (query.data?.passkeys.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">No passkeys registered.</p>
        ) : (
          <ul className="space-y-2">
            {query.data!.passkeys.map((pk) => (
              <li
                key={pk.credentialId}
                className="flex items-center justify-between gap-3 rounded-md border border-card-border p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{pk.deviceType}</div>
                  <div className="text-xs text-muted-foreground">
                    Created <RelativeTime iso={pk.createdAt} /> · Last used{" "}
                    {pk.lastUsedAt ? <RelativeTime iso={pk.lastUsedAt} /> : "never"}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-muted-foreground break-all">
                    {pk.credentialId}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pendingId === pk.credentialId && revoke.isPending}
                  onClick={async () => {
                    const ok = window.confirm("Revoke this passkey?");
                    if (!ok) return;
                    setPendingId(pk.credentialId);
                    try {
                      await revoke.mutateAsync(pk.credentialId);
                    } catch {
                      // Surfaced via revoke.isError + the Alert above.
                    } finally {
                      setPendingId(null);
                    }
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
