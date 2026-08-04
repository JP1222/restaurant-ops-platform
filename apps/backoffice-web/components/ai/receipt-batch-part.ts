import type { InventoryReceiptParseResult } from "@rop/contracts";

import type { ReceiptBatchSource } from "./receipt-batch-card";

export const RECEIPT_BATCH_PART_TYPE = "data-receiptBatch" as const;

// Payload carried by the synthetic assistant message that renders the receipt
// batch card. The receipt flow is a deterministic client step (ADR-0538) — these
// parts are appended to the useChat list locally and filtered out of any model
// request, so the image/batch never reaches the chat model.
export interface ReceiptBatchPartData {
  lines: InventoryReceiptParseResult["lines"];
  source: ReceiptBatchSource;
  applied: boolean;
  appliedSummary?: string;
}

export interface ReceiptBatchPart {
  type: typeof RECEIPT_BATCH_PART_TYPE;
  id?: string;
  data: ReceiptBatchPartData;
}

export function isReceiptBatchPart(part: { type: string }): part is ReceiptBatchPart {
  return (
    part.type === RECEIPT_BATCH_PART_TYPE &&
    typeof (part as ReceiptBatchPart).data === "object" &&
    (part as ReceiptBatchPart).data !== null
  );
}
