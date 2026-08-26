import { useEffect, useRef, useState } from "react";
import {
  dismissRunNotice,
  useStore,
  type RunNotice,
  type RunNoticeKind,
} from "../store";

/**
 * Transient run-problem notes for this session (provider retries, run
 * failures, interrupts) fed by session.retry.scheduled / session.error /
 * session.execution.* / session.step.failed. Rendered above the composer via
 * SendErrorStrip, using the same RunsPanel-strip idiom: left accent border,
 * rounded, text-xs. Retries are amber (still trying), failures red, an
 * interrupt muted. Rows are dismissible; the store caps and expires them.
 *
 * Rows also clear themselves: a hairline under each row FILLS UP over ~10s
 * and when it is full the notice dismisses itself. The countdown only runs
 * while the tab is visible (a hidden tab freezes the fill), so a warning
 * never disappears before it has actually been seen.
 */

const NOTICE_TTL_MS = 10_000;
const TICK_MS = 250;

const KIND_STYLE: Record<
  RunNoticeKind,
  {
    icon: string;
    label: string;
    iconClass: string;
    labelClass: string;
    rowClass: string;
    barClass: string;
  }
> = {
  retry: {
    icon: "⚠",
    label: "Retry",
    iconClass: "text-[color:var(--surface-warning-strong)]",
    labelClass: "font-medium text-[color:var(--surface-warning-strong)]",
    rowClass:
      "border-l-[color:var(--surface-warning-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-warning-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-warning-strong)_8%,transparent)]",
    barClass: "bg-[color:var(--surface-warning-strong)]",
  },
  error: {
    icon: "⚠",
    label: "Error",
    iconClass: "text-[color:var(--surface-critical-strong)]",
    labelClass: "font-medium text-[color:var(--surface-critical-strong)]",
    rowClass:
      "border-l-[color:var(--surface-critical-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-critical-strong)_8%,transparent)]",
    barClass: "bg-[color:var(--surface-critical-strong)]",
  },
  failed: {
    icon: "⚠",
    label: "Failed",
    iconClass: "text-[color:var(--surface-critical-strong)]",
    labelClass: "font-medium text-[color:var(--surface-critical-strong)]",
    rowClass:
      "border-l-[color:var(--surface-critical-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-critical-strong)_8%,transparent)]",
    barClass: "bg-[color:var(--surface-critical-strong)]",
  },
  interrupted: {
    icon: "⏹",
    label: "Interrupted",
    iconClass: "text-[var(--text-weaker)]",
    labelClass: "font-medium text-[var(--text-weaker)]",
    rowClass:
      "border-l-[color:var(--text-weaker)] border-y border-r border-[color-mix(in_oklch,var(--text-weaker)_25%,transparent)] bg-transparent",
    barClass: "bg-[color:var(--text-weaker)]",
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

/**
 * Visible-time countdown per notice id. Returns id -> ms elapsed (for the
 * fill bar). Hidden-tab time does not count; dismissal happens here so the
 * bar freezing IS the pause indicator.
 */
function useNoticeCountdown(sessionID: string, notices: RunNotice[] | undefined) {
  const [elapsed, setElapsed] = useState<Record<string, number>>({});
  const leftRef = useRef<Record<string, number>>({});
  const ids = notices ? notices.map((n) => n.id).join("\n") : "";

  useEffect(() => {
    const seen = ids ? ids.split("\n") : [];
    for (const id of seen) if (!(id in leftRef.current)) leftRef.current[id] = NOTICE_TTL_MS;
    for (const id of Object.keys(leftRef.current)) {
      if (!seen.includes(id)) delete leftRef.current[id];
    }
    if (seen.length === 0) {
      setElapsed({});
      return;
    }

    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const delta = now - last;
      last = now;
      // Only burn down while the tab can actually be seen.
      if (typeof document !== "undefined" && document.hidden) return;

      const snap: Record<string, number> = {};
      const expired: string[] = [];
      for (const id of seen) {
        const left = Math.max(0, (leftRef.current[id] ?? NOTICE_TTL_MS) - delta);
        leftRef.current[id] = left;
        snap[id] = NOTICE_TTL_MS - left;
        if (left === 0) expired.push(id);
      }
      setElapsed(snap);
      for (const id of expired) dismissRunNotice(sessionID, id);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [ids, sessionID]);

  return elapsed;
}

export function RunNotices({ sessionID }: { sessionID: string }) {
  const notices = useStore((s) => s.runNotices[sessionID]);
  useRelativeTick(!!notices && notices.length > 0);
  const elapsed = useNoticeCountdown(sessionID, notices);
  if (!notices || notices.length === 0) return null;
  return (
    <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-1 pt-2">
      <div className="mx-auto flex max-h-32 max-w-3xl flex-col gap-1 overflow-y-auto">
        {notices.map((notice) => {
          const style = KIND_STYLE[notice.kind];
          const pct = Math.min(
            100,
            (((elapsed[notice.id] ?? 0) / NOTICE_TTL_MS) * 100),
          );
          return (
            <div
              key={notice.id}
              className={`relative flex items-start gap-2 rounded-md border-l-2 py-1 pl-2.5 pr-2 pb-1.5 text-xs text-[var(--text-base)] ${style.rowClass}`}
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
              {/* Fill-up indicator: full width = auto-dismiss (visible time only). */}
              <span
                aria-hidden
                className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] opacity-40 ${style.barClass}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
