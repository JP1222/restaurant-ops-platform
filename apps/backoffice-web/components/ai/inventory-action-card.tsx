"use client";

import { getToolName, isToolUIPart, type UIMessagePart } from "ai";
import {
  Check,
  ClipboardCheck,
  PackagePlus,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

const WRITE_TOOLS = new Set([
  "record_receiving",
  "record_waste",
  "set_inventory_count",
]);

export function isInventoryWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

interface ActionInput {
  item?: string;
  quantity?: number;
  counted_quantity?: number;
  reason?: string;
  note?: string;
}

interface ActionOutput {
  ok?: boolean;
  item?: { name?: string; sku?: string; unit?: string };
  on_hand_before?: number;
  on_hand_after?: number;
  error?: string;
  query?: string;
  candidates?: string[];
}

const META: Record<string, { Icon: LucideIcon; verb: string }> = {
  record_receiving: { Icon: PackagePlus, verb: "Receive" },
  record_waste: { Icon: Trash2, verb: "Waste" },
  set_inventory_count: { Icon: ClipboardCheck, verb: "Set count" },
};

function summarize(toolName: string, input: ActionInput): string {
  const item = input.item?.trim() || "item";
  if (toolName === "record_receiving") {
    return `Receive +${input.quantity ?? "?"} · ${item}`;
  }
  if (toolName === "record_waste") {
    const reason = input.reason ? ` (${input.reason})` : "";
    return `Waste −${input.quantity ?? "?"} · ${item}${reason}`;
  }
  return `Set count = ${input.counted_quantity ?? "?"} · ${item}`;
}

interface InventoryActionCardProps {
  part: AnyPart;
  onApprove?: (id: string, approved: boolean) => void;
}

export function InventoryActionCard({ part, onApprove }: InventoryActionCardProps) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const meta = META[toolName];
  if (!meta) return null;

  const state = part.state;
  const input = ("input" in part ? part.input : undefined) as ActionInput | undefined;
  const output = ("output" in part ? part.output : undefined) as ActionOutput | undefined;
  const approvalId = (part as { approval?: { id?: string } }).approval?.id;
  const { Icon } = meta;

  return (
    <div className="bg-card my-2 rounded-xl border p-3 text-sm" data-testid="inventory-action-card">
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="font-medium tabular-nums">{summarize(toolName, input ?? {})}</span>
      </div>
      {input?.note ? (
        <p className="text-muted-foreground mt-1 pl-6 text-xs">{input.note}</p>
      ) : null}

      {state === "approval-requested" && approvalId ? (
        <div className="mt-3 flex items-center gap-2 pl-6">
          <Button
            size="sm"
            onClick={() => onApprove?.(approvalId, true)}
            data-testid="inventory-action-confirm"
          >
            <Check className="size-3.5" />
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onApprove?.(approvalId, false)}
            data-testid="inventory-action-cancel"
          >
            <X className="size-3.5" />
            Cancel
          </Button>
        </div>
      ) : null}

      {state === "input-available" || state === "approval-responded" ? (
        <p className="text-muted-foreground mt-2 pl-6 text-xs">Applying…</p>
      ) : null}

      {state === "output-denied" ? (
        <p className="text-muted-foreground mt-2 pl-6 text-xs">Cancelled — nothing was changed.</p>
      ) : null}

      {state === "output-available" && output ? (
        output.ok ? (
          <div
            className="mt-2 flex items-center gap-1.5 pl-6 text-xs"
            style={{ color: "var(--trend-up)" }}
          >
            <Check className="size-3.5 shrink-0" aria-hidden />
            <span className="tabular-nums">
              {meta.verb} applied · {output.item?.name ?? input?.item} ·{" "}
              {output.on_hand_before} → {output.on_hand_after} {output.item?.unit ?? ""}
            </span>
          </div>
        ) : (
          <div className="text-muted-foreground mt-2 flex items-start gap-1.5 pl-6 text-xs">
            <TriangleAlert
              className="mt-0.5 size-3.5 shrink-0"
              style={{ color: "var(--trend-down)" }}
              aria-hidden
            />
            <span>
              {output.error === "ambiguous"
                ? `Several items match “${output.query}”: ${(output.candidates ?? []).join(", ")}. Ask which one.`
                : `No item matches “${output.query}”. Nothing was changed.`}
            </span>
          </div>
        )
      ) : null}

      {state === "output-error" ? (
        <p
          className="mt-2 flex items-center gap-1.5 pl-6 text-xs"
          style={{ color: "var(--trend-down)" }}
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span>Couldn’t apply — try again.</span>
        </p>
      ) : null}
    </div>
  );
}
