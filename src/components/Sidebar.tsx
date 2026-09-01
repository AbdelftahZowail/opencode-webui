import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import {
  ChevronDown,
  FolderTree,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import {
  DRAFT_SESSION_ID,
  NEW_SESSION_HREF,
  loadMoreSessions,
  prefetchSession,
  refreshSessions,
  selectSession,
  sessionHref,
  setHighlightMessage,
  setPendingWorkspace,
  startDraftSession,
  useStore,
} from "../store";
import { api } from "../api/client";
import type { SessionInfo } from "../api/types";
import { searchContent, type ContentHits, type MessageHit } from "../lib/searchIndex";
import { SEARCH_KBD, IS_MAC } from "../lib/platform";
import { Slot, getPages, getContextMenus, subscribeRegistry } from "../extensions/registry";
import { timeAgo } from "./ui";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileExplorer } from "./FileExplorer";
import { SettingsDialog, openSettings } from "./settings/SettingsDialog";

const SECTION_LIMIT = 3;
const CONTENT_GROUP_LIMIT = 20;
/** Content/server search kicks in from this query length. */
const SEARCH_DEBOUNCE_MIN_LENGTH = 2;
/**
 * Fired after an in-app pushState to an extension page route so App's
 * pathname listener repaints (pushState alone fires no event). Mirrors
 * EXT_NAVIGATE_EVENT in App.tsx.
 */
const EXT_NAVIGATE_EVENT = "webui:navigate";
const SIDEBAR_DEFAULT_WIDTH = 288;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_COLLAPSED_WIDTH = 56;

// Registry tick for context menus — useSyncExternalStore pattern (no exported version).
// Single registry subscription fans out, so one bump increments exactly once.
let _sidebarExtVersion = 0;
const _sidebarExtListeners = new Set<() => void>();
let _sidebarExtSubscribed = false;
function ensureSidebarExtSubscribed() {
  if (_sidebarExtSubscribed) return;
  _sidebarExtSubscribed = true;
  subscribeRegistry(() => {
    _sidebarExtVersion++;
    for (const cb of _sidebarExtListeners) cb();
  });
}
function subscribeSidebarExt(cb: () => void) {
  ensureSidebarExtSubscribed();
  _sidebarExtListeners.add(cb);
  return () => _sidebarExtListeners.delete(cb);
}
function getSidebarExtSnapshot() {
  return _sidebarExtVersion;
}
function getSidebarExtServerSnapshot() {
  return 0;
}
function useSidebarExtVersion(): number {
  return useSyncExternalStore(subscribeSidebarExt, getSidebarExtSnapshot, getSidebarExtServerSnapshot);
}

