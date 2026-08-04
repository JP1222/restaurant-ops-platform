"use client";

import * as React from "react";
import { Barcode, Check, ScanLine, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";
import {
  useBarcodeLookup,
  useInventory,
  useScanReceiveAdHoc,
  useScanRegisterSave,
  type ScanRegisterInput
} from "@/hooks/use-inventory";
import { useIdempotencyKey } from "@/hooks/use-idempotency-key";
import type {
  InventoryCategory,
  InventoryItem,
  InventoryItemCreate,
  InventoryUnitKind
} from "@rop/contracts";

import { BackofficeBarcodeScanner } from "./backoffice-barcode-scanner";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

const EMPTY_FORM = {
  name: "",
  category: "",
  unit: "",
  unitKind: "count" as InventoryUnitKind,
  packLabel: "",
  packQty: "",
  vendor: "",
  price: ""
};

// Scan-to-register sheet (barcode-onboarding ADR, D2). The manager scans a Sam's/Walmart package
// on their phone: scan -> the code is resolved; an already-registered code shows its item, an
// unknown code opens a review form (match-or-create) that chains createItem -> optional savePack
// -> saveBarcode; after saving, the camera re-arms for the next package (the rapid-fire haul
// loop). Registration is backoffice-only (Iron Law #4); the floor only resolves.
export function ScanRegisterSheet({
  categories,
  mobile
}: {
  categories: InventoryCategory[];
  mobile: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [code, setCode] = React.useState<string | null>(null);
  const [manualCode, setManualCode] = React.useState("");
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [attachMode, setAttachMode] = React.useState(false);
  const [attachItemId, setAttachItemId] = React.useState("");
  const [attachSearch, setAttachSearch] = React.useState("");
  const [savedItem, setSavedItem] = React.useState<InventoryItem | null>(null);
  // Receive-on-register (P4): book the delivered quantity right after saving, so a haul goes
  // 0 -> on_hand in one motion. `receiveLater` skips the step for the rest of the session.
  const [receiveLater, setReceiveLater] = React.useState(false);
  const [recvQty, setRecvQty] = React.useState("");
  const [recvPackId, setRecvPackId] = React.useState("");
  // The code whose OFF suggestions we've already applied — so a prefill happens once per code and
  // never overwrites the manager's edits.
  const appliedFor = React.useRef<string | null>(null);

  const lookup = useBarcodeLookup(code);
  const save = useScanRegisterSave();
  const receive = useScanReceiveAdHoc();
  const receiveKey = useIdempotencyKey();
  const { data } = useInventory();
  const items = data?.items ?? [];

  // Pre-fill the review form from OFF suggestions once they arrive for the current code. A miss
  // (cups/straws/supplies, or no OFF db) leaves the form blank — the "new" path.
  React.useEffect(() => {
    const s = lookup.data && !lookup.data.registered ? lookup.data.suggestions : null;
    if (s && code && appliedFor.current !== code) {
      appliedFor.current = code;
      setForm((f) => ({
        ...f,
        name: f.name || s.name,
        category: s.category ?? f.category,
        unit: f.unit || s.unit,
        unitKind: s.unit_kind
      }));
    }
  }, [lookup.data, code]);

  const setField = (key: keyof typeof EMPTY_FORM, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Begin a fresh registration for `next` (a scanned/typed code), or reset to idle when null.
  function startCode(next: string | null) {
    setCode(next);
    setForm({ ...EMPTY_FORM, category: categories[0]?.id ?? "" });
    setAttachMode(false);
    setAttachItemId("");
    setAttachSearch("");
    setSavedItem(null);
    setRecvQty("");
    setRecvPackId("");
    save.reset();
    receive.reset();
    appliedFor.current = null;
  }

  function closeAll() {
    setOpen(false);
    setScanning(false);
    setManualCode("");
    setReceiveLater(false);
    startCode(null);
  }

  // Loop back to the camera for the next package — the batch-haul behavior.
  function scanNext() {
    setManualCode("");
    startCode(null);
    setScanning(true);
  }

  const packQtyNum = parseFloat(form.packQty);
  const wantsPack = form.packLabel.trim() !== "" && Number.isFinite(packQtyNum) && packQtyNum > 0;
  const stepUnit = form.unit.trim() || "units";
  const packSentence = wantsPack
    ? `1 ${form.packLabel.trim()} = ${packQtyNum} ${stepUnit} · this barcode maps to the ${form.packLabel.trim()}`
    : `This barcode maps to the item (counted in ${stepUnit}).`;

  const newValid = form.name.trim() !== "" && form.category !== "" && form.unit.trim() !== "";
  const canSave = code !== null && !save.isPending && (attachMode ? attachItemId !== "" : newValid);
  const hasSuggestions = Boolean(lookup.data && !lookup.data.registered && lookup.data.suggestions);

  function buildItem(): InventoryItemCreate {
    const priceCents = Math.round((parseFloat(form.price) || 0) * 100);
    return {
      name: form.name.trim(),
      category: form.category as InventoryItemCreate["category"],
      unit: form.unit.trim(),
      unit_kind: form.unitKind,
      // Par is per-location and set later; default to 0 / no-ceiling so a fast scan never blocks.
      par_min: 0,
      par_max: 0,
      vendor: form.vendor.trim() || undefined,
      purchase_cost_cents: priceCents > 0 ? priceCents : undefined,
      pack_qty: wantsPack ? packQtyNum : undefined
    };
  }

  async function submit() {
    if (!code || !canSave) return;
    const input: ScanRegisterInput = attachMode
      ? { existingItemId: attachItemId, barcode: { code, source: "manufacturer" } }
      : {
          item: buildItem(),
          pack: wantsPack
            ? { label: form.packLabel.trim(), base_qty_per_pack: packQtyNum, is_purchase_default: true }
            : undefined,
          barcode: { code, source: "manufacturer" }
        };
    const saved = await save.mutateAsync(input);
    setSavedItem(saved);
  }

  // Book the delivered quantity for the just-saved item (P4). A pack_id ⇒ qty is in packs and the
  // API converts via base_qty_per_pack; absent ⇒ base units. Fresh idempotency key per (item, qty,
  // pack) so a re-tap dedups, then loop back to the camera for the next package.
  async function bookReceipt() {
    if (!savedItem) return;
    const qty = parseFloat(recvQty);
    if (!Number.isFinite(qty) || qty <= 0) return;
    await receive.mutateAsync({
      vendor: savedItem.vendor || undefined,
      lines: [{ sku: savedItem.id, qty, pack_id: recvPackId || undefined }],
      idempotency_key: receiveKey.keyFor(JSON.stringify({ id: savedItem.id, qty, packId: recvPackId }))
    });
    receiveKey.reset();
    scanNext();
  }

  const recvQtyNum = parseFloat(recvQty);
  const recvValid = Number.isFinite(recvQtyNum) && recvQtyNum > 0;
  const recvUnitLabel = recvPackId
    ? ((savedItem?.packs ?? []).find((p) => p.id === recvPackId)?.label ?? "pack")
    : (savedItem?.unit ?? "units");

  const needle = attachSearch.trim().toLowerCase();
  const filteredItems = (needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items).slice(0, 8);

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
          } else {
            closeAll();
          }
        }}
      >
        <SheetTrigger asChild>
          <Button size="sm" variant="outline">
            <ScanLine className="size-3.5" />
            {mobile ? "Scan" : "Scan to add"}
          </Button>
        </SheetTrigger>
        <SheetContent
          side={mobile ? "bottom" : "right"}
          className={mobile ? "max-h-[92vh]" : "sm:max-w-md"}
        >
          <SheetHeader>
            <SheetTitle>Scan to add</SheetTitle>
            <SheetDescription>
              Scan a package barcode to register it. Scan again to add the next item.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-4 overflow-y-auto px-4 pb-6">
            {savedItem ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-md border border-border bg-trend-up-bg/60 px-3 py-2 text-sm">
                  <Check className="size-4 text-trend-up" />
                  Saved <span className="font-medium">{savedItem.name}</span>.
                </div>
                {receiveLater ? (
                  <div className="flex gap-2">
                    <Button onClick={scanNext} className="flex-1">
                      <ScanLine className="size-3.5" /> Scan next
                    </Button>
                    <Button variant="outline" onClick={closeAll}>
                      Done
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">How many did you receive?</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="recv-qty">Quantity</Label>
                        <Input
                          id="recv-qty"
                          value={recvQty}
                          inputMode="decimal"
                          autoFocus
                          onChange={(e) => setRecvQty(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && recvValid && !receive.isPending) void bookReceipt();
                          }}
                          placeholder="0"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="recv-pack">In</Label>
                        <select
                          id="recv-pack"
                          value={recvPackId}
                          onChange={(e) => setRecvPackId(e.target.value)}
                          className={SELECT_CLASS}
                        >
                          <option value="">{savedItem.unit}</option>
                          {(savedItem.packs ?? []).map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label} ({p.base_qty_per_pack} {savedItem.unit})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {receive.isError ? (
                      <p className="text-xs text-trend-down">Could not book the receipt — try again.</p>
                    ) : null}
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={scanNext} disabled={receive.isPending}>
                        Skip
                      </Button>
                      <Button
                        onClick={() => void bookReceipt()}
                        disabled={!recvValid || receive.isPending}
                        className="flex-1"
                      >
                        {receive.isPending
                          ? "Booking…"
                          : recvValid
                            ? `Receive ${recvQtyNum} ${recvUnitLabel}`
                            : "Receive"}
                      </Button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReceiveLater(true)}
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Receive everything later
                    </button>
                  </>
                )}
              </div>
            ) : code === null ? (
              <div className="space-y-4">
                <Button onClick={() => setScanning(true)} className="w-full">
                  <ScanLine className="size-4" /> Scan a barcode
                </Button>
                <div className="space-y-1">
                  <Label htmlFor="scan-manual">Or enter the code</Label>
                  <div className="flex gap-2">
                    <Input
                      id="scan-manual"
                      value={manualCode}
                      onChange={(e) => setManualCode(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && manualCode.trim()) startCode(manualCode.trim());
                      }}
                      inputMode="numeric"
                      placeholder="0123456789012"
                      className="font-mono"
                    />
                    <Button variant="outline" onClick={() => startCode(manualCode.trim())} disabled={!manualCode.trim()}>
                      Look up
                    </Button>
                  </div>
                </div>
              </div>
            ) : lookup.isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Looking up {code}…</p>
            ) : lookup.data?.registered ? (
              <div className="space-y-3">
                <div className="rounded-md border border-border bg-secondary/40 px-3 py-3 text-sm">
                  <div className="text-muted-foreground">Already registered</div>
                  <div className="mt-0.5 font-medium">{lookup.data.item?.name}</div>
                  <div className="mt-0.5 font-mono text-xs text-muted-foreground">{code}</div>
                </div>
                <Button onClick={scanNext} className="w-full">
                  <ScanLine className="size-3.5" /> Scan next
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                  <Barcode className="size-4 text-muted-foreground" />
                  <span className="font-mono text-sm">{code}</span>
                  <span className={hasSuggestions ? "ml-auto text-xs text-trend-up" : "ml-auto text-xs text-muted-foreground"}>
                    {hasSuggestions ? "found — review the details" : "new — fill in the details"}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setAttachMode((m) => !m)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  {attachMode ? "Create a new item instead" : "Attach to an existing item instead"}
                </button>

                {attachMode ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
                      <Input
                        value={attachSearch}
                        onChange={(e) => setAttachSearch(e.target.value)}
                        placeholder="Search items…"
                        className="pl-8"
                      />
                    </div>
                    <div className="max-h-48 space-y-1 overflow-y-auto">
                      {filteredItems.map((i) => (
                        <button
                          key={i.id}
                          type="button"
                          onClick={() => setAttachItemId(i.id)}
                          className={
                            "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm " +
                            (attachItemId === i.id
                              ? "border-foreground/40 bg-secondary"
                              : "border-border hover:bg-secondary/60")
                          }
                        >
                          <span className="truncate">{i.name}</span>
                          {attachItemId === i.id ? <Check className="size-4 text-trend-up" /> : null}
                        </button>
                      ))}
                      {filteredItems.length === 0 ? (
                        <p className="px-1 py-2 text-xs text-muted-foreground">No matching items.</p>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="scan-name">Name</Label>
                      <Input
                        id="scan-name"
                        value={form.name}
                        onChange={(e) => setField("name", e.target.value)}
                        maxLength={120}
                        autoFocus
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="scan-cat">Category</Label>
                        <select
                          id="scan-cat"
                          value={form.category}
                          onChange={(e) => setField("category", e.target.value)}
                          className={SELECT_CLASS}
                        >
                          {categories.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="scan-unit">Unit</Label>
                        <Input
                          id="scan-unit"
                          value={form.unit}
                          onChange={(e) => setField("unit", e.target.value)}
                          placeholder="each / oz / ml"
                          maxLength={24}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="scan-kind">Unit type</Label>
                      <select
                        id="scan-kind"
                        value={form.unitKind}
                        onChange={(e) => setField("unitKind", e.target.value as InventoryUnitKind)}
                        className={SELECT_CLASS}
                      >
                        <option value="count">Count</option>
                        <option value="weight">Weight</option>
                        <option value="volume">Volume</option>
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="scan-packlabel">
                          Pack <span className="text-muted-foreground">(optional)</span>
                        </Label>
                        <Input
                          id="scan-packlabel"
                          value={form.packLabel}
                          onChange={(e) => setField("packLabel", e.target.value)}
                          placeholder="Case"
                          maxLength={60}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="scan-packqty">Units / pack</Label>
                        <Input
                          id="scan-packqty"
                          value={form.packQty}
                          inputMode="decimal"
                          onChange={(e) => setField("packQty", e.target.value)}
                          placeholder="24"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{packSentence}</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="scan-vendor">
                          Vendor <span className="text-muted-foreground">(optional)</span>
                        </Label>
                        <Input
                          id="scan-vendor"
                          value={form.vendor}
                          onChange={(e) => setField("vendor", e.target.value)}
                          maxLength={120}
                          placeholder="Sam's Club"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="scan-price">
                          Price $ <span className="text-muted-foreground">(optional)</span>
                        </Label>
                        <Input
                          id="scan-price"
                          value={form.price}
                          inputMode="decimal"
                          onChange={(e) => setField("price", e.target.value)}
                          placeholder="12.98"
                        />
                      </div>
                    </div>
                  </>
                )}

                {save.isError ? (
                  <p className="text-xs text-trend-down">
                    {save.error instanceof Error ? save.error.message : "Could not save."}
                  </p>
                ) : null}

                <div className="flex gap-2 pt-1">
                  <Button variant="outline" onClick={() => startCode(null)} disabled={save.isPending}>
                    Back
                  </Button>
                  <Button onClick={() => void submit()} disabled={!canSave} className="flex-1">
                    {save.isPending ? "Saving…" : attachMode ? "Attach barcode" : "Register item"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {scanning ? (
        <BackofficeBarcodeScanner
          onDetect={(detected) => {
            setScanning(false);
            startCode(detected.trim());
          }}
          onClose={() => setScanning(false)}
        />
      ) : null}
    </>
  );
}
