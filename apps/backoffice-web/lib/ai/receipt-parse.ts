import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";

import {
  InventoryReceiptParseLineSchema,
  InventoryReceiptParseResultSchema,
  type InventoryReceiptParseLine,
  type InventoryReceiptParseResult,
} from "@rop/contracts";

import { logVisionParseEvent } from "@/lib/ai/log";
import { recordAiUsage } from "@/lib/ai/usage";
import { createVisionProvider } from "@/lib/ai/vision-provider";
import { getSetting } from "@/lib/settings";

// Model-facing schema (ADR-0538 D3): the vision model's structured output
// is markedly more reliable with required-but-NULLABLE fields than with optional
// ones (an omitted optional often trips the JSON-mode validator), so we ask the
// model for explicit nulls and map them to the contract's optionals below.
const VisionReceiptSchema = z.object({
  vendor: z.string().nullable(),
  invoice_date: z.string().nullable(),
  lines: z.array(
    z.object({
      description: z.string(),
      qty: z.number(),
      unit: z.string().nullable(),
      unit_price_cents: z.number().int().nullable(),
      canonical_name: z.string().nullable(),
      brand: z.string().nullable(),
      pack: z.string().nullable(),
    }),
  ),
});

// Bounds the vision call so a stalled Gemini connection can't pin the operator's
// scan flow (backoffice intake sheet + crew-web scan proxy) on an unbounded await.
// Sizing rationale: a clean 7-8 line invoice extracts in ~10-21s, and latency scales
// with the output-token count, so a real 25-40-line delivery invoice can legitimately
// need 40-80s — prod logged a real parse hitting the old 60s ceiling at 60006ms (a 504
// the cook then had to retry). 90s gives that heavy-invoice tail genuine headroom while
// staying finite, and nothing upstream caps it sooner: the crew→backoffice proxy fetch
// has no timeout and no Traefik request read-timeout is configured. The logVisionParseEvent
// latency metric (now with droppedLines) is what lets us re-tune this with data. The route
// maps the resulting VisionTimeoutError to a 504 `vision_timeout` so the client offers a retry.
const VISION_TIMEOUT_MS = 90_000;

// Retry budget for transient Gemini errors (429 / 503 "overloaded" / network blips).
// These retries SHARE the single VISION_TIMEOUT_MS deadline (the abort signal is the
// hard wall-clock ceiling across all attempts), so a hung attempt still surfaces at
// the deadline — not at attempts × timeout. Pinned to the AI SDK default so the knob
// is explicit and tunable alongside the timeout.
const VISION_MAX_RETRIES = 2;

export class VisionTimeoutError extends Error {
  /** Wall-clock ms spent before the deadline aborted — surfaced for latency observability. */
  readonly durationMs?: number;
  constructor(durationMs?: number) {
    super(`vision model did not respond within ${VISION_TIMEOUT_MS / 1000}s`);
    this.name = "VisionTimeoutError";
    this.durationMs = durationMs;
  }
}

const PROMPT = [
  "You are extracting line items from a restaurant vendor delivery invoice or receipt.",
  "Return the vendor/supplier name, the invoice date (ISO 8601 if legible), and EVERY line item.",
  "For each line: `description` exactly as printed, `qty` as a number, `unit` if shown (lb, case, each, ...),",
  "and `unit_price_cents` as an INTEGER number of cents (multiply a dollar price by 100; $12.50 -> 1250).",
  "ALSO normalize each line for catalog matching: `canonical_name` = a short GENERIC product name with the",
  "brand and any store/club words removed but the size kept (e.g. \"MEMBER'S MARK WHOLE MILK 12 OZ\" ->",
  "\"Whole Milk 12 oz\"); `brand` = the brand/manufacturer only (\"Member's Mark\"), or null if none; `pack` =",
  "the size/pack descriptor (\"12 oz\", \"case of 24\"), or null. The canonical_name is a normalization of the",
  "SAME printed text — do NOT invent a different product.",
  "Use null for any field that is not legible. Do NOT invent items, quantities, prices, or SKUs —",
  "transcribe only what is visibly printed on the document.",
].join(" ");

// Validate one optional value against its field schema, coercing a non-conforming value
// (e.g. a vendor/date label longer than the contract's length cap) to undefined instead of
// throwing. Used for the cosmetic envelope fields so a stray label can't reject a whole parse.
function fitOptional<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> | undefined {
  const parsed = schema.safeParse(value ?? undefined);
  return parsed.success ? parsed.data : undefined;
}

