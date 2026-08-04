"use client";

import { useState } from "react";
import { ChevronDown, Key, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { resolvePasskeyFeedback } from "@rop/auth/client";
import type { AdminUserPasskey, SelfProfile } from "@rop/contracts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CommitField } from "../commit-field";
import { SettingRow } from "../setting-row";
import type { SaveStatus } from "../status-pill";
import { ChangePasswordCard } from "../account/change-password-card";
import { RelativeTime } from "@/components/ops/relative-time";
import { useProfile, useUpdateProfile } from "@/hooks/use-profile";
import {
  useAddSelfPasskey,
  useRemoveSelfPasskey,
  useSelfPasskeys
} from "@/hooks/use-self-passkeys";

const ROLE_LABEL: Record<SelfProfile["role"], string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  ADMIN: "Admin"
};

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function ProfilePanel() {
  const profile = useProfile();
  const updateProfile = useUpdateProfile();
  const [nameStatus, setNameStatus] = useState<SaveStatus | null>(null);

  const onCommitName = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === profile.data?.displayName) return;
    setNameStatus("saving");
    try {
      await updateProfile.mutateAsync({ displayName: trimmed });
      setNameStatus("saved");
      window.setTimeout(() => setNameStatus(null), 1_900);
    } catch (error) {
      setNameStatus("error");
      toast.error(error instanceof Error ? error.message : "Could not update your name.");
    }
  };

  if (profile.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[92px] w-full rounded-xl" />
        <Skeleton className="h-[220px] w-full rounded-xl" />
        <Skeleton className="h-[180px] w-full rounded-xl" />
      </div>
    );
  }

  if (profile.isError || !profile.data) {
    return (
      <p className="text-sm text-destructive">
        Could not load your profile:{" "}
        {profile.error instanceof Error ? profile.error.message : "unknown error"}
      </p>
    );
  }

  const me = profile.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-xl border bg-card px-6 py-5 shadow-sm">
        <Avatar className="size-16">
          <AvatarFallback className="bg-accent-soft text-xl font-semibold text-accent">
            {initials(me.displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{me.displayName}</div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            {ROLE_LABEL[me.role]} · @{me.username}
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card px-6 shadow-sm">
        <SettingRow
          label="Display name"
          description="Your name as it appears to the rest of the team."
          htmlFor="p-name"
          status={nameStatus}
        >
          <CommitField
            id="p-name"
            value={me.displayName}
            maxLength={120}
            onCommit={onCommitName}
          />
        </SettingRow>

        <SettingRow
          label="Role"
          description="Roles are managed under Team & Access by an Owner — you can't change your own."
        >
          <Badge variant="secondary">{ROLE_LABEL[me.role]}</Badge>
        </SettingRow>

        <PasskeysRow passkeyCount={me.passkeyCount} />
      </div>

      <ChangePasswordCard />
    </div>
  );
}

function PasskeysRow({ passkeyCount }: { passkeyCount: number }) {
  const [open, setOpen] = useState(false);
  const passkeys = useSelfPasskeys();
  const addPasskey = useAddSelfPasskey();
  const removePasskey = useRemoveSelfPasskey();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const count = passkeys.data?.length ?? passkeyCount;

  const onAdd = async () => {
    try {
      await addPasskey.mutateAsync();
      toast.success("Passkey added");
      setOpen(true);
    } catch (error) {
      const feedback = resolvePasskeyFeedback(error, "registration");
      if (feedback.kind === "feedback") {
        if (feedback.tone === "error") {
          toast.error(feedback.message);
        } else {
          toast.info(feedback.message);
        }
      }
    }
  };

  const onRemove = async (credentialId: string) => {
    setPendingId(credentialId);
    try {
      await removePasskey.mutateAsync(credentialId);
      toast.success("Passkey removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the passkey.");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <SettingRow
      label="Passkeys"
      description="Passwordless sign-in registered to this account. Add this device, or manage existing keys."
      full
    >
      <Collapsible open={open} onOpenChange={setOpen} className="w-full">
        <div className="flex items-center justify-end gap-2.5">
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              <Key />
              {count} registered
              <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <Button variant="outline" size="sm" onClick={onAdd} disabled={addPasskey.isPending}>
            {addPasskey.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
            {addPasskey.isPending ? "Waiting for device…" : "Add a passkey"}
          </Button>
        </div>

        <CollapsibleContent className="mt-3">
          {passkeys.isLoading ? (
            <Skeleton className="h-[120px] w-full" />
          ) : passkeys.isError ? (
            <p className="text-right text-xs text-destructive">
              Could not load passkeys:{" "}
              {passkeys.error instanceof Error ? passkeys.error.message : "unknown"}
            </p>
          ) : (passkeys.data?.length ?? 0) === 0 ? (
            <p className="text-right text-xs text-muted-foreground">
              No passkeys yet. Add this device for passwordless sign-in.
            </p>
          ) : (
            <ul className="space-y-2 text-left">
              {passkeys.data!.map((passkey) => (
                <PasskeyListItem
                  key={passkey.credentialId}
                  passkey={passkey}
                  removing={pendingId === passkey.credentialId && removePasskey.isPending}
                  onRemove={() => onRemove(passkey.credentialId)}
                />
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
    </SettingRow>
  );
}

function PasskeyListItem({
  passkey,
  removing,
  onRemove
}: {
  passkey: AdminUserPasskey;
  removing: boolean;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-card-border p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium capitalize">{passkey.deviceType}</div>
        <div className="text-xs text-muted-foreground">
          Added <RelativeTime iso={passkey.createdAt} /> · Last used{" "}
          {passkey.lastUsedAt ? <RelativeTime iso={passkey.lastUsedAt} /> : "never"}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onRemove} disabled={removing}>
        {removing ? <Loader2 className="animate-spin" /> : null}
        {removing ? "Removing…" : "Remove"}
      </Button>
    </li>
  );
}
