import { create } from "zustand";

export interface ViewSnapshot {
  view: "today" | "trends" | "compare" | "ops" | "menu" | "dayparts";
  url: string;
  data: unknown;
  capturedAt: string;
  truncated?: boolean;
}

export type AiLayoutMode = "floating" | "sidebar" | "fullscreen";

const LAYOUT_MODES: readonly AiLayoutMode[] = ["floating", "sidebar", "fullscreen"];
const MODE_STORAGE_KEY = "yr.ai.layoutMode";

function readStoredMode(): AiLayoutMode {
  if (typeof window === "undefined") return "floating";
  try {
    const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (stored && (LAYOUT_MODES as readonly string[]).includes(stored)) {
      return stored as AiLayoutMode;
    }
  } catch {
    /* localStorage unavailable (private mode / SSR) — fall back to default */
  }
  return "floating";
}

function persistMode(mode: AiLayoutMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* best-effort persistence */
  }
}

interface AiAssistantState {
  isOpen: boolean;
  /** Morphable shell geometry — remembered across sessions via localStorage. */
  mode: AiLayoutMode;
  /** Bumped by newChat() so the chat pane can clear its useChat message list. */
  chatResetNonce: number;
  prefilledPrompt: string | null;
  openSource: "fab" | "insight" | "chart" | null;
  viewSnapshot: ViewSnapshot | null;
  conversationId: string | null;
  open: (opts?: { prompt?: string; source?: AiAssistantState["openSource"] }) => void;
  close: () => void;
  setMode: (mode: AiLayoutMode) => void;
  newChat: () => void;
  selectConversation: (id: string | null) => void;
  clearPrompt: () => void;
  setViewSnapshot: (snapshot: ViewSnapshot | null) => void;
  setConversationId: (id: string | null) => void;
  clearConversation: () => void;
}

const MAX_SNAPSHOT_BYTES = 2048;

function capSnapshot(input: ViewSnapshot): ViewSnapshot {
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length <= MAX_SNAPSHOT_BYTES) return input;
  } catch {
    /* fall through to truncate */
  }
  return {
    view: input.view,
    url: input.url,
    data: null,
    capturedAt: input.capturedAt,
    truncated: true,
  };
}

export const useAiAssistantStore = create<AiAssistantState>((set) => ({
  isOpen: false,
  mode: readStoredMode(),
  chatResetNonce: 0,
  prefilledPrompt: null,
  openSource: null,
  viewSnapshot: null,
  conversationId: null,
  open: (opts = {}) =>
    set({
      isOpen: true,
      prefilledPrompt: opts.prompt ?? null,
      openSource: opts.source ?? "fab",
    }),
  close: () => set({ isOpen: false }),
  setMode: (mode) => {
    persistMode(mode);
    set({ mode });
  },
  // New chat resets the in-memory transcript + server conversation linkage. The
  // nonce drives the chat pane's setMessages([]); clearing conversationId starts
  // a fresh server-side conversation on the next send.
  newChat: () =>
    set((state) => ({
      chatResetNonce: state.chatResetNonce + 1,
      conversationId: null,
      viewSnapshot: null,
    })),
  // Switch the active conversation (history pick). Bumping chatResetNonce is what
  // tells the chat pane to clear its transcript — a plain setConversationId does
  // NOT, so the server assigning the current chat its id never clears the thread.
  selectConversation: (id) =>
    set((state) => ({
      chatResetNonce: state.chatResetNonce + 1,
      conversationId: id,
      viewSnapshot: null,
    })),
  clearPrompt: () => set({ prefilledPrompt: null, openSource: null }),
  setViewSnapshot: (snapshot) =>
    set({ viewSnapshot: snapshot ? capSnapshot(snapshot) : null }),
  setConversationId: (id) => set({ conversationId: id }),
  clearConversation: () => set({ conversationId: null, viewSnapshot: null }),
}));
