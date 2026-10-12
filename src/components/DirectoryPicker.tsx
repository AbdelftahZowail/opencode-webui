import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CornerDownLeft, Folder, History, Trash2, X } from "lucide-react";
import { api } from "../api/client";
import type { LocationInfo, ProjectInfo } from "../api/client";
import { autoRegister } from "../extensions/registry";
import { notify } from "../lib/notify";
import {
  clearDirRecents,
  contractHome,
  dirPrefix,
  expandHome,
  lastSegment,
  loadDirRecents,
  normalizePath,
  rankDirectories,
  recordDirRecent,
  resolveDirectory,
} from "../lib/dirRecents";

/**
 * Directory picker for `session.cd` / `/move` (parity R8). Modal with a
 * directory input and a completion list: per-project recents are prepended,
 * `~` / `~/` / `../` / absolute paths all resolve, `tab` expands the
 * highlighted suggestion, and a destructive `ctrl+d` (armed, then confirmed)
 * clears the project's recents.
 *
 * Presentational + local: it owns its query/suggestion state and emits the
 * chosen directory through `onPick`; the caller owns the move. Rendered
 * through its `<Target id="directory.picker">` so wraps/replaces apply.
 */
export interface DirectoryPickerProps {
  /** Ambient session workspace — the fs listing scope. */
  location?: string;
  /** Home directory (derived by the caller) so `~` expands. */
  home?: string;
  /** Per-project recents key (the session workspace). */
  project?: string;
  currentDirectory?: string;
  onPick: (directory: string) => void;
  onClose: () => void;
}

export function DirectoryPicker({
  location,
  home,
  project,
  currentDirectory,
  onPick,
  onClose,
}: DirectoryPickerProps) {
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>(() => loadDirRecents(project));
  const [suggested, setSuggested] = useState<string[]>([]);
  const [completions, setCompletions] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [clearArmed, setClearArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Known workspaces + the current directory, offered when the query is empty.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [projects, loc] = await Promise.all([
          api.projectList().catch(() => [] as ProjectInfo[]),
          api.location().catch(() => null as LocationInfo | null),
        ]);
        if (cancelled) return;
        const set = new Set<string>();
        for (const p of projects) if (p.directory) set.add(normalizePath(p.directory));
        if (loc?.directory) set.add(normalizePath(loc.directory));
        if (currentDirectory) set.add(normalizePath(currentDirectory));
        setSuggested([...set].sort());
      } catch {
        /* suggestions are a convenience — recents still work */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentDirectory]);

  // Engine-side completions for the typed prefix (debounced). The engine lists
  // absolute AND relative paths and returns entry paths relative to the
  // location, so we rebuild candidates as `<typed dir>/<entry basename>`.
  useEffect(() => {
    const rawPrefix = dirPrefix(query);
    const listPath = normalizePath(expandHome(rawPrefix, home));
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .fsList({ location, path: listPath || undefined })
        .then((res) => {
          if (cancelled) return;
          const dirs = res.data
            .filter((e) => e.type === "directory")
            .map((e) => `${rawPrefix}${lastSegment(e.path)}`);
          setCompletions(dirs);
        })
        .catch(() => {
          if (!cancelled) setCompletions([]);
        });
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, location, home]);

  const rows = useMemo(
    () => rankDirectories(query, { recents, candidates: [...suggested, ...completions], home }),
    [query, recents, suggested, completions, home],
  );

  const recentSet = useMemo(() => new Set(recents.map(normalizePath)), [recents]);

  // Keep the highlight on a real row as the list shrinks/grows under typing.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 2500);
    return () => clearTimeout(timer);
  }, [clearArmed]);

  function choose(dir: string) {
    const resolved = resolveDirectory(dir, { home, base: location });
    if (!resolved) return;
    recordDirRecent(project, resolved);
    onPick(resolved);
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (rows.length ? (i + 1) % rows.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
      return;
    }
    if (e.key === "Tab") {
      // Expand the highlighted completion into the input (drill in) rather
      // than committing — v2's `tab` expands, Enter picks.
      const row = rows[selected];
      if (row) {
        e.preventDefault();
        setQuery(`${contractHome(row, home)}/`);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[selected];
      if (row) choose(row);
      else if (query.trim()) choose(query);
      return;
    }
    if (e.key.toLowerCase() === "d" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      // Destructive clear: arm, then a second ctrl+d confirms.
      e.preventDefault();
      if (clearArmed) {
        clearDirRecents(project);
        setRecents([]);
        setClearArmed(false);
        notify({ title: "Directory recents cleared" });
      } else {
        setClearArmed(true);
      }
    }
  }

  return (
    <div
      data-oc-directory-picker
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--text-strong)]">Change directory</h3>
          <button
            type="button"
            onClick={onClose}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-weak)]"
            title="Close (esc)"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <p className="mt-1 text-xs text-[var(--text-weaker)]">
          Moves this session, or sets where new sessions open. `~`, `~/`, `../` and absolute paths all work.
        </p>

        <input
          ref={inputRef}
          data-oc-directory-input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={currentDirectory ? contractHome(currentDirectory, home) : "~/projects/foo"}
          spellCheck={false}
          autoComplete="off"
          className="mt-3 w-full rounded-md border border-[var(--border-base)] bg-[var(--input-base)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-strong)] outline-none placeholder:text-[var(--text-weaker)] focus:border-[var(--border-selected)]"
        />

        {currentDirectory && (
          <button
            type="button"
            onClick={() => choose(currentDirectory)}
            className="mt-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)]"
            title="Keep the current directory"
          >
            <CornerDownLeft className="size-3" />
            current: <span className="truncate font-mono">{contractHome(currentDirectory, home)}</span>
          </button>
        )}

        <div
          ref={listRef}
          className="mt-2 max-h-64 overflow-y-auto rounded-md border border-[var(--border-weak-base)]"
        >
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-xs text-[var(--text-weaker)]">
              {query.trim() ? "No matching directories" : "No directories"}
            </p>
          ) : (
            rows.map((dir, i) => {
              const isRecent = recentSet.has(normalizePath(dir));
              return (
                <button
                  key={dir}
                  type="button"
                  data-oc-directory-row
                  data-selected={i === selected ? "true" : undefined}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => choose(dir)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                    i === selected
                      ? "bg-[var(--surface-raised-base-active)] text-[var(--text-strong)]"
                      : "text-[var(--text-base)] hover:bg-[var(--surface-base-hover)]"
                  }`}
                >
                  {isRecent ? (
                    <History className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
                  ) : (
                    <Folder className="size-3.5 shrink-0 text-[var(--text-weak)]" />
                  )}
                  <span className="truncate font-mono">{contractHome(dir, home)}</span>
                  {isRecent && (
                    <span className="ml-auto shrink-0 text-[10px] text-[var(--text-weaker)]">recent</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-[var(--text-weaker)]">
          <span>
            <span className="text-[var(--text-weak)]">↑↓</span> move ·{" "}
            <span className="text-[var(--text-weak)]">tab</span> expand ·{" "}
            <span className="text-[var(--text-weak)]">↵</span> move here
          </span>
          {recents.length > 0 && (
            <span className={clearArmed ? "text-[var(--surface-critical-strong)]" : ""}>
              {clearArmed ? (
                <span className="flex items-center gap-1">
                  <Trash2 className="size-3" /> ctrl+d again to clear recents
                </span>
              ) : (
                <span>ctrl+d clear recents</span>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "directory.picker": (p) => <DirectoryPicker {...(p as unknown as DirectoryPickerProps)} />,
});
