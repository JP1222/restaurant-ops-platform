"use client";

import { useEffect, useRef, useState } from "react";

import type { InventoryItem, InventoryUnitKind } from "@rop/contracts";

import {
  addItem,
  applyCount,
  archiveItem,
  receiveAdHoc,
  recordWaste,
  removeItemImage,
  saveItemCost,
  saveItemInfo,
  suggestEmoji,
  toggle86,
  updateItemPar,
  uploadItemImage,
  itemImageUrl,
  writeFailureReason,
  type WriteFailure,
} from "@/lib/api";
import { cn } from "@/lib/cn";
import { useCrewData } from "@/lib/crew-data";
import { CREW_STATUS, crewStatus, money } from "@/lib/crew-status";
import { REASON_GLYPHS } from "@/lib/employees";
import { resizeImageForUpload, type ResizedImage } from "@/lib/image";
import { useIdempotencyKey } from "@/lib/use-idempotency-key";
import { EmojiPicker } from "./emoji-picker";
import { ScanRegisterFlow } from "./scan-register-flow";
import { ItemThumb } from "./item-thumb";
import { STRINGS, writeFailureKey, type StringKey } from "@/lib/strings";
import type { Lang } from "@/lib/types";
import { useCrewSize } from "@/lib/use-crew-size";

// Artículos — the Catálogo surface. A searchable item list ⇄ item detail/edit,
// consolidating per-item actions (edit info, 86, recount, waste) and "＋ Nuevo".
// The detail is a sub-state driven by `sel` (lifted to crew-app so the top-bar
// back can do detail → list; see §4 of the design handoff). Replaces the old
// stand-alone Add item / Edit item / 86 screens.
type Filter = "all" | "critical" | "low" | "healthy";

