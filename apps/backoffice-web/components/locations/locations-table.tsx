"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { StoreLocation } from "@rop/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useBindMerchant,
  useCreateLocation,
  useLocations,
  useRenameLocation,
  useUnlinkedMerchants,
} from "@/hooks/use-locations";
import { DEFAULT_STORE_TIMEZONE, STORE_TIMEZONES } from "@/lib/timezones";

export function LocationsTable() {
  const { data, isLoading, isError, error } = useLocations();
  const rename = useRenameLocation();
  const create = useCreateLocation();
  const bind = useBindMerchant();
  const [editing, setEditing] = useState<StoreLocation | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTz, setNewTz] = useState<string>(DEFAULT_STORE_TIMEZONE);
  const [binding, setBinding] = useState<StoreLocation | null>(null);
  const [selectedMerchant, setSelectedMerchant] = useState("");
  // Only fetch the unbound-POS list while the bind dialog is open.
  const unlinked = useUnlinkedMerchants(binding !== null);

  if (isLoading) {
    return <div className="text-muted-foreground p-6 text-sm">Loading stores…</div>;
  }
  if (isError) {
    return (
      <Alert variant="destructive" className="m-6">
        <AlertTitle>Couldn&apos;t load stores</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  const locations = data?.locations ?? [];

  const openRename = (loc: StoreLocation) => {
    setEditing(loc);
    setDraft(loc.name);
  };

  const submit = () => {
    if (!editing) return;
    const name = draft.trim();
    if (name && name !== editing.name) {
      rename.mutate({ id: editing.id, name }, { onSuccess: () => setEditing(null) });
    } else {
      setEditing(null);
    }
  };

  const openCreate = () => {
    setNewName("");
    setNewTz(DEFAULT_STORE_TIMEZONE);
    setCreating(true);
  };

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { name, timezone: newTz },
      {
        onSuccess: () => {
          setCreating(false);
          toast.success(`Added ${name}`);
        },
        onError: () => toast.error("Could not add store"),
      },
    );
  };

  const openBind = (loc: StoreLocation) => {
    setSelectedMerchant("");
    setBinding(loc);
  };

  const submitBind = () => {
    if (!binding || !selectedMerchant) return;
    bind.mutate(
      { locationId: binding.id, merchantId: selectedMerchant },
      {
        onSuccess: () => {
          const name = binding.name;
          setBinding(null);
          toast.success(`Connected POS to ${name}`);
        },
        onError: () => toast.error("Could not connect POS"),
      },
    );
  };

  const merchants = unlinked.data?.merchants ?? [];

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-4" />
          Add store
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Store</TableHead>
            <TableHead>Timezone</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>POS</TableHead>
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {locations.map((loc) => (
            <TableRow key={loc.id}>
              <TableCell className="font-medium">{loc.name}</TableCell>
              <TableCell className="text-muted-foreground">{loc.timezone}</TableCell>
              <TableCell>
                <Badge variant={loc.active ? "default" : "secondary"}>
                  {loc.active ? "Active" : "Inactive"}
                </Badge>
              </TableCell>
              <TableCell>
                {loc.merchantId ? (
                  <span className="text-muted-foreground font-mono text-xs">{loc.merchantId}</span>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => openBind(loc)}>
                    Connect POS
                  </Button>
                )}
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="sm" onClick={() => openRename(loc)}>
                  Rename
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {locations.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground py-8 text-center text-sm">
                No stores yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename store</DialogTitle>
            <DialogDescription>Update the display name for this store.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="store-name">Store name</Label>
            <Input
              id="store-name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={120}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={rename.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={rename.isPending || draft.trim().length === 0}>
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) setCreating(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add store</DialogTitle>
            <DialogDescription>
              Create a new location. It opens with the default hours and no POS connection — adjust
              its hours in Settings → Store Hours, then connect its POS to see sales.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-store-name">Store name</Label>
              <Input
                id="new-store-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={120}
                placeholder="e.g. Downtown"
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-store-tz">Timezone</Label>
              <Select value={newTz} onValueChange={setNewTz}>
                <SelectTrigger id="new-store-tz" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STORE_TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              onClick={submitCreate}
              disabled={create.isPending || newName.trim().length === 0}
            >
              {create.isPending ? "Adding…" : "Add store"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={binding !== null}
        onOpenChange={(open) => {
          if (!open) setBinding(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect POS{binding ? ` — ${binding.name}` : ""}</DialogTitle>
            <DialogDescription>
              Bind a connected POS account to this store so its sales, tickets, and reports scope to
              it. Only accounts not already linked to a store are listed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bind-merchant">POS account</Label>
            {unlinked.isLoading ? (
              <div className="text-muted-foreground text-sm">Loading connected POS accounts…</div>
            ) : merchants.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                No unconnected POS accounts. Connect a POS (e.g. install the Clover app) first, then
                bind it here.
              </div>
            ) : (
              <Select value={selectedMerchant} onValueChange={setSelectedMerchant}>
                <SelectTrigger id="bind-merchant" className="w-full">
                  <SelectValue placeholder="Choose a POS account" />
                </SelectTrigger>
                <SelectContent>
                  {merchants.map((merchant) => (
                    <SelectItem key={merchant.id} value={merchant.id}>
                      {merchant.name ? `${merchant.name} (${merchant.id})` : merchant.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBinding(null)} disabled={bind.isPending}>
              Cancel
            </Button>
            <Button onClick={submitBind} disabled={bind.isPending || !selectedMerchant}>
              {bind.isPending ? "Connecting…" : "Connect POS"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
