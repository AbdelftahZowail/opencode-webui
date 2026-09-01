import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderTree,
  Loader2,
} from "lucide-react";
import { api } from "../api/client";
import type { FsEntry } from "../api/client";
import { useStore } from "../store";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DiffView } from "./DiffView";

const normPath = (p: string) => p.replace(/\/+$/, "");
const leafName = (p: string) => normPath(p).split("/").filter(Boolean).pop() ?? p;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function sameFile(a: string, b: string) {
  const x = normPath(a.replace(/^\.\//, ""));
  const y = normPath(b.replace(/^\.\//, ""));
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return normPath(a.path).localeCompare(normPath(b.path));
  });
}

function fileIcon(name: string) {
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  const cls = "size-3.5 shrink-0 text-[var(--text-weaker)]";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "avif"].includes(ext)) return <FileImage className={cls} />;
  if (["json", "jsonc", "yaml", "yml", "toml"].includes(ext)) return <FileJson className={cls} />;
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z"].includes(ext)) return <FileArchive className={cls} />;
  if (["txt", "log", "csv", "tsv", "ini", "env", "conf", "lock", "gitignore"].includes(ext))
    return <FileText className={cls} />;
  if (
    [
      "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "py", "rb", "java", "c", "h", "hpp", "cc", "cpp",
      "css", "scss", "html", "vue", "svelte", "sh", "bash", "zsh", "sql", "graphql", "gql", "md", "mdx", "zig",
    ].includes(ext)
  )
    return <FileCode className={cls} />;
  return <File className={cls} />;
}

interface TreeNode {
  expanded: boolean;
  loading: boolean;
  children?: FsEntry[];
  error?: string;
}

interface TreeRowProps {
  entry: FsEntry;
  depth: number;
  nodes: Record<string, TreeNode>;
  selectedPath: string | null;
  onToggle: (entry: FsEntry) => void;
  onOpen: (entry: FsEntry) => void;
}