export function ItemsScreen({
  lang,
  sel,
  setSel,
  onChanged,
  showToast,
}: {
  lang: Lang;
  sel: string | null;
  setSel: (s: string | null) => void;
  onChanged: () => Promise<void> | void;
  // App-level toast (crew-app) — surfaces bulk write failures ("couldn't save").
  showToast?: (msg: string) => void;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { items, categories } = useCrewData();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Scan-to-register overlay (barcode-onboarding ADR, opened to the floor): scan a UPC → OFF
  // auto-fill → create + bind barcode + receive. Reached from the ＋New "Add item" chooser.
  const [registering, setRegistering] = useState(false);
  // The "Add item" chooser (bottom sheet) behind ＋New — pick Scan barcode (→ registering) or
  // Enter manually (→ the blank new-item form). Replaces the old standalone Registrar toolbar
  // button + the search-field scan icons (the Home "Escanear código" tile owns stock-adjust).
  const [addOpen, setAddOpen] = useState(false);

  // Multi-select + batch delete (design handoff §1–2). `selecting` is a mode
  // toggle (the iOS Photos / Files pattern), NOT always-on per-row checkboxes —
  // both alternatives were explicitly rejected in the handoff. `undo` holds the
  // archived ids so the snackbar can restore (un-archive) them within 5s.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Record<string, true>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ ids: string[]; count: number } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  // Arm the 5s auto-dismiss + stash the just-archived ids. Shared by BOTH batch
  // delete (here) and the detail-view delete (ItemDetail → onArchived), so the
  // single undo snackbar on the list covers every delete path.
  const startUndo = (ids: string[]) => {
    if (!ids.length) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ ids, count: ids.length });
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };

  const toastError = (e: unknown) => showToast?.(T[writeFailureKey(writeFailureReason(e))]);

  if (sel === "__new__") {
    return <ItemDetail key="__new__" lang={lang} isNew onChanged={onChanged} onClose={() => setSel(null)} />;
  }
  if (sel) {
    const live = items.find((it) => it.id === sel);
    if (live) {
      return (
        <ItemDetail
          key={live.id}
          lang={lang}
          item={live}
          onChanged={onChanged}
          onClose={() => setSel(null)}
          onArchived={startUndo}
        />
      );
    }
    // Item vanished from the dataset (archived elsewhere) — fall back to the list.
  }

  const ql = q.trim().toLowerCase();
  const rows = items.filter((it) => {
    if (filter !== "all" && crewStatus(it) !== filter) return false;
    if (!ql) return true;
    return it.name.toLowerCase().includes(ql) || it.sku.toLowerCase().includes(ql);
  });

  // Selection persists across filter changes, so count/act on every still-live
  // selected id (not just the currently-visible rows). "Select all" therefore
  // MERGES the visible rows into the selection (and "Deselect all" removes only
  // the visible rows) — it never discards out-of-view selections.
  const selectedIds = items.filter((it) => selected[it.id]).map((it) => it.id);
  const selCount = selectedIds.length;
  const allSelected = rows.length > 0 && rows.every((it) => selected[it.id]);

  const chips: Filter[] = ["all", "critical", "low", "healthy"];

  const exitSelect = () => {
    setSelecting(false);
    setSelected({});
    setConfirmDelete(false);
  };
  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = { ...s };
      if (n[id]) delete n[id];
      else n[id] = true;
      return n;
    });
  const onSelectAll = () =>
    setSelected((s) => {
      const n = { ...s };
      // Toggle the visible rows as a group; out-of-view selections are untouched.
      if (allSelected) rows.forEach((it) => delete n[it.id]);
      else rows.forEach((it) => (n[it.id] = true));
      return n;
    });
  const onCard = (id: string) => (selecting ? toggleSelect(id) : setSel(id));

  // Batch delete = N soft archives (the real "delete"), then one undo snapshot.
  // allSettled so a single failed archive doesn't lose the others' undo; the undo
  // set is only the ids that actually archived.
  const confirmDeleteNow = () => {
    if (busy || !selCount) return;
    const ids = selectedIds;
    void (async () => {
      setBusy(true);
      const results = await Promise.allSettled(ids.map((id) => archiveItem(id)));
      await onChanged();
      setBusy(false);
      exitSelect();
      const ok = ids.filter((_, i) => results[i]?.status === "fulfilled");
      if (ok.length) startUndo(ok);
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) toastError(failed.reason);
    })();
  };

  // Undo = un-archive (archived=false) — a clean, side-effect-free restore (the
  // API only flips archivedAt). Fresh calls, not the original ones.
  const undoDelete = () => {
    if (!undo || busy) return;
    const ids = undo.ids;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    void (async () => {
      setBusy(true);
      const results = await Promise.allSettled(ids.map((id) => archiveItem(id, false)));
      await onChanged();
      setBusy(false);
      setUndo(null);
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) toastError(failed.reason);
    })();
  };

  // Bulk "Mark 86": flag only the selected items that aren't already 86 — toggle86
  // toggles, so flagging an already-86 item would silently un-86 it.
  const bulkMark86 = () => {
    if (busy || !selCount) return;
    const targets = items.filter((it) => selected[it.id] && !it.flagged_86).map((it) => it.id);
    void (async () => {
      setBusy(true);
      const results = await Promise.allSettled(targets.map((id) => toggle86(id)));
      await onChanged();
      setBusy(false);
      exitSelect();
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) toastError(failed.reason);
    })();
  };

  // Header morphs with mode but keeps both lines (height constant — never drop the
  // subtitle or the page jumps; design handoff §1).
  const title = selecting
    ? selCount > 0
      ? T.it_sel_n.replace("{n}", String(selCount))
      : T.it_sel_title
    : T.cat_items;
  const subtitle = selecting ? (selCount > 0 ? T.it_sel_more : T.it_sel_tap) : T.items_sub;
  // A floating bar (bulk actions or undo) sits over the last rows — reserve space.
  const floatingBar = (selecting && selCount > 0 && !confirmDelete) || Boolean(undo);

  return (
    <div className="h-full flex flex-col bg-zinc-50 relative">
      <div className={cn("flex items-start gap-3.5", phone ? "px-4 pt-3.5" : "px-10 pt-4")}>
        <div className="flex-1 min-w-0">
          <h2 className={cn("font-semibold tracking-tight text-zinc-900", phone ? "text-xl" : "text-3xl")}>
            {title}
          </h2>
          <p
            className={cn("mt-1", phone ? "text-sm" : "text-base")}
            style={{ color: selecting ? "#1F8A5B" : "#71717a" }}
          >
            {subtitle}
          </p>
        </div>
      </div>

      {registering && (
        <ScanRegisterFlow
          lang={lang}
          categories={categories}
          onDone={() => setRegistering(false)}
          onChanged={onChanged}
        />
      )}
      {/* Toolbar: search (flex-1) + a right-aligned cluster that swaps IN PLACE
          between default (Select / ＋ New) and select mode (Select all / Done). */}
      <div className={cn("flex gap-3 pt-2", phone ? "flex-col items-stretch px-4" : "items-center px-10")}>
        <div
          className={cn(
            "flex-1 flex items-center gap-2.5 rounded-2xl bg-white border border-zinc-200 px-4",
            phone ? "h-[58px]" : "h-13",
          )}
          style={phone ? undefined : { height: 52 }}
        >
          <SearchIcon className="size-5 text-zinc-400 flex-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={T.items_search_ph}
            className="flex-1 bg-transparent border-0 outline-none text-base"
          />
        </div>
        <div className={cn("flex gap-3", phone && "w-full")}>
          {selecting ? (
            <>
              <button
                onClick={onSelectAll}
                className={cn(TOOLBAR_GHOST, phone && "flex-1")}
                style={{ height: 52 }}
              >
                {allSelected ? T.it_deselect_all : T.it_select_all}
              </button>
              <button
                onClick={exitSelect}
                className={cn(
                  "inline-flex items-center justify-center rounded-[14px] text-white font-semibold text-[15px] px-5",
                  phone && "flex-1",
                )}
                style={{ background: "#18181b", height: 52 }}
              >
                {T.done}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setSelecting(true)}
                className={cn(TOOLBAR_GHOST, phone && "flex-1")}
                style={{ height: 52 }}
              >
                {T.it_select}
              </button>
              <button
                onClick={() => setAddOpen(true)}
                className={cn(
                  "inline-flex items-center justify-center gap-2 rounded-[14px] text-white font-semibold text-[15px] px-4.5",
                  phone && "flex-1",
                )}
                style={{ background: "#1F8A5B", height: 52 }}
              >
                <PlusIcon className="size-[18px]" /> {T.items_new}
              </button>
            </>
          )}
        </div>
      </div>

      <div className={cn("flex items-center gap-2 pt-3.5 pb-1 overflow-x-auto", phone ? "px-4" : "px-10")}>
        {chips.map((k) => {
          const active = filter === k;
          const dot = k !== "all" ? CREW_STATUS[k].color : undefined;
          return (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={cn(
                // 44px tall for gloved-hand taps (design handoff §7).
                "inline-flex items-center gap-1.5 h-11 px-4 rounded-full text-sm whitespace-nowrap border",
                active ? "bg-zinc-900 text-white border-zinc-900" : "bg-white text-zinc-600 border-zinc-200",
              )}
            >
              {dot && <span className="size-2 rounded-full" style={{ background: dot }} />}
              {k === "all" ? T.items_all : STRINGS[lang][CREW_STATUS[k].labelKey]}
            </button>
          );
        })}
      </div>

      <div
        className={cn(
          "flex-1 overflow-y-auto grid gap-2.5 content-start pt-2",
          phone ? "px-4 grid-cols-1" : "px-10 grid-cols-2",
        )}
        style={{
          paddingBottom: phone
            ? `calc(${floatingBar ? "7rem" : "1rem"} + env(safe-area-inset-bottom))`
            : floatingBar
              ? "7rem"
              : "1rem",
        }}
      >
        {rows.length === 0 ? (
          <EmptyState
            lang={lang}
            query={q}
            filtered={filter !== "all"}
            onClear={() => setQ("")}
            onShowAll={() => setFilter("all")}
          />
        ) : (
          rows.map((it) => (
            <ItemCard
              key={it.id}
              item={it}
              lang={lang}
              selecting={selecting}
              selected={Boolean(selected[it.id])}
              query={q}
              onClick={() => onCard(it.id)}
            />
          ))
        )}
      </div>

      {/* Bulk action bar — floating dark pill, centered, rises on entry. */}
      {selecting && selCount > 0 && !confirmDelete && (
        <div className="absolute inset-x-0 bottom-0 z-40 flex justify-center px-6 pt-4 pb-6 pointer-events-none">
          <div
            className="pointer-events-auto flex items-center gap-3.5 rounded-[20px] crew-bar-up"
            style={{ background: "#18181b", padding: "12px 14px 12px 22px", boxShadow: "0 18px 40px -12px rgba(0,0,0,0.5)" }}
          >
            <span className="text-white text-[15px] font-semibold whitespace-nowrap">
              {T.it_sel_n.replace("{n}", String(selCount))}
            </span>
            <span className="w-px h-6 flex-none" style={{ background: "rgba(255,255,255,0.15)" }} />
            <button
              onClick={bulkMark86}
              disabled={busy}
              className="inline-flex items-center gap-2 h-11 px-4.5 rounded-[14px] text-white text-[15px] font-semibold whitespace-nowrap disabled:opacity-50"
              style={{ background: "rgba(255,255,255,0.1)" }}
            >
              ⊘ {T.e86_mark}
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="inline-flex items-center gap-2 h-11 px-5 rounded-[14px] text-white text-[15px] font-semibold whitespace-nowrap disabled:opacity-50"
              style={{ background: "#dc2626" }}
            >
              <TrashIcon className="size-[17px]" /> {T.it_del_n.replace("{n}", String(selCount))}
            </button>
          </div>
        </div>
      )}

      {/* Undo snackbar — appears after a delete, auto-dismisses in 5s. */}
      {undo && (
        <div className="absolute inset-x-0 bottom-0 z-50 flex justify-center px-6 pt-4 pb-6 pointer-events-none">
          <div
            className="pointer-events-auto flex items-center gap-4 rounded-2xl crew-bar-up"
            style={{ background: "#18181b", padding: "12px 14px 12px 22px", boxShadow: "0 18px 40px -12px rgba(0,0,0,0.5)" }}
          >
            <span className="text-white text-[15px] font-medium whitespace-nowrap">
              {undo.count === 1 ? T.it_deleted_one : T.it_deleted_many.replace("{n}", String(undo.count))}
            </span>
            <button
              onClick={undoDelete}
              disabled={busy}
              className="inline-flex items-center gap-2 h-11 px-4.5 rounded-xl text-white text-[15px] font-semibold disabled:opacity-50"
              style={{ background: "#1F8A5B" }}
            >
              <UndoIcon className="size-4" /> {T.undo}
            </button>
          </div>
        </div>
      )}

      {/* Delete confirm modal — scrim + blur, pops in. */}
      {confirmDelete && (
        <div
          className="absolute inset-0 z-[60] flex items-center justify-center crew-fade-in"
          style={{ background: "rgba(24,24,27,0.4)", backdropFilter: "blur(2px)" }}
        >
          <div
            className="bg-white rounded-3xl p-7 mx-6 crew-pop"
            style={{ width: 440, maxWidth: "calc(100% - 3rem)", boxShadow: "0 30px 60px -15px rgba(0,0,0,0.4)" }}
          >
            <div className="flex items-center justify-center rounded-full size-13 mb-4" style={{ background: "#fde7e6" }}>
              <TrashIcon className="size-6 text-[#dc2626]" />
            </div>
            <div className="text-xl font-semibold text-zinc-900">
              {selCount === 1 ? T.it_del_confirm_one : T.it_del_confirm_many.replace("{n}", String(selCount))}
            </div>
            <p className="mt-2 text-[15px] leading-relaxed text-zinc-500">{T.it_del_note}</p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={busy}
                className="flex-1 rounded-2xl border border-zinc-200 bg-white text-zinc-600 font-semibold disabled:opacity-50"
                style={{ height: 52 }}
              >
                {T.cancel}
              </button>
              <button
                onClick={confirmDeleteNow}
                disabled={busy}
                className="flex-1 rounded-2xl text-white font-semibold disabled:opacity-50"
                style={{ background: "#dc2626", height: 52 }}
              >
                {selCount === 1 ? T.it_del_confirm_btn_one : T.it_del_confirm_btn_many.replace("{n}", String(selCount))}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ＋New "Add item" chooser — Scan barcode (→ scan-to-register) or Enter manually
          (→ blank new-item form). Both land on the same editor; the scan path arrives pre-filled. */}
      {addOpen && (
        <AddItemSheet
          lang={lang}
          onScan={() => {
            setAddOpen(false);
            setRegistering(true);
          }}
          onManual={() => {
            setAddOpen(false);
            setSel("__new__");
          }}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

// Ghost toolbar button (Select / Select all / Deselect all): white, hairline
// border, dark text — the design's neutral cluster button.
const TOOLBAR_GHOST =
  "inline-flex items-center justify-center rounded-[14px] bg-white border border-zinc-200 text-zinc-800 font-semibold text-[15px] px-4.5";

// The ＋New "Add item" chooser: a bottom sheet offering the two ways to create an item — Scan
// barcode (teal → scan-to-register) and Enter manually (neutral → the blank editor). Both land
// on the same new-item form; the scan path arrives pre-filled. Reuses the crew animation
// vocabulary (scrim fade + sheet rise) and the prototype's tokens; tap-outside dismisses.
function AddItemSheet({
  lang,
  onScan,
  onManual,
  onClose,
}: {
  lang: Lang;
  onScan: () => void;
  onManual: () => void;
  onClose: () => void;
}) {
  const T = STRINGS[lang];
  return (
    <div
      className="absolute inset-0 z-[72] flex flex-col justify-end crew-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={T.add_title}
    >
      <button
        aria-label={T.cancel}
        onClick={onClose}
        className="absolute inset-0 border-0"
        style={{ background: "rgba(10,10,10,0.45)" }}
      />
      <div
        className="relative bg-white crew-bar-up"
        style={{
          borderRadius: "24px 24px 0 0",
          padding: "20px 18px",
          paddingBottom: "calc(26px + env(safe-area-inset-bottom))",
          boxShadow: "0 -8px 40px rgba(0,0,0,0.2)",
        }}
      >
        <div className="mx-auto mb-4" style={{ width: 40, height: 4, borderRadius: 99, background: "#e4e4e7" }} />
        <div className="font-semibold text-zinc-900 mb-4" style={{ fontSize: 18, letterSpacing: "-0.01em", marginLeft: 4 }}>
          {T.add_title}
        </div>
        <div className="flex flex-col gap-3">
          <AddOption
            onClick={onScan}
            tone="scan"
            title={T.add_scan}
            sub={T.add_scan_sub}
            icon={<ViewfinderIcon className="size-[26px]" />}
          />
          <AddOption
            onClick={onManual}
            tone="manual"
            title={T.add_manual}
            sub={T.add_manual_sub}
            icon={<PencilIcon className="size-6" />}
          />
        </div>
      </div>
    </div>
  );
}

// One chooser tile. `tone` flips the whole palette: teal-on-white for the scan path, neutral
// (white card, grey chip) for manual. Height = 16px padding + 50px icon chip ≈ 82px, well over
// the 56px gloved-hand target.
function AddOption({
  onClick,
  tone,
  title,
  sub,
  icon,
}: {
  onClick: () => void;
  tone: "scan" | "manual";
  title: string;
  sub: string;
  icon: React.ReactNode;
}) {
  const scan = tone === "scan";
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-4 text-left active:scale-[0.99] transition-transform"
      style={{
        padding: 16,
        borderRadius: 16,
        background: scan ? "#0d9488" : "#fff",
        border: scan ? undefined : "1px solid #e4e4e7",
        color: scan ? "#fff" : "#18181b",
      }}
    >
      <span
        className="flex items-center justify-center flex-none"
        style={{
          width: 50,
          height: 50,
          borderRadius: 14,
          background: scan ? "rgba(255,255,255,0.18)" : "#f4f4f5",
          color: scan ? "#fff" : "#52525b",
        }}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block font-semibold" style={{ fontSize: 17 }}>
          {title}
        </span>
        <span className="block" style={{ fontSize: 13, marginTop: 1, color: scan ? "rgba(255,255,255,0.85)" : "#71717a" }}>
          {sub}
        </span>
      </span>
      <span style={{ fontSize: 24, color: scan ? "rgba(255,255,255,0.7)" : "#d4d4d8" }}>›</span>
    </button>
  );
}

function ItemCard({
  item,
  lang,
  selecting,
  selected,
  query,
  onClick,
}: {
  item: InventoryItem;
  lang: Lang;
  selecting: boolean;
  selected: boolean;
  query: string;
  onClick: () => void;
}) {
  const s = crewStatus(item);
  const barColor = CREW_STATUS[s].color;
  const ratio = item.par_min > 0 ? item.on_hand / item.par_min : item.on_hand > 0 ? 1 : 0;
  const pct = Math.max(3, Math.min(100, Math.round(ratio * 100)));
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-4 rounded-[18px] p-3.5 text-left active:scale-[0.995] transition-transform border",
        selected ? "" : "bg-white border-zinc-200 hover:border-zinc-300",
      )}
      style={selected ? { background: "#f0faf5", borderColor: "#1F8A5B", boxShadow: "0 0 0 1px #1F8A5B" } : undefined}
    >
      {selecting && (
        <span
          className="flex items-center justify-center rounded-full flex-none text-white"
          style={{
            width: 26,
            height: 26,
            background: selected ? "#1F8A5B" : "#fff",
            border: selected ? "none" : "2px solid #d4d4d8",
          }}
        >
          {selected && <CheckIcon className="size-3.5" />}
        </span>
      )}
      <ItemThumb item={item} className="size-12 text-[23px] flex-none" rounded="rounded-2xl" />
      <div className="flex-1 min-w-0">
        <div className="text-[17px] font-semibold text-zinc-900 truncate">
          <Highlight text={item.name} query={query} />
        </div>
        <div className="flex items-center gap-2.5 mt-1.5">
          <span className="h-1.5 rounded-full bg-zinc-100 overflow-hidden flex-none" style={{ width: 84 }}>
            <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: barColor }} />
          </span>
          <span className="font-mono text-xs text-zinc-500 tabular-nums">
            {item.on_hand}/{item.par_min} {item.unit}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1.5 flex-none">
        <StatusPill item={item} lang={lang} />
        <span className="font-mono text-sm text-zinc-600 tabular-nums">{money(item.cost_cents)}</span>
      </div>
    </button>
  );
}

