"use client";

import { useState } from "react";
import type { InventoryEmployee } from "@rop/contracts";
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
import { useResetCrewPin, useUpdateCrew } from "@/hooks/use-crew";

type Mode = "none" | "edit" | "reset-pin" | "toggle";

export function CrewRowActions({ employee }: { employee: InventoryEmployee }) {
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
          <DropdownMenuItem onSelect={() => setMode("edit")}>Edit</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setMode("reset-pin")}>Reset PIN</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setMode("toggle")}
            className={employee.active ? "text-destructive focus:text-destructive" : undefined}
          >
            {employee.active ? "Disable" : "Enable"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditDialog open={mode === "edit"} onClose={close} employee={employee} />
      <ResetPinDialog open={mode === "reset-pin"} onClose={close} employee={employee} />
      <ToggleDialog open={mode === "toggle"} onClose={close} employee={employee} />
    </>
  );
}

function EditDialog({
  open,
  onClose,
  employee
}: {
  open: boolean;
  onClose: () => void;
  employee: InventoryEmployee;
}) {
  const [name, setName] = useState(employee.name);
  const [role, setRole] = useState(employee.role);
  const [shift, setShift] = useState(employee.shift);
  const update = useUpdateCrew(employee.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          setName(employee.name);
          setRole(employee.role);
          setShift(employee.shift);
          update.reset();
        }
      }}
    >
      <DialogContent>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const n = name.trim();
            const r = role.trim();
            const s = shift.trim();
            if (!n || !r || !s) return;
            await update.mutateAsync({ name: n, role: r, shift: s });
            onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit {employee.name}</DialogTitle>
            <DialogDescription>Update the crew member&apos;s name, role, and shift.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="edit-crew-name">Name</Label>
            <Input
              id="edit-crew-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="edit-crew-role">Role</Label>
              <Input
                id="edit-crew-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                maxLength={40}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-crew-shift">Shift</Label>
              <Input
                id="edit-crew-shift"
                value={shift}
                onChange={(event) => setShift(event.target.value)}
                maxLength={40}
                required
              />
            </div>
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

function ResetPinDialog({
  open,
  onClose,
  employee
}: {
  open: boolean;
  onClose: () => void;
  employee: InventoryEmployee;
}) {
  const [pin, setPin] = useState("");
  const reset = useResetCrewPin(employee.id);
  const pinValid = /^\d{6}$/.test(pin);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          setPin("");
          reset.reset();
        }
      }}
    >
      <DialogContent>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!pinValid) return;
            await reset.mutateAsync({ pin });
            onClose();
            setPin("");
          }}
        >
          <DialogHeader>
            <DialogTitle>Reset PIN for {employee.name}</DialogTitle>
            <DialogDescription>
              Set a new 6-digit PIN and share it with the crew member. The old PIN stops working
              immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="reset-crew-pin">New PIN</Label>
            <Input
              id="reset-crew-pin"
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder="6-digit PIN"
              className="font-mono tabular-nums"
              required
              autoFocus
            />
          </div>
          {reset.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not reset PIN</AlertTitle>
              <AlertDescription>
                {reset.error instanceof Error ? reset.error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={reset.isPending || !pinValid}>
              {reset.isPending ? "Saving..." : "Set PIN"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToggleDialog({
  open,
  onClose,
  employee
}: {
  open: boolean;
  onClose: () => void;
  employee: InventoryEmployee;
}) {
  const update = useUpdateCrew(employee.id);
  const disabling = employee.active;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
          update.reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {disabling ? `Disable ${employee.name}?` : `Enable ${employee.name}?`}
          </DialogTitle>
          <DialogDescription>
            {disabling
              ? "They will no longer be able to log in on the floor. Their past waste, count, and receiving history is kept."
              : "They will be able to log in on the floor again with their existing PIN."}
          </DialogDescription>
        </DialogHeader>
        {update.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not update</AlertTitle>
            <AlertDescription>
              {update.error instanceof Error ? update.error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={disabling ? "destructive" : "default"}
            onClick={async () => {
              await update.mutateAsync({ active: !employee.active });
              onClose();
            }}
            disabled={update.isPending}
          >
            {update.isPending ? "Saving..." : disabling ? "Disable" : "Enable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
