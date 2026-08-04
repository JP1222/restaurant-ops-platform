"use client";

// Shared end-of-flow confirmation for the Movimientos flows (Recibir / Merma /
// Reconteo). Big green check + title + optional sub + a single Listo button → home.
// Mirrors the design handoff's CrewDone (the scan flow keeps its own richer recap
// success).
//
// When a flow changed stock (Merma / Reconteo) it can pass `onUndo` to surface a
// secondary Undo button beside Done (design handoff §3): the flow owns the actual
// reversal (re-applying the pre-write count via the real API), so this component
// stays presentational — it just renders the button, its busy state, and any
// reversal error. Flows that don't change reversible stock (Recibir) omit `onUndo`
// and the screen looks exactly as before.
export function FlowSuccess({
  title,
  sub,
  doneLabel,
  onDone,
  onUndo,
  undoLabel,
  busy,
  error,
}: {
  title: string;
  sub?: string;
  doneLabel: string;
  onDone: () => void;
  onUndo?: () => void;
  undoLabel?: string;
  busy?: boolean;
  error?: string | null;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center bg-zinc-50 p-10 text-center">
      <div
        className="rounded-full text-white flex items-center justify-center size-32 crew-pop"
        style={{ background: "#10b981", boxShadow: "0 20px 50px -12px rgba(16,185,129,.5)" }}
      >
        <svg viewBox="0 0 24 24" className="size-16" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h1 className="text-4xl font-semibold tracking-tight mt-7 text-zinc-900">{title}</h1>
      {sub && <p className="text-zinc-500 text-lg mt-2.5">{sub}</p>}
      <div className="flex items-center gap-3 mt-8">
        {onUndo && (
          <button
            onClick={onUndo}
            disabled={busy}
            className="h-15 px-7 rounded-[18px] border border-zinc-200 bg-white text-zinc-600 font-semibold text-lg inline-flex items-center gap-2 active:scale-95 transition-transform disabled:opacity-50"
            style={{ height: 60 }}
          >
            <UndoIcon className="size-[18px]" />
            {undoLabel}
          </button>
        )}
        <button
          onClick={onDone}
          disabled={busy}
          className="px-10 rounded-2xl text-white font-semibold text-lg active:scale-95 transition-transform disabled:opacity-50"
          style={{ background: "#18181b", height: 60 }}
        >
          {doneLabel}
        </button>
      </div>
      {error && <div className="mt-4 text-sm text-red-600">{error}</div>}
    </div>
  );
}

function UndoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 5 5v0a5 5 0 0 1-5 5H9" />
    </svg>
  );
}
