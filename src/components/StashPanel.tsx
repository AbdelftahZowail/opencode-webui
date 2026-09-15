import { useEffect, useMemo, useRef, useState } from "react";
import type { StashEntry } from "../lib/stash";
import { autoRegister } from "../extensions/registry";
import { timeAgo } from "./ui";

/**
 * Prompt-stash panel (P6). Like `RunsPanel`, it REPLACES the composer while
 * open — a bottom strip, not a modal. Presentational only: it takes the stash
 * list and emits intents (`onPop` / `onDelete` / `onClose`); it never touches
 * `api.*`, the store, or localStorage.
 *
 * Newest-first, mirroring v2's `dialog-stash` (`entries.toReversed()`). ↑/↓
 * move the highlight (wrapping), Enter restores the highlighted entry, Backspace
 * / Delete removes it, Esc closes. Keys are captured in the window CAPTURE
 * phase so global navigation hotkeys stay idle while the panel is open.
 */

export interface StashPanelProps {
  entries: StashEntry[];
  onPop: (entry: StashEntry) => void;
  onDelete: (entry: StashEntry) => void;
  onClose: () => void;
}

export function StashPanel({ entries, onPop, onDelete, onClose }: StashPanelProps) {
  // v2's dialog shows the stash most-recent-first.
  const rows = useMemo(() => [...entries].reverse(), [entries]);
  const [selected, setSelected] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // A delete (or a stash change under us) can shrink the list past the cursor.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // The composer is unmounted while this panel is open: take focus so arrows
  // don't scroll the page and the capture-phase handler is the obvious owner.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
  }, []);

  // Capture-phase key owner: arrows/enter/backspace/delete/esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys = ["ArrowUp", "ArrowDown", "Enter", "Escape", "Backspace", "Delete"];
      if (!keys.includes(e.key)) return;
      // Backspace/Delete are destructive: never steal them from a real
      // editable target (defensive — this panel has none today).
      if (e.key === "Backspace" || e.key === "Delete") {
        const t = e.target;
        if (
          t instanceof HTMLInputElement ||
          t instanceof HTMLTextAreaElement ||
          (t instanceof HTMLElement && t.isContentEditable)
        ) {
          return;
        }
      }
      const empty = rows.length === 0;
      if (empty && e.key !== "Escape" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        if (!empty) setSelected((i) => (i + 1) % rows.length);
        return;
      }
      if (e.key === "ArrowUp") {
        if (!empty) setSelected((i) => (i - 1 + rows.length) % rows.length);
        return;
      }
      const entry = rows[selected];
      if (!entry) return;
      if (e.key === "Enter") {
        // v2's select removes + hands the entry over + clears the dialog.
        onPop(entry);
        onClose();
        return;
      }
      onDelete(entry);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rows, selected, onPop, onDelete, onClose]);

  // Click-outside dismisses. Clicks on the toggle that opened the panel are
  // exempt (`data-stash-panel-trigger`), else the dismiss-then-reopen
  // mousedown/click pair leaves it stuck open — the RunsPanel idiom.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target)) return;
      if (target.closest("[data-stash-panel-trigger]")) return;
      onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className="border-t border-[color:var(--border-weak-base)] px-3 pb-2 pt-2"
      data-oc-stash-panel
    >
      <div className="mx-auto max-w-3xl">
        <div
          ref={boxRef}
          tabIndex={-1}
          className="min-h-44 max-h-64 overflow-y-auto border-l-2 border-[color:var(--border-strong)] bg-[color:var(--background-strong)] px-4 py-2 font-mono text-sm outline-none"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm font-bold text-[color:var(--text-strong)]">Stash</span>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer font-mono text-xs text-[color:var(--text-weaker)] hover:text-[color:var(--text-weak)]"
            >
              esc
            </button>
          </div>

          {rows.length === 0 ? (
            <p className="pt-2 text-[color:var(--text-weak)]">Nothing stashed yet</p>
          ) : (
            rows.map((entry, i) => (
              <StashRow
                key={`${entry.timestamp}:${i}`}
                entry={entry}
                selected={i === selected}
                onClick={() => {
                  onPop(entry);
                  onClose();
                }}
              />
            ))
          )}
        </div>
        <p className="mt-1 pl-1 font-mono text-[10px] text-[color:var(--text-weaker)]">
          {rows.length > 0 && (
            <>
              ↑↓ select{" · "}
              <span className="text-[color:var(--text-weak)]">↵</span> restore{" · "}
              <span className="text-[color:var(--text-weak)]">⌫</span> delete{" · "}
            </>
          )}
          <span className="text-[color:var(--text-weak)]">esc</span> close
        </p>
      </div>
    </div>
  );
}

function StashRow({
  entry,
  selected,
  onClick,
}: {
  entry: StashEntry;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // Arrow-key moves must stay visible in a scrolled list.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const firstLine = (entry.text.split("\n")[0] ?? "").trim();
  const lineCount = entry.text.split("\n").length;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-left font-mono text-xs transition-colors ${
        selected
          ? "bg-[color:var(--surface-raised-base-active)] text-[color:var(--text-strong)]"
          : "text-[color:var(--text-base)] hover:bg-[color:var(--surface-base-hover)]"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{firstLine || " "}</span>
      {lineCount > 1 && (
        <span className="shrink-0 font-mono text-[10px] text-[color:var(--text-weaker)]">
          ~{lineCount} lines
        </span>
      )}
      <span className="shrink-0 font-mono text-[10px] text-[color:var(--text-weaker)]">
        {timeAgo(entry.timestamp)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "stash.panel": (p) => <StashPanel {...(p as unknown as StashPanelProps)} />,
});
