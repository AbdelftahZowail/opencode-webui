import { ArrowDownToLine, ArrowUpToLine, Loader2, Play, Trash2 } from "lucide-react";
import {
  flushSteersNow,
  pendingDelete,
  pendingSendNow,
  pendingSetDelivery,
  useStore,
  type PendingSend,
} from "../store";

/**
 * Pending busy-sends for this session — the STEER vs QUEUE system's visible
 * half. A message sent while the session was busy never fakes a transcript
 * turn; it lives here as a durable inbox item until the engine delivers it.
 *
 * Two groups (steers first): ⚡ steer joins the ACTIVE run at its next step
 * (amber accent), ⏳ queue parks until AFTER the current turn (muted/blue).
 * Rows resolve when the item leaves the inbox (delivered/cancelled) — see
 * store reconcileInbox. Rendered above the composer slot so it also shows
 * while RunsPanel replaces the composer. Same strip idiom as SendErrorStrip:
 * left accent border, rounded, text-xs.
 */

const ICON_BTN =
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)] focus-visible:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--border-selected)]";

interface GroupSpec {
  delivery: "steer" | "queue";
  caption: string;
  accent: string;
}

const GROUPS: GroupSpec[] = [
  {
    delivery: "steer",
    caption: "⚡ steer · sent at the next step",
    accent: "border-l-[color:var(--surface-warning-strong)]",
  },
  {
    delivery: "queue",
    caption: "⏳ queue · sent after this turn",
    accent: "border-l-[color:var(--text-interactive-base)]",
  },
];

export function QueueStrip({ sessionID }: { sessionID: string }) {
  const entries = useStore((s) => s.pending[sessionID]);
  const running = useStore((s) => s.running[sessionID] ?? false);
  if (!entries || entries.length === 0) return null;
  const steers = entries.filter((p) => (p.delivery ?? "steer") === "steer");
  const queues = entries.filter((p) => p.delivery === "queue");
  if (steers.length === 0 && queues.length === 0) return null;

  return (
    <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-1 pt-1" data-oc-queue-strip>
      <div className="mx-auto max-w-3xl overflow-hidden rounded-md border border-[color-mix(in_oklch,var(--border-base)_55%,transparent)] bg-[color-mix(in_oklch,var(--surface-base)_40%,transparent)]">
        <div className="divide-y divide-[color:var(--border-weak-base)]">
          {GROUPS.map((group) => {
            const rows = group.delivery === "steer" ? steers : queues;
            if (rows.length === 0) return null;
            return (
              <div key={group.delivery} className={`${group.accent} border-l-2`}>
                <div className="flex items-center gap-2 px-2 pb-0.5 pt-1">
                  <span className="truncate font-mono text-[10px] tracking-wide uppercase text-[var(--text-weaker)]">
                    {group.caption}
                    {rows.length > 1 ? ` (${rows.length})` : ""}
                  </span>
                  {group.delivery === "steer" && running && (
                    <button
                      type="button"
                      onClick={() => void flushSteersNow(sessionID)}
                      title="Interrupt the current step and deliver all steered messages now (queued ones stay parked)"
                      className={`${ICON_BTN} ml-auto h-5 w-auto gap-1 px-1.5 font-mono text-[10px] normal-case`}
                    >
                      <Play className="size-3" />
                      interrupt &amp; send now
                    </button>
                  )}
                </div>
                {rows.map((row) => (
                  <QueueRow
                    key={row.key}
                    sessionID={sessionID}
                    row={row}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function QueueRow({ sessionID, row }: { sessionID: string; row: PendingSend }) {
  const sending = row.state === "sending";
  const isQueue = row.delivery === "queue";
  return (
    <div className="group flex items-center gap-2 py-1 pr-1 pl-2.5 text-xs text-[var(--text-base)]">
      {sending ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-[var(--text-weaker)]" />
      ) : (
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${
            isQueue ? "bg-[color:var(--text-interactive-base)]" : "bg-[color:var(--surface-warning-strong)]"
          }`}
        />
      )}
      <span className="min-w-0 flex-1 truncate" title={row.text}>
        {row.text}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {/* Delivery toggle */}
        <button
          type="button"
          disabled={sending}
          onClick={() => pendingSetDelivery(sessionID, row.key, isQueue ? "steer" : "queue")}
          title={isQueue ? "send at next step" : "move to queue"}
          className={`${ICON_BTN} ${sending ? "pointer-events-none opacity-40" : ""}`}
        >
          {isQueue ? <ArrowUpToLine className="size-3.5" /> : <ArrowDownToLine className="size-3.5" />}
        </button>
        {/* Queue rows can jump the line by flipping to steer (wakes execution). */}
        {isQueue && !sending && (
          <button
            type="button"
            onClick={() => pendingSendNow(sessionID, row.key)}
            title="send now"
            className={ICON_BTN}
          >
            <Play className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => pendingDelete(sessionID, row.key)}
          title={sending ? "cancel send" : "cancel"}
          className={ICON_BTN}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
