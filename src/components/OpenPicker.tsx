import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowLeft,
  Clock,
  Folder,
  GitBranch,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { ProjectInfo, WorktreeDirectory } from "../api/client";
import type { SessionInfo } from "../api/types";
import { autoRegister } from "../extensions/registry";
import { findHome, workspaceName } from "../lib/workspaces";
import { Spinner, timeAgo } from "./ui";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "./ui/dialog";

/**
 * R11 — Open / recents picker (v2 `component/dialog-open.tsx`).
 *
 * One surface to reach a session, a project, or a project's worktrees:
 *   Enter  open the highlighted session / directory
 *   →      drill INTO a project's worktrees (the orchestrator loads them)
 *   ←/Esc  step back out (Esc at the root closes)
 *   ctrl+n create a worktree for the drilled project inline
 *
 * Presentational: sessions/projects/worktrees and every mutation arrive as
 * props. No fetch happens here (AGENTS rule 2).
 *
 * Targets: `open.picker`.
 */

export interface OpenPickerProps {
  open: boolean;
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  currentSessionID?: string | null;
  /** The directory the picker is scoped to (highlighted project). */
  currentDirectory?: string | null;
  /** Running/queued by session id. */
  live?: Record<string, boolean>;
  /** Worktrees for the drilled project directory (loaded by the caller). */
  worktrees?: WorktreeDirectory[] | null;
  worktreesLoading?: boolean;
  /** Enter on a session. */
  onOpenSession: (sessionID: string) => void;
  /** Enter on a project / worktree directory. */
  onOpenDirectory: (directory: string) => void;
  /** → into a project: load its worktrees. */
  onDrillProject?: (directory: string) => void;
  /** ctrl+n: create a worktree for the drilled project. */
  onCreateWorktree?: (directory: string) => void | Promise<void>;
  onClose: () => void;
}

type Item =
  | { kind: "session"; session: SessionInfo }
  | { kind: "project"; project: ProjectInfo }
  | { kind: "worktree"; worktree: WorktreeDirectory };