function SessionContextMenu({ sessionID, children }: { sessionID: string; children: ReactNode }) {
  const version = useSidebarExtVersion();
  const menus = useMemo(() => getContextMenus("session"), [version]);
  if (menus.length === 0) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-36">
        {menus.map((item) => (
          <ContextMenuItem
            key={item.id}
            onSelect={() => {
              try {
                item.run({ sessionID });
              } catch (err) {
                console.error(`[extensions] contextMenu "${item.id}" crashed:`, err);
              }
            }}
          >
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function isHomeDir(dir: string): boolean {
  return /^\/home\/[^/]+$/.test(dir) || /^\/Users\/[^/]+$/.test(dir);
}

function findHome(dirs: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const d of dirs) {
    if (!d) continue;
    const t = d.replace(/\/+$/, "");
    if (isHomeDir(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [dir, n] of counts) {
    if (n > bestN) {
      best = dir;
      bestN = n;
    }
  }
  return best;
}

function workspaceName(directory: string | undefined, home?: string): string {
  if (!directory) return "Other";
  const trimmed = directory.replace(/\/+$/, "");
  if (home && isHomeDir(home) && trimmed === home) return "~";
  if (home && isHomeDir(home) && trimmed.startsWith(home + "/")) {
    return "~/" + trimmed.slice(home.length + 1);
  }
  return trimmed;
}

/** Directory equality that tolerates trailing slashes. */
function sameDirectory(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const sessionsCursor = useStore((s) => s.sessionsCursor);
  const activeIDs = useStore((s) => s.activeIDs);
  const current = useStore((s) => s.currentSessionID);
  const connected = useStore((s) => s.connected);
  const pending = useStore((s) => s.pendingWorkspace);
  const running = useStore((s) => s.running);
  const queued = useStore((s) => s.queued);
  const [query, setQuery] = useState("");
  // Layer B (server title search) + layer C (message content search).
  const [serverHits, setServerHits] = useState<SessionInfo[]>([]);
  const [contentHits, setContentHits] = useState<ContentHits>(new Map());
  const [contentSearching, setContentSearching] = useState(false);
  const [collapsedHits, setCollapsedHits] = useState<Set<string>>(new Set());
  const sidebarRef = useRef<HTMLElement>(null);
  const [showMore, setShowMore] = useState<Record<string, boolean>>({});
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const explorerSignal = useStore((s) => s.uiSignals.explorer);

  // /diff (and any other surface) can request the file explorer open.
  useEffect(() => {
    if (explorerSignal) setFilesOpen(true);
  }, [explorerSignal]);

  const home = useMemo(() => findHome(sessions.map((s) => s.location?.directory)), [sessions]);

  /** Running or queued both read as live here — visibility and markers. */
  const isLive = (id: string) => !!running[id] || !!queued[id];

  // Parents with a currently running/queued subagent child, for the row
  // marker. Children aren't listed top-level but stay present in `sessions`.
  const subagentActiveParents = useMemo(() => {
    const parents = new Set<string>();
    for (const s of sessions) {
      if (s.parentID && isLive(s.id)) parents.add(s.parentID);
    }
    return parents;
  }, [sessions, running, queued]);

  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();

  // Layer B: server-side title search, debounced 250ms once the query is
  // >= 2 chars — catches sessions beyond the currently loaded pages.
  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setServerHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .listSessions({ search: trimmedQuery, limit: 100 })
        .then((res) => {
          if (!cancelled) setServerHits(res.data.filter((s) => !s.parentID));
        })
        .catch(() => {
          if (!cancelled) setServerHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery]);

  // Layer C: message content search over the known sessions, debounced
  // 250ms. Reports partial matches while fetch batches land.
  useEffect(() => {
    if (trimmedQuery.length < 2) {
      setContentHits(new Map());
      setContentSearching(false);
      return;
    }
    let cancelled = false;
    setContentSearching(true);
    const timer = setTimeout(() => {
      searchContent(trimmedQuery, sessions, (partial) => {
        if (!cancelled) setContentHits(new Map(partial));
      })
        .catch(() => new Map<string, MessageHit[]>())
        .then((matches) => {
          if (!cancelled) {
            setContentHits(new Map(matches));
            setContentSearching(false);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedQuery, sessions]);

  // Pending-workspace highlight yields to any click outside the sidebar.
  useEffect(() => {
    if (!pending) return;
    const onDocMouseDown = (event: globalThis.MouseEvent) => {
      if (sidebarRef.current && !sidebarRef.current.contains(event.target as Node)) {
        setPendingWorkspace(null);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () => document.removeEventListener("mousedown", onDocMouseDown, true);
  }, [pending]);

  const groups = useMemo(() => {
    const buckets = new Map<string, typeof sessions>();
    const seen = new Set<string>();
    for (const s of sessions) {
      // Subagent (child) sessions are managed inside their parent session,
      // never listed or counted as top-level workspace entries.
      if (s.parentID) continue;
      if (
        normalizedQuery &&
        !(s.title ?? "Untitled session").toLowerCase().includes(normalizedQuery) &&
        !workspaceName(s.location?.directory, home).toLowerCase().includes(normalizedQuery) &&
        !(s.location?.directory ?? "").toLowerCase().includes(normalizedQuery)
      ) {
        continue;
      }
      seen.add(s.id);
      const key = workspaceName(s.location?.directory, home);
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }
    // Server hits (layer B): merge in sessions the local list doesn't hold,
    // grouped under their own workspace like loaded ones.
    for (const s of serverHits) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const key = workspaceName(s.location?.directory, home);
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }
    const isRunningId = (id: string) => !!(running[id] || activeIDs.includes(id));
    const sorted = [...buckets.entries()].map(([name, list]) => ({
      name,
      list: [...list].sort((a, b) => {
        const ar = isRunningId(a.id);
        const br = isRunningId(b.id);
        if (ar !== br) return Number(br) - Number(ar);
        return b.time.updated - a.time.updated;
      }),
    }));
    // Running workspaces bubble above idle ones, preserving insertion order within each partition.
    sorted.sort((a, b) => {
      const ar = buckets.get(a.name)?.some((s) => isRunningId(s.id)) ?? false;
      const br = buckets.get(b.name)?.some((s) => isRunningId(s.id)) ?? false;
      if (ar !== br) return Number(br) - Number(ar);
      return 0;
    });
    return sorted;
  }, [sessions, serverHits, normalizedQuery, home, running, activeIDs]);

  // Real computation: every known session with a content hit that isn't
  // already visible in a title/workspace/server group.
  const contentOnly = useMemo(() => {
    if (!normalizedQuery || contentHits.size === 0) return [] as SessionInfo[];
    const listed = new Set(groups.flatMap((g) => g.list.map((s) => s.id)));
    const byID = new Map(sessions.map((s) => [s.id, s]));
    const out: SessionInfo[] = [];
    for (const id of contentHits.keys()) {
      if (listed.has(id)) continue;
      const s = byID.get(id);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.time.updated - a.time.updated).slice(0, CONTENT_GROUP_LIMIT);
  }, [sessions, groups, contentHits, normalizedQuery]);

  /** Total sessions currently surfaced across all search layers. */
  const matchedCount =
    groups.reduce((n, g) => n + g.list.length, 0) + contentOnly.length;

  const toggleHitCollapse = (id: string) => {
    setCollapsedHits((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleHitClick = (sessionID: string, messageID: string) => {
    setHighlightMessage(sessionID, messageID);
    void selectSession(sessionID);
  };

  const hasMore = sessionsCursor != null;

  const toggleWorkspace = (name: string) => {
    const nextCollapsed = !collapsedWorkspaces[name];
    setCollapsedWorkspaces((prev) => ({ ...prev, [name]: nextCollapsed }));
    if (nextCollapsed) setShowMore((prev) => ({ ...prev, [name]: false }));
  };

  /**
   * Workspace header click: mark this workspace as the next new session's
   * target (highlight). With a draft already open, also retarget it so its
   * composer subtitle follows the highlight immediately.
   */
  const selectPendingWorkspace = (directory: string | undefined) => {
    const dir = directory ?? null;
    setPendingWorkspace(dir);
    if (current === DRAFT_SESSION_ID) startDraftSession(dir);
  };

  const toggleShowMore = (name: string) =>
    setShowMore((prev) => ({ ...prev, [name]: !prev[name] }));

  const resizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, event.clientX)));
  };

  const resizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
  };

  const toggleSidebar = () => setSidebarCollapsed((prev) => !prev);

  return (
    <aside
      ref={sidebarRef}
      className={`relative flex min-w-0 shrink-0 flex-col overflow-hidden border-r border-border bg-background ${resizing ? "select-none" : ""}`}
      style={{ width: sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth }}
    >
      <div
        className={`border-b border-border ${
          sidebarCollapsed ? "flex flex-col items-center gap-2 px-2 py-2.5" : "flex items-center justify-between gap-2 px-3 py-2.5"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              connected ? "bg-[var(--surface-success-strong)]" : "bg-[var(--surface-warning-strong)]"
            }`}
          />
          {sidebarCollapsed ? (
            <span className="font-mono text-xs font-semibold text-foreground" title="OpenCode">OC</span>
          ) : (
            <span className="truncate text-sm font-semibold text-foreground">OpenCode</span>
          )}
        </div>
        {sidebarCollapsed ? (
          <>
            <NewSessionLink collapsed />
            <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Expand sidebar">
              <PanelLeftOpen />
            </Button>
          </>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Collapse sidebar">
              <PanelLeftClose />
            </Button>
            <NewSessionLink />
          </div>
        )}
      </div>

      {sidebarCollapsed ? (
        <CollapsedSidebar groups={groups} current={current} activeIDs={activeIDs} onExpand={toggleSidebar} />
      ) : (
        <>
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="session-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions"
                className={`h-7 pl-7 ${IS_MAC ? "pr-8" : "pr-12"}`}
              />
              <kbd
                aria-hidden
                title={`Focus session search (${IS_MAC ? "Cmd+F" : "Ctrl+F"})`}
                className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-1 py-px font-mono text-[9px] leading-[1.4] text-[var(--text-weaker)]"
              >
                {SEARCH_KBD}
              </kbd>
            </div>
            {trimmedQuery.length >= SEARCH_DEBOUNCE_MIN_LENGTH && (
              <p className="mt-1 px-1 text-[10px] text-[var(--text-weaker)]" aria-live="polite">
                {matchedCount} matched
                {contentSearching ? " · searching messages…" : ""}
              </p>
            )}
          </div>

          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="w-full min-w-0 max-w-full p-2">
              {contentOnly.length > 0 && (
                <section className="mb-4 w-full min-w-0 max-w-full last:mb-1">
                  <div className="mb-1 flex min-w-0 items-center gap-2 border-b border-[var(--border-weak-base)] px-2 py-1.5">
                    <span className="min-w-0 truncate text-[11px] font-medium tracking-wide text-[var(--text-weaker)] uppercase">
                      Content matches
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{contentOnly.length}</span>
                  </div>
                  {contentOnly.map((s) => {
                    const hits = contentHits.get(s.id) ?? [];
                    const collapsed = collapsedHits.has(s.id);
                    return (
                      <div key={s.id} className="mb-1">
                        <SessionRow
                          id={s.id}
                          title={s.title ?? "Untitled session"}
                          updated={s.time.updated}
                          active={activeIDs.includes(s.id)}
                          selected={s.id === current}
                          subagentsActive={subagentActiveParents.has(s.id)}
                          onSelect={() => void selectSession(s.id)}
                        />
                        {hits.length > 0 && (
                          <div className="ml-2 border-l border-[var(--border-weak-base)] pl-2">
                            <button
                              type="button"
                              onClick={() => toggleHitCollapse(s.id)}
                              className="mb-1 flex w-full cursor-pointer items-center gap-1 text-[10px] text-[var(--text-weaker)] hover:text-[var(--text-weak)]"
                            >
                              <ChevronDown className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                              {hits.length} {hits.length === 1 ? "message" : "messages"} match{hits.length === 1 ? "" : "es"}
                            </button>
                            {!collapsed && (
                              <div className="flex flex-col gap-1 pb-1">
                                {hits.slice(0, 5).map((h: MessageHit) => (
                                  <button
                                    key={h.messageID}
                                    type="button"
                                    onClick={() => handleHitClick(s.id, h.messageID)}
                                    className="cursor-pointer rounded-md bg-[var(--surface-inset-base)] px-2 py-1 text-left text-xs leading-relaxed text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
                                    title="Open session and scroll to message"
                                  >
                                    <span className="line-clamp-2">
                                      {h.snippet.slice(0, h.matchStart)}
                                      <mark className="rounded-sm bg-yellow-500/30 px-0.5 font-medium text-[var(--text-strong)]">
                                        {h.snippet.slice(h.matchStart, h.matchEnd)}
                                      </mark>
                                      {h.snippet.slice(h.matchEnd)}
                                    </span>
                                  </button>
                                ))}
                                {hits.length > 5 && (
                                  <span className="px-2 text-[10px] text-[var(--text-weaker)]">+{hits.length - 5} more in this session</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}
              {groups.length === 0 && contentOnly.length === 0 && (
                <p className="px-2.5 py-4 text-xs text-[var(--text-weak)]">
                  {sessions.length === 0 ? "No sessions yet." : "No matches."}
                </p>
              )}
              {groups.map((group) => {
                const isCollapsed = !!collapsedWorkspaces[group.name];
                const isShowingMore = !!showMore[group.name];
                // Default visibility: the newest SECTION_LIMIT sessions PLUS
                // every running/queued one not already among them — live work
                // is never buried behind "Show more".
                const visible = isCollapsed
                  ? []
                  : isShowingMore
                    ? group.list
                    : group.list.filter((s, i) => i < SECTION_LIMIT || isLive(s.id));
                const moreCount = group.list.length - visible.length;
                // The highlight keys off the real directory, not its display
                // name ("~/code" vs "/home/z/code"); "Other" (no directory)
                // can never be a pending target.
                const directory = group.list.find((s) => s.location?.directory)?.location?.directory ?? null;
                const isPending = !!pending && !!directory && sameDirectory(pending, directory);
                return (
                  <section key={group.name} className="mb-4 w-full min-w-0 max-w-full last:mb-1">
                    <div
                      onClick={() =>
                        // Whole header targets this workspace for new
                        // sessions (highlight); clicking again while already
                        // highlighted toggles the group instead.
                        isPending ? toggleWorkspace(group.name) : selectPendingWorkspace(directory ?? undefined)
                      }
                      aria-pressed={isPending}
                      title={isPending ? "Collapse / expand workspace" : "New session here"}
                      className={`mb-1 flex min-w-0 cursor-pointer select-none items-center gap-2 border-b px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide transition-colors ${
                        isPending ? "ring-1 ring-inset ring-[var(--border-selected)] bg-[var(--surface-raised-base)]" : ""
                      } ${isPending ? "" : "border-[var(--border-weak-base)]"}`}
                    >
                      <span className={`min-w-0 truncate ${isPending ? "text-[var(--text-weak)]" : "text-[var(--text-weaker)]"}`}>{group.name}</span>
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        aria-label={isCollapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleWorkspace(group.name);
                        }}
                        title={isCollapsed ? "Expand workspace" : "Collapse workspace"}
                        className="ml-auto inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-0.5 hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-weak)]"
                      >
                        <ChevronDown className={`size-3 shrink-0 text-[var(--text-weaker)] transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                      </button>
                      {isPending && (
                        <span
                          className="shrink-0 cursor-pointer text-[var(--text-weaker)] hover:text-foreground"
                          title="New session here"
                          onClick={(event) => {
                            event.stopPropagation();
                            startDraftSession(directory);
                          }}
                        >
                          <Plus className="size-3.5" />
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{group.list.length}</span>
                    </div>
                    {visible.map((s) => {
                      const active = activeIDs.includes(s.id);
                      const hits = contentHits.get(s.id) ?? [];
                      const collapsed = collapsedHits.has(s.id);
                      const showHits = hits.length > 0 && trimmedQuery.length >= SEARCH_DEBOUNCE_MIN_LENGTH;
                      return (
                        <div key={s.id} className="mb-0.5">
                          <SessionRow
                            id={s.id}
                            title={s.title ?? "Untitled session"}
                            updated={s.time.updated}
                            active={active}
                            selected={s.id === current}
                            subagentsActive={subagentActiveParents.has(s.id)}
                            onSelect={() => void selectSession(s.id)}
                          />
                          {showHits && (
                            <div className="ml-2 border-l border-[var(--border-weak-base)] pl-2">
                              <button
                                type="button"
                                onClick={() => toggleHitCollapse(s.id)}
                                className="mb-1 flex w-full cursor-pointer items-center gap-1 text-[10px] text-[var(--text-weaker)] hover:text-[var(--text-weak)]"
                              >
                                <ChevronDown className={`size-3 shrink-0 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
                                {hits.length} {hits.length === 1 ? "message" : "messages"} match{hits.length === 1 ? "" : "es"}
                              </button>
                              {!collapsed && (
                                <div className="flex flex-col gap-1 pb-1">
                                  {hits.slice(0, 5).map((h: MessageHit) => (
                                    <button
                                      key={h.messageID}
                                      type="button"
                                      onClick={() => handleHitClick(s.id, h.messageID)}
                                      className="cursor-pointer rounded-md bg-[var(--surface-inset-base)] px-2 py-1 text-left text-xs leading-relaxed text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
                                      title="Open session and scroll to message"
                                    >
                                      <span className="line-clamp-2">
                                        {h.snippet.slice(0, h.matchStart)}
                                        <mark className="rounded-sm bg-yellow-500/30 px-0.5 font-medium text-[var(--text-strong)]">
                                          {h.snippet.slice(h.matchStart, h.matchEnd)}
                                        </mark>
                                        {h.snippet.slice(h.matchEnd)}
                                      </span>
                                    </button>
                                  ))}
                                  {hits.length > 5 && (
                                    <span className="px-2 text-[10px] text-[var(--text-weaker)]">+{hits.length - 5} more in this session</span>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {!isCollapsed && moreCount > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleShowMore(group.name)}
                        className="mt-1 w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-xs text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-weak)]"
                      >
                        {isShowingMore ? "Show less" : `Show ${moreCount} more…`}
                      </button>
                    )}
                  </section>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMoreSessions()}
                  className="w-full cursor-pointer rounded-md px-2.5 py-2 text-center text-xs text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-weak)]"
                >
                  Load more sessions
                </button>
              )}
            </div>
          </ScrollArea>

          <SidebarFooter onFiles={() => setFilesOpen(true)} />
        </>
      )}

      {sidebarCollapsed && (
        <div className="flex flex-col items-center gap-1 border-t border-border p-2">
          <button type="button" onClick={() => setFilesOpen(true)} className="inline-flex cursor-pointer rounded-md p-1.5 text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground" title="Files">
            <FolderTree className="size-4" />
          </button>
          <button type="button" onClick={() => openSettings()} className="inline-flex cursor-pointer rounded-md p-1.5 text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground" title="Settings">
            <SettingsIcon className="size-4" />
          </button>
        </div>
      )}
      <Slot region="sidebar" />
      <FileExplorer open={filesOpen} onOpenChange={setFilesOpen} />
      <SettingsDialog />
      {!sidebarCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={resizeStart}
          onPointerMove={resize}
          onPointerUp={resizeEnd}
          onPointerCancel={resizeEnd}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const delta = event.key === "ArrowRight" ? 16 : -16;
            setSidebarWidth((width) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width + delta)));
          }}
          className="absolute top-0 right-0 z-20 h-full w-1 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-[var(--border-hover)] focus:bg-[var(--border-selected)] focus:outline-none"
        />
      )}
    </aside>
  );
}

type SessionGroup = { name: string; list: SessionInfo[] };

/** One-shot fetch of the proxy's app version (`GET /api/webui/config`),
 * rendered as a muted `v1.0.4` next to the connection dot in the header. */
function WebUIVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/webui/config")
      .then((r) => (r.ok ? (r.json() as Promise<{ version?: string }>) : null))
      .then((cfg) => {
        if (!cancelled && cfg?.version) setVersion(cfg.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!version) return null;
  return (
    <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]" title={`webui v${version}`}>
      v{version}
    </span>
  );
}

/**
 * Instant, offline draft open — no network, so no busy gate. Keeps the
 * /new-session anchor so middle-click/modified clicks still work natively.
 */
function NewSessionLink({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <Button asChild variant="default" size={collapsed ? "icon" : "sm"}>
      <a
        href={NEW_SESSION_HREF}
        aria-label="New session"
        title={collapsed ? "New session" : undefined}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          startDraftSession(null);
        }}
      >
        <Plus />
        {!collapsed && <span className="truncate">New session</span>}
      </a>
    </Button>
  );
}

function CollapsedSidebar({
  groups,
  current,
  activeIDs,
  onExpand,
}: {
  groups: SessionGroup[];
  current: string | null;
  activeIDs: string[];
  onExpand: () => void;
}) {
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <div className="flex w-full min-w-0 flex-col items-center gap-3 p-2">
        {groups.map((group) => (
          <section key={group.name} className="flex w-full flex-col items-center gap-1.5 border-b border-[var(--border-weak-base)] pb-3 last:border-b-0">
            <button
              type="button"
              onClick={onExpand}
              title={`${group.name} (${group.list.length} sessions)`}
              className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground"
            >
              <FolderTree className="size-4" />
            </button>
            {group.list.slice(0, SECTION_LIMIT).map((session) => (
              <CollapsedSessionLink
                key={session.id}
                id={session.id}
                title={session.title ?? "Untitled session"}
                selected={session.id === current}
                active={activeIDs.includes(session.id)}
                onSelect={() => void selectSession(session.id)}
              />
            ))}
            {group.list.length > SECTION_LIMIT && (
              <button
                type="button"
                onClick={onExpand}
                title={`Open workspace to see ${group.list.length - SECTION_LIMIT} more sessions`}
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-[10px] text-[var(--text-weaker)] hover:bg-[var(--surface-base-hover)] hover:text-foreground"
              >
                +{group.list.length - SECTION_LIMIT}
              </button>
            )}
          </section>
        ))}
      </div>
    </ScrollArea>
  );
}

function SidebarFooter({
  onFiles,
}: {
  onFiles: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs text-[var(--text-weak)]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={onFiles} className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
          <FolderTree className="size-3" />
          Files
        </button>
        <button type="button" onClick={() => openSettings()} className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
          <SettingsIcon className="size-3" />
          Settings
        </button>
        <WebUIVersion />
        {/* Extension pages: native /ext/{id} anchors styled like the footer
            links above; hidden entirely when no pages are registered. */}
        <ExtensionPagesNav />
      </div>
    </div>
  );
}

/**
 * Freshness for late/hot-swapped extension registrations — a local counter
 * bumped by the registry's subscribe callback (the registry exposes no
 * version snapshot for useSyncExternalStore). Same pattern as MessageItem's.
 */
function useRegistryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeRegistry(() => setVersion((v) => v + 1)), []);
  return version;
}

/** One extension page as a footer link: "/ext/{id}", tooltip = title/description. */
function ExtensionPagesNav() {
  const registryVersion = useRegistryVersion();
  const pages = useMemo(() => getPages(), [registryVersion]);
  if (pages.length === 0) return null;
  return (
    <>
      {pages.map((page) => (
        <a
          key={page.id}
          href={`/ext/${page.id}`}
          title={page.description ? `${page.title} — ${page.description}` : page.title}
          onClick={(event) => {
            // Unmodified left-clicks stay in-app (pushState, no reload);
            // modified clicks / middle clicks keep the native anchor behavior.
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            window.history.pushState({}, "", `/ext/${page.id}`);
            window.dispatchEvent(new Event(EXT_NAVIGATE_EVENT));
          }}
          className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground"
        >
          <Puzzle className="size-3" />
          {page.title}
        </a>
      ))}
    </>
  );
}

function CollapsedSessionLink({
  id,
  title,
  selected,
  active,
  onSelect,
}: {
  id: string;
  title: string;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <a
      href={sessionHref(id)}
      title={title}
      aria-label={title}
      aria-current={selected ? "page" : undefined}
      onClick={(event) => handleSessionLinkClick(event, onSelect)}
      onMouseEnter={() => prefetchSession(id)}
      onFocus={() => prefetchSession(id)}
      className={`relative inline-flex size-8 items-center justify-center rounded-md text-xs font-medium transition-colors ${
        selected ? "bg-[var(--surface-raised-base)] text-foreground" : "text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground"
      }`}
    >
      {(title.trim()[0] ?? "S").toUpperCase()}
      {active && <span className="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-[var(--surface-success-strong)]" />}
    </a>
  );
}

function handleSessionLinkClick(event: MouseEvent<HTMLAnchorElement>, onSelect: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  void onSelect();
}

function SessionRow({
  id,
  title,
  updated,
  active,
  selected,
  subagentsActive,
  onSelect,
}: {
  id: string;
  title: string;
  updated: number;
  active: boolean;
  selected: boolean;
  /** A subagent child of this session is currently running/queued. */
  subagentsActive: boolean;
  onSelect: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <SessionContextMenu sessionID={id}>
      <Slot region="sidebar.session.before" sessionID={id} />
      <div className="group relative mb-0.5 w-full min-w-0 max-w-full">
        {/* Hover/focus warms the transcript cache so the click paints instantly. */}
        <a
          href={sessionHref(id)}
          title={title}
          aria-current={selected ? "page" : undefined}
          onClick={(event) => handleSessionLinkClick(event, onSelect)}
          onMouseEnter={() => prefetchSession(id)}
          onFocus={() => prefetchSession(id)}
          className={`block w-full min-w-0 max-w-full overflow-hidden rounded-md px-2.5 py-2 pr-12 transition-colors ${
            selected ? "bg-[var(--surface-raised-base)]" : "hover:bg-[var(--surface-base-hover)]"
          }`}
        >
        <div className="flex min-w-0 max-w-full items-center gap-2">
          {subagentsActive && (
            <span
              title="Subagents running"
              aria-label="Subagents running"
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--surface-success-strong)]"
            />
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{title}</span>
          {active && (
            <Badge className="shrink-0 border-transparent bg-[var(--surface-success-base)] text-[var(--text-on-success-base)]">
              run
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 max-w-full items-center gap-2 text-xs text-[var(--text-weak)]">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-weaker)]">{id.slice(0, 12)}</span>
          <span className="shrink-0">{timeAgo(updated)}</span>
        </div>
      </a>
      <div className="invisible absolute right-2 bottom-1.5 flex items-center gap-1 group-hover:visible group-focus-within:visible">
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="cursor-pointer text-[var(--text-on-critical-strong)] hover:text-[var(--text-on-critical-base)]"
              onClick={() => {
                void api.deleteSession(id).then(refreshSessions);
                if (selected) void selectSession(null);
              }}
            >
              yes
            </button>
            <button
              type="button"
              className="cursor-pointer text-[var(--text-weak)] hover:text-foreground"
              onClick={() => setConfirmDelete(false)}
            >
              no
            </button>
          </>
        ) : (
          <button
            type="button"
            title="Delete session"
            aria-label={`Delete ${title}`}
            className="cursor-pointer text-[var(--text-weaker)] hover:text-[var(--text-on-critical-base)]"
            onClick={() => setConfirmDelete(true)}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
      <Slot region="sidebar.session.after" sessionID={id} />
    </SessionContextMenu>
  );
}
