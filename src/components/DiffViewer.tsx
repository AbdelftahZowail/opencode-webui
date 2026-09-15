import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Columns2,
  FileDiff,
  Loader2,
  Rows3,
  X,
} from "lucide-react";
import type { FileDiffInfo, VcsBase } from "../api/client";
import {
  buildDiffTree,
  diffSourceHint,
  diffSourceLabel,
  diffTotals,
  diffTreeDirs,
  DIFF_SOURCES,
  flattenDiffTree,
  hunkCount,
  statusClass,
  statusLabel,
  type DiffSource,
  type DiffTreeNode,
} from "../lib/sessionDiff";
import { cn } from "../lib/utils";
import { autoRegister } from "../extensions/registry";
import { DiffView } from "./DiffView";
import { Button } from "./ui";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/dialog";

/**
 * Turn-scoped diff viewer (P2). Presentational: it receives the diff slice and
 * emits store actions — it never calls `api.*` (the store owns side effects).
 *
 * Three sources (see `lib/sessionDiff.ts`), a changed-file tree, per-file and
 * per-hunk navigation, split vs unified, and local-only review markers.
 * Rendering goes through the ONE diff renderer (`DiffView`).
 */
export interface DiffViewerProps {
  sessionID: string;
  files: FileDiffInfo[];
  source: DiffSource;
  loading: boolean;
  error: string | null;
  reviewed: string[];
  selectedFile: string | null;
  /** Resolved base for the "branch" source, when the engine reported one. */
  base?: VcsBase | null;
  onSelectSource: (source: DiffSource) => void;
  onSelectFile: (file: string | null) => void;
  onToggleReviewed: (file: string, reviewed: boolean) => void;
  onClose: () => void;
}

