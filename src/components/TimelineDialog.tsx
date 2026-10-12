import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { ArrowLeft, Copy, Crosshair, GitBranch, ListTree, Undo2, X } from "lucide-react";
import type { MessageInfo, UserMessage } from "../api/types";
import { autoRegister } from "../extensions/registry";
import {
  attachmentCount,
  clampSelection,
  moveSelection,
  previewText,
  relativeTime,
  userMessages,
} from "../lib/timeline";

/**
 * R4 — Timeline dialog + Message Actions (v2's `/timeline` / `session.timeline`,
 * `<leader>g`). Presentational: it renders the user-message timeline and emits
 * intents; it never calls `api.*`, the store, or `navigator.clipboard` itself.
 *
 * Behaviour (parity.md §5 R4):
 *  - every real user message, NEWEST FIRST, each with a relative-time footer;
 *  - ↑/↓ move the selection and LIVE-jump the transcript behind the dialog
 *    (`onJump`) WITHOUT closing it;
 *  - Enter opens Message Actions for the selected message — Jump to / Revert /
 *    Copy text / Fork;
 *  - Esc closes (from the list) or returns to the list (from the actions).
 *
 * The overlay is deliberately non-modal (a floating panel with a light scrim,
 * the `SearchPanel` idiom) so the live jump is visible: a modal scrim would
 * hide the very transcript the ▶ timeline is driving.
 */

export interface TimelineDialogProps {
  /** The full transcript (all message types); user rows are extracted inside. */
  messages: MessageInfo[];
  sessionID: string;
  /** Live-jump the transcript to a message without closing the dialog. */
  onJump: (messageID: string) => void;
  /** Revert at a message and seed the composer with its text. */
  onRevert: (messageID: string, text: string) => void;
  /** Copy a message's text. */
  onCopy: (text: string) => void | Promise<void>;
  /** Fork the session before a message. */
  onFork: (messageID: string) => void | Promise<void>;
  onClose: () => void;
}

type Mode = "list" | "actions";

interface ActionDef {
  key: "jump" | "revert" | "copy" | "fork";
  label: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
}

/** The four v2 Message Actions, in v2 order. */
const ACTIONS: ActionDef[] = [
  { key: "jump", label: "Jump to", hint: "scroll the transcript", icon: Crosshair },
  { key: "revert", label: "Revert", hint: "undo & seed the prompt", icon: Undo2 },
  { key: "copy", label: "Copy text", hint: "copy this message", icon: Copy },
  { key: "fork", label: "Fork", hint: "new session before this", icon: GitBranch },
];