export function StatusPill({ item, lang }: { item: InventoryItem; lang: Lang }) {
  const s = crewStatus(item);
  const m = CREW_STATUS[s];
  const label = item.flagged_86 ? "86" : STRINGS[lang][m.labelKey];
  return (
    <span
      className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[13px] font-semibold"
      style={{ color: m.color, background: m.soft }}
    >
      <span className="size-[7px] rounded-full" style={{ background: m.color }} />
      {label}
    </span>
  );
}

const BLANK_CATEGORY = "food";

function ItemDetail({
  lang,
  item,
  isNew,
  initialPack,
  onChanged,
  onClose,
  onArchived,
}: {
  lang: Lang;
  item?: InventoryItem;
  isNew?: boolean;
  // A barcode-resolved pack id (ADR-0737): pre-selects in Merma / Recibir so a scanned pack
  // code lands ready-to-count. Ignored if it isn't one of this item's packs.
  initialPack?: string | null;
  onChanged: () => Promise<void> | void;
  onClose: () => void;
  // Notify the list a delete (soft archive) happened, so it shows the SAME undo
  // snackbar as batch delete. Called with the archived id(s) right before close.
  onArchived?: (ids: string[]) => void;
}) {
  const T = STRINGS[lang];
  const phone = useCrewSize().kind === "phone";
  const { categories, wasteReasons } = useCrewData();

  const [edit, setEdit] = useState(!!isNew);
  const [panel, setPanel] = useState<null | "recount" | "waste" | "receive">(null);
  const [pv, setPv] = useState("");
  const [wasteReason, setWasteReason] = useState<string | null>(null);
  // Which pack the cook records Merma / Recibir against (null = base unit). When set, the
  // qty input counts PACKS and the panel shows the base-unit conversion + sends pack_id
  // (ADR-0737). Shared across the panels because only one is ever open at a time.
  const [panelPack, setPanelPack] = useState<string | null>(null);
  // Seeded once from the barcode-resolved pack; pre-selects on panel open. Re-seeds each
  // open since the scanned pack is the cook's stated intent — one tap on "Por unidad" undoes it.
  const [pendingPack] = useState<string | null>(initialPack ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<WriteFailure | null>(null);
  // These quick-action panels stay mounted after a successful write (the item detail
  // doesn't unmount), so reset() the key on success — else a second, identical waste
  // would reuse the key and the server would dedup the real second event away.
  const { keyFor, reset: resetKey } = useIdempotencyKey();

  // Edit/create form state, seeded once from the item (a snapshot the operator edits).
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState<string>(item?.category ?? categories[0]?.id ?? BLANK_CATEGORY);
  const [unit, setUnit] = useState(item?.unit ?? "each");
  // Base-unit kind (count/weight/volume) — what a pack's base_qty_per_pack is measured in.
  const [unitKind, setUnitKind] = useState<InventoryUnitKind>(item?.unit_kind ?? "count");
  const [costCents, setCostCents] = useState(item?.cost_cents ?? 0);
  const [vendor, setVendor] = useState(item?.vendor ?? "");
  // Current on-hand quantity, editable straight from the catalog form (the floor asked
  // for it here, not only behind the Reconteo action). Held as a raw string — same
  // partial-input-friendly pattern as the recount panel — and committed on save through
  // the audited applyCount path (a recount), never a raw on_hand column write. Empty /
  // unchanged ⇒ no count is sent. Base units (a pack-scoped count would need pack UI;
  // that stays in the by-pack panels).
  const [onHandText, setOnHandText] = useState(item ? String(item.on_hand) : "");
  const [par, setPar] = useState(item?.par_min ?? 0);
  // Upper par (overstock ceiling + reorder target). 0 = "no ceiling" — optional, like
  // the min on a scanned line, so a floor item isn't forced to carry an upper bound it
  // doesn't have (and Backoffice won't false-flag it "over"). See contracts par_max.
  const [parMax, setParMax] = useState(item?.par_max ?? 0);
  const [newPhoto, setNewPhoto] = useState<ResizedImage | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [icon, setIcon] = useState(item?.icon ?? "");
  const [iconSuggesting, setIconSuggesting] = useState(false);
  // Once the operator opens the picker (pick OR clear), auto-suggestion stops for good:
  // we never clobber a manual choice, and we don't re-suggest after a deliberate clear.
  const iconTouched = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const errText = err ? T[writeFailureKey(err)] : null;

  // AI emoji-icon suggestion. Fired when the name field settles (onBlur) on create or
  // rename, and only when the item still has no icon — so a manual pick is never overwritten
  // (the user's decision: suggest only when empty). Best-effort + cosmetic: a failed/empty
  // suggestion just leaves the category-glyph fallback. The post-await re-checks guard a
  // race where the operator picks an icon or edits the name while the call is in flight.
  const maybeSuggestIcon = async (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed || icon || iconTouched.current || iconSuggesting) return;
    setIconSuggesting(true);
    try {
      const glyph = await suggestEmoji(trimmed);
      if (glyph && !iconTouched.current) {
        setIcon((current) => (current ? current : glyph));
      }
    } finally {
      setIconSuggesting(false);
    }
  };

  const runWrite = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await onChanged();
      after?.();
    } catch (e) {
      setErr(writeFailureReason(e));
    } finally {
      setBusy(false);
    }
  };

  const onPickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const resized = await resizeImageForUpload(file);
      setNewPhoto(resized);
      setRemovePhoto(false);
    } catch {
      setErr("server");
    }
  };

  const saveEdit = () =>
    runWrite(
      async () => {
        if (isNew) {
          const created = await addItem({
            name: name.trim(),
            category,
            unit: unit.trim() || "each",
            unit_kind: unitKind,
            par_min: par,
            par_max: parMax,
            vendor: vendor.trim() || undefined,
            purchase_cost_cents: costCents > 0 ? Math.round(costCents) : undefined,
            pack_qty: costCents > 0 ? 1 : undefined,
            icon: icon || undefined,
          });
          if (newPhoto) await uploadItemImage(created.id, newPhoto.contentType, newPhoto.dataBase64);
          // addItem starts on_hand at 0; if the cook entered a starting count, set it via a
          // recount (the audited count path) so the new item lands stocked, not empty.
          const startQty = parseFloat(onHandText);
          if (Number.isFinite(startQty) && startQty > 0) {
            await applyCount({ [created.id]: startQty }, "New item count", keyFor(`new-count|${created.id}|${startQty}`));
          }
          return;
        }
        if (!item) return;
        const patch: Parameters<typeof saveItemInfo>[1] = {
          name: name.trim(),
          category,
          unit: unit.trim() || item.unit,
        };
        if (unitKind !== item.unit_kind) patch.unit_kind = unitKind;
        if (vendor.trim() !== (item.vendor ?? "")) patch.vendor = vendor.trim();
        if (icon !== (item.icon ?? "")) patch.icon = icon;
        await saveItemInfo(item.id, patch);
        if (Math.round(costCents) !== Math.round(item.cost_cents)) {
          await saveItemCost(item.id, costCents, item.pack_qty);
        }
        if (par !== item.par_min || parMax !== item.par_max) {
          await updateItemPar(item.id, { par_min: par, par_max: parMax });
        }
        // A changed on-hand commits as a recount (audited count path), exactly like the
        // Reconteo action — never a raw column write. Unchanged ⇒ skip.
        const nextQty = parseFloat(onHandText);
        if (Number.isFinite(nextQty) && nextQty >= 0 && nextQty !== item.on_hand) {
          await applyCount({ [item.id]: nextQty }, "Edit count", keyFor(`edit-count|${item.id}|${nextQty}`));
        }
        if (newPhoto) await uploadItemImage(item.id, newPhoto.contentType, newPhoto.dataBase64);
        else if (removePhoto && item.has_image) await removeItemImage(item.id);
      },
      () => (isNew ? onClose() : setEdit(false)),
    );

  // Soft archive (the floor "delete"). The item drops out of the active dataset, so
  // we notify the list (for the undo snackbar) and close back to it; the snackbar's
  // Undo un-archives, and a manager can also restore it from Backoffice.
  const deleteItem = () => {
    if (!item) return;
    void runWrite(() => archiveItem(item.id), () => {
      onArchived?.([item.id]);
      onClose();
    });
  };

  const applyPanel = () => {
    if (!item) return;
    const n = Number(pv);
    if (!Number.isFinite(n)) return;
    if (panel === "recount") {
      const counted = Math.max(0, n);
      // Re-tap "Aplicar" after an error reuses the key; a different counted value re-keys.
      const key = keyFor(`Quick recount|${item.id}|${counted}`);
      void runWrite(() => applyCount({ [item.id]: counted }, "Quick recount", key), () => {
        resetKey();
        setPanel(null);
        setPv("");
      });
    } else if (panel === "receive") {
      if (n <= 0) return;
      // Quick floor receive (ADR-0737): pricing-free — only the on_hand bump, no vendor /
      // cost, so it stays inside the Floor boundary (deeper PO/vendor work stays backoffice's).
      // `qty` rides as the pack COUNT; inventory-api multiplies by base_qty_per_pack for the
      // matched sku, exactly like waste.
      const pack = item.packs?.find((p) => p.id === panelPack) ?? null;
      const key = keyFor(`receive|${item.id}|${n}|${pack?.id ?? ""}`);
      void runWrite(
        () => receiveAdHoc(undefined, [{ sku: item.id, qty: n, ...(pack ? { pack_id: pack.id } : {}) }], key),
        () => {
          resetKey();
          setPanel(null);
          setPv("");
          setPanelPack(null);
        },
      );
    } else {
      if (!wasteReason || n <= 0) return;
      // By-pack: `qty` rides as the pack COUNT (server multiplies by base_qty_per_pack);
      // cost_cents is computed here in base units since the waste path trusts the client cost.
      const pack = item.packs?.find((p) => p.id === panelPack) ?? null;
      const baseQty = pack ? n * pack.base_qty_per_pack : n;
      const cost = Math.round(item.cost_cents * baseQty);
      const key = keyFor(`${item.id}|${n}|${pack?.id ?? ""}|${wasteReason}|${cost}`);
      void runWrite(
        () =>
          recordWaste(
            {
              sku: item.id,
              qty: n,
              ...(pack ? { pack_id: pack.id } : {}),
              reason: wasteReason,
              notes: "",
              photo: false,
              cost_cents: cost,
            },
            key,
          ),
        () => {
          resetKey();
          setPanel(null);
          setPv("");
          setWasteReason(null);
          setPanelPack(null);
        },
      );
    }
  };

  // The pack chosen in the Merma panel (null = base unit) — drives the count-unit label
  // and the live "N × pack = M base" conversion readout below the qty input.
  const panelPackObj = item?.packs?.find((p) => p.id === panelPack) ?? null;
  const pendingPackObj = item?.packs?.find((p) => p.id === pendingPack) ?? null;

  const valid =
    name.trim().length > 0 &&
    Boolean(category) &&
    (unit.trim().length > 0 || !isNew) &&
    // A set ceiling (par_max > 0) must be at or above the min; 0 means "no ceiling".
    (parMax === 0 || parMax >= par);
  const showingPhoto = newPhoto
    ? `data:${newPhoto.contentType};base64,${newPhoto.dataBase64}`
    : item?.has_image && !removePhoto
      ? itemImageUrl(item.id)
      : null;

  return (
    <div className="h-full flex flex-col bg-zinc-50">
      <div className={cn("flex items-center gap-4", phone ? "px-4 pt-3.5 flex-wrap" : "px-10 pt-4")}>
        {edit ? (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            aria-label={T.edititem_icon_change}
            title={T.edititem_icon_change}
            className={cn(
              "relative rounded-[20px] bg-zinc-100 flex items-center justify-center flex-none overflow-hidden transition-transform active:scale-95",
              phone ? "size-14 text-2xl" : "size-18 text-4xl",
            )}
          >
            {showingPhoto ? (
              // eslint-disable-next-line @next/next/no-img-element -- local preview / proxied photo
              <img src={showingPhoto} alt="" className="h-full w-full object-cover" />
            ) : iconSuggesting && !icon ? (
              <span className="animate-pulse">✨</span>
            ) : (
              icon || "📦"
            )}
            <span className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-zinc-900 text-[11px] leading-none text-white ring-2 ring-zinc-50">
              ✎
            </span>
          </button>
        ) : (
          item && <ItemThumb item={item} className="size-18 text-4xl flex-none" rounded="rounded-[20px]" />
        )}
        <div className="flex-1 min-w-0">
          <h2 className={cn("font-semibold tracking-tight text-zinc-900", phone ? "text-xl" : "text-2xl")}>
            {isNew ? T.items_new : item?.name}
          </h2>
        </div>
        {!isNew && item && <StatusPill item={item} lang={lang} />}
        {!isNew && !edit && (
          <button
            onClick={() => setEdit(true)}
            className="inline-flex items-center gap-2 h-12 px-4.5 rounded-xl text-white font-semibold text-[15px]"
            style={{ background: "#18181b" }}
          >
            ✎ {T.it_edit}
          </button>
        )}
      </div>

      <div
        className={cn("flex-1 overflow-y-auto", phone ? "px-4 pt-4" : "px-10 pt-5")}
        style={{ paddingBottom: phone ? "calc(1rem + env(safe-area-inset-bottom))" : undefined }}
      >
        {edit ? (
          <>
            <div className={cn("grid gap-3.5", phone ? "grid-cols-1" : "grid-cols-2")}>
            <PhotoField
              lang={lang}
              showingPhoto={showingPhoto}
              hasStored={Boolean(item?.has_image)}
              onPick={onPickPhoto}
              onClear={() => {
                setNewPhoto(null);
                setRemovePhoto(Boolean(item?.has_image));
              }}
            />
            <Field label={T.f_name}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={(e) => void maybeSuggestIcon(e.target.value)}
                placeholder="—"
                className={inputCls}
              />
            </Field>
            <Field label={T.f_category}>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={T.f_price}>
              <MoneyInput cents={costCents} onChange={setCostCents} />
            </Field>
            <Field label={T.f_unit}>
              <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="each" className={inputCls} />
            </Field>
            <Field label={T.f_unit_kind}>
              <div className="flex gap-2">
                {(["count", "weight", "volume"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setUnitKind(k)}
                    className={cn(
                      "h-12 flex-1 rounded-[14px] text-sm font-medium",
                      unitKind === k ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600",
                    )}
                  >
                    {T[`unit_kind_${k}` as StringKey]}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={T.f_vendor}>
              <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="—" className={inputCls} />
            </Field>
            <Field label={T.it_in_stock}>
              <input
                type="number"
                inputMode="decimal"
                value={onHandText}
                onChange={(e) => setOnHandText(e.target.value)}
                placeholder="0"
                className={inputCls}
              />
            </Field>
            <Field label={T.f_par}>
              <input
                type="number"
                inputMode="numeric"
                value={par}
                onChange={(e) => setPar(Math.max(0, parseInt(e.target.value || "0", 10)))}
                className={inputCls}
              />
            </Field>
            <Field label={`${T.f_par_max} · ${T.f_optional}`}>
              <input
                type="number"
                inputMode="numeric"
                placeholder="—"
                // 0 renders blank so the placeholder reads as "no ceiling" (optional),
                // mirroring the scanned-line par field; any real max must be >= the min.
                value={parMax || ""}
                onChange={(e) => setParMax(Math.max(0, parseInt(e.target.value || "0", 10)))}
                className={inputCls}
              />
              {parMax > 0 && parMax < par && (
                <span className="text-[12px] text-red-600">{T.f_par_max_hint}</span>
              )}
            </Field>
            </div>

            {!isNew && item && (
              <div className="mt-5 border-t border-zinc-100 pt-4">
                {confirmDelete ? (
                  <div className="rounded-[18px] border border-red-200 bg-red-50 p-4">
                    <div className="text-[15px] font-semibold text-red-700">{T.it_delete_q}</div>
                    <p className="mt-1 text-sm text-red-600/80">{T.it_delete_note}</p>
                    <div className="mt-3 flex gap-2.5">
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="h-11 rounded-xl border border-zinc-200 bg-white px-4 font-medium text-zinc-600"
                      >
                        {T.cancel}
                      </button>
                      <button
                        onClick={deleteItem}
                        disabled={busy}
                        className="h-11 rounded-xl bg-red-600 px-4 font-semibold text-white disabled:opacity-50"
                      >
                        {T.it_delete_yes}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex items-center gap-2 text-[15px] font-medium text-red-600"
                  >
                    <span className="text-lg">🗑</span> {T.it_delete}
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          item && (
            <>
              <div className={cn("grid gap-3", phone ? "grid-cols-2" : "grid-cols-3")}>
                <StatTile k={T.it_in_stock}>
                  <span className="font-mono tabular-nums">
                    {item.on_hand} <small className="text-sm text-zinc-400 font-normal">{item.unit}</small>
                  </span>
                </StatTile>
                <StatTile k={T.f_par}>
                  <span className="font-mono tabular-nums">{item.par_min}</span>
                </StatTile>
                <StatTile k={T.f_par_max}>
                  {/* "—" when unset (0): no overstock ceiling for this item. */}
                  <span className="font-mono tabular-nums">{item.par_max > 0 ? item.par_max : "—"}</span>
                </StatTile>
                <StatTile k={T.f_price}>
                  <span className="font-mono tabular-nums">{money(item.cost_cents)}</span>
                </StatTile>
                <StatTile k={T.f_category}>
                  {categories.find((c) => c.id === item.category)?.name ?? "—"}
                </StatTile>
                <StatTile k={T.f_vendor}>{item.vendor || "—"}</StatTile>
              </div>

              {panel ? (
                <div className="mt-3.5 bg-white border border-zinc-200 rounded-[18px] p-4">
                  <div className="text-[15px] font-semibold text-zinc-600 mb-3">
                    {panel === "recount" ? T.it_recount_set : panel === "receive" ? T.it_receive_sub : T.it_waste_sub}
                  </div>
                  {panel === "waste" && (
                    <div className="flex items-center gap-2 overflow-x-auto pb-2">
                      {wasteReasons.map((r) => {
                        const active = wasteReason === r.id;
                        return (
                          <button
                            key={r.id}
                            onClick={() => setWasteReason(r.id)}
                            className={cn(
                              "inline-flex items-center gap-1.5 h-10 px-3.5 rounded-xl text-sm font-medium whitespace-nowrap",
                              active ? "bg-zinc-800 text-white" : "bg-zinc-100 text-zinc-600",
                            )}
                          >
                            <span>{REASON_GLYPHS[r.id] ?? "•"}</span>
                            {STRINGS[lang][("rsn_" + r.id) as StringKey]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {(panel === "waste" || panel === "receive") && item.packs && item.packs.length > 0 && (
                    <div className="flex items-center gap-2 overflow-x-auto pb-2">
                      <button
                        onClick={() => setPanelPack(null)}
                        className={cn(
                          "h-9 px-3 rounded-lg text-sm font-medium whitespace-nowrap",
                          panelPack === null ? "bg-emerald-600 text-white" : "bg-zinc-100 text-zinc-600",
                        )}
                      >
                        {T.pack_by_unit}
                      </button>
                      {item.packs.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setPanelPack(p.id)}
                          className={cn(
                            "h-9 px-3 rounded-lg text-sm font-medium whitespace-nowrap",
                            panelPack === p.id ? "bg-emerald-600 text-white" : "bg-zinc-100 text-zinc-600",
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2.5 mt-1">
                    <input
                      type="number"
                      inputMode="numeric"
                      autoFocus
                      value={pv}
                      onChange={(e) => setPv(e.target.value)}
                      placeholder={panel === "recount" ? String(item.on_hand) : "0"}
                      className="w-28 h-13 rounded-[14px] border border-zinc-200 px-3.5 font-mono text-xl"
                      style={{ height: 52 }}
                    />
                    <span className="text-[15px] text-zinc-500">{panelPackObj ? T.pack_count_unit : item.unit}</span>
                    <button
                      onClick={applyPanel}
                      disabled={busy || (panel === "waste" && (!wasteReason || Number(pv) <= 0)) || (panel === "receive" && Number(pv) <= 0)}
                      className="ml-auto h-13 px-6 rounded-[14px] text-white font-semibold text-base disabled:opacity-50"
                      style={{ background: "#1F8A5B", height: 52 }}
                    >
                      {T.it_apply}
                    </button>
                    <button
                      onClick={() => {
                        setPanel(null);
                        setPv("");
                        setWasteReason(null);
                        setPanelPack(null);
                      }}
                      className="h-13 px-4.5 rounded-[14px] bg-zinc-100 text-zinc-600 font-medium"
                      style={{ height: 52 }}
                    >
                      {T.cancel}
                    </button>
                  </div>
                  {panelPackObj && Number(pv) > 0 && (
                    <div className="mt-2.5 font-mono text-[13px] text-zinc-500">
                      {Number(pv)} × {panelPackObj.label} = {Number(pv) * panelPackObj.base_qty_per_pack} {item.unit}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-3.5 grid grid-cols-2 gap-3">
                  <ActionButton
                    label={item.flagged_86 ? T.it_act_un86 : T.it_act_86}
                    glyph="⊘"
                    active={item.flagged_86}
                    onClick={() => void runWrite(() => toggle86(item.id))}
                  />
                  <ActionButton
                    label={T.mov_recount}
                    glyph="📋"
                    onClick={() => {
                      setPanel("recount");
                      setPv(String(item.on_hand));
                    }}
                  />
                  <ActionButton
                    label={T.mov_waste}
                    glyph="🗑"
                    onClick={() => {
                      setPanel("waste");
                      setPv("");
                      setPanelPack(pendingPackObj ? pendingPack : null);
                    }}
                  />
                  <ActionButton
                    label={T.it_act_receive}
                    glyph="📥"
                    onClick={() => {
                      setPanel("receive");
                      setPv("");
                      setPanelPack(pendingPackObj ? pendingPack : null);
                    }}
                  />
                </div>
              )}
            </>
          )
        )}

        {errText && <div className="mt-3 text-sm text-red-600">{errText}</div>}
      </div>

      {edit && (
        <div
          className="shrink-0 border-t border-zinc-100 bg-zinc-50 flex gap-3 px-4 sm:px-10 py-3.5"
          style={{ paddingBottom: phone ? "calc(0.875rem + env(safe-area-inset-bottom))" : undefined }}
        >
          <button
            onClick={() => (isNew ? onClose() : setEdit(false))}
            className="h-14 px-6 rounded-2xl bg-zinc-100 text-zinc-600 font-semibold flex-none"
          >
            {T.cancel}
          </button>
          <button
            onClick={saveEdit}
            disabled={!valid || busy}
            className="flex-1 h-14 rounded-2xl text-white font-semibold text-lg inline-flex items-center justify-center gap-2 disabled:opacity-50"
            style={{ background: "#1F8A5B" }}
          >
            {isNew ? T.it_create : T.it_save}
          </button>
        </div>
      )}

      {pickerOpen && (
        <EmojiPicker
          lang={lang}
          current={icon}
          onPick={(e) => {
            iconTouched.current = true;
            setIcon(e);
            setPickerOpen(false);
          }}
          onClear={() => {
            iconTouched.current = true;
            setIcon("");
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

const inputCls =
  "h-11 px-3 rounded-xl border border-zinc-200 bg-white text-[15px] outline-none focus:border-violet-500";

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1.5", wide && "sm:col-span-2")}>
      <span className="text-[13px] text-zinc-500 font-medium">{label}</span>
      {children}
    </label>
  );
}

function MoneyInput({ cents, onChange }: { cents: number; onChange: (c: number) => void }) {
  // Local text buffer so typing isn't fought by eager reformatting. The OLD version
  // forced `value={(cents/100).toFixed(2)}`, so every keystroke re-parsed → re-rounded
  // → re-formatted to 2 decimals: you couldn't clear the field, couldn't type "5." on
  // the way to "5.50", and the cursor jumped. `null` = unfocused (show prop value);
  // non-null = actively typing (show exactly what was typed). type="text" +
  // inputMode="decimal" shows the numeric keypad yet allows partial input like "5."
  // and an empty field. No useEffect needed — the display is always derived.
  const fmt = (c: number) => (c > 0 ? (c / 100).toFixed(2) : "");
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? fmt(cents);

  return (
    <div className="flex items-center h-11 rounded-xl border border-zinc-200 bg-white pl-3 focus-within:border-violet-500">
      <span className="text-zinc-500 font-mono">$</span>
      <input
        type="text"
        inputMode="decimal"
        value={display}
        onFocus={() => setDraft(fmt(cents))}
        onChange={(e) => {
          const raw = e.target.value;
          // Permit only digits + a single dot while typing; silently drop stray chars.
          if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
          setDraft(raw);
          const parsed = parseFloat(raw);
          onChange(Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0);
        }}
        onBlur={() => setDraft(null)}
        placeholder="0.00"
        className="flex-1 h-10 px-2 bg-transparent border-0 outline-none font-mono text-[15px]"
      />
    </div>
  );
}

function StatTile({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-2xl p-4">
      <div className="text-[13px] text-zinc-500">{k}</div>
      <div className="text-[22px] font-semibold mt-1 text-zinc-900">{children}</div>
    </div>
  );
}

function ActionButton({
  label,
  glyph,
  active,
  onClick,
}: {
  label: string;
  glyph: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-2 h-24 rounded-[18px] border text-[15px] font-semibold active:scale-[0.98] transition-transform",
        active ? "bg-zinc-800 text-white border-zinc-800" : "bg-white text-zinc-600 border-zinc-200",
      )}
    >
      <span className="text-[26px]">{glyph}</span>
      {label}
    </button>
  );
}

function PhotoField({
  lang,
  showingPhoto,
  hasStored,
  onPick,
  onClear,
}: {
  lang: Lang;
  showingPhoto: string | null;
  hasStored: boolean;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const T = STRINGS[lang];
  return (
    <Field label={T.edititem_photo} wide>
      <div className="flex items-center gap-4">
        <label className="rounded-2xl overflow-hidden border border-zinc-200 bg-zinc-100 flex items-center justify-center flex-none size-20 active:scale-95 transition-transform cursor-pointer">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          {showingPhoto ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview / proxied photo
            <img src={showingPhoto} alt="" className="h-full w-full object-cover" />
          ) : (
            <CameraIcon className="size-8 text-zinc-400" />
          )}
        </label>
        {(showingPhoto || hasStored) && (
          <button onClick={onClear} className="text-sm text-zinc-500 underline">
            {T.edititem_photo_remove}
          </button>
        )}
      </div>
    </Field>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// Corner-bracket viewfinder (scan-barcode option in the Add-item chooser).
function ViewfinderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </svg>
  );
}

// Pencil (enter-manually option in the Add-item chooser).
function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}

// Search-match highlight (design handoff §4): wrap the first case-insensitive
// occurrence of `query` in the name with a <mark>. Rendered inline (the prototype
// pre-split into before/match/after spans; React lets us do it in one pass).
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: "#fde68a", color: "#18181b", borderRadius: 3, padding: "0 1px" }}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

// Empty state for the Items grid (design handoff §5). Two variants: an active
// search ("No results" → Clear search) vs. an empty filter ("Nothing here" → Show
// all). A genuinely empty catalog (no query, filter = all) shows the "Nothing
// here" copy with no action button.
function EmptyState({
  lang,
  query,
  filtered,
  onClear,
  onShowAll,
}: {
  lang: Lang;
  query: string;
  filtered: boolean;
  onClear: () => void;
  onShowAll: () => void;
}) {
  const T = STRINGS[lang];
  const searching = query.trim().length > 0;
  const title = searching ? T.items_none : T.it_empty_filter_t;
  // Subtitle distinguishes three empties: an active search, an active filter, and
  // a genuinely empty catalog (no query, no filter) — the last must NOT claim a
  // filter is hiding items.
  const sub = searching
    ? T.it_empty_results_s.replace("{q}", query.trim())
    : filtered
      ? T.it_empty_filter_s
      : T.it_empty_none;
  const action = searching
    ? { label: T.it_empty_clear, onClick: onClear }
    : filtered
      ? { label: T.it_empty_show_all, onClick: onShowAll }
      : null;
  return (
    <div className="col-span-full flex flex-col items-center justify-center text-center" style={{ padding: "60px 20px" }}>
      <div className="flex items-center justify-center rounded-full bg-zinc-100 mb-4 size-18">
        <SearchIcon className="size-8 text-zinc-400" />
      </div>
      <div className="text-lg font-semibold text-zinc-600">{title}</div>
      <p className="mt-1.5 text-[15px] text-zinc-400" style={{ maxWidth: 320 }}>
        {sub}
      </p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 h-11 px-5 rounded-[14px] border border-zinc-200 bg-white text-zinc-800 font-semibold text-[15px]"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </svg>
  );
}

function UndoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9" />
    </svg>
  );
}