function TreeRow({ entry, depth, nodes, selectedPath, onToggle, onOpen }: TreeRowProps) {
  const isDir = entry.type === "directory";
  const key = normPath(entry.path);
  const node = nodes[key];
  const name = leafName(entry.path);
  const selected = selectedPath === key;
  const indent = 6 + depth * 13;
  const act = () => (isDir ? onToggle(entry) : onOpen(entry));
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={act}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            act();
          }
        }}
        className={cn(
          "flex cursor-pointer items-center gap-1 rounded-sm py-[3px] pr-2",
          selected
            ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
            : "text-[var(--text-base)] hover:bg-[var(--surface-base-hover)]",
        )}
        style={{ paddingLeft: indent }}
      >
        {isDir ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-[var(--text-weaker)] transition-transform",
              node?.expanded && "rotate-90",
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {isDir ? (
          <Folder
            className={cn(
              "size-3.5 shrink-0",
              node?.expanded ? "text-[var(--text-interactive-base)]" : "text-[var(--text-weak)]",
            )}
          />
        ) : (
          fileIcon(name)
        )}
        <span className={cn("truncate font-mono text-xs", isDir ? "text-[var(--text-strong)]" : "text-[var(--text-base)]")}>
          {name}
        </span>
        {node?.loading && <Loader2 className="ml-auto size-3 shrink-0 animate-spin text-[var(--text-weaker)]" />}
        {node?.error && <span className="ml-auto shrink-0 text-[10px] text-[var(--text-on-critical-base)]">!</span>}
      </div>
      {isDir && node?.expanded && (
        <div>
          {node.loading ? (
            <div className="space-y-1.5 py-1" style={{ paddingLeft: indent + 13 }}>
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : node.error ? (
            <div className="py-1 text-[11px] text-[var(--text-on-critical-base)]" style={{ paddingLeft: indent + 13 }}>
              {node.error}
            </div>
          ) : node.children && node.children.length === 0 ? (
            <div className="py-0.5 text-[11px] italic text-[var(--text-weaker)]" style={{ paddingLeft: indent + 13 }}>
              empty
            </div>
          ) : (
            node.children?.map((child) => (
              <TreeRow
                key={normPath(child.path)}
                entry={child}
                depth={depth + 1}
                nodes={nodes}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ChangeBadge({ count, error }: { count: number | null; error: string | null }) {
  if (error) {
    return (
      <Badge variant="outline" title={error} className="border-border/50 text-[var(--text-weaker)]">
        vcs n/a
      </Badge>
    );
  }
  if (count === null) return null;
  if (count === 0) {
    return <Badge className="border-transparent bg-[var(--surface-success-base)] text-[var(--text-on-success-base)]">clean</Badge>;
  }
  return (
    <Badge className="border-transparent bg-[var(--surface-critical-base)] text-[var(--text-on-critical-base)]">
      {count} changed
    </Badge>
  );
}

export function FileExplorer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sessionLocation = useStore(
    (s) => s.sessions.find((x) => x.id === s.currentSessionID)?.location?.directory,
  );
  const [locationDir, setLocationDir] = useState<string | null>(null);
  const [rootEntries, setRootEntries] = useState<FsEntry[] | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({});
  const [selected, setSelected] = useState<FsEntry | null>(null);
  const [preview, setPreview] = useState<{ content?: string; error?: string; loading: boolean }>({ loading: false });
  const [diff, setDiff] = useState<{ patch?: string; error?: string; loading: boolean }>({ loading: false });
  const [changedCount, setChangedCount] = useState<number | null>(null);
  const [vcsError, setVcsError] = useState<string | null>(null);
  const selectedRef = useRef<FsEntry | null>(null);
  const loadedDirRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = (dir: string) => {
      if (cancelled) return;
      if (loadedDirRef.current !== dir) {
        loadedDirRef.current = dir;
        setRootEntries(null);
        setRootError(null);
        setNodes({});
        setChangedCount(null);
        setVcsError(null);
        setSelected(null);
        selectedRef.current = null;
      }
      setLocationDir(dir);
      void api
        .fsList({ location: dir })
        .then((res) => {
          if (!cancelled) {
            setRootEntries(res.data);
            setRootError(null);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setRootError(errMsg(e));
        });
      void api
        .vcsStatus({ directory: dir })
        .then((res) => {
          if (!cancelled) setChangedCount(res.data.length);
        })
        .catch((e: unknown) => {
          if (!cancelled) setVcsError(errMsg(e));
        });
    };
    if (sessionLocation) {
      load(sessionLocation);
    } else {
      void api
        .location()
        .then((loc) => {
          if (!cancelled) load(loc.directory);
        })
        .catch((e: unknown) => {
          if (!cancelled) setRootError(errMsg(e));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, sessionLocation]);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      selectedRef.current = null;
      setPreview({ loading: false });
      setDiff({ loading: false });
    }
  }, [open]);

  const toggle = (entry: FsEntry) => {
    const key = normPath(entry.path);
    const existing = nodes[key];
    if (existing?.expanded) {
      setNodes((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    setNodes((prev) => ({
      ...prev,
      [key]: { expanded: true, loading: !prev[key]?.children, children: prev[key]?.children },
    }));
    if (!existing?.children) {
      void api
        .fsList({ location: locationDir ?? undefined, path: key })
        .then((res) =>
          setNodes((prev) =>
            prev[key] ? { ...prev, [key]: { ...prev[key], children: res.data, loading: false } } : prev,
          ),
        )
        .catch((e: unknown) =>
          setNodes((prev) =>
            prev[key] ? { ...prev, [key]: { ...prev[key], error: errMsg(e), loading: false } } : prev,
          ),
        );
    }
  };

  const openFile = (entry: FsEntry) => {
    selectedRef.current = entry;
    setSelected(entry);
    setPreview({ loading: true });
    setDiff({ loading: true });
    void api
      .fsRead(entry.path, locationDir ?? undefined)
      .then((content) => {
        if (selectedRef.current?.path !== entry.path) return;
        setPreview({ content, loading: false });
      })
      .catch((e: unknown) => {
        if (selectedRef.current?.path !== entry.path) return;
        setPreview({ error: errMsg(e), loading: false });
      });
    // vcs/base infers the review base (branch creation history); pass its ref
    // to the diff so ambiguous Git history doesn't 400. Null ⇒ engine default.
    void api
      .vcsBase(locationDir ? { directory: locationDir } : undefined)
      .then((r) => r.data)
      .catch(() => null)
      .then((base) =>
        api.vcsDiff(
          "working",
          locationDir ? { directory: locationDir } : undefined,
          3,
          base?.ref ?? null,
        ),
      )
      .then((res) => {
        if (selectedRef.current?.path !== entry.path) return;
        const hit = res.data.find((d) => sameFile(d.file, entry.path));
        setDiff({ patch: hit?.patch, loading: false });
      })
      .catch((e: unknown) => {
        if (selectedRef.current?.path !== entry.path) return;
        setDiff({ error: errMsg(e), loading: false });
      });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[min(44rem,calc(100vw-0.5rem))]! gap-0 p-0 sm:max-w-[44rem]!"
      >
        <SheetHeader className="border-b border-border px-4 py-3 pr-12">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <FolderTree className="size-4 text-[var(--text-weak)]" />
            Files
            <ChangeBadge count={changedCount} error={vcsError} />
          </SheetTitle>
          {locationDir && (
            <SheetDescription className="truncate font-mono text-[11px] text-[var(--text-weaker)]">
              {locationDir}
            </SheetDescription>
          )}
        </SheetHeader>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[40%] min-w-56 shrink-0 flex-col border-r border-border">
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-1.5">
                {rootError ? (
                  <div className="px-2 py-3 text-xs text-[var(--text-on-critical-base)]">{rootError}</div>
                ) : rootEntries === null ? (
                  <div className="space-y-1.5 p-1">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-4 w-full" />
                    ))}
                  </div>
                ) : rootEntries.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-[var(--text-weak)]">Empty directory</div>
                ) : (
                  sortEntries(rootEntries).map((entry) => (
                    <TreeRow
                      key={normPath(entry.path)}
                      entry={entry}
                      depth={0}
                      nodes={nodes}
                      selectedPath={selected ? normPath(selected.path) : null}
                      onToggle={toggle}
                      onOpen={openFile}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <Tabs defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-[var(--text-weak)]">{selected.path}</span>
                  <TabsList variant="line" className="h-6 shrink-0">
                    <TabsTrigger value="preview" className="text-xs">
                      Preview
                    </TabsTrigger>
                    <TabsTrigger value="diff" className="text-xs">
                      Diff
                    </TabsTrigger>
                  </TabsList>
                </div>
                <TabsContent value="preview" className="flex min-h-0 flex-1 flex-col">
                  {preview.loading ? (
                    <div className="space-y-1.5 p-3">
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-3 w-5/6" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  ) : preview.error ? (
                    <div className="p-4 text-xs text-[var(--text-on-critical-base)]">{preview.error}</div>
                  ) : (
                    <ScrollArea className="min-h-0 flex-1">
                      <pre className="p-3 font-mono text-xs leading-[1.6] whitespace-pre text-[var(--text-base)]">
                        {preview.content ?? ""}
                      </pre>
                    </ScrollArea>
                  )}
                </TabsContent>
                <TabsContent value="diff" className="flex min-h-0 flex-1 flex-col">
                  {diff.loading ? (
                    <div className="space-y-1.5 p-3">
                      <Skeleton className="h-3 w-11/12" />
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-3 w-5/6" />
                    </div>
                  ) : diff.error ? (
                    <div className="p-4 text-xs text-[var(--text-on-critical-base)]">Diff unavailable: {diff.error}</div>
                  ) : diff.patch ? (
                    <ScrollArea className="min-h-0 flex-1">
                      <DiffView diff={diff.patch} className="p-3" />
                    </ScrollArea>
                  ) : (
                    <div className="p-4 text-xs text-[var(--text-weak)]">No uncommitted changes for this file.</div>
                  )}
                </TabsContent>
              </Tabs>
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 text-xs text-[var(--text-weak)]">
                Select a file to preview
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
