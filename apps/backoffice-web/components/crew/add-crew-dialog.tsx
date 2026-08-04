"use client";

import { useState } from "react";
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
import { useCreateCrew } from "@/hooks/use-crew";

export function AddCrewDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [shift, setShift] = useState("");
  const [pin, setPin] = useState("");
  const create = useCreateCrew();

  function reset() {
    setName("");
    setRole("");
    setShift("");
    setPin("");
    create.reset();
  }

  const pinValid = /^\d{6}$/.test(pin);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Add crew</Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const n = name.trim();
            const r = role.trim();
            const s = shift.trim();
            if (!n || !r || !s || !pinValid) return;
            await create.mutateAsync({ name: n, role: r, shift: s, pin });
            setOpen(false);
            reset();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add crew member</DialogTitle>
            <DialogDescription>
              Creates a floor login. You set the 6-digit PIN and share it with the crew member; it
              is stored hashed and never shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="add-crew-name">Name</Label>
            <Input
              id="add-crew-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="add-crew-role">Role</Label>
              <Input
                id="add-crew-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="Line cook"
                maxLength={40}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-crew-shift">Shift</Label>
              <Input
                id="add-crew-shift"
                value={shift}
                onChange={(event) => setShift(event.target.value)}
                placeholder="AM"
                maxLength={40}
                required
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="add-crew-pin">PIN</Label>
            <Input
              id="add-crew-pin"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder="6-digit PIN"
              className="font-mono tabular-nums"
              required
            />
            <p className="text-xs text-muted-foreground">Must be 6 digits and unique across the crew.</p>
          </div>
          {create.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not add crew member</AlertTitle>
              <AlertDescription>
                {create.error instanceof Error ? create.error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !pinValid}>
              {create.isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