export function DiffViewer(props: DiffViewerProps) {
  const {
    files,
    source,
    loading,
    error,
    reviewed,
    selectedFile,
    base,
    onSelectSource,
    onSelectFile,
    onToggleReviewed,
    onClose,
  } = props;

  const [view, setView] = useState<"unified" | "split">("unified");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [activeHunk, setActiveHunk] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildDiffTree(files), [files]);
  const visible = useMemo(() => flattenDiffTree(tree, collapsed), [tree, collapsed]);
  const totals = useMemo(() => diffTotals(files), [files]);
  const active = useMemo(
    () => files.find((f) => f.file === selectedFile) ?? files[0],
    [files, selectedFile],
  );
  const patch = active?.patch ?? "";
  const hunks = useMemo(() => hunkCount(patch), [patch]);

  const fileIndex = active ? files.findIndex((f) => f.file === active.file) : -1;
  const isReviewed = active ? reviewed.includes(active.file) : false;

  // A new file or source restarts hunk navigation.
  useEffect(() => {
    setActiveHunk(0);
  }, [active?.file, source]);

  const scrollToHunk = (next: number) => {
    if (hunks === 0) return;
    const index = ((next % hunks) + hunks) % hunks;
    setActiveHunk(index);
    scrollRef.current
      ?.querySelector(`[data-diff-hunk="${index}"]`)
      ?.scrollIntoView({ block: "start" });
  };

  const stepFile = (delta: number) => {
    if (files.length === 0) return;
    const next = (fileIndex + delta + files.length) % files.length;
    onSelectFile(files[next]!.file);
  };

  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allCollapsed = collapsed.size >= diffTreeDirs(tree).length;

  // Navigation keys. Modifier combos stay with the browser/app; the dialog
  // owns plain keys while it is up, so this is safe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      switch (e.key) {
        case "j":
          e.preventDefault();
          scrollToHunk(activeHunk + 1);
          break;
        case "k":
          e.preventDefault();
          scrollToHunk(activeHunk - 1);
          break;
        case "n":
          e.preventDefault();
          stepFile(1);
          break;
        case "p":
          e.preventDefault();
          stepFile(-1);
          break;
        case "m":
          if (active) {
            e.preventDefault();
            onToggleReviewed(active.file, !isReviewed);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-oc-diff-viewer
        className="flex h-[min(90dvh,60rem)] w-[min(96rem,calc(100vw-1rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="flex shrink-0 flex-col gap-2 border-b border-[var(--border-weak-base)] px-3 py-2">
          <div className="flex items-center gap-2">
            <FileDiff className="size-4 shrink-0 text-[var(--text-weak)]" />
            <DialogTitle className="text-sm font-medium text-[var(--text-strong)]">
              Review changes
            </DialogTitle>
            <span className="text-[11px] text-[var(--text-weaker)]">
              {totals.files} file{totals.files === 1 ? "" : "s"}
              {totals.additions > 0 && (
                <span className="ml-1 text-[color:var(--surface-success-strong)]">
                  +{totals.additions}
                </span>
              )}
              {totals.deletions > 0 && (
                <span className="ml-1 text-[color:var(--surface-critical-strong)]">
                  −{totals.deletions}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div
              className="flex shrink-0 rounded-md border border-[var(--border-weak-base)] p-0.5"
              role="tablist"
              aria-label="Diff source"
            >
              {DIFF_SOURCES.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={source === item}
                  data-oc-diff-source={item}
                  onClick={() => onSelectSource(item)}
                  className={cn(
                    "cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors",
                    source === item
                      ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                      : "text-[var(--text-weak)] hover:text-[var(--text-strong)]",
                  )}
                >
                  {diffSourceLabel(item)}
                </button>
              ))}
            </div>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-weaker)]">
              {diffSourceHint(source)}
              {source === "branch" && base ? (
                <span className="ml-1 font-mono">{base.name}</span>
              ) : null}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                disabled={files.length === 0}
                title="Previous file (p)"
                onClick={() => stepFile(-1)}
              >
                ‹ file
              </Button>
              <Button
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                disabled={files.length === 0}
                title="Next file (n)"
                onClick={() => stepFile(1)}
              >
                file ›
              </Button>
              <span className="mx-1 text-[var(--text-weaker)]">·</span>
              <Button
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                disabled={hunks === 0}
                title="Previous hunk (k)"
                onClick={() => scrollToHunk(activeHunk - 1)}
              >
                ‹ hunk
              </Button>
              <span className="px-1 text-[11px] tabular-nums text-[var(--text-weaker)]">
                {hunks === 0 ? "0/0" : `${activeHunk + 1}/${hunks}`}
              </span>
              <Button
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                disabled={hunks === 0}
                title="Next hunk (j)"
                onClick={() => scrollToHunk(activeHunk + 1)}
              >
                hunk ›
              </Button>
            </div>
            <div className="flex shrink-0 rounded-md border border-[var(--border-weak-base)] p-0.5">
              <button
                type="button"
                aria-pressed={view === "unified"}
                title="Unified view"
                onClick={() => setView("unified")}
                className={cn(
                  "flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                  view === "unified"
                    ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                    : "text-[var(--text-weak)] hover:text-[var(--text-strong)]",
                )}
              >
                <Rows3 className="size-3" />
                Unified
              </button>
              <button
                type="button"
                aria-pressed={view === "split"}
                title="Side-by-side view"
                onClick={() => setView("split")}
                className={cn(
                  "flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                  view === "split"
                    ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                    : "text-[var(--text-weak)] hover:text-[var(--text-strong)]",
                )}
              >
                <Columns2 className="size-3" />
                Split
              </button>
            </div>
            <Button
              variant={isReviewed ? "secondary" : "ghost"}
              className="h-6 shrink-0 px-2 text-[11px]"
              disabled={!active}
              title="Toggle reviewed (m)"
              onClick={() => active && onToggleReviewed(active.file, !isReviewed)}
            >
              <Check className="size-3" />
              {isReviewed ? "Reviewed" : "Mark reviewed"}
            </Button>
          </div>
          {reviewed.length > 0 && (
            <span className="text-[11px] text-[var(--text-weaker)]">
              {reviewed.length}/{files.length} file
              {files.length === 1 ? "" : "s"} reviewed
            </span>
          )}
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            className="flex w-[clamp(14rem,26%,22rem)] shrink-0 flex-col border-r border-[var(--border-weak-base)]"
            data-oc-diff-tree
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-weak-base)] px-2 py-1">
              <span className="text-[11px] text-[var(--text-weaker)]">Files</span>
              <button
                type="button"
                className="ml-auto cursor-pointer text-[11px] text-[var(--text-weak)] transition-colors hover:text-[var(--text-strong)]"
                onClick={() =>
                  setCollapsed(allCollapsed ? new Set() : new Set(diffTreeDirs(tree)))
                }
              >
                {allCollapsed ? "Expand all" : "Collapse all"}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {loading && files.length === 0 ? (
                <div className="space-y-1.5 p-2">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className="h-3 animate-pulse rounded bg-[var(--surface-raised-base)]"
                    />
                  ))}
                </div>
              ) : files.length === 0 ? (
                <p className="p-2 text-[11px] text-[var(--text-weaker)]">
                  No changed files.
                </p>
              ) : (
                visible.map((node) => (
                  <DiffTreeRow
                    key={`${node.type}:${node.path}`}
                    node={node}
                    collapsed={collapsed.has(node.path)}
                    selected={node.type === "file" && node.path === active?.file}
                    reviewed={node.type === "file" && reviewed.includes(node.path)}
                    onToggle={toggleDir}
                    onSelect={onSelectFile}
                  />
                ))
              )}
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col" data-oc-diff-detail>
            {active && (
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-weak-base)] px-3 py-1.5">
                <span
                  className={cn("shrink-0 font-mono text-[11px]", statusClass(active.status))}
                  title={active.status}
                >
                  {statusLabel(active.status)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-weak)]">
                  {active.file}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--text-weaker)]">
                  {active.additions > 0 && (
                    <span className="text-[color:var(--surface-success-strong)]">
                      +{active.additions}
                    </span>
                  )}
                  {active.deletions > 0 && (
                    <span className="ml-1 text-[color:var(--surface-critical-strong)]">
                      −{active.deletions}
                    </span>
                  )}
                </span>
              </div>
            )}
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="flex items-center gap-2 p-4 text-xs text-[var(--text-weak)]">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading diff…
                </div>
              ) : error ? (
                <p className="p-4 text-xs text-[color:var(--surface-critical-strong)]">
                  Diff unavailable: {error}
                </p>
              ) : !active ? (
                <p className="p-4 text-xs text-[var(--text-weak)]">
                  No changes in this source.
                </p>
              ) : !patch ? (
                <p className="p-4 text-xs text-[var(--text-weak)]">
                  No patch for {active.file} (binary or too large).
                </p>
              ) : (
                <DiffView diff={patch} view={view} activeHunk={activeHunk} className="py-1" />
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DiffTreeRow({
  node,
  collapsed,
  selected,
  reviewed,
  onToggle,
  onSelect,
}: {
  node: DiffTreeNode;
  collapsed: boolean;
  selected: boolean;
  reviewed: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isDir = node.type === "dir";
  const indent = 4 + node.depth * 12;
  return (
    <div
      role="button"
      tabIndex={0}
      data-oc-diff-file={isDir ? undefined : node.path}
      onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (isDir) onToggle(node.path);
        else onSelect(node.path);
      }}
      style={{ paddingLeft: indent }}
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded-sm py-[3px] pr-2",
        selected
          ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
          : "text-[var(--text-base)] hover:bg-[color:var(--surface-base-hover)]",
      )}
    >
      {isDir ? (
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-[var(--text-weaker)] transition-transform",
            !collapsed && "rotate-90",
          )}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      {!isDir && node.file && (
        <span
          className={cn("w-3 shrink-0 font-mono text-[10px]", statusClass(node.file.status))}
          title={node.file.status}
        >
          {statusLabel(node.file.status)}
        </span>
      )}
      <span
        className={cn(
          "truncate font-mono text-[11px]",
          isDir ? "text-[var(--text-strong)]" : "text-[var(--text-base)]",
          reviewed && !isDir && "line-through opacity-60",
        )}
      >
        {node.name}
      </span>
      {reviewed && !isDir && (
        <Check className="ml-auto size-3 shrink-0 text-[color:var(--surface-success-strong)]" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "diff.viewer": (p) => <DiffViewer {...(p as unknown as DiffViewerProps)} />,
});