// Run a base64 invoice image through the vision model and return the contract-shaped
// extraction. The model only proposes line descriptions; mapping a description to a
// catalog SKU is a deterministic client step (D3), so a hallucinated SKU can never
// reach the ledger. Throws MissingVisionKeyError (→ 503 at the route) when unkeyed.
export async function parseReceiptImage(
  imageBase64: string,
  mimeType: string,
): Promise<InventoryReceiptParseResult> {
  const provider = await createVisionProvider();
  const modelId = await getSetting("ai.vision_model_id");
  const fallbackModelId = (await getSetting("ai.vision_fallback_model_id")).trim();
  const thinkingLevel = await getSetting("ai.vision_thinking_level");

  const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS);
  const startedAt = Date.now();

  // One vision attempt against a given model id. The primary and the fallback share the
  // single wall-clock deadline and retry budget, so the timeout stays the hard ceiling
  // across BOTH attempts (a slow primary leaves the fallback proportionally less runway).
  const runVision = (id: string) =>
    generateObject({
      model: provider(id),
      schema: VisionReceiptSchema,
      abortSignal: timeout,
      maxRetries: VISION_MAX_RETRIES,
      providerOptions: {
        // Invoice extraction is OCR + structuring, not reasoning — but gemini-flash is a
        // thinking model and, left uncapped, spent a large + VARIABLE hidden reasoning
        // budget that dominated scan latency and cost (usage ledger: ~300-640 output
        // tokens/line vs ~46 of visible JSON; one 22-line invoice burned 14k output
        // tokens / 77s). Cap it via the operator-tunable ai.vision_thinking_level
        // (default "low"); raise toward "high" only if accuracy drops on dense invoices.
        google: { thinkingConfig: { thinkingLevel } } satisfies GoogleGenerativeAIProviderOptions,
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image", image: imageBase64, mediaType: mimeType },
          ],
        },
      ],
    });

  let object: z.infer<typeof VisionReceiptSchema>;
  let usage: Awaited<ReturnType<typeof runVision>>["usage"] | undefined;
  let usedModelId = modelId;
  let fallbackUsed = false;
  try {
    ({ object, usage } = await runVision(modelId));
  } catch (primaryError) {
    // Attribute by OUR signal, not by error shape: AbortSignal.timeout aborts with a
    // DOMException named TimeoutError (which is NOT instanceof Error in Node), and the
    // AI SDK rethrows abort errors unwrapped — `timeout.aborted` sidesteps both quirks.
    // A fired deadline means the budget is spent: surface the timeout, never burn the
    // remainder on a fallback that would abort on its first await.
    if (timeout.aborted) {
      throw new VisionTimeoutError(Date.now() - startedAt);
    }
    // Transient primary failure with time left on the clock (classically a Gemini
    // "high demand" 503 after the retry budget): escalate to the configured fallback
    // model once. An empty or same-as-primary fallback means there's nothing to try.
    if (!fallbackModelId || fallbackModelId === modelId) {
      throw primaryError;
    }
    try {
      ({ object, usage } = await runVision(fallbackModelId));
      usedModelId = fallbackModelId;
      fallbackUsed = true;
    } catch (fallbackError) {
      if (timeout.aborted) {
        throw new VisionTimeoutError(Date.now() - startedAt);
      }
      throw fallbackError;
    }
  }

  // Null -> undefined, then re-validate at the boundary so the BFF only ever emits
  // contract-shaped data (the same discipline as the inventory dataset read).
  //
  // PER-LINE RESILIENCE (the historical intermittent-502 fix): the model-facing
  // VisionReceiptSchema is intentionally looser than the strict contract line schema
  // (e.g. it lets qty/unit_price_cents go negative and strings exceed the contract's
  // length caps). A single line in that gap — a credit/return line the model reads as a
  // negative, or an over-long unit string — used to fail the whole-array .parse() and
  // 502 the ENTIRE scan, so one bad line on a 30-line delivery killed the import. Validate
  // each line on its own instead: keep the ones that fit the contract, drop + count the
  // rest. A partial extraction is far better than a dead end for the cook.
  const mapped = object.lines.map((line) => ({
    description: line.description,
    qty: line.qty,
    unit: line.unit ?? undefined,
    unit_price_cents: line.unit_price_cents ?? undefined,
    canonical_name: line.canonical_name ?? undefined,
    brand: line.brand ?? undefined,
    pack: line.pack ?? undefined,
  }));
  const lines: InventoryReceiptParseLine[] = [];
  for (const line of mapped) {
    const parsed = InventoryReceiptParseLineSchema.safeParse(line);
    if (parsed.success) lines.push(parsed.data);
  }
  const droppedLines = mapped.length - lines.length;

  // Total extraction failure — the model returned lines but every one violated the
  // contract — keeps the hard-failure signal: throw so the route maps it to
  // parse_failed/502 (and no success metric is logged) rather than handing the cook a
  // misleading empty review.
  if (mapped.length > 0 && lines.length === 0) {
    throw new Error(`receipt parse produced ${mapped.length} lines, all contract-invalid`);
  }

  // Vendor / invoice_date are cosmetic labels (a heading + metadata). Coerce a value that
  // would bust the contract's length cap to undefined rather than reject the whole parse
  // over a label, so the same resilience covers the envelope. `lines` is already
  // contract-valid, so this final parse cannot throw.
  const result = InventoryReceiptParseResultSchema.parse({
    vendor: fitOptional(InventoryReceiptParseResultSchema.shape.vendor, object.vendor),
    invoice_date: fitOptional(InventoryReceiptParseResultSchema.shape.invoice_date, object.invoice_date),
    lines,
  });

  // Success-path metric (the route only logs failures). Emitted after the boundary parse
  // so a total failure above is a parse_failed, not a logged "success" — and
  // lineCount/droppedLines/vendorPresent double as a cheap extraction-quality signal.
  logVisionParseEvent({
    latencyMs: Date.now() - startedAt,
    lineCount: result.lines.length,
    droppedLines,
    vendorPresent: Boolean(result.vendor),
    modelId: usedModelId,
    fallbackUsed,
  });

  // Usage & cost ledger (fire-and-forget) — attributed to the model that produced
  // the extraction (primary or fallback).
  recordAiUsage({
    feature: "vision_scan",
    modelId: usedModelId,
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    outputTokens: usage?.outputTokens,
  });

  return result;
}
