import { useSyncExternalStore } from "react";
import { dismissToast, getToasts, subscribeToasts } from "../lib/notify";

export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex flex-col gap-0.5 rounded-md border px-3 py-2.5 shadow-lg backdrop-blur-sm transition-all ${
            t.variant === "destructive"
              ? "border-[color:var(--surface-critical-strong)] bg-[color-mix(in_oklch,var(--surface-critical-strong)_12%,var(--surface-float-base))] text-[var(--text-strong)]"
              : "border-[var(--border-weak-base)] bg-[var(--surface-float-base)] text-[var(--text-strong)]"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-medium leading-tight">{t.title}</span>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              className="shrink-0 cursor-pointer text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)]"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
          {t.description ? (
            <span className="text-xs leading-snug text-[var(--text-weak)]">{t.description}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
