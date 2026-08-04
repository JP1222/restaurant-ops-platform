# Backoffice AI Assistant — Evolution Roadmap

> **Status:** current — living plan (not an ADR — each phase gets its own ADR when it lands).
**Scope:** `apps/backoffice-web` AI assistant.
**Goal:** turn the hand-rolled chat into a polished, governed, generative-UI assistant **without surrendering the governance layer** (`safe-query`, approval gates, numeric guardrail, audit, BFF boundaries).

## Current status (updated 2026-06-07)

| # | Phase | Status |
| --- | --- | --- |
| 1 | assistant-ui shell + decompose `chat-pane` | 📋 **planned** — detailed cutover plan below; scaffolding proven in `/ai-lab` on a now-stale branch (forward-port, don't checkout — see plan) |
| 2 | `web_search` tool (Gemini grounding) | 🟢 **in review** — PR #610 |
| 3 | Mermaid renderer | ✅ **shipped** — PR #606 |
| 4 | fixed tool→component (charts) | ✅ **partial** — PR #606 (`get_trends`→line, `get_top_items`→bar); more tools + dashboard-card reuse remain |
| 5 | referenced ChartSpec registry (mini-Tambo) | ⏸️ **not started** — deliberately deferred; #606 did the simpler fixed-mapping (Phase 4) path instead |
| 6 | artifact sandbox | ⏸️ **not started** — last, highest-risk |

**What actually shipped in #606 (Phases 3 + 4), with deviations from the original plan worth knowing:**

- **Mermaid (Phase 3)** renders via Streamdown's `plugins.renderers` hook on the ```mermaid markdown fence — *not* a separate tool/spec as originally sketched. Hardening that the plan didn't anticipate: it must gate on `mermaid.parse(..., { suppressErrors: true })` validity (Streamdown reports `isIncomplete: false` on every stream frame, so that flag can't gate rendering); labels render as native SVG `<text>` (`htmlLabels: false`) because the svg-only DOMPurify pass strips `<foreignObject>` HTML labels, leaving empty nodes; untrusted output is sanitized via a DOMPurify DOM-fragment + `replaceChildren` (no `innerHTML`).
- **Charts (Phase 4)** render from **tool output** (`renderToolChart(toolName, output)` in `components/ai/chart-card.tsx`), zod-validated against the known `TrendsView` / `TopItemsView` shapes, falling back to the raw tool-output card on mismatch. This is the governance-safe choice (Invariant 2): the chart plots the tool's actual numbers, never model-transcribed values. The original Phase-4 idea of splitting the dashboard KPI cards into presentational/container and reusing them for "how are we doing today" is **still open**.
- **Lesson for client components:** a `"use client"` component must NOT import the `@rop/contracts` barrel — it drags the whole barrel into every page that mounts the AI FAB and reorders module-eval, tripping a prerender TDZ that `typecheck` can't see (only `next build` catches it). Keep the canonical wire schema in contracts (server validates with it) and a local render-guard schema in the client component.

## Invariants — hold across every phase

1. **Vercel AI SDK stays the base.** Governance (BFF, `safe-query`, approval, `findUnverifiedFigures`, audit, persistence) is never bypassed.
2. **AI decides presentation, never authoritative numbers.** Business figures must reference a verified tool result — never be inlined by the model (see Phase 5). Web-sourced numbers are excluded from the numeric guardrail at both the server `onFinish` and the client figure-collector (Phase 2).
3. **shadcn only** (backoffice component rules 2–4): charts via `<ChartContainer>`, tables via shadcn `<Table>`, no second component library.
4. **Sensitive data stays in our perimeter.** No Assistant Cloud, no E2B cloud sandbox; web search is treated as data egress + untrusted input.
5. **Each phase on a branch; e2e green before merge.** The approval flow is security-sensitive — keep it covered.
6. **Scan before you build** (now in root `AGENTS.md`): commodity layer → adopt a mature lib; domain/governance → keep in-house.

## Resolved decisions (debates we already settled)

| Question | Decision | Why |
| --- | --- | --- |
| Chat shell | **Adopt assistant-ui** | Commodity UI layer; sits on `/api/ai/chat` via `useChatRuntime`; shadcn-native (no rule-4 break); fixes the message-state bugs |
| Tambo framework | **Don't adopt — borrow ~150 lines** | It's fullstack (own backend/db/agent loop, confirmed in its source) and overlaps our governed chain; only its registry + streaming-renderer patterns are worth taking |
| Persistence | **Self-host (our DB)** | Financial data never goes to a managed cloud |
| Mastra / LangGraph | **Parked** | Our hardest flow (receipt) is deliberately NOT an agent (ADR-0538) |
| Artifact sandbox | **Last, separate origin** | Biggest security surface; only after the governed layers are solid |
| Charts: model-spec vs tool-rendered | **Tool-rendered first (Phase 4)** | Governance-safe (numbers come from the tool, not the model). The model-composed ChartSpec registry (Phase 5) is the richer-but-riskier follow-up |
| Web search provider | **Gemini grounding** | Reuses the existing `ai.vision_api_key` — no new credential. DeepSeek has no native search |

## Phase overview

| # | Phase | Goal | Effort | Risk |
| --- | --- | --- | --- | --- |
| 1 | assistant-ui shell + decompose `chat-pane` | fix UI-state bugs, better UX | M | M |
| 2 | `web_search` tool | AI can fetch current info | L | L |
| 3 | Mermaid renderer | AI draws flow/explainer diagrams | L | L |
| 4 | fixed tool→component | authoritative metrics reuse dashboard cards | M | L |
| 5 | referenced ChartSpec registry (mini-Tambo) | AI composes comparison/trend charts | M | M |
| 6 | artifact sandbox | bespoke interactive widgets | H | H |

---

## Phase 1 — assistant-ui shell + decompose `chat-pane.tsx`

**Goal:** replace the tangled chat shell with assistant-ui's tested primitives; kill the message-vanishing/streaming-state bug class; better animation/UX.

**Driving insight:** the backend (`route.ts`, `tools.ts`) is already clean — don't touch it. The mess is concentrated in `chat-pane.tsx`, which tangles UI + receipt business flow + message state + transport. This phase decomposes that file. `useExternalStoreRuntime` keeps `useChat` as the single source of truth (transport, streaming, tool approval, conversation linkage); assistant-ui is view-only — borrow the pattern, not the grip on the core.

### ⚠️ Critical caveat — forward-port, do NOT `git checkout` the scaffolding branch

The assistant-ui external-store scaffolding (`chat-runtime-provider.tsx`, `aui-message.ts`, `aui-thread.tsx`, `aui-tool-uis.tsx`, `chat-transport.ts`, `app/(authed)/ai-lab/page.tsx`) lives on the stale branch `claude/cranky-chandrasekhar-5a4de9`. That branch **predates** the diagrams/charts feature and the Gemini vision fallback: a naive checkout of its files would **delete `chart-card.tsx` + `mermaid-renderer.tsx`** and **revert the per-turn `sanitizeForModel`** that keeps the last user turn's file for the vision fallback. **Hand-port the scaffolding forward onto current `main`; never cherry-pick or `git checkout <branch> -- components/ai/`.**

### Three gaps in the scaffolding to close first

1. **Receipt card not wired.** `aui-message.ts` projects the deterministic `data-receiptBatch` part as a tool-call, but `aui-tool-uis.tsx` only registers the 3 write tools in `toolComponents.by_name` — the receipt card would fall through to `ToolFallback` and render as raw JSON. Register a `receiptBatch` renderer.
2. **Stale `sanitizeForModel`.** The branch's `chat-transport.ts` strips ALL file parts; the live `chat-pane.tsx` keeps the LAST user turn's file so the Gemini vision fallback works. The forward-port must use the live per-turn version.
3. **Receipt flow still in the pane.** `runReceiptFlow` / `applyReceipt` / `cancelReceipt` / `updateBatchPart` are deterministic client logic (ADR-0538) currently inside `chat-pane.tsx`. Extract them to a hook **before** retiring the pane — they must not live in the runtime provider or any view component.

The 5 `InventoryActionCard` approval states port for free: `aui-tool-uis.tsx` reuses `InventoryActionCard` unchanged by cross-referencing the live `useChat` tool part by `toolCallId` and wiring approve/deny to the native `addToolApprovalResponse`.

### Cutover steps

0. **Rebase, don't checkout.** Forward-port the 5 scaffolding files + the `ai-lab` page by hand. Add deps `@assistant-ui/react ^0.14.14` and `@assistant-ui/react-ai-sdk ^1.3.32`; `pnpm install`; commit the lockfile.
1. **One transport.** Land `chat-transport.ts` as the single transport, but **replace its stale `sanitizeForModel`** with the live `chat-pane.tsx` version (keeps `file` parts on the LAST user turn only — vision fallback — while dropping all `data-*` parts). Have the live pane import `createChatTransport` so prod and lab share one transport before the swap.
2. **Extract the receipt flow** out of `chat-pane.tsx` into `lib/ai/use-receipt-batch.ts` (client hook): move `runReceiptFlow`, `applyReceipt`, `cancelReceipt`, `updateBatchPart`, and the `parsing`/`applyingIds` state. The hook takes `setMessages` + the inventory hooks and returns `{ runReceiptFlow, applyReceipt, cancelReceipt, applyingIds, parsing }`. Keep `summarizeParse`/`summarizeApply` from `lib/ai/receipt-flow.ts`.
3. **Wire the receipt card into assistant-ui.** In `aui-tool-uis.tsx` add a `ReceiptBatchToolUI` that, for `toolName === RECEIPT_BATCH_PART_TYPE` (`data-receiptBatch`), looks up the live part by id and renders `ReceiptBatchCard` with the `use-receipt-batch` handlers + dataset. Register it in `toolComponents.by_name` so it no longer falls through to `ToolFallback`. (Gap #1 fix.)
4. **Promote `chat-runtime-provider.tsx`** to host the deterministic flow: call `use-receipt-batch` (sharing the same `useChat setMessages`) and expose its handlers + dataset + `applyingIds` through `useChatController`. Tool UIs read them via context. Keeps `useChat` the brain and the receipt flow out of the view layer.
5. **Build the real Thread** to replace `MessageList`/`MessageBubble`: port the production chrome onto `aui-thread.tsx` — `ChatEmptyState`, the streaming/Thinking indicator, the unverified-figures guardrail badge (`lib/ai/message-figures.ts`), `chart-card.renderToolChart` for chartable outputs, `mermaid-renderer` via `<Response>`, and the `ChatComposer` (attachments, Scan-receipt vs Ask-AI dual action, file picker, drag/paste, ⌘-stop). Composer submit must replicate `ChatPane.handleSubmit`: image→`runReceiptFlow`, PDF→Ask-AI `sendMessage`, text→`sendMessage`. **Preserve every `data-testid` / `aria-label` the e2e depends on** (`tool-call-card`, `inventory-action-card`, `inventory-action-confirm/cancel`, `receipt-batch-card/confirm`, the `chat message` textbox, the `send message` button).
6. **Swap the mount.** In `ai-fab.tsx` replace `<ChatPane />` with `<ChatRuntimeProvider><Thread/></ChatRuntimeProvider>`, mounted **once** and toggled by visibility (the thread + an in-flight stream must survive a close, like today). Move the `prefilledPrompt` subscription and the **nonce-keyed** `chatResetNonce` reset (`setMessages([])`) into `ChatRuntimeProvider` — keep it nonce-keyed, NOT `conversationId`-keyed (clearing on the null→id transition was the documented message-vanishing bug). Keep ⌘J / Escape handlers + layout modes.
7. **Delete the retired shell:** `chat-pane.tsx`, `message-list.tsx`, `message-bubble.tsx`. Keep `inventory-action-card.tsx`, `receipt-batch-card.tsx`, `receipt-batch-part.ts`, `chat-composer.tsx`, `chat-empty-state.tsx`, `chart-card.tsx`, `mermaid-renderer.tsx`, `sources-card.tsx`, `conversation-history-panel.tsx`.
8. **Remove the `/ai-lab` smoke harness** (`app/(authed)/ai-lab/page.tsx`) once the real mount is verified.
9. **Verify:** `typecheck && lint && build`, `pnpm test`, `pnpm test:e2e` (backoffice `ai-chat.spec.ts` + the crew waste/receive specs), plus a manual `pnpm dev` (3001) pass of the receipt scan→confirm→applied path and a write-tool approve/deny path (those aren't fully covered by the e2e).

### Risks

- **Stale-branch regression (highest):** checking out branch files reverts diagrams/charts + the vision-fallback `sanitizeForModel`. Forward-port only.
- **Receipt card renders as raw JSON** without the Step-3 registration.
- **Approval-id plumbing:** `InventoryActionCard` reads `approvalId` off the LIVE `useChat` part; `aui-tool-uis.tsx` must keep the cross-reference-by-`toolCallId` seam — do not read approval state from assistant-ui's projected part.
- **Thread persistence:** mount the provider once and toggle visibility, or `useChat` state resets and the thread is lost mid-stream.
- **Conversation-reset timing:** preserve the nonce-keyed (not id-keyed) reset exactly.
- **E2E selector drift:** the rebuilt Thread/Composer must keep the exact `data-testid`/`aria-label`s or the backoffice approval e2e goes red. (The crew waste/receive/recount specs hit a native `/api/inventory/*` flow with zero chat dependency — unaffected, but must stay green.)

**Exit criteria:** all chat e2e green; approval flow 5 states correct; receipt flow works; message-state bug class gone.

---

## Phase 2 — `web_search` tool (Gemini grounding) — PR #610

**Goal:** AI can fetch current web info. DeepSeek has no native search → it's a tool.

**Shipped shape:** a read-only `web_search` tool whose `execute` POSTs to a BFF route `/api/ai/web-search`, which delegates to Gemini "Grounding with Google Search" via the existing vision provider (reuses `ai.vision_api_key` — no new key). Returns `{ query, answer, sources: [{title, url}], available }`. A `ai.web_search_enabled` kill switch defaults **OFF / fail-closed**; off-or-unkeyed → a clean `{ available: false }` payload, never a 500.

**Governance / security (the parts that matter):**

- Web-sourced numbers are **excluded from the numeric guardrail** at BOTH the server `onFinish` and the client `message-figures.ts`, keyed off one shared `WEB_TOOLS` constant — they can never launder as DB-verified figures. The Sources card renders web data in muted/neutral tokens (external, not authoritative).
- The 3 inventory write tools keep `needsApproval` — injected/untrusted web text can at most make the model *propose* a write; the human Confirm gate still fires. Approval keys on tool identity, never on tool arguments or output.
- Source URLs are **http(s)-only** (drops `javascript:`/`data:` schemes) at both the contracts boundary (`WebSearchSourceSchema`) and the client render guard.

**Activation (post-deploy, user-gated):** kill switch is OFF by default → ensure `ai.vision_api_key` is set, flip `ai.web_search_enabled` on in `/settings`, then live-test a current-events question.

**Known limit (pre-existing, shared with charts):** tool `toolResults` aren't persisted, so the Sources card is live-only and empty on conversation reload.

---

## Phase 3 — Mermaid renderer (shipped, PR #606)

Done. See **Current status** above for the as-shipped details and the hardening (streaming-validity gate, native SVG labels, DOMPurify fragment).

---

## Phase 4 — fixed tool→component (authoritative data) — partial, PR #606

**Goal:** governed metrics render as dashboard-grade components, not JSON.

**Shipped:** `renderToolChart` maps `get_trends`→line and `get_top_items`→bar via `<ChartContainer>` + recharts, plotting the tool's own zod-validated output; unknown shapes fall back to the JSON card.

**Remaining:** extend the mapping to `get_today_hourly` / `compare_periods` / `get_week_over_week` / KPI tools, and split the dashboard cards (`today/top-items-card`, `today/hourly-pulse-chart`, `kpi/kpi-card`, `today/wow-bars`) into presentational (props) + container (fetch) so "how are we doing today" renders real cards whose numbers match the dashboard.

---

## Phase 5 — referenced ChartSpec registry (the "mini-Tambo")

**Goal:** AI composes comparison/trend charts — choosing *how* to visualize, never *what the numbers are*.

**Borrow from Tambo** (read from its `react-sdk`, ~150 lines — patterns only, not the framework):

- **Registry shape:** `Record<name, { description, propsSchema (zod), component, loadingComponent? }>`.
- **Streaming renderer:** `partial-json` parse for incomplete streamed props + stable React key (`content.id`) to preserve instance identity during streaming.
- **`loadingComponent`** per entry for the streaming state.
- **Forbid `z.record()`** in spec schemas (their `assertNoRecordSchema`) — keep the model on-script.

**Two governance INVERSIONS Tambo does NOT do (must add):**

1. **Reference, not inline.** Tambo's renderer validates props *shape*, not *truth* — it would happily render model-fabricated numbers. ChartSpec carries `source: { toolCallId, … }`; the renderer reads the **verified tool output** by id, not model-inlined data.
2. **Flip the fail policy.** Tambo renders-on-validation-fail (warn only). For authoritative numbers, **fail closed**: validation/provenance fail → don't render the number. A wrong figure is worse than none.

```ts
// GOOD — AI picks the viz, data is referenced
const ChartSpec = z.object({
  title: z.string(),
  chartType: z.enum(["bar", "line"]),
  source: z.object({ toolCallId: z.string(), dataset: z.enum([/* ... */]) }),
  xKey: z.string(),
  yKeys: z.array(z.string()),
  explanation: z.string().optional(),
});
// BAD — model inlines numbers (bypasses findUnverifiedFigures)
const BadChartSpec = z.object({ data: z.array(z.object({ day: z.string(), sales: z.number() })) });
```

**Gotcha to verify:** `appendMessage` in `route.ts` persists `toolCalls` — confirm tool **outputs** are persisted too, else referenced charts (and the Phase-2 Sources card) break after a page reload. (Today they don't — see the Phase-2 known limit.)

**Exit criteria:** "compare this week vs last as a line chart" works; numbers trace to `get_week_over_week`, not the model.

---

## Phase 6 — artifact sandbox (last)

**Goal:** AI generates bespoke interactive widgets for open-ended explanation (the Claude-artifacts experience).

**Work:** separate origin (e.g. `artifact.example.com`) + sandboxed iframe (strict sandbox attrs) + CSP (no arbitrary network) + postMessage data bridge with **desensitized snapshot only**; no cookie/localStorage/BFF; static scan + timeout on generated code; read-only.

**Exit criteria:** AI builds an interactive explainer that cannot reach the session or any API.

---

## Not doing

- ❌ Migrate the governance/agent loop to Tambo (borrow patterns only).
- ❌ Assistant Cloud / E2B cloud for sensitive data.
- ❌ Let the model inline business numbers into any spec.
- ❌ Swap the agent runtime (Mastra/LangGraph) while `streamText` + tools suffices.

## Next step

Phase 1, on a branch: **forward-port** (not checkout) the assistant-ui scaffolding, close the 3 gaps, port `InventoryActionCard` first and validate all approval states, then decompose the rest of `chat-pane.tsx`. Keep the chat e2e green.
