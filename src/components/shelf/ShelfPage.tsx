import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Library,
  Loader2,
  Menu,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { openMobileSidebar } from "../../store";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import {
  fetchShelf,
  formatMtime,
  formatSize,
  isPreviewable,
  kindLabel,
  publicShelfUrl,
  shelfFileUrl,
  type ShelfEntry,
  type ShelfListResponse,
} from "./shelfApi";
import { ShelfPreview } from "./ShelfPreview";

function kindIcon(kind: ShelfEntry["kind"]) {
  const cls = "size-8";
  switch (kind) {
    case "dir":
      return <Folder className={cls} />;
    case "image":
      return <FileImage className={cls} />;
    case "video":
      return <FileVideo className={cls} />;
    case "audio":
      return <FileAudio className={cls} />;
    case "text":
      return <FileText className={cls} />;
    default:
      return <File className={cls} />;
  }
}

function ShelfCard({
  entry,
  onOpen,
}: {
  entry: ShelfEntry;
  onOpen: (entry: ShelfEntry) => void;
}) {
  const isDir = entry.kind === "dir";
  const isImage = entry.kind === "image";
  const meta = isDir
    ? `${entry.count ?? 0} item${entry.count === 1 ? "" : "s"}`
    : formatSize(entry.size);
  return (
    <button
      type="button"
      data-oc-shelf-item={entry.kind}
      onClick={() => onOpen(entry)}
      title={`${entry.path}${isDir ? "" : ` · ${meta}`}`}
      className="group flex w-full cursor-pointer flex-col overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] text-left transition-colors hover:border-[var(--border-selected)] hover:bg-[var(--surface-base-hover)]"
    >
      <span className="flex h-28 w-full items-center justify-center overflow-hidden bg-[var(--surface-raised-base)] text-[var(--text-weaker)]">
        {isImage ? (
          <img
            src={shelfFileUrl(entry.path)}
            alt={entry.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          kindIcon(entry.kind)
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <span className="truncate text-[13px] font-medium text-[var(--text-strong)]">{entry.name}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-weaker)]">
          <span className="truncate font-mono">
            {entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : kindLabel(entry.kind)}
          </span>
          <span className="ml-auto shrink-0 tabular-nums">{meta}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * The native file-shelf browse page, routed at `/shelf` (see App.tsx). Reads
 * the core proxy listing (`/api/shelf/list`) and serves bytes from the frozen
 * `/api/shelf/file/` prefix. Read-only — there is no upload path here.
 */
export function ShelfPage() {
  const [dir, setDir] = useState("");
  const [filter, setFilter] = useState("");
  const [searchAll, setSearchAll] = useState(false);
  const [data, setData] = useState<ShelfListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ShelfEntry | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const requestSeq = useRef(0);

  const runSearch = searchAll && filter.trim() !== "";
  // The request depends on the filter ONLY when a server-side search is active;
  // otherwise filtering is client-side and typing must not refetch the folder.
  const searchQuery = runSearch ? filter.trim() : "";

  useEffect(() => {
    const controller = new AbortController();
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    fetchShelf(
      searchQuery ? { q: searchQuery, signal: controller.signal } : { dir, signal: controller.signal },
    )
      .then((body) => {
        if (seq !== requestSeq.current) return;
        setData(body);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [dir, searchQuery, reloadTick]);

  const navigate = useCallback((nextDir: string) => {
    setDir(nextDir);
    setFilter("");
    setSearchAll(false);
    setPreview(null);
  }, []);

  const entries = useMemo(() => {
    const list = data?.entries ?? [];
    if (!filter.trim() || runSearch) return list;
    const needle = filter.trim().toLowerCase();
    return list.filter((e) => e.path.toLowerCase().includes(needle));
  }, [data, filter, runSearch]);

  function openEntry(entry: ShelfEntry) {
    if (entry.kind === "dir") {
      navigate(entry.path);
      return;
    }
    if (isPreviewable(entry.kind)) {
      setPreview(entry);
      return;
    }
    // Active types are never previewed inline — download them instead.
    window.open(shelfFileUrl(entry.path, { download: true }), "_blank", "noopener,noreferrer");
  }

  const crumbs = useMemo(() => {
    const parts = dir === "" ? [] : dir.split("/");
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
  }, [dir]);

  const totalCount = data?.count ?? 0;
  const publicItems = data?.publicItems ?? [];

  return (
    <div className="pane-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-[var(--border-base)] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openMobileSidebar}
            title="Open sessions"
            aria-label="Open sessions"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)] md:hidden"
          >
            <Menu className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => window.history.back()}
            title="Go back"
            className="hidden shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-1.5 py-0.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)] md:inline-flex"
          >
            <ArrowLeft className="size-3" />
            Back
          </button>
          <Library className="size-4 shrink-0 text-[var(--text-weaker)]" />
          <span className="truncate text-[var(--font-size-large)] font-medium text-[var(--text-strong)]">
            File shelf
          </span>
          {totalCount > 0 && (
            <span className="shrink-0 rounded-full border border-[var(--border-weak-base)] px-2 py-0.5 text-[11px] text-[var(--text-weaker)]">
              {totalCount} here
            </span>
          )}
          {publicItems.length > 0 && (
            <span
              className="hidden shrink-0 rounded-full border border-[var(--border-weak-base)] px-2 py-0.5 text-[11px] text-[var(--text-weaker)] sm:inline"
              title={data?.publicRoot ?? undefined}
            >
              {publicItems.length} public
            </span>
          )}
          <button
            type="button"
            onClick={() => setReloadTick((n) => n + 1)}
            title="Refresh"
            className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 font-mono text-[11px] text-[var(--text-weaker)]">
          <Folder className="size-3 shrink-0" />
          <button
            type="button"
            onClick={() => navigate("")}
            className="cursor-pointer truncate hover:text-[var(--text-strong)]"
            title={data?.root}
          >
            {data?.root ?? "…"}
          </button>
          {crumbs.map((crumb) => (
            <span key={crumb.path} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="size-3 shrink-0 opacity-60" />
              <button
                type="button"
                onClick={() => navigate(crumb.path)}
                className="cursor-pointer truncate hover:text-[var(--text-strong)]"
                title={crumb.path}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-base)] px-3 py-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--text-weaker)]" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            placeholder={runSearch ? "Search all files…" : "Filter this folder…"}
            className="h-7 pl-8 text-xs"
          />
          {filter !== "" && (
            <button
              type="button"
              onClick={() => setFilter("")}
              title="Clear filter"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 text-[var(--text-weaker)] hover:text-[var(--text-strong)]"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSearchAll((v) => !v)}
          aria-pressed={searchAll}
          title="Search the whole shelf, not just this folder"
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors",
            searchAll
              ? "border-[var(--border-selected)] bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
              : "border-[var(--border-weak-base)] text-[var(--text-weak)] hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]",
          )}
        >
          <Search className="size-3" />
          All files
        </button>
        {data?.truncated && (
          <span className="text-[11px] text-[var(--text-weaker)]">
            truncated at {data.maxEntries}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <div className="rounded-lg border border-dashed border-[var(--border-base)] p-6 text-center text-sm text-[var(--text-weaker)]">
            Could not read the shelf: {error}
          </div>
        ) : loading && !data ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--text-weaker)]">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            {runSearch && (
              <div className="mb-2 text-xs text-[var(--text-weaker)]">
                {entries.length} result{entries.length === 1 ? "" : "s"} for “{filter.trim()}”
              </div>
            )}
            {entries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border-base)] p-6 text-center text-sm text-[var(--text-weaker)]">
                {filter.trim()
                  ? "No files match the filter."
                  : "This folder is empty. Drop files into it and hit Refresh."}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2.5">
                {entries.map((entry) => (
                  <ShelfCard key={`${entry.kind}:${entry.path}`} entry={entry} onOpen={openEntry} />
                ))}
              </div>
            )}

            {publicItems.length > 0 && !runSearch && (
              <section className="mt-6">
                <div className="mb-2 flex items-baseline gap-2 text-xs font-medium text-[var(--text-weaker)]">
                  <span className="uppercase tracking-wide">Public — no login</span>
                  <span className="text-[11px] font-normal">anyone with the link can open these</span>
                </div>
                <div className="flex flex-col gap-1">
                  {publicItems.map((item) => (
                    <a
                      key={`pub:${item.path}`}
                      href={publicShelfUrl(data?.publicPrefix ?? "/shared", item.path)}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center gap-2 rounded-md border border-[var(--border-base)] px-2.5 py-1.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
                      title={publicShelfUrl(data?.publicPrefix ?? "/shared", item.path)}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">{item.path}</span>
                      <span className="shrink-0 rounded border border-[var(--border-weak-base)] px-1 text-[10px] uppercase">
                        public
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--text-weaker)]">{formatSize(item.size)}</span>
                      <span className="hidden shrink-0 tabular-nums text-[var(--text-weaker)] sm:inline">
                        {formatMtime(item.mtime)}
                      </span>
                      <Download className="size-3 shrink-0" />
                    </a>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      {preview && <ShelfPreview entry={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
