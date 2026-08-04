"use client";

import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
  type UIMessagePart,
} from "ai";
import { FileText, TriangleAlert } from "lucide-react";
import { type ReactNode } from "react";

import { Message, MessageContent } from "@/components/ai-elements/message";
import { Response } from "@/components/ai-elements/response";
import { unverifiedFiguresForMessage } from "@/lib/ai/message-figures";
import { renderToolChart } from "./chart-card";
import {
  InventoryActionCard,
  isInventoryWriteTool,
} from "./inventory-action-card";
import { isReceiptBatchPart, type ReceiptBatchPart } from "./receipt-batch-part";
import { isWebSearchTool, renderWebSearchCard } from "./sources-card";

interface MessageBubbleProps {
  message: UIMessage;
  /** True while this bubble is the one actively streaming — suppress the
   * guardrail badge until the answer (and its tool outputs) settle. */
  streaming?: boolean;
  /** Approve/deny callback for write tools gated behind SDK tool approval. */
  onApprove?: (id: string, approved: boolean) => void;
  /** Renders the receipt batch card for a `data-receiptBatch` part. Supplied by
   * the chat pane, which owns the dataset + confirm/cancel handlers. */
  renderReceiptBatch?: (messageId: string, part: ReceiptBatchPart) => ReactNode;
}

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

interface FilePart {
  type: "file";
  url: string;
  mediaType?: string;
  filename?: string;
}

function isFilePart(part: AnyPart): part is AnyPart & FilePart {
  return part.type === "file" && typeof (part as { url?: unknown }).url === "string";
}

function formatStateLabel(state: string): string {
  switch (state) {
    case "input-streaming":
    case "input-available":
    case "input-start":
      return "Running";
    case "output-available":
      return "Completed";
    case "output-error":
    case "tool-input-error":
      return "Failed";
    case "output-denied":
      return "Denied";
    case "approval-requested":
    case "approval-responded":
      return "Awaiting approval";
    default:
      return state;
  }
}

function ToolPartCard({ part }: { part: AnyPart }) {
  if (!isToolUIPart(part)) return null;

  const toolName = getToolName(part);
  const state = part.state;
  const input = "input" in part ? part.input : undefined;
  const output = "output" in part ? part.output : undefined;
  const errorText = "errorText" in part ? part.errorText : undefined;

  return (
    <details className="bg-card w-full rounded-md border text-xs" data-testid="tool-call-card">
      <summary className="text-muted-foreground hover:bg-muted/40 flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2">
        <span className="text-foreground font-medium">{toolName}</span>
        <span className="text-muted-foreground">{formatStateLabel(state)}</span>
      </summary>
      <div className="space-y-2 border-t px-3 py-2">
        {input !== undefined ? (
          <div>
            <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">Input</div>
            <pre className="bg-muted/60 overflow-x-auto rounded-md p-2 text-xs">
              {JSON.stringify(input, null, 2)}
            </pre>
          </div>
        ) : null}
        {output !== undefined ? (
          <div>
            <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">Output</div>
            <pre className="bg-muted/60 overflow-x-auto rounded-md p-2 text-xs">
              {JSON.stringify(output, null, 2)}
            </pre>
          </div>
        ) : null}
        {errorText ? <div className="text-destructive text-xs">{errorText}</div> : null}
      </div>
    </details>
  );
}

// A user-attached file (receipt scan image, or an Ask-AI image/PDF). Images show a
// thumbnail; a PDF (or other non-image) shows a generic file icon. The kind label is
// derived from the media type rather than assumed to be a receipt.
function AttachmentChip({ part }: { part: FilePart }) {
  const isImage = (part.mediaType ?? "").startsWith("image/");
  const kindLabel = isImage ? "Image" : part.mediaType === "application/pdf" ? "PDF" : "File";
  return (
    <div className="bg-primary-foreground/15 border-primary-foreground/20 mt-1 inline-flex items-center gap-2 rounded-md border p-1 pr-2">
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={part.url} alt="" className="size-9 rounded-sm object-cover" />
      ) : (
        <div className="bg-primary-foreground/25 grid size-9 place-items-center rounded-sm">
          <FileText className="size-4" />
        </div>
      )}
      <div className="min-w-0">
        <div className="max-w-[160px] truncate text-xs font-medium">
          {part.filename ?? kindLabel.toLowerCase()}
        </div>
        <div className="text-[0.7rem] opacity-70">{kindLabel}</div>
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  streaming = false,
  onApprove,
  renderReceiptBatch,
}: MessageBubbleProps) {
  const parts = (message.parts ?? []) as AnyPart[];
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <Message from="user">
        <MessageContent>
          {parts.map((part, index) => {
            if (isTextUIPart(part)) {
              return part.text ? (
                <span key={index} className="whitespace-pre-wrap">
                  {part.text}
                </span>
              ) : null;
            }
            if (isFilePart(part)) {
              return <AttachmentChip key={index} part={part} />;
            }
            return null;
          })}
        </MessageContent>
      </Message>
    );
  }

  const unverifiedFigures = streaming ? [] : unverifiedFiguresForMessage(message);

  return (
    <Message from="assistant" className="w-full">
      <div className="flex w-full flex-col gap-2">
        {parts.map((part, index) => {
          if (isTextUIPart(part)) {
            return part.text ? (
              <MessageContent key={index} className="self-start">
                <Response>{part.text}</Response>
              </MessageContent>
            ) : null;
          }

          if (isReasoningUIPart(part)) return null;

          if (isReceiptBatchPart(part)) {
            return (
              <div key={index} className="w-full">
                {renderReceiptBatch?.(message.id, part)}
              </div>
            );
          }

          if (isToolUIPart(part)) {
            const toolName = getToolName(part);
            if (isInventoryWriteTool(toolName)) {
              return <InventoryActionCard key={index} part={part} onApprove={onApprove} />;
            }
            // web_search renders its grounded answer's sources as the muted
            // "From the web" card (visually distinct from authoritative KPI
            // cards). Falls through to the raw card if the shape doesn't validate.
            if (isWebSearchTool(toolName) && part.state === "output-available" && "output" in part) {
              const card = renderWebSearchCard(toolName, part.output);
              if (card) {
                return (
                  <div key={index} className="w-full">
                    {card}
                  </div>
                );
              }
            }
            // Chartable tools render their result as a real chart (plotted from
            // the tool's own data). Falls back to the raw card if the output
            // shape doesn't validate.
            if (part.state === "output-available" && "output" in part) {
              const chart = renderToolChart(toolName, part.output);
              if (chart) {
                return (
                  <div key={index} className="w-full">
                    {chart}
                  </div>
                );
              }
            }
            return <ToolPartCard key={index} part={part} />;
          }

          return null;
        })}

        {unverifiedFigures.length > 0 ? (
          <div
            className="text-muted-foreground flex items-center gap-1.5 text-xs"
            title={`Not found in this turn's tool data: ${unverifiedFigures
              .map((figure) => figure.text)
              .join(", ")}`}
            data-testid="unverified-figures-badge"
          >
            <TriangleAlert className="size-3.5 shrink-0 text-[var(--trend-down)]" aria-hidden />
            <span>
              {unverifiedFigures.length} figure
              {unverifiedFigures.length === 1 ? "" : "s"} not verified against tool data
            </span>
          </div>
        ) : null}
      </div>
    </Message>
  );
}
