"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  isVisionTimeout,
  useAdHocReceive,
  useInventoryDataset,
  useReceiptParse,
} from "@/hooks/use-inventory";
import {
  fileToBase64,
  formatFileSize,
  summarizeApply,
  summarizeParse,
} from "@/lib/ai/receipt-flow";
import { bestCatalogMatch } from "@/lib/inventory/receipt-match";
import { mergeReceiptLines } from "@rop/contracts/match";
import { useAiAssistantStore } from "@/stores/ai-assistant";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import { ReceiptBatchCard, type ReceiptApplyLine } from "./receipt-batch-card";
import {
  RECEIPT_BATCH_PART_TYPE,
  isReceiptBatchPart,
  type ReceiptBatchPart,
  type ReceiptBatchPartData,
} from "./receipt-batch-part";

interface ComposerPreview {
  url: string;
  name: string;
  sizeLabel: string;
  isImage: boolean;
}

function textPart(text: string) {
  return { type: "text" as const, text };
}

// Prepare the transcript for a model request:
//   - Always drop `data-*` parts — the receipt batch card is UI-only (ADR-0538).
//   - Keep `file` parts ONLY on the current (last user) turn. Vision fallback is
//     per-turn, so the chat model should see at most the image being asked about;
//     every earlier file (a prior ask, or a deterministic receipt-scan image) is
//     stripped so it never bloats — or, on a text-only provider, crashes — the request.
// Messages left with no parts are dropped entirely.
function sanitizeForModel(messages: UIMessage[]): UIMessage[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const cleaned: UIMessage[] = [];
  messages.forEach((message, index) => {
    const keepFiles = index === lastUserIndex;
    const parts = (message.parts ?? []).filter((part) => {
      if (part.type.startsWith("data-")) return false;
      if (part.type === "file") return keepFiles;
      return true;
    });
    if (parts.length > 0) cleaned.push({ ...message, parts });
  });
  return cleaned;
}

