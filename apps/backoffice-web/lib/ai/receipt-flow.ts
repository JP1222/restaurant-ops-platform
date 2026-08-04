import type { InventoryDataset, InventoryReceiptParseResult } from "@rop/contracts";

import type { ReceiptApplyLine } from "@/components/ai/receipt-batch-card";
import { bestCatalogMatch } from "@/lib/inventory/receipt-match";

export function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export async function fileToBase64(
  file: File,
): Promise<{ dataUrl: string; base64: string }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  return { dataUrl, base64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl };
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

// Markdown summary streamed before the batch card: what the parse found and how
// many lines matched existing items vs. look new.
export function summarizeParse(
  result: InventoryReceiptParseResult,
  items: InventoryDataset["items"],
  aliases: InventoryDataset["item_aliases"] = [],
): string {
  const total = result.lines.length;
  const matched = result.lines.filter(
    (line) =>
      bestCatalogMatch(line.description, items, {
        aliases,
        vendor: result.vendor,
        canonicalName: line.canonical_name,
      }) !== "",
  ).length;
  const newCount = total - matched;
  const vendor = result.vendor?.trim() || "the";
  const datePart = result.invoice_date ? ` (${result.invoice_date})` : "";
  const newPart =
    newCount > 0
      ? `, flagged ${newCount} new ${newCount === 1 ? "one" : "ones"}`
      : "";
  return (
    `Read your **${vendor}** receipt${datePart}. I found **${total} line${total === 1 ? "" : "s"}** — ` +
    `matched ${matched} to existing items${newPart}. Confirm the quantities and I'll log receiving:`
  );
}

// Markdown wrap-up streamed after a confirmed receive: what came back above
// critical, any new SKU created, and what is still critical (not on this receipt).
export function summarizeApply(
  applied: ReceiptApplyLine[],
  items: InventoryDataset["items"],
): string {
  const appliedItemIds = new Set(applied.filter((line) => line.itemId).map((line) => line.itemId));

  const restocked = applied
    .filter((line) => !line.isNew && (line.onHandBefore ?? 0) <= 0)
    .map((line) => line.displayName);
  // Dedupe by name: a grouped multi-size family is ONE created item across several lines (ADR-882).
  const created = [...new Set(applied.filter((line) => line.isNew).map((line) => line.displayName))];
  const stillCritical = items
    .filter((item) => item.on_hand <= 0 && !appliedItemIds.has(item.id))
    .map((item) => item.name);

  let text = "Done — on-hand counts are updated.";
  if (restocked.length > 0) {
    text += ` ${joinNames(restocked)} ${restocked.length > 1 ? "are" : "is"} back above critical.`;
  }
  if (created.length > 0) {
    text += ` Created **${joinNames(created)}** as a new SKU.`;
  }
  if (stillCritical.length > 0) {
    text += `\n\nStill critical: ${joinNames(stillCritical)} — not on this receipt. Want me to draft a reorder?`;
  }
  return text;
}