export function OpenPicker({
  open,
  sessions,
  projects,
  currentSessionID,
  currentDirectory,
  live,
  worktrees,
  worktreesLoading,
  onOpenSession,
  onOpenDirectory,
  onDrillProject,
  onCreateWorktree,
  onClose,
}: OpenPickerProps) {
  const [query, setQuery] = useState("");
  const [drillDir, setDrillDir] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDrillDir(null);
    setCreating(false);
  }, [open]);

  const trimmed = query.trim().toLowerCase();
  const home = useMemo(() => findHome(sessions.map((s) => s.location?.directory)), [sessions]);

  const projectDirs = useMemo(() => {
    const seen = new Set<string>();
    const out: ProjectInfo[] = [];
    for (const p of projects) {
      if (!p.directory || seen.has(p.directory)) continue;
      seen.add(p.directory);
      out.push(p);
    }
    return out;
  }, [projects]);

  const rootItems = useMemo<Item[]>(() => {
    const sessionItems: Item[] = sessions
      .filter((s) => !s.parentID)
      .filter(
        (s) =>
          !trimmed ||
          (s.title ?? "").toLowerCase().includes(trimmed) ||
          s.id.includes(trimmed) ||
          (s.location?.directory ?? "").toLowerCase().includes(trimmed),
      )
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, 60)
      .map((session) => ({ kind: "session", session }));
    const projectItems: Item[] = projectDirs
      .filter((p) => !trimmed || (p.directory ?? "").toLowerCase().includes(trimmed) || p.canonical.toLowerCase().includes(trimmed))
      .map((project) => ({ kind: "project", project }));
    return [...sessionItems, ...projectItems];
  }, [sessions, projectDirs, trimmed]);

  const drilledDir = drillDir && projectDirs.some((p) => p.directory === drillDir) ? drillDir : null;

  const items = useMemo<Item[]>(() => {
    if (drilledDir) {
      return (worktrees ?? []).map((worktree) => ({ kind: "worktree", worktree }));
    }
    return rootItems;
  }, [drilledDir, worktrees, rootItems]);

  const [hi, setHi] = useState(0);
  useEffect(() => setHi(0), [trimmed, drilledDir]);
  const sel = Math.min(hi, Math.max(0, items.length - 1));

  const choose = (item: Item) => {
    if (item.kind === "session") {
      onOpenSession(item.session.id);
    } else if (item.kind === "project") {
      onOpenDirectory(item.project.directory!);
    } else {
      onOpenDirectory(item.worktree.directory);
    }
    onClose();
  };

  const drillInto = (item: Item) => {
    if (item.kind !== "project" || !item.project.directory) return;
    setDrillDir(item.project.directory);
    onDrillProject?.(item.project.directory);
  };

  const back = () => {
    if (drilledDir) {
      setDrillDir(null);
      return;
    }
    onClose();
  };

  const createWorktree = () => {
    const highlighted = drilledDir ? null : items[sel];
    const dir =
      drilledDir ??
      (highlighted && highlighted.kind === "project" ? highlighted.project.directory! : null) ??
      currentDirectory ??
      null;
    if (!dir || creating) return;
    setCreating(true);
    const result = onCreateWorktree?.(dir);
    if (result instanceof Promise) {
      result.finally(() => setCreating(false));
    } else {
      setCreating(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.isContentEditable;

    if (e.ctrlKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      createWorktree();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      back();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi(Math.min(sel + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(Math.max(sel - 1, 0));
      return;
    }
    if (e.key === "ArrowRight" && !typing) {
      const item = items[sel];
      if (item && item.kind === "project") {
        e.preventDefault();
        drillInto(item);
      }
      return;
    }
    if (e.key === "ArrowLeft" && !typing && drilledDir) {
      e.preventDefault();
      back();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[sel];
      if (item) choose(item);
    }
  };

  // Group the root items: Recent sessions, then Projects.
  const sessionItems = items.filter((i): i is Extract<Item, { kind: "session" }> => i.kind === "session");
  const projectItems = items.filter((i): i is Extract<Item, { kind: "project" }> => i.kind === "project");

  const renderGroup = (label: string, group: Item[]) => {
    if (group.length === 0) return null;
    return (
      <section className="mb-1.5 last:mb-0">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="text-[10px] font-medium tracking-wide text-[var(--text-weaker)] uppercase">{label}</span>
          <span className="font-mono text-[10px] text-[var(--text-weaker)]">{group.length}</span>
        </div>
        {group.map((item) => {
          const index = items.indexOf(item);
          return (
            <PickerItem
              key={keyOf(item)}
              item={item}
              home={home}
              selected={item.kind === "session" && item.session.id === currentSessionID}
              highlighted={index === sel}
              live={item.kind === "session" ? !!live?.[item.session.id] : false}
              onHover={() => setHi(index)}
              onChoose={() => choose(item)}
              onDrill={() => drillInto(item)}
            />
          );
        })}
      </section>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogContent
          showCloseButton={false}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          data-oc-open-picker
          data-oc-open-picker-mode={drilledDir ? "worktrees" : "root"}
          className="flex max-h-[76vh] w-[min(34rem,calc(100vw-1.5rem))] flex-col gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-3 py-2">
            {drilledDir ? (
              <button
                type="button"
                onClick={back}
                title="Back"
                aria-label="Back"
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
              >
                <ArrowLeft className="size-4" />
              </button>
            ) : (
              <Search className="size-4 shrink-0 text-[var(--text-weaker)]" />
            )}
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
              {drilledDir ? (
                <span className="flex items-center gap-1.5">
                  <GitBranch className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
                  <span className="truncate">{workspaceName(drilledDir, home)}</span>
                  <span className="shrink-0 text-[10px] font-normal text-[var(--text-weaker)]">worktrees</span>
                </span>
              ) : (
                "Open"
              )}
            </DialogTitle>
            <button
              type="button"
              data-oc-open-create-worktree
              onClick={createWorktree}
              disabled={creating || (!drilledDir && !currentDirectory && items[sel]?.kind !== "project")}
              title="New worktree (ctrl+n)"
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-[var(--border-weak-base)] px-1.5 py-0.5 text-[10px] text-[var(--text-weaker)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)] disabled:pointer-events-none disabled:opacity-40"
            >
              {creating ? <Spinner className="size-3" /> : <Plus className="size-3" />}
              worktree
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close picker"
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
            >
              <X className="size-4" />
            </button>
          </div>

          {!drilledDir && (
            <div className="border-b border-[var(--border-weak-base)] px-3 py-1.5">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions and projects"
                autoComplete="off"
                spellCheck={false}
                data-oc-open-search
                className="w-full bg-transparent text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-weaker)]"
              />
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-oc-open-body>
            {drilledDir ? (
              worktreesLoading ? (
                <div className="flex items-center gap-2 px-3 py-8 text-xs text-[var(--text-weaker)]">
                  <Spinner className="size-3" /> Loading worktrees…
                </div>
              ) : items.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-[var(--text-weaker)]">
                  No worktrees. Press <span className="font-mono">ctrl+n</span> to create one.
                </p>
              ) : (
                renderGroup("Worktrees", items)
              )
            ) : items.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-[var(--text-weaker)]">Nothing to open.</p>
            ) : (
              <>
                {renderGroup("Sessions", sessionItems)}
                {renderGroup("Projects", projectItems)}
              </>
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-[var(--border-weak-base)] px-3 py-1.5 font-mono text-[10px] text-[var(--text-weaker)]">
            <span>↑↓ select</span>
            <span>↵ open</span>
            {!drilledDir && <span>→ worktrees</span>}
            {drilledDir && <span>← back</span>}
            <span>
              <span className="text-[var(--text-weak)]">ctrl+n</span> new worktree
            </span>
            <span className="flex-1" />
            <span>{drilledDir ? "esc back" : "esc close"}</span>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function keyOf(item: Item): string {
  if (item.kind === "session") return `s:${item.session.id}`;
  if (item.kind === "project") return `p:${item.project.id}`;
  return `w:${item.worktree.directory}`;
}

function PickerItem({
  item,
  home,
  selected,
  highlighted,
  live,
  onHover,
  onChoose,
  onDrill,
}: {
  item: Item;
  home?: string;
  selected: boolean;
  highlighted: boolean;
  live: boolean;
  onHover: () => void;
  onChoose: () => void;
  onDrill: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const base = `flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
    highlighted ? "bg-[var(--surface-raised-base-active)]" : "hover:bg-[var(--surface-base-hover)]"
  }`;

  if (item.kind === "session") {
    const s = item.session;
    return (
      <button
        ref={ref}
        type="button"
        data-oc-open-session
        data-session-id={s.id}
        onMouseMove={onHover}
        onClick={onChoose}
        className={base}
      >
        {live ? (
          <Spinner className="size-3 shrink-0" />
        ) : (
          <Clock className="size-3 shrink-0 text-[var(--text-weaker)]" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-strong)]">
          {s.title || "Untitled session"}
        </span>
        <span className="hidden max-w-40 shrink-0 truncate font-mono text-[10px] text-[var(--text-weaker)] sm:block">
          {workspaceName(s.location?.directory, home)}
        </span>
        {selected && <span className="size-1.5 shrink-0 rounded-full bg-[var(--surface-success-strong)]" />}
        <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--text-weaker)]">
          {timeAgo(s.time.updated)}
        </span>
      </button>
    );
  }

  if (item.kind === "project") {
    const p = item.project;
    return (
      <button
        ref={ref}
        type="button"
        data-oc-open-project
        onMouseMove={onHover}
        // Enter / click opens the directory (v2: → drills, below).
        onClick={onChoose}
        className={base}
      >
        <Folder className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-strong)]">
          {workspaceName(p.directory ?? undefined, home)}
        </span>
        <span className="hidden max-w-48 shrink-0 truncate font-mono text-[10px] text-[var(--text-weaker)] sm:block">
          {p.directory}
        </span>
        {/* Mouse affordance for `→` (drill into worktrees). */}
        <span
          role="button"
          tabIndex={-1}
          data-oc-open-drill
          title="Worktrees (→)"
          aria-label="Show worktrees"
          onClick={(e) => {
            e.stopPropagation();
            onDrill();
          }}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
        >
          <GitBranch className="size-3" />
        </span>
      </button>
    );
  }

  return (
    <button
      ref={ref}
      type="button"
      data-oc-open-worktree
      onMouseMove={onHover}
      onClick={onChoose}
      className={base}
    >
      <GitBranch className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
      <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-strong)]">
        {workspaceName(item.worktree.directory, home)}
      </span>
      {item.worktree.strategy && (
        <span className="shrink-0 rounded border border-[var(--border-weak-base)] px-1 font-mono text-[9px] text-[var(--text-weaker)]">
          {item.worktree.strategy}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "open.picker": (p) => <OpenPicker {...(p as unknown as OpenPickerProps)} />,
});
