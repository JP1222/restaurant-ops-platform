"use client";

import { useState } from "react";
import type { AdminUserCreateResponse } from "@rop/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LinkShareBlock } from "@/components/settings/account/link-share-block";
import { useCreateAdminUser } from "@/hooks/use-admin-users";

export function AddUserDialog() {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [issued, setIssued] = useState<AdminUserCreateResponse | null>(null);
  const create = useCreateAdminUser();

  function reset() {
    setUsername("");
    setDisplayName("");
    setIssued(null);
    create.reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Add user</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{issued ? "Invitation ready" : "Add admin user"}</DialogTitle>
          <DialogDescription>
            {issued
              ? "Share this one-time link with the user. They set their own password — it works once and expires."
              : "Creates the account, then shares a one-time link so the user can set their own password."}
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <LinkShareBlock url={issued.setupUrl} expiresInSeconds={issued.expiresInSeconds} />
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const u = username.trim();
              const d = displayName.trim();
              if (!u || !d) return;
              const response = await create.mutateAsync({ username: u, displayName: d });
              setIssued(response);
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="add-user-username">Username</Label>
              <Input
                id="add-user-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="kitchenmanager"
                minLength={2}
                maxLength={64}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-user-displayname">Display name</Label>
              <Input
                id="add-user-displayname"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Kitchen Manager"
                maxLength={120}
                required
              />
            </div>
            {create.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not create user</AlertTitle>
                <AlertDescription>
                  {create.error instanceof Error ? create.error.message : "Unknown error"}
                </AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {issued ? (
          <DialogFooter>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
