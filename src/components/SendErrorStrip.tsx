import { clearSendError, useStore } from "../store";
import { RunNotices } from "./RunNotices";

/**
 * Last send failure for this session, TUI-style: errors stay visible inline,
 * never toasted away. Sits above the composer (RunsPanel strip idiom: left
 * accent border, rounded, text-xs). Dismissed by click or replaced by a newer
 * error — deliberately NOT auto-cleared on the next send, so a failed prompt
 * stays accounted for even after a retry succeeds.
 *
 * RunNotices (live run problems: retries, failures, interrupts) ride in the
 * same slot, above the send error.
 */
export function SendErrorStrip({ sessionID }: { sessionID: string }) {
  const error = useStore((s) => s.sendErrors[sessionID]);
  return (
    <>
      <RunNotices sessionID={sessionID} />
      {error ? (
        <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-2 pt-2">
          <div className="mx-auto flex max-w-3xl items-start gap-2 rounded-md border-l-2 border-l-[color:var(--surface-critical-strong)] border-y border-r border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[color-mix(in_oklch,var(--surface-critical-strong)_8%,transparent)] py-1.5 pl-2.5 pr-2 text-xs text-[var(--text-base)]">
            <span aria-hidden className="shrink-0 text-[color:var(--surface-warning-strong)]">
              ⚠
            </span>
            <span className="min-w-0 flex-1 break-words">
              <span className="font-medium text-[color:var(--surface-critical-strong)]">{error.type}</span>
              {": "}
              {error.message}
            </span>
            <button
              type="button"
              onClick={() => clearSendError(sessionID)}
              title="Dismiss"
              className="shrink-0 cursor-pointer text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)]"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
