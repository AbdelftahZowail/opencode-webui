import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowLeft, Folder, Plus, SquareSplitHorizontal, XIcon } from "lucide-react";
import { api, type LocationInfo, type ProjectInfo } from "../api/client";
import {
  addSplitPane,
  closeSplitPicker,
  createRealSession,
  isDraftSession,
  useStore,
} from "../store";
import { Spinner, timeAgo } from "./ui";

/**
 * The "open a session in a split" dialog (VS Code split-editor parity).
 * Two modes: pick an EXISTING session (type-to-filter, keyboard-first) or
 * start a brand-new one in a chosen workspace. Overlay click / Esc close
 * via Radix; the app-wide Esc handler already yields to [role="dialog"].
 */

const contentCls =
  "fixed top-1/2 left-1/2 z-50 flex w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

const inputCls =
  "w-full rounded-md border border-[var(--border-base)] bg-[var(--input-base)] px-2.5 py-1.5 text-sm text-[var(--text-strong)] outline-none transition-colors placeholder:text-[var(--text-weaker)] focus:border-[var(--border-selected)]";

const rowIdle =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors text-[color:var(--text-base)] hover:bg-[color:var(--surface-base-hover)]";
const rowActive =
  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors bg-[color:var(--surface-raised-base-active)] text-[color:var(--text-strong)]";

export function SplitPicker() {
  const open = useStore((s) => s.splitPickerOpen);
  // Mount fresh per open so query/mode/busy state never leaks between opens.
  if (!open) return null;
  return <SplitPickerDialog />;
}

