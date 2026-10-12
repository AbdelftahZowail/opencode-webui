import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Columns2,
  FileDiff,
  GitBranch,
  HelpCircle,
  Loader2,
  Maximize2,
  PanelLeft,
  Rows3,
  Search,
  WrapText,
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
  isImageFile,
  statusClass,
  statusLabel,
  type DiffSource,
  type DiffTreeNode,
} from "../lib/sessionDiff";
import { baseLabel, filterBranches, groupBranches } from "../lib/diffBranches";
import { getPrefs, setPref, subscribePrefs } from "../prefs";
import { cn } from "../lib/utils";
import { autoRegister } from "../extensions/registry";
import { DiffImagePane } from "./DiffImagePane";
import { DiffView } from "./DiffView";
import { Button } from "./ui";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/dialog";

/**
 * Turn-scoped diff viewer (P2, completed in R7). Presentational: it receives
 * the diff slice and emits store actions — it never calls `api.*` (the store
 * owns side effects; the image pane's one-shot content read is the exception,
 * scoped to `DiffImagePane`).
 *
 * Four sources (see `lib/sessionDiff.ts`), a changed-file tree, a searchable
 * base-branch picker, per-file and per-hunk navigation, vim scroll keys, split
 * vs unified, image previews, and local-only review markers. Rendering goes
 * through the ONE diff renderer (`DiffView`).
 */
