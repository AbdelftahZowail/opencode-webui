import { useEffect, useState } from "react";
import { dismissRunNotice, useStore, type RunNoticeKind } from "../store";

/**
 * Transient run-problem notes for this session (provider retries, run
 * failures, interrupts) fed by session.retry.scheduled / session.error /
 * session.execution.* / session.step.failed. Rendered above the composer via
 * SendErrorStrip, using the same RunsPanel-strip idiom: left accent border,
 * rounded, text-xs. Retries are amber (still trying), failures red, an
 * interrupt muted. Rows are dismissible; the store caps and expires them.
 */

const KIND_STYLE: Record<
  RunNoticeKind,
  {
    icon: string;
    label: string;
    iconClass: string;
    labelClass: string;
    rowClass: string;
  }
> = {
  retry: {
    icon: "⚠",
    label: "Retry",
    iconClass: "text-[color:var(--surface-warning-strong)]",
    labelClass: "font-medium text-[color:var(--surface-warning-strong)]",
    rowClass:
      "border-l-[color:var(--surface-warning-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-warning-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-warning-strong)_8%,transparent)]",
  },
  error: {
    icon: "⚠",
    label: "Error",
    iconClass: "text-[color:var(--surface-critical-strong)]",
    labelClass: "font-medium text-[color:var(--surface-critical-strong)]",
    rowClass:
      "border-l-[color:var(--surface-critical-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-critical-strong)_8%,transparent)]",
  },
  failed: {
    icon: "⚠",
    label: "Failed",
    iconClass: "text-[color:var(--surface-critical-strong)]",
    labelClass: "font-medium text-[color:var(--surface-critical-strong)]",
    rowClass:
      "border-l-[color:var(--surface-critical-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-critical-strong)_8%,transparent)]",
  },
  interrupted: {
    icon: "⏹",
    label: "Interrupted",
    iconClass: "text-[var(--text-weaker)]",
    labelClass: "font-medium text-[var(--text-weaker)]",
    rowClass:
      "border-l-[color:var(--text-weaker)] border-y border-r border-[color-mix(in_oklch,var(--text-weaker)_25%,transparent)] bg-transparent",
  },
};

function relativeTime(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Re-render every 15s while notices exist so the relative times stay honest. */
function useRelativeTick(enabled: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, [enabled]);
}

export function RunNotices({ sessionID }: { sessionID: string }) {
  const notices = useStore((s) => s.runNotices[sessionID]);
  useRelativeTick(!!notices && notices.length > 0);
  if (!notices || notices.length === 0) return null;
  return (
    <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-1 pt-2">
      <div className="mx-auto flex max-h-32 max-w-3xl flex-col gap-1 overflow-y-auto">
        {notices.map((notice) => {
          const style = KIND_STYLE[notice.kind];
          return (
            <div
              key={notice.id}
              className={`flex items-start gap-2 rounded-md border-l-2 py-1 pl-2.5 pr-2 text-xs text-[var(--text-base)] ${style.rowClass}`}
            >
              <span aria-hidden className={`shrink-0 ${style.iconClass}`}>
                {style.icon}
              </span>
              <span className="min-w-0 flex-1 break-words">
                <span className={style.labelClass}>{style.label}</span>
                {": "}
                {notice.text}
              </span>
              <span className="shrink-0 whitespace-nowrap tabular-nums text-[var(--text-weaker)]">
                {relativeTime(notice.at)}
              </span>
              <button
                type="button"
                onClick={() => dismissRunNotice(sessionID, notice.id)}
                title="Dismiss"
                className="shrink-0 cursor-pointer text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)]"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
