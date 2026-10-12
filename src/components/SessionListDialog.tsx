import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Clock,
  FolderOpen,
  Layers,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { SessionInfo } from "../api/types";
import { autoRegister } from "../extensions/registry";
import { findHome, workspaceName } from "../lib/workspaces";
import { timeAgo, Spinner } from "./ui";
import { Dialog, DialogContent, DialogPortal } from "./ui/dialog";

/**
 * R11 — Session list dialog (v2 `component/dialog-session-list.tsx`).
 *
 * The keyboard-first "switch session" surface: server-side search, groups
 * ordered **Pinned → Today → date**, a running spinner per busy session,
 * quick-slot numbers on pinned rows, `ctrl+a` to widen search to all projects,
 * and per-row pin/unpin/delete/rename.
 *
 * Presentational: the store owns sessions/pins/running and performs the
 * mutations; this component only emits (`onSelect`, `onTogglePin`, `onRename`,
 * `onDelete`, `onSearch`). R11 deliberately does NOT own the tab model — pins
 * arrive as props (`pinned`, ordered = quick-slot order) so R3 keeps them.
 *
 * Targets: `sessionList.dialog`.
 */

const SEARCH_MIN = 2;

export interface SessionListDialogProps {
  open: boolean;
  sessions: SessionInfo[];
  currentSessionID?: string | null;
  /** Running/queued by session id — drives the row spinner. */
  live?: Record<string, boolean>;
  /** Debounced server-side search (empty string clears). `allProjects` widens scope. */
  onSearch?: (query: string, allProjects: boolean) => void;
  /** The latest server-side results, unioned with `sessions` while searching. */
  searchResults?: SessionInfo[] | null;
  /** A server-side search is in flight. */
  searching?: boolean;
  /** Ordered pinned session ids (index+1 = quick slot 1..9). Owned by R3. */
  pinned?: string[];
  onTogglePin?: (sessionID: string) => void;
  /** Search scope: false = current project, true = all projects. */
  allProjects?: boolean;
  onToggleAllProjects?: () => void;
  onSelect: (sessionID: string) => void;
  onRename?: (sessionID: string, title: string) => void;
  onDelete?: (sessionID: string) => void;
  onClose: () => void;
}