export function TimelineDialog({
  messages,
  sessionID,
  onJump,
  onRevert,
  onCopy,
  onFork,
  onClose,
}: TimelineDialogProps) {
  const rows = useMemo(() => userMessages(messages), [messages]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [actionIndex, setActionIndex] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Newest user message is the initial selection (top of a newest-first list).
  const current = rows[selected] ?? null;

  // Keep the cursor inside the rows as the transcript grows/shrinks under us.
  useEffect(() => {
    setSelected((s) => clampSelection(s, rows.length));
  }, [rows.length]);

  // Take focus so the page's arrow bindings stay idle under the dialog.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    boxRef.current?.focus({ preventScroll: true });
  }, []);

  // LIVE jump: every selection move previews that message in the transcript
  // behind the dialog. Keyed on the row id (NOT on `onJump`, whose identity the
  // orchestrator may recreate) so a re-render never re-fires the jump.
  const gotoID = current?.id ?? null;
  useEffect(() => {
    if (!gotoID) return;
    onJump(gotoID);
  }, [gotoID]);

  function runAction(key: ActionDef["key"]) {
    const row = rows[selected];
    if (!row) return;
    switch (key) {
      case "jump":
        onJump(row.id);
        onClose();
        return;
      case "revert":
        onRevert(row.id, row.text ?? "");
        onClose();
        return;
      case "copy":
        void onCopy(row.text ?? "");
        // Non-destructive: stay open, back on the list.
        setMode("list");
        return;
      case "fork":
        void onFork(row.id);
        onClose();
        return;
    }
  }

  // Capture-phase key owner: the dialog owns ↑/↓/Enter/Esc while it is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys = ["ArrowUp", "ArrowDown", "Enter", "Escape", "Home", "End"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "list") {
        if (e.key === "Escape") {
          onClose();
          return;
        }
        if (rows.length === 0) return;
        if (e.key === "ArrowDown") {
          setSelected((i) => moveSelection(i, 1, rows.length));
          return;
        }
        if (e.key === "ArrowUp") {
          setSelected((i) => moveSelection(i, -1, rows.length));
          return;
        }
        if (e.key === "Home") {
          setSelected(0);
          return;
        }
        if (e.key === "End") {
          setSelected(rows.length - 1);
          return;
        }
        if (e.key === "Enter") {
          setActionIndex(0);
          setMode("actions");
        }
        return;
      }
      // Actions mode.
      if (e.key === "Escape") {
        setMode("list");
        return;
      }
      if (e.key === "ArrowDown") {
        setActionIndex((i) => moveSelection(i, 1, ACTIONS.length));
        return;
      }
      if (e.key === "ArrowUp") {
        setActionIndex((i) => moveSelection(i, -1, ACTIONS.length));
        return;
      }
      if (e.key === "Enter") {
        runAction(ACTIONS[actionIndex]!.key);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <>
      {/* Light scrim + press-catcher: the transcript stays visible behind it. */}
      <div
        className="fixed inset-0 z-50 bg-black/20 duration-100 animate-in fade-in"
        aria-hidden
        onMouseDown={onClose}
      />
      <div
        ref={boxRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Timeline"
        data-oc-timeline
        data-oc-timeline-session={sessionID}
        className="fixed top-[8vh] left-1/2 z-50 flex max-h-[76vh] w-[min(30rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-float-base)] shadow-2xl outline-none duration-150 animate-in fade-in slide-in-from-top-4"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-3 py-2.5">
          {mode === "actions" ? (
            <button
              type="button"
              onClick={() => setMode("list")}
              title="Back to timeline"
              aria-label="Back to timeline"
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
            >
              <ArrowLeft className="size-4" />
            </button>
          ) : (
            <ListTree className="size-4 shrink-0 text-[var(--text-weaker)]" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
            {mode === "actions" ? "Message Actions" : "Timeline"}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">
            {rows.length} message{rows.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="Close timeline"
            aria-label="Close timeline"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="size-4" />
          </button>
        </div>

        {mode === "list" ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {rows.length === 0 ? (
              <p className="px-2 py-8 text-center text-xs text-[var(--text-weaker)]">
                No user messages yet.
              </p>
            ) : (
              rows.map((row, i) => (
                <TimelineRow
                  key={row.id}
                  message={row}
                  selected={i === selected}
                  onClick={() => {
                    if (i === selected) {
                      setActionIndex(0);
                      setMode("actions");
                    } else {
                      setSelected(i);
                    }
                  }}
                />
              ))
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="mb-2 rounded-lg bg-[var(--surface-inset-base)] px-3 py-2">
              <p className="line-clamp-2 text-xs leading-relaxed text-[var(--text-weak)]">
                {current ? previewText(current, 220) || "(empty message)" : ""}
              </p>
              {current && (
                <p className="mt-1 font-mono text-[10px] text-[var(--text-weaker)]">
                  {relativeTime(current.time.created)}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1" data-oc-timeline-actions>
              {ACTIONS.map((action, i) => (
                <ActionRow
                  key={action.key}
                  action={action}
                  selected={i === actionIndex}
                  onClick={() => runAction(action.key)}
                />
              ))}
            </div>
          </div>
        )}

        <p className="border-t border-[var(--border-weak-base)] px-3 py-1.5 font-mono text-[10px] text-[var(--text-weaker)]">
          {mode === "list" ? (
            rows.length > 0 ? (
              <>
                ↑↓ select · <span className="text-[var(--text-weak)]">↵</span> actions ·{" "}
                <span className="text-[var(--text-weak)]">esc</span> close
              </>
            ) : (
              <>
                <span className="text-[var(--text-weak)]">esc</span> close
              </>
            )
          ) : (
            <>
              ↑↓ select · <span className="text-[var(--text-weak)]">↵</span> run ·{" "}
              <span className="text-[var(--text-weak)]">esc</span> back
            </>
          )}
        </p>
      </div>
    </>
  );
}

/** One timeline row: preview + relative-time footer. */
function TimelineRow({
  message,
  selected,
  onClick,
}: {
  message: UserMessage;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // Arrow-key moves must stay visible in a scrolled list.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const files = attachmentCount(message);

  return (
    <button
      ref={ref}
      type="button"
      data-oc-timeline-row
      data-selected={selected ? "true" : undefined}
      onClick={onClick}
      className={`flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? "bg-[var(--surface-raised-base-active)] text-[var(--text-strong)]"
          : "text-[var(--text-base)] hover:bg-[var(--surface-base-hover)]"
      }`}
    >
      <span className="w-full truncate text-xs text-[var(--text-strong)]">
        {previewText(message) || "(empty message)"}
      </span>
      <span className="flex items-center gap-2 font-mono text-[10px] text-[var(--text-weaker)]">
        <span>{relativeTime(message.time.created)}</span>
        {files > 0 && (
          <span>
            · {files} file{files === 1 ? "" : "s"}
          </span>
        )}
      </span>
    </button>
  );
}

/** One Message Actions row. */
function ActionRow({
  action,
  selected,
  onClick,
}: {
  action: ActionDef;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const Icon = action.icon;

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <button
      ref={ref}
      type="button"
      data-oc-timeline-action
      data-selected={selected ? "true" : undefined}
      onClick={onClick}
      className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? "bg-[var(--surface-raised-base-active)] text-[var(--text-strong)]"
          : "text-[var(--text-base)] hover:bg-[var(--surface-base-hover)]"
      }`}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-xs">{action.label}</span>
      <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{action.hint}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "timeline.dialog": (p) => <TimelineDialog {...(p as unknown as TimelineDialogProps)} />,
});