function SplitPickerDialog() {
  const sessions = useStore((s) => s.sessions);
  const panes = useStore((s) => s.panes);
  const runningMap = useStore((s) => s.running);
  const queuedMap = useStore((s) => s.queued);
  const activeIDs = useStore((s) => s.activeIDs);
  const focusedSession = useStore((s) =>
    s.currentSessionID && !isDraftSession(s.currentSessionID)
      ? s.sessions.find((x) => x.id === s.currentSessionID) ?? s.sessionDetails[s.currentSessionID]
      : undefined,
  );

  const [mode, setMode] = useState<"sessions" | "workspace">("sessions");
  const [query, setQuery] = useState("");
  /** Highlight index into `filtered`; reset on every query change. */
  const [hi, setHi] = useState(0);
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [wsLoading, setWsLoading] = useState(false);
  /** Key of the workspace option currently creating its session (busy guard). */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wsLoadedRef = useRef(false);

  // Sessions already visible in ANY pane are not candidates.
  const excluded = useMemo(() => new Set(panes.map((p) => p.sessionID)), [panes]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const list = sessions.filter(
      (s) =>
        !excluded.has(s.id) &&
        // Subagent sessions (parentID set) stay out of top-level pickers —
        // same rule as the sidebar; they're managed inside their parent.
        !s.parentID &&
        (!q ||
          (s.title ?? "").toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          s.location.directory.toLowerCase().includes(q)),
    );
    return list.sort((a, b) => b.time.updated - a.time.updated);
  }, [sessions, excluded, q]);
  const sel = Math.min(hi, Math.max(0, filtered.length - 1));

  useEffect(() => setHi(0), [q]);

  const focusedDir = focusedSession?.location?.directory;

  // Workspace list is fetched ONCE per dialog open, on first need — same
  // data/pattern as WorkspacePicker's refresh().
  function enterWorkspaces() {
    setMode("workspace");
    setError(null);
    if (wsLoadedRef.current) return;
    wsLoadedRef.current = true;
    setWsLoading(true);
    void Promise.all([api.locationInfo(), api.projectList()])
      .then(([loc, list]) => {
        setLocation(loc);
        setProjects(list);
      })
      .catch(() => setError("Could not load workspaces"))
      .finally(() => setWsLoading(false));
  }

  function backToSessions() {
    setMode("sessions");
    setError(null);
  }

  function pick(id: string) {
    void addSplitPane(id).then((ok) => {
      if (!ok) setError("Already open in a pane, or no free slots");
    });
  }

  async function chooseWorkspace(key: string, directory: string | null) {
    if (busyKey) return; // double-submit guard
    setBusyKey(key);
    setError(null);
    try {
      const sid = await createRealSession(directory);
      const ok = await addSplitPane(sid);
      if (!ok) setError("No free split slots");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }

  const projectDirs = useMemo(() => {
    const seen = new Set<string>();
    for (const d of projects) {
      if (d.directory) seen.add(d.directory);
    }
    return [...seen];
  }, [projects]);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(o) => {
        if (!o) closeSplitPicker();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="bg-black/60" />
        <DialogPrimitive.Content
          tabIndex={-1}
          data-slot="dialog-content"
          className={contentCls}
          aria-describedby={undefined}
          // Focus lands on the filter box itself so typing starts instantly.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title className="flex items-center gap-2 text-[var(--font-size-large)] font-medium text-[var(--text-strong)]">
            <SquareSplitHorizontal className="size-4 shrink-0 text-[var(--text-interactive-base)]" aria-hidden />
            Split view
            <span className="truncate text-xs font-normal text-[var(--text-weaker)]">
              open a session beside this one
            </span>
          </DialogPrimitive.Title>

          {mode === "sessions" ? (
            <>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setHi(Math.min(sel + 1, filtered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setHi(Math.max(sel - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const s = filtered[sel];
                    if (s) pick(s.id);
                  }
                  // Escape bubbles to Radix → closes the dialog.
                }}
                placeholder="Filter sessions… (title, id, workspace)"
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
              />

              {/* Pinned action: create a brand-new session into the next split. */}
              <button
                type="button"
                onClick={enterWorkspaces}
                disabled={busyKey !== null}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-dashed border-[var(--border-weak-base)] px-2 py-1.5 text-left text-sm text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)] disabled:pointer-events-none disabled:opacity-50"
              >
                <Plus className="size-3.5 shrink-0" />
                Start new session
              </button>

              <div className="-mx-1 max-h-72 overflow-y-auto px-1">
                {filtered.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-[var(--text-weaker)]">
                    {q ? "No matching sessions" : "Every session is already in a pane"}
                  </p>
                ) : (
                  filtered.map((s, i) => (
                    <PickerRow
                      key={s.id}
                      title={s.title || `session ${s.id.slice(0, 8)}…`}
                      dir={s.location.directory}
                      at={s.time.updated}
                      // Green-pulse live marker, same idiom as
                      // Sidebar/SubagentStrip: running OR queued counts.
                      running={!!runningMap[s.id] || !!queuedMap[s.id] || activeIDs.includes(s.id)}
                      highlighted={i === sel}
                      onHover={() => setHi(i)}
                      onPick={() => pick(s.id)}
                    />
                  ))
                )}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={backToSessions}
                className="flex cursor-pointer items-center gap-1 self-start rounded-md px-1 py-0.5 text-xs text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)]"
              >
                <ArrowLeft className="size-3" /> all sessions
              </button>

              <div className="-mx-1 max-h-80 overflow-y-auto px-1">
                {wsLoading ? (
                  <div className="flex items-center gap-2 px-2 py-6 text-xs text-[var(--text-weaker)]">
                    <Spinner className="size-3" /> Loading workspaces…
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <WorkspaceRow
                      label="Default workspace"
                      sub={location?.directory}
                      busy={busyKey === "default"}
                      disabled={busyKey !== null}
                      onChoose={() => chooseWorkspace("default", null)}
                    />
                    {focusedDir && focusedSession && (
                      <WorkspaceRow
                        label={`same as ${focusedSession.title ?? "current session"}`}
                        sub={focusedDir}
                        busy={busyKey === "focused"}
                        disabled={busyKey !== null}
                        onChoose={() => chooseWorkspace("focused", focusedDir)}
                      />
                    )}
                    {projectDirs.map((d) => (
                      <WorkspaceRow
                        key={d}
                        label={baseName(d)}
                        sub={d}
                        busy={busyKey === d}
                        disabled={busyKey !== null}
                        onChoose={() => chooseWorkspace(d, d)}
                      />
                    ))}
                    {projectDirs.length === 0 && !focusedDir && (
                      <p className="px-2 py-4 text-center text-xs text-[var(--text-weaker)]">No workspaces</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {error && <p className="text-xs text-[var(--surface-critical-strong)]">{error}</p>}
          <p className="text-xs text-[var(--text-weaker)]">
            <span className="font-mono">↑↓</span> select · <span className="font-mono">↵</span> open ·{" "}
            <span className="font-mono">esc</span> close
          </p>

          <DialogPrimitive.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute top-2 right-2 flex size-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
            >
              <XIcon className="size-4" />
            </button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Sidebar-style workspace label: collapse /home/<user> to "~", else full path. */
function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

/** One candidate session row; keeps the arrow-highlight scrolled into view. */
function PickerRow({
  title,
  dir,
  at,
  running,
  highlighted,
  onHover,
  onPick,
}: {
  title: string;
  dir: string;
  at: number;
  running: boolean;
  highlighted: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  return (
    <button
      ref={ref}
      type="button"
      onMouseMove={onHover}
      onClick={onPick}
      title={dir}
      className={highlighted ? rowActive : rowIdle}
    >
      {/* Same pulsing-dot idiom as the sidebar/GateChip running indicator. */}
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          running ? "animate-pulse bg-emerald-500" : "bg-[color:var(--border-base)]"
        }`}
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="max-w-44 shrink-0 truncate font-mono text-[10px] text-[var(--text-weaker)]">{dir}</span>
      {running && (
        <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">running</span>
      )}
      <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--text-weaker)]">
        {timeAgo(at)}
      </span>
    </button>
  );
}

/** One workspace choice for the "start new session" flow. */
function WorkspaceRow({
  label,
  sub,
  busy,
  disabled,
  onChoose,
}: {
  label: string;
  sub?: string;
  busy: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <button type="button" onClick={onChoose} disabled={disabled} className={busy ? rowActive : rowIdle}>
      {busy ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : (
        <Folder className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
      )}
      <span className="min-w-0 shrink truncate">{label}</span>
      {sub && <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--text-weaker)]">{sub}</span>}
    </button>
  );
}