export function ChatPane() {
  const [input, setInput] = useState<string>("");

  const isOpen = useAiAssistantStore((s) => s.isOpen);
  const chatResetNonce = useAiAssistantStore((s) => s.chatResetNonce);

  // The panel (and this pane) stays mounted so a close preserves the thread, so
  // a deep-link prompt (e.g. from an insight card) arrives via the store after
  // mount. Consume it through a store subscription — setting state from an
  // external-store callback rather than synchronously inside an effect body.
  useEffect(() => {
    return useAiAssistantStore.subscribe((state, prev) => {
      if (state.prefilledPrompt && state.prefilledPrompt !== prev.prefilledPrompt) {
        setInput(state.prefilledPrompt);
        useAiAssistantStore.getState().clearPrompt();
      }
    });
  }, []);

  const { data: dataset } = useInventoryDataset(isOpen);
  const parseReceipt = useReceiptParse();
  const receive = useAdHocReceive();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ComposerPreview | null>(null);
  const [parsing, setParsing] = useState(false);
  const [applyingIds, setApplyingIds] = useState<Set<string>>(() => new Set());
  // Set when a receipt parse hit the vision timeout (504 vision_timeout): keeps the
  // payload + the assistant bubble id so "Try again" re-runs the parse in place,
  // without duplicating the user's receipt message.
  const [receiptRetry, setReceiptRetry] = useState<{
    assistantId: string;
    base64: string;
    mimeType: string;
  } | null>(null);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: "/api/ai/chat",
      prepareSendMessagesRequest: ({ messages, body }) => ({
        body: {
          ...body,
          messages: sanitizeForModel(messages as UIMessage[]),
          viewSnapshot: useAiAssistantStore.getState().viewSnapshot,
          conversationId: useAiAssistantStore.getState().conversationId,
        },
      }),
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        const incoming = response.headers.get("X-Conversation-Id");
        if (incoming && incoming !== useAiAssistantStore.getState().conversationId) {
          useAiAssistantStore.getState().setConversationId(incoming);
        }
        return response;
      },
    });
  }, []);

  const { messages, status, error, sendMessage, stop, setMessages, addToolApprovalResponse } =
    useChat({
      transport,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    });

  // Clear the transcript only on an explicit reset — New chat or picking a past
  // conversation both bump chatResetNonce. Deliberately NOT keyed on
  // conversationId: the server assigns the current chat its id on the first send
  // (null -> id), and clearing on that transition wiped the in-flight thread
  // mid-stream (the message-vanishing bug).
  const lastResetNonceRef = useRef<number>(chatResetNonce);
  useEffect(() => {
    if (lastResetNonceRef.current !== chatResetNonce) {
      lastResetNonceRef.current = chatResetNonce;
      setMessages([]);
      // A pending receipt-retry points at a message id that no longer exists.
      setReceiptRetry(null);
    }
  }, [chatResetNonce, setMessages]);

  const clearPending = useCallback(() => {
    setPendingFile(null);
    setPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  useEffect(() => () => clearPending(), [clearPending]);

  const isBusy = status === "submitted" || status === "streaming" || parsing;

  const handleFiles = useCallback(
    (files: FileList | File[] | null) => {
      const list = files ? Array.from(files) : [];
      const file =
        list.find((f) => f.type.startsWith("image/")) ??
        list.find((f) => f.type === "application/pdf") ??
        list[0];
      if (!file) return;
      const isImage = file.type.startsWith("image/");
      setPreview((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return {
          url: URL.createObjectURL(file),
          name: file.name,
          sizeLabel: formatFileSize(file.size),
          isImage,
        };
      });
      setPendingFile(file);
    },
    [],
  );

  const openFilePicker = useCallback((capture?: boolean) => {
    const input = fileInputRef.current;
    if (!input) return;
    if (capture) input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.click();
  }, []);

  const updateBatchPart = useCallback(
    (messageId: string, patch: Partial<ReceiptBatchPartData>) => {
      setMessages((prev) =>
        prev.map((message) => {
          if (message.id !== messageId) return message;
          return {
            ...message,
            parts: (message.parts ?? []).map((part) =>
              isReceiptBatchPart(part)
                ? { ...part, data: { ...part.data, ...patch } }
                : part,
            ),
          };
        }),
      );
    },
    [setMessages],
  );

  // Run the deterministic parse and land the outcome (batch card / failure text)
  // in the assistant bubble `assistantId`. Factored out of runReceiptFlow so a
  // vision-timeout retry can re-run it against the same bubble.
  const parseReceiptIntoMessage = useCallback(
    async (assistantId: string, base64: string, mimeType: string) => {
      const items = dataset?.items ?? [];
      setReceiptRetry(null);
      setParsing(true);

      try {
        const result = await parseReceipt.mutateAsync({
          image_base64: base64,
          mime_type: mimeType,
        });

        if (result.lines.length === 0) {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    parts: [
                      textPart(
                        "I couldn't read any line items off that image. Try a clearer photo, or add the lines from Inventory > Receiving.",
                      ),
                    ],
                  }
                : message,
            ),
          );
          return;
        }

        // Collapse duplicate lines that resolve to the SAME catalog item (same unit + price)
        // before the card + summary render, so a receipt that lists one product on several
        // lines shows ONE row with summed qty (conservative merge — ADR-0538 D4). A price/unit
        // difference keeps the line separate so the operator sees it.
        const aliases = dataset?.item_aliases ?? [];
        const { lines } = mergeReceiptLines(
          result.lines,
          result.lines.map(
            (parsedLine) =>
              bestCatalogMatch(parsedLine.description, items, {
                aliases,
                vendor: result.vendor,
                canonicalName: parsedLine.canonical_name,
              }) || null,
          ),
        );
        const mergedResult = { ...result, lines };

        const batchPart: ReceiptBatchPart = {
          type: RECEIPT_BATCH_PART_TYPE,
          id: crypto.randomUUID(),
          data: {
            lines,
            // Keep the REAL parsed vendor ("" when illegible) so the alias is learned
            // vendor-scoped (ADR-0586); the card shows "Receipt" for a blank.
            source: { vendor: result.vendor?.trim() ?? "", date: result.invoice_date },
            applied: false,
          },
        };
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? ({
                  ...message,
                  parts: [
                    textPart(summarizeParse(mergedResult, items, aliases)),
                    batchPart,
                  ],
                } as unknown as UIMessage)
              : message,
          ),
        );
      } catch (parseError) {
        const timedOut = isVisionTimeout(parseError);
        const detail = parseError instanceof Error ? parseError.message : "Unknown error";
        const failureText = timedOut
          ? "Reading that receipt took too long and the scan timed out. It's usually quicker on a second pass — use Try again below."
          : `I couldn't read that receipt — ${detail}`;
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, parts: [textPart(failureText)] }
              : message,
          ),
        );
        if (timedOut) setReceiptRetry({ assistantId, base64, mimeType });
      } finally {
        setParsing(false);
      }
    },
    [dataset, parseReceipt, setMessages],
  );

  const runReceiptFlow = useCallback(
    async (caption: string, file: File) => {
      const { dataUrl, base64 } = await fileToBase64(file);
      const mimeType = file.type || "image/jpeg";

      const assistantId = crypto.randomUUID();
      const userMessage = {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [
          textPart(caption || "Here's a receipt — update my stock."),
          { type: "file" as const, url: dataUrl, mediaType: mimeType, filename: file.name },
        ],
      } as unknown as UIMessage;
      const thinkingMessage = {
        id: assistantId,
        role: "assistant" as const,
        parts: [textPart("Reading your receipt…")],
      } as unknown as UIMessage;

      setMessages((prev) => [...prev, userMessage, thinkingMessage]);
      await parseReceiptIntoMessage(assistantId, base64, mimeType);
    },
    [setMessages, parseReceiptIntoMessage],
  );

  const retryReceiptParse = useCallback(() => {
    const retry = receiptRetry;
    if (!retry || parsing) return;
    setMessages((prev) =>
      prev.map((message) =>
        message.id === retry.assistantId
          ? { ...message, parts: [textPart("Reading your receipt…")] }
          : message,
      ),
    );
    void parseReceiptIntoMessage(retry.assistantId, retry.base64, retry.mimeType);
  }, [receiptRetry, parsing, setMessages, parseReceiptIntoMessage]);

  // "Ask AI about this file" — sends the attachment as a real chat message so it
  // reaches /api/ai/chat. On a text-only chat provider the route swaps THIS turn to
  // the Gemini vision model (gated by ai.vision_fallback_enabled); a multimodal
  // provider reads it directly. Distinct from runReceiptFlow, which is the
  // deterministic receipt scan that never touches the chat model (ADR-0538).
  const handleAskImage = useCallback(async () => {
    if (isBusy || !pendingFile) return;
    const file = pendingFile;
    const caption = input.trim();
    setInput("");
    clearPending();
    const { dataUrl } = await fileToBase64(file);
    await sendMessage({
      ...(caption ? { text: caption } : {}),
      files: [
        {
          type: "file" as const,
          url: dataUrl,
          mediaType: file.type || "application/octet-stream",
          filename: file.name,
        },
      ],
    });
  }, [isBusy, pendingFile, input, clearPending, sendMessage]);

  const handleSubmit = useCallback(() => {
    if (isBusy) return;
    if (pendingFile) {
      // An image's primary action (Enter / Send) stays "Scan receipt" to preserve the
      // snap-and-receive muscle memory; "Ask AI" is the secondary action. A PDF has no
      // deterministic scan, so its only — and primary — action is Ask AI.
      if (pendingFile.type.startsWith("image/")) {
        const file = pendingFile;
        const caption = input.trim();
        setInput("");
        clearPending();
        void runReceiptFlow(caption, file);
      } else {
        void handleAskImage();
      }
      return;
    }
    const trimmed = input.trim();
    if (!trimmed) return;
    void sendMessage({ text: trimmed });
    setInput("");
  }, [isBusy, input, pendingFile, clearPending, runReceiptFlow, handleAskImage, sendMessage]);

  const handlePrompt = useCallback(
    (text: string) => {
      if (isBusy) return;
      void sendMessage({ text });
    },
    [isBusy, sendMessage],
  );

  const applyReceipt = useCallback(
    async (messageId: string, lines: ReceiptApplyLine[], vendor: string) => {
      const items = dataset?.items ?? [];
      setApplyingIds((prev) => new Set(prev).add(messageId));
      try {
        await receive.mutateAsync({
          vendor: vendor || undefined,
          // Anchor the idempotency key to the (immutable) AI message: re-tapping "Apply"
          // after a failed/lost response reuses it and the server dedups, instead of a
          // fresh per-tap UUID that would double-apply the receipt.
          idempotency_key: `receipt:${messageId}`,
          // `description` (raw printed text) + brand/pack ride along so the receive learns
          // a vendor alias for both matched and new lines (ADR-0586 D2).
          lines: lines.map((line) =>
            line.sku
              ? {
                  sku: line.sku,
                  qty: line.qty,
                  unit_cost_cents: line.unitCostCents,
                  description: line.description,
                  brand: line.brand,
                  pack: line.pack,
                }
              : {
                  name: line.name,
                  category: line.category,
                  unit: line.unit,
                  qty: line.qty,
                  unit_cost_cents: line.unitCostCents,
                  description: line.description,
                  brand: line.brand,
                  pack: line.pack,
                  icon: line.icon,
                  // ADR-882: same-product-different-size lines book one item, many packs. `item_group`
                  // ties the lines; `new_pack` is this size (qty counts packs, API multiplies by base).
                  ...(line.itemGroup ? { item_group: line.itemGroup } : {}),
                  ...(line.newPack ? { new_pack: line.newPack } : {}),
                },
          ),
        });

        updateBatchPart(messageId, { applied: true });
        const wrapUp = {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          parts: [textPart(summarizeApply(lines, items))],
        } as unknown as UIMessage;
        setMessages((prev) => [...prev, wrapUp]);
      } catch (applyError) {
        toast.error("Couldn't apply receiving", {
          description: applyError instanceof Error ? applyError.message : "Try again.",
        });
      } finally {
        setApplyingIds((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      }
    },
    [dataset, receive, setMessages, updateBatchPart],
  );

  const cancelReceipt = useCallback(
    (messageId: string) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === messageId
            ? { ...message, parts: [textPart("Receiving cancelled — nothing was changed.")] }
            : message,
        ),
      );
    },
    [setMessages],
  );

  const renderReceiptBatch = useCallback(
    (messageId: string, part: ReceiptBatchPart) => (
      <ReceiptBatchCard
        lines={part.data.lines}
        source={part.data.source}
        items={dataset?.items ?? []}
        aliases={dataset?.item_aliases ?? []}
        applied={part.data.applied}
        appliedSummary={part.data.appliedSummary}
        pending={applyingIds.has(messageId)}
        onApply={(lines) => void applyReceipt(messageId, lines, part.data.source.vendor)}
        onCancel={() => cancelReceipt(messageId)}
      />
    ),
    [dataset, applyingIds, applyReceipt, cancelReceipt],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MessageList
        messages={messages}
        status={status}
        onApprove={(id, approved) => void addToolApprovalResponse({ id, approved })}
        renderReceiptBatch={renderReceiptBatch}
        onPrompt={handlePrompt}
        onUploadReceipt={() => openFilePicker(false)}
      />
      {error ? (
        <div className="bg-destructive/10 text-destructive border-t px-6 py-2 text-sm" role="alert">
          {error.message}
        </div>
      ) : null}
      {receiptRetry ? (
        <div className="flex items-center justify-between gap-3 border-t px-6 py-2 text-sm">
          <span className="text-muted-foreground">The receipt scan timed out.</span>
          <Button type="button" variant="outline" size="sm" onClick={retryReceiptParse} disabled={parsing}>
            Try again
          </Button>
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onAskImage={() => void handleAskImage()}
        onStop={status === "streaming" ? () => void stop() : undefined}
        busy={isBusy}
        attachment={
          preview
            ? {
                name: preview.name,
                sizeLabel: preview.sizeLabel,
                previewUrl: preview.url,
                isImage: preview.isImage,
              }
            : null
        }
        onRemoveAttachment={clearPending}
        onOpenFilePicker={openFilePicker}
        onFiles={handleFiles}
      />
    </div>
  );
}
