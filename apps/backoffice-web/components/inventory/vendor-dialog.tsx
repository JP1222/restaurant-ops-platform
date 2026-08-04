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
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateVendor, useSaveVendor } from "@/hooks/use-inventory";
import { cn } from "@/lib/utils";
import type { InventoryCategory, InventoryVendor, InventoryVendorSave } from "@rop/contracts";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const CHIP_CLASS = (active: boolean) =>
  cn(
    "h-8 rounded-md border px-2.5 text-xs font-medium transition-colors",
    active
      ? "border-foreground/30 bg-secondary text-foreground"
      : "border-border bg-background text-muted-foreground hover:bg-secondary/60"
  );

// Controlled add/edit vendor dialog (catalog D2). Pass `vendor` to edit; omit to add.
// The parent keys this by vendor id so the field initializers re-run per vendor.
export function VendorDialog({
  open,
  onOpenChange,
  vendor,
  categories
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor?: InventoryVendor | null;
  categories: InventoryCategory[];
}) {
  const isEdit = Boolean(vendor);
  const [name, setName] = useState(vendor?.name ?? "");
  const [type, setType] = useState(vendor?.type ?? "");
  const [contact, setContact] = useState(vendor?.contact ?? "");
  const [phone, setPhone] = useState(vendor?.phone ?? "");
  const [email, setEmail] = useState(vendor?.email ?? "");
  const [account, setAccount] = useState(vendor?.account ?? "");
  const [terms, setTerms] = useState(vendor?.terms ?? "");
  const [minOrder, setMinOrder] = useState(vendor ? (vendor.min_order_cents / 100).toFixed(2) : "");
  const [cutoff, setCutoff] = useState(vendor?.cutoff ?? "");
  const [preferred, setPreferred] = useState(vendor?.preferred ?? false);
  const [days, setDays] = useState<string[]>(vendor?.delivery_days ?? []);
  const [cats, setCats] = useState<string[]>(vendor?.categories ?? []);
  const [tags, setTags] = useState((vendor?.tags ?? []).join(", "));

  const create = useCreateVendor();
  const save = useSaveVendor();
  const pending = create.isPending || save.isPending;
  const isError = create.isError || save.isError;
  const error = create.error ?? save.error;

  const valid = name.trim() !== "";

  const toggleDay = (d: string) =>
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  const toggleCat = (id: string) =>
    setCats((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid) return;
            const payload: InventoryVendorSave = {
              name: name.trim(),
              type: type.trim() || undefined,
              contact: contact.trim() || undefined,
              phone: phone.trim() || undefined,
              email: email.trim() || undefined,
              account: account.trim() || undefined,
              terms: terms.trim() || undefined,
              min_order_cents: minOrder.trim()
                ? Math.round((parseFloat(minOrder) || 0) * 100)
                : undefined,
              cutoff: cutoff.trim() || undefined,
              delivery_days: days,
              categories: cats as InventoryVendorSave["categories"],
              preferred,
              tags: tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            };
            if (vendor) {
              await save.mutateAsync({ id: vendor.id, body: payload });
            } else {
              await create.mutateAsync(payload);
            }
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit vendor" : "Add vendor"}</DialogTitle>
            <DialogDescription>
              {isEdit
                ? "Update contact, terms, and ordering details. Performance scores come from received-PO reconciliation."
                : "Create a supplier. Fill-rate / on-time / price-stability scores fill in later from received-PO reconciliation."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <Label htmlFor="vendor-name">Name</Label>
            <Input
              id="vendor-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="vendor-type">Type</Label>
              <Input
                id="vendor-type"
                value={type}
                onChange={(event) => setType(event.target.value)}
                placeholder="Specialty / Broadline"
                maxLength={60}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vendor-account">Account #</Label>
              <Input
                id="vendor-account"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                maxLength={60}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="vendor-contact">Contact</Label>
              <Input
                id="vendor-contact"
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vendor-phone">Phone</Label>
              <Input
                id="vendor-phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                maxLength={40}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="vendor-email">Email</Label>
            <Input
              id="vendor-email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={160}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="vendor-terms">Terms</Label>
              <Input
                id="vendor-terms"
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
                placeholder="Net 7"
                maxLength={60}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vendor-minorder">Min order $</Label>
              <Input
                id="vendor-minorder"
                value={minOrder}
                inputMode="decimal"
                onChange={(event) => setMinOrder(event.target.value)}
                placeholder="150.00"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="vendor-cutoff">Cutoff</Label>
              <Input
                id="vendor-cutoff"
                value={cutoff}
                onChange={(event) => setCutoff(event.target.value)}
                placeholder="9:00 PM CT"
                maxLength={60}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Delivery days</Label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  className={CHIP_CLASS(days.includes(d))}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {categories.length > 0 ? (
            <div className="space-y-1.5">
              <Label>Categories supplied</Label>
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCat(c.id)}
                    className={CHIP_CLASS(cats.includes(c.id))}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="vendor-tags">
              Tags <span className="text-muted-foreground">(comma-separated)</span>
            </Label>
            <Input
              id="vendor-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="local, organic"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={preferred}
              onChange={(event) => setPreferred(event.target.checked)}
              className="size-4 rounded border-border accent-foreground"
            />
            Preferred vendor
          </label>

          {isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not save vendor</AlertTitle>
              <AlertDescription>
                {error instanceof Error ? error.message : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !valid}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Add vendor"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