type Row = { session: SessionInfo; quick?: number };
type Group = { label: string; rows: Row[] };

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** v2's date buckets: Today, Yesterday, then the calendar date. */
function groupLabel(ts: number): string {
  const now = new Date();
  if (dayKey(ts) === dayKey(now.getTime())) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(ts) === dayKey(yesterday.getTime())) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function SessionListDialog({
  open,
  sessions,
  currentSessionID,
  live,
  onSearch,
  searchResults,
  searching,
  pinned = [],
  onTogglePin,
  allProjects = false,
  onToggleAllProjects,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: SessionListDialogProps) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Keep the search callback out of the effect deps (a caller passing an inline
  // arrow must not thrash the debounce) and only fire on an actual key change
  // (so a "" clear can never loop against a parent that stores the results).
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const lastSearch = useRef("\u0000init");

  // Fresh per open.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRenaming(null);
    setPendingDelete(null);
    lastSearch.current = "\u0000init";
  }, [open]);

  const trimmed = query.trim();

  // Debounced server-side search (one-shot timeout, not a recurring poller).
  useEffect(() => {
    if (!open) return;
    const key = `${trimmed}\u0000${allProjects}`;
    if (key === lastSearch.current) return;
    if (trimmed.length < SEARCH_MIN) {
      lastSearch.current = key;
      onSearchRef.current?.("", allProjects);
      return;
    }
    const t = setTimeout(() => {
      lastSearch.current = key;
      onSearchRef.current?.(trimmed, allProjects);
    }, 250);
    return () => clearTimeout(t);
  }, [open, trimmed, allProjects]);

  const home = useMemo(() => findHome(sessions.map((s) => s.location?.directory)), [sessions]);

  // Union local list with server results while a search is active.
  const pool = useMemo(() => {
    const byId = new Map<string, SessionInfo>();
    for (const s of sessions) if (!s.parentID) byId.set(s.id, s);
    if (trimmed.length >= SEARCH_MIN && searchResults) {
      for (const s of searchResults) if (!s.parentID) byId.set(s.id, s);
    }
    return [...byId.values()];
  }, [sessions, searchResults, trimmed]);

  const filtered = useMemo(() => {
    if (!trimmed) return pool;
    const q = trimmed.toLowerCase();
    return pool.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        s.id.includes(q) ||
        (s.location?.directory ?? "").toLowerCase().includes(q),
    );
  }, [pool, trimmed]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  const groups = useMemo<Group[]>(() => {
    const byId = new Map(filtered.map((s) => [s.id, s]));
    const out: Group[] = [];

    // 1. Pinned — in pin order (quick-slot number 1..9).
    const pinnedRows: Row[] = [];
    pinned.forEach((id, i) => {
      const session = byId.get(id);
      if (session) {
        pinnedRows.push({ session, quick: i < 9 ? i + 1 : undefined });
        byId.delete(id);
      }
    });
    if (pinnedRows.length > 0) out.push({ label: "Pinned", rows: pinnedRows });

    // 2. Today → Yesterday → date, each newest-first. Iterating the
    //    time-sorted remainder and bucketing by first sight keeps Today at the
    //    top without a separate ordering pass.
    const rest = [...byId.values()].sort((a, b) => b.time.updated - a.time.updated);
    const buckets = new Map<string, Row[]>();
    for (const s of rest) {
      const label = groupLabel(s.time.updated);
      const list = buckets.get(label) ?? [];
      list.push({ session: s });
      buckets.set(label, list);
    }
    for (const [label, rows] of buckets) out.push({ label, rows });
    return out;
  }, [filtered, pinned]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const [hi, setHi] = useState(0);
  useEffect(() => setHi(0), [trimmed, allProjects]);
  const sel = Math.min(hi, Math.max(0, flat.length - 1));

  const choose = (s: SessionInfo) => {
    onSelect(s.id);
    onClose();
  };

  const startRename = (s: SessionInfo) => {
    setRenaming(s.id);
    setRenameText(s.title ?? "");
    setPendingDelete(null);
  };

  const commitRename = () => {
    if (renaming && renameText.trim()) onRename?.(renaming, renameText.trim());
    setRenaming(null);
  };

  const requestDelete = (s: SessionInfo) => {
    if (pendingDelete === s.id) {
      onDelete?.(s.id);
      setPendingDelete(null);
      return;
    }
    setPendingDelete(s.id);
  };

  // Keyboard owner. Letters are ignored while the search/rename input has focus.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement;
    const typing =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    if (e.ctrlKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onToggleAllProjects?.();
      return;
    }
    // While renaming, the inline input owns Enter/Esc (and the arrow keys move
    // the caret, not the list selection).
    if (renaming) {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setRenaming(null);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (pendingDelete) setPendingDelete(null);
      else onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi(Math.min(sel + 1, flat.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(Math.max(sel - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = flat[sel];
      if (row) choose(row.session);
      return;
    }
    if (typing) return;

    const row = flat[sel];
    if (!row) return;
    if (e.key >= "1" && e.key <= "9") {
      const quick = flat.find((r) => r.quick === Number(e.key));
      if (quick) {
        e.preventDefault();
        choose(quick.session);
      }
      return;
    }
    if (e.key.toLowerCase() === "p") {
      e.preventDefault();
      onTogglePin?.(row.session.id);
    } else if (e.key.toLowerCase() === "r") {
      e.preventDefault();
      startRename(row.session);
    } else if (e.key === "Delete" || e.key.toLowerCase() === "d") {
      e.preventDefault();
      requestDelete(row.session);
    }
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
          data-oc-session-list-dialog
          className="flex max-h-[76vh] w-[min(34rem,calc(100vw-1.5rem))] flex-col gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-3 py-2">
            <Search className="size-4 shrink-0 text-[var(--text-weaker)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions"
              autoComplete="off"
              spellCheck={false}
              data-oc-session-list-search
              className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-strong)] outline-none placeholder:text-[var(--text-weaker)]"
            />
            <button
              type="button"
              data-oc-session-list-scope
              onClick={onToggleAllProjects}
              title={allProjects ? "Searching all projects" : "Searching this project"}
              className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                allProjects
                  ? "border-[var(--border-selected)] text-[var(--text-strong)]"
                  : "border-[var(--border-weak-base)] text-[var(--text-weaker)] hover:text-[var(--text-strong)]"
              }`}
            >
              <Layers className="size-3" />
              {allProjects ? "all projects" : "this project"}
            </button>
            {searching && <Spinner className="size-3.5 shrink-0" />}
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close session list"
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-oc-session-list-body>
            {flat.length === 0 ? (
              <p className="px-3 py-10 text-center text-xs text-[var(--text-weaker)]">
                {trimmed ? "No matching sessions." : "No sessions yet."}
              </p>
            ) : (
              groups.map((group) => (
                <section key={group.label} className="mb-1.5 last:mb-0">
                  <div className="flex items-center gap-2 px-2 py-1">
                    <span className="text-[10px] font-medium tracking-wide text-[var(--text-weaker)] uppercase">
                      {group.label}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--text-weaker)]">{group.rows.length}</span>
                  </div>
                  {group.rows.map((row) => {
                    const index = flat.indexOf(row);
                    return (
                      <SessionRow
                        key={row.session.id}
                        row={row}
                        home={home}
                        selected={row.session.id === currentSessionID}
                        highlighted={index === sel}
                        live={!!live?.[row.session.id]}
                        pinned={pinnedSet.has(row.session.id)}
                        renaming={renaming === row.session.id}
                        renameText={renameText}
                        confirmingDelete={pendingDelete === row.session.id}
                        showQuickSlots={pinned.length > 0}
                        onHover={() => setHi(index)}
                        onChoose={() => choose(row.session)}
                        onTogglePin={() => onTogglePin?.(row.session.id)}
                        onStartRename={() => startRename(row.session)}
                        onRenameText={setRenameText}
                        onCommitRename={commitRename}
                        onDelete={() => requestDelete(row.session)}
                      />
                    );
                  })}
                </section>
              ))
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-[var(--border-weak-base)] px-3 py-1.5 font-mono text-[10px] text-[var(--text-weaker)]">
            <span>↑↓ select</span>
            <span>↵ open</span>
            <span>1-9 slots</span>
            <span>
              <span className="text-[var(--text-weak)]">ctrl+a</span> scope
            </span>
            <span>p pin</span>
            <span>r rename</span>
            <span>d delete</span>
            <span className="flex-1" />
            <span>esc close</span>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

function SessionRow({
  row,
  home,
  selected,
  highlighted,
  live,
  pinned,
  renaming,
  renameText,
  confirmingDelete,
  showQuickSlots,
  onHover,
  onChoose,
  onTogglePin,
  onStartRename,
  onRenameText,
  onCommitRename,
  onDelete,
}: {
  row: Row;
  home?: string;
  selected: boolean;
  highlighted: boolean;
  live: boolean;
  pinned: boolean;
  renaming: boolean;
  renameText: string;
  confirmingDelete: boolean;
  showQuickSlots: boolean;
  onHover: () => void;
  onChoose: () => void;
  onTogglePin: () => void;
  onStartRename: () => void;
  onRenameText: (t: string) => void;
  onCommitRename: () => void;
  onDelete: () => void;
}) {
  const s = row.session;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  return (
    <div
      ref={ref}
      data-oc-session-list-row
      data-session-id={s.id}
      data-selected={highlighted ? "true" : undefined}
      onMouseMove={onHover}
      className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
        highlighted ? "bg-[var(--surface-raised-base-active)]" : "hover:bg-[var(--surface-base-hover)]"
      }`}
    >
      {showQuickSlots && (
        <span
          className={`w-4 shrink-0 text-center font-mono text-[10px] ${
            row.quick ? "text-[var(--text-weak)]" : "text-transparent"
          }`}
          aria-hidden
        >
          {row.quick ?? "·"}
        </span>
      )}
      <span className="flex w-3.5 shrink-0 justify-center">
        {live ? <Spinner className="size-3" /> : <Clock className="size-3 text-[var(--text-weaker)]" />}
      </span>

      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            value={renameText}
            autoFocus
            onChange={(e) => onRenameText(e.target.value)}
            onBlur={onCommitRename}
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded border border-[var(--border-selected)] bg-[var(--input-base)] px-1.5 py-0.5 text-xs text-[var(--text-strong)] outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onChoose}
            className="block w-full truncate text-left text-xs text-[var(--text-strong)]"
            title={s.title ?? "Untitled session"}
          >
            {s.title || "Untitled session"}
          </button>
        )}
        <div className="flex items-center gap-1.5 truncate font-mono text-[10px] text-[var(--text-weaker)]">
          <FolderOpen className="size-2.5 shrink-0" />
          <span className="truncate">{workspaceName(s.location?.directory, home)}</span>
        </div>
      </div>

      <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{timeAgo(s.time.updated)}</span>

      {/* Row actions: visible on hover/focus, always reachable by keyboard. */}
      {!renaming && (
        <div
          className={`flex shrink-0 items-center gap-0.5 ${
            highlighted || confirmingDelete ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <button
            type="button"
            onClick={onTogglePin}
            title={pinned ? "Unpin" : "Pin (quick slot)"}
            aria-label={pinned ? "Unpin session" : "Pin session"}
            className="flex size-5 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            {pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
          </button>
          <button
            type="button"
            onClick={onStartRename}
            title="Rename"
            aria-label="Rename session"
            className="flex size-5 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <Pencil className="size-3" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title={confirmingDelete ? "Confirm delete" : "Delete"}
            aria-label="Delete session"
            className={`flex h-5 cursor-pointer items-center justify-center gap-1 rounded-md px-1 transition-colors hover:bg-[var(--surface-base-hover)] ${
              confirmingDelete
                ? "text-[var(--surface-critical-strong)]"
                : "text-[var(--text-weaker)] hover:text-[var(--surface-critical-strong)]"
            }`}
          >
            <Trash2 className="size-3" />
            {confirmingDelete && <span className="text-[10px]">confirm</span>}
          </button>
        </div>
      )}

      {selected && !renaming && (
        <span className="size-1.5 shrink-0 rounded-full bg-[var(--surface-success-strong)]" aria-label="current" />
      )}
      {confirmingDelete && !live && <span className="sr-only">Delete confirm armed</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "sessionList.dialog": (p) => <SessionListDialog {...(p as unknown as SessionListDialogProps)} />,
});
