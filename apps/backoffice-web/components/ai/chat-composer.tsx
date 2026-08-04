"use client";

import {
  Camera,
  FileText,
  Paperclip,
  ScanLine,
  SendHorizontal,
  Sparkles,
  Square,
  UploadCloud,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MAX_CHARS = 2000;

export interface ComposerAttachment {
  name: string;
  sizeLabel: string;
  previewUrl: string;
  /** Image → offer both Scan receipt + Ask AI; non-image (PDF) → Ask AI only. */
  isImage: boolean;
}

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Primary action: text send (no attachment), Scan receipt (image), or Ask AI (PDF). */
  onSubmit: () => void;
  /** Secondary action for images: send the file to the chat model instead of scanning. */
  onAskImage: () => void;
  onStop?: () => void;
  busy: boolean;
  attachment: ComposerAttachment | null;
  onRemoveAttachment: () => void;
  onOpenFilePicker: (capture?: boolean) => void;
  onFiles: (files: FileList | File[] | null) => void;
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onAskImage,
  onStop,
  busy,
  attachment,
  onRemoveAttachment,
  onOpenFilePicker,
  onFiles,
}: ChatComposerProps) {
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea from one line up to the max height, then scroll.
  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(120, node.scrollHeight)}px`;
  }, [value]);

  const overLimit = value.length > MAX_CHARS;
  const ready = (value.trim().length > 0 || attachment !== null) && !busy && !overLimit;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (ready) onSubmit();
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onFiles(event.dataTransfer.files);
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.clipboardData.files.length > 0) onFiles(event.clipboardData.files);
  };

  return (
    <div className="flex-none border-t p-3">
      <div
        className={cn(
          "border-input bg-background relative rounded-lg border px-2 py-2 transition-[border-color,box-shadow]",
          focused && "border-ring ring-ring/20 ring-[3px]",
          dragging && "border-ring border-dashed",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onPaste={handlePaste}
      >
        {attachment ? (
          <div className="mb-2 flex flex-wrap gap-2">
            <div className="border-border bg-muted relative flex items-center gap-2 rounded-md border p-1 pr-2">
              {attachment.isImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={attachment.previewUrl}
                  alt=""
                  className="size-9 rounded-sm object-cover"
                />
              ) : (
                <div className="bg-background grid size-9 place-items-center rounded-sm">
                  <FileText className="text-muted-foreground size-4" />
                </div>
              )}
              <div className="min-w-0">
                <div className="max-w-[140px] truncate text-xs font-medium">{attachment.name}</div>
                <div className="text-muted-foreground text-[0.7rem]">{attachment.sizeLabel}</div>
              </div>
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={onRemoveAttachment}
                className="bg-foreground text-background grid size-4 place-items-center rounded-full"
              >
                <X className="size-2.5" />
              </button>
            </div>
          </div>
        ) : null}

        <Textarea
          ref={textareaRef}
          aria-label="Chat message"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Ask anything, or drop a receipt photo…"
          rows={1}
          maxLength={MAX_CHARS}
          className="max-h-[120px] min-h-9 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        />

        <div className="mt-1 flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="text-muted-foreground size-8"
            aria-label="Attach receipt image"
            onClick={() => onOpenFilePicker(false)}
          >
            <Paperclip className="size-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="text-muted-foreground size-8"
            aria-label="Take photo"
            onClick={() => onOpenFilePicker(true)}
          >
            <Camera className="size-4" />
          </Button>
          <span className="flex-1" />
          {onStop ? (
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-8"
              aria-label="Stop generating"
              onClick={onStop}
            >
              <Square className="size-4" />
            </Button>
          ) : attachment ? (
            // With a file attached, the action is explicit. An image offers both the
            // deterministic receipt scan (primary) and asking the AI about it; a PDF
            // can only be asked about.
            <div className="flex items-center gap-1.5">
              {attachment.isImage ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1.5"
                    disabled={!ready}
                    onClick={onAskImage}
                  >
                    <Sparkles className="size-4" />
                    Ask AI
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={!ready}
                    onClick={onSubmit}
                  >
                    <ScanLine className="size-4" />
                    Scan receipt
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1.5"
                  disabled={!ready}
                  onClick={onSubmit}
                >
                  <Sparkles className="size-4" />
                  Ask AI
                </Button>
              )}
            </div>
          ) : (
            <Button
              type="button"
              size="icon"
              className={cn("size-8", !ready && "bg-muted text-muted-foreground")}
              aria-label="Send message"
              disabled={!ready}
              onClick={onSubmit}
            >
              <SendHorizontal className="size-4" />
            </Button>
          )}
        </div>

        {dragging ? (
          <div className="bg-background/85 border-ring pointer-events-none absolute inset-0 z-[6] flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed backdrop-blur-sm">
            <UploadCloud className="text-accent size-7" />
            <b className="text-sm font-semibold">Drop to scan</b>
            <span className="text-muted-foreground text-xs">Receipt, shopping list, or invoice</span>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex items-center justify-between px-1">
        <span className="text-muted-foreground text-xs">
          AI can make mistakes — confirm before it changes stock.
        </span>
        <span
          className={cn("text-muted-foreground font-mono text-xs tabular-nums", overLimit && "text-destructive")}
          aria-live="polite"
        >
          {value.length}/{MAX_CHARS}
        </span>
      </div>
    </div>
  );
}