export interface DiffViewerProps {
  sessionID: string;
  files: FileDiffInfo[];
  source: DiffSource;
  loading: boolean;
  error: string | null;
  reviewed: string[];
  selectedFile: string | null;
  /** Resolved (inferred) base for the base-relative sources, when reported. */
  base?: VcsBase | null;
  /** Searchable local + remote branch list for the base picker (R7). */
  branches?: string[];
  /** The chosen base ref, remembered by the store until the viewer closes. */
  baseRef?: string | null;
  /** Session directory — resolves image paths for the preview pane. */
  location?: string | null;
  onSelectSource: (source: DiffSource) => void;
  onSelectFile: (file: string | null) => void;
  onToggleReviewed: (file: string, reviewed: boolean) => void;
  /** Pick / clear the base branch. The store remembers it until close. */
  onSelectBase?: (branch: string | null) => void;
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
    branches,
    baseRef,
    location,
    onSelectSource,
    onSelectFile,
    onToggleReviewed,
    onSelectBase,
    onClose,
  } = props;

  const [view, setView] = useState<"unified" | "split">("unified");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [activeHunk, setActiveHunk] = useState(0);
  const [showTree, setShowTree] = useState(true);
  const [singlePatch, setSinglePatch] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // R12: wrap long diff lines (persisted pref, shared across the app).
  const [diffWrap, setDiffWrap] = useState(() => getPrefs().diffWrap);
  useEffect(() => subscribePrefs(() => setDiffWrap(getPrefs().diffWrap)), []);
  const [baseOpen, setBaseOpen] = useState(false);
  const [baseQuery, setBaseQuery] = useState("");
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingG = useRef(false);

  const tree = useMemo(() => buildDiffTree(files), [files]);
  const visible = useMemo(() => flattenDiffTree(tree, collapsed), [tree, collapsed]);
  const totals = useMemo(() => diffTotals(files), [files]);
  const active = useMemo(
    () => files.find((f) => f.file === selectedFile) ?? files[0],
    [files, selectedFile],
  );
  const patch = active?.patch ?? "";
  const hunks = useMemo(() => hunkCount(patch), [patch]);
  const showImage = !!active && isImageFile(active.file);

  const branchList = useMemo(
    () => filterBranches(branches ?? [], baseQuery),
    [branches, baseQuery],
  );
  const branchGroups = useMemo(() => groupBranches(branchList), [branchList]);
  const hasBranches = (branches?.length ?? 0) > 0;
  const showBasePicker = (source === "branch" || source === "committed") && !!onSelectBase;
  const effectiveBase = baseRef ?? base?.name ?? null;

  const fileIndex = active ? files.findIndex((f) => f.file === active.file) : -1;
  const isReviewed = active ? reviewed.includes(active.file) : false;
  const treeVisible = showTree && !singlePatch;

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

  const cycleSource = () => {
    const index = DIFF_SOURCES.indexOf(source);
    onSelectSource(DIFF_SOURCES[(index + 1) % DIFF_SOURCES.length]!);
  };

  const rowHeight = () => {
    const el = scrollRef.current?.querySelector("[data-diff-kind]");
    return (el as HTMLElement | null)?.offsetHeight || 19;
  };

  const scrollByPx = (delta: number) => {
    scrollRef.current?.scrollBy({ top: delta });
  };

  const scrollPage = (unit: "page" | "half", direction: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = unit === "page" ? el.clientHeight * 0.9 : el.clientHeight / 2;
    el.scrollBy({ top: direction * amount });
  };

  const scrollEdge = (edge: "top" | "bottom") => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: edge === "top" ? 0 : el.scrollHeight });
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

  // Navigation keys. The dialog owns plain keys while it is up; modifier combos
  // stay with the browser/app except Ctrl+d / Ctrl+u (half-page, vim).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "d" || e.key === "u") {
          e.preventDefault();
          pendingG.current = false;
          scrollPage("half", e.key === "d" ? 1 : -1);
        }
        return;
      }
      if (e.altKey) return;
      if (e.key === "g") {
        e.preventDefault();
        if (pendingG.current) {
          pendingG.current = false;
          scrollEdge("top");
        } else {
          pendingG.current = true;
        }
        return;
      }
      pendingG.current = false;
      switch (e.key) {
        case "j":
          e.preventDefault();
          scrollByPx(rowHeight());
          break;
        case "k":
          e.preventDefault();
          scrollByPx(-rowHeight());
          break;
        case " ":
          e.preventDefault();
          scrollPage("page", e.shiftKey ? -1 : 1);
          break;
        case "PageDown":
          e.preventDefault();
          scrollPage("page", 1);
          break;
        case "PageUp":
          e.preventDefault();
          scrollPage("page", -1);
          break;
        case "]":
          e.preventDefault();
          scrollToHunk(activeHunk + 1);
          break;
        case "[":
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
        case "s":
          e.preventDefault();
          setSinglePatch((v) => !v);
          break;
        case "b":
          e.preventDefault();
          setShowTree((v) => !v);
          break;
        case "d":
          e.preventDefault();
          cycleSource();
          break;
        case "G":
          e.preventDefault();
          scrollEdge("bottom");
          break;
        case "?":
          e.preventDefault();
          setHelpOpen((v) => !v);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const label = showBasePicker
    ? `vs ${baseLabel(effectiveBase)}`
    : (base && (source === "branch" || source === "committed") ? base.name : null);

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
            <div className="relative ml-auto flex items-center gap-0.5">
              <button
                type="button"
                aria-label="Keyboard shortcuts"
                aria-expanded={helpOpen}
                data-oc-diff-help-toggle
                title="Shortcuts (?)"
                onClick={() => setHelpOpen((v) => !v)}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
              >
                <HelpCircle className="size-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
              >
                <X className="size-4" />
              </button>
              {helpOpen && (
                <DiffHelpPopover onClose={() => setHelpOpen(false)} />
              )}
            </div>
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

            {showBasePicker && (
              <div className="relative shrink-0">
                <button
                  type="button"
                  aria-expanded={baseOpen}
                  aria-label="Choose base branch"
                  data-oc-diff-base-toggle
                  title="Choose base branch"
                  onClick={() => {
                    setBaseQuery("");
                    setBaseOpen((v) => !v);
                  }}
                  className={cn(
                    "flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-2 py-0.5 font-mono text-[11px] transition-colors",
                    baseOpen
                      ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                      : "text-[var(--text-base)] hover:text-[var(--text-strong)]",
                  )}
                >
                  <GitBranch className="size-3" />
                  {label}
                </button>
                {baseOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-[55]"
                      onClick={() => setBaseOpen(false)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setBaseOpen(false);
                      }}
                    />
                    <div
                      data-oc-diff-base
                      className="absolute top-full left-0 z-[56] mt-1 w-72 overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] shadow-xl"
                    >
                      <div className="flex items-center gap-1.5 border-b border-[var(--border-weak-base)] px-2 py-1.5">
                        <Search className="size-3 shrink-0 text-[var(--text-weaker)]" />
                        <input
                          autoFocus
                          value={baseQuery}
                          onChange={(e) => setBaseQuery(e.target.value)}
                          placeholder="Search branches…"
                          className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--text-strong)] outline-none placeholder:text-[var(--text-weaker)]"
                        />
                      </div>
                      <div className="max-h-64 overflow-y-auto p-1">
                        <BranchItem
                          name={null}
                          active={!baseRef}
                          onPick={() => {
                            onSelectBase?.(null);
                            setBaseOpen(false);
                          }}
                        />
                        {!hasBranches ? (
                          <p className="px-2 py-1 text-[11px] text-[var(--text-weaker)]">
                            No branches reported.
                          </p>
                        ) : branchList.length === 0 ? (
                          <p className="px-2 py-1 text-[11px] text-[var(--text-weaker)]">
                            No match.
                          </p>
                        ) : (
                          <>
                            <BranchGroup label="Local" names={branchGroups.local} active={baseRef} onPick={(n) => { onSelectBase?.(n); setBaseOpen(false); }} />
                            <BranchGroup label="Remote" names={branchGroups.remote} active={baseRef} onPick={(n) => { onSelectBase?.(n); setBaseOpen(false); }} />
                          </>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-weaker)]">
              {diffSourceHint(source)}
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
                title="Previous hunk ([)"
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
                title="Next hunk (])"
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

            <div className="flex shrink-0 rounded-md border border-[var(--border-weak-base)] p-0.5">
              <button
                type="button"
                aria-pressed={showTree && !singlePatch}
                disabled={singlePatch}
                data-oc-diff-tree-toggle
                title="Toggle file tree (b)"
                onClick={() => setShowTree((v) => !v)}
                className={cn(
                  "flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed",
                  showTree && !singlePatch
                    ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                    : "text-[var(--text-weak)] hover:text-[var(--text-strong)]",
                )}
              >
                <PanelLeft className="size-3" />
                Tree
              </button>
              <button
                type="button"
                aria-pressed={singlePatch}
                data-oc-diff-single
                title="Single-patch (focus) mode (s)"
                onClick={() => setSinglePatch((v) => !v)}
                className={cn(
                  "flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                  singlePatch
                    ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                    : "text-[var(--text-weak)] hover:text-[var(--text-strong)]",
                )}
              >
                <Maximize2 className="size-3" />
                Single
              </button>
            </div>

            <div className="flex shrink-0 rounded-md border border-[var(--border-weak-base)] p-0.5">
              <button
                type="button"
                aria-pressed={diffWrap}
                data-oc-diff-wrap
                title="Wrap long lines"
                onClick={() => setPref("diffWrap", !diffWrap)}
                className={cn(
                  "flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors",
                  diffWrap
                    ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                    : "text-[var(--text-weak)] hover:text-[var(--text-strong)]",
                )}
              >
                <WrapText className="size-3" />
                Wrap
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
          {treeVisible && (
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
                      onContextMenu={(path, x, y) => setMenu({ path, x, y })}
                    />
                  ))
                )}
              </div>
            </aside>
          )}

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
              ) : showImage ? (
                <DiffImagePane
                  file={active.file}
                  status={active.status}
                  source={source}
                  location={location}
                />
              ) : !patch ? (
                <p className="p-4 text-xs text-[var(--text-weak)]">
                  No patch for {active.file} (binary or too large).
                </p>
              ) : (
                <DiffView diff={patch} view={view} activeHunk={activeHunk} className="py-1" wrap={diffWrap} />
              )}
            </div>
          </section>
        </div>

        {menu && active && (
          <FileContextMenu
            x={menu.x}
            y={menu.y}
            reviewed={reviewed.includes(menu.path)}
            onToggle={(value) => onToggleReviewed(menu.path, value)}
            onClose={() => setMenu(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BranchItem({
  name,
  active,
  onPick,
}: {
  name: string | null;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-[11px] transition-colors",
        active
          ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
          : "text-[var(--text-base)] hover:bg-[color:var(--surface-base-hover)]",
      )}
    >
      <GitBranch className="size-3 shrink-0 text-[var(--text-weaker)]" />
      <span className="truncate">{name ?? "auto (inferred base)"}</span>
      {active && <Check className="ml-auto size-3 shrink-0" />}
    </button>
  );
}

function BranchGroup({
  label,
  names,
  active,
  onPick,
}: {
  label: string;
  names: string[];
  active: string | null | undefined;
  onPick: (name: string) => void;
}) {
  if (names.length === 0) return null;
  return (
    <div className="mt-1">
      <p className="px-2 py-0.5 text-[10px] tracking-wide text-[var(--text-weaker)] uppercase">
        {label}
      </p>
      {names.map((name) => (
        <BranchItem
          key={name}
          name={name}
          active={active === name}
          onPick={() => onPick(name)}
        />
      ))}
    </div>
  );
}

function DiffHelpPopover({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ["j / k", "Scroll down / up"],
    ["Ctrl+d / Ctrl+u", "Half page down / up"],
    ["Space / Shift+Space", "Page down / up"],
    ["gg / G", "Top / bottom"],
    ["] / [", "Next / previous hunk"],
    ["n / p", "Next / previous file"],
    ["m", "Mark file reviewed"],
    ["s", "Single-patch (focus) mode"],
    ["b", "Toggle file tree"],
    ["d", "Switch diff source"],
    ["?", "Toggle this help"],
  ];
  return (
    <>
      <div className="fixed inset-0 z-[55]" onClick={onClose} />
      <div
        data-oc-diff-help
        className="absolute top-full right-0 z-[56] mt-1 w-72 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-2 shadow-xl"
      >
        <p className="mb-1.5 px-1 text-[11px] font-medium text-[var(--text-strong)]">
          Diff shortcuts
        </p>
        <dl className="space-y-1">
          {rows.map(([key, desc]) => (
            <div key={key} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 rounded border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-base)]">
                {key}
              </dt>
              <dd className="text-right text-[11px] text-[var(--text-weak)]">{desc}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

function FileContextMenu({
  x,
  y,
  reviewed,
  onToggle,
  onClose,
}: {
  x: number;
  y: number;
  reviewed: boolean;
  onToggle: (reviewed: boolean) => void;
  onClose: () => void;
}) {
  const item =
    "flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] text-[var(--text-base)] transition-colors hover:bg-[color:var(--surface-base-hover)]";
  return (
    <>
      <div
        className="fixed inset-0 z-[60]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        data-oc-diff-file-menu
        style={{ left: x, top: y }}
        className="fixed z-[61] min-w-40 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-1 shadow-xl"
      >
        <button
          type="button"
          className={item}
          onClick={() => {
            onToggle(true);
            onClose();
          }}
        >
          <Check className="size-3" />
          Mark complete
        </button>
        <button
          type="button"
          className={item}
          onClick={() => {
            onToggle(false);
            onClose();
          }}
        >
          Mark incomplete
        </button>
        <span className="mt-0.5 block px-2 text-[10px] text-[var(--text-weaker)]">
          {reviewed ? "Currently complete" : "Currently incomplete"}
        </span>
      </div>
    </>
  );
}

function DiffTreeRow({
  node,
  collapsed,
  selected,
  reviewed,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  node: DiffTreeNode;
  collapsed: boolean;
  selected: boolean;
  reviewed: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (path: string, x: number, y: number) => void;
}) {
  const isDir = node.type === "dir";
  const indent = 4 + node.depth * 12;
  return (
    <div
      role="button"
      tabIndex={0}
      data-oc-diff-file={isDir ? undefined : node.path}
      onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
      onContextMenu={(e) => {
        if (isDir) return;
        e.preventDefault();
        onContextMenu(node.path, e.clientX, e.clientY);
      }}
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
