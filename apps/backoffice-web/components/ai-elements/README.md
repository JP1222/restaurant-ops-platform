# ai-elements (vendored)

These are [Vercel AI Elements](https://ai-sdk.dev/elements) components (MIT) — the
official AI-SDK component library built on shadcn/ui. They are normally installed
with the shadcn CLI from `registry.ai-sdk.dev`, but that registry is unreachable
from this environment's network, so the handful we use are **checked in** here and
re-pointed at our own aliases (`@/components/ui/*`, `@/lib/utils`).

Vendored subset (trimmed to what the AI assistant uses):

- `conversation.tsx` — `Conversation` / `ConversationContent` / `ConversationScrollButton`
  (StickToBottom auto-scroll — the streaming-stability fix).
- `message.tsx` — `Message` / `MessageContent` (assistant bubble styled to our tokens).
- `response.tsx` — `Response`, wrapping `streamdown` for streaming-safe markdown.
- `suggestion.tsx` — the `Suggestion` pill button.
- `loader.tsx` — the "Thinking…" spinner.

If the registry becomes reachable, these can be replaced with the CLI-managed
versions: `pnpm dlx ai-elements@latest add conversation message response suggestion loader`.
Upstream is heavier (Streamdown math/mermaid/code plugins, a 1.4k-line PromptInput);
the assistant's composer is a focused component in `../ai/chat-composer.tsx`.
