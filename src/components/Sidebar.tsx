import { useMemo, useState, type MouseEvent, type PointerEvent } from "react";
import {
  ChevronDown,
  FolderTree,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings as SettingsIcon,
  Terminal,
  X,
} from "lucide-react";
import { loadMoreSessions, newSession, refreshSessions, selectSession, sessionHref, useStore } from "../store";
import { api } from "../api/client";
import type { SessionInfo } from "../api/types";
import { SlotOutlet } from "../extensions/registry";
import { timeAgo } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileExplorer } from "./FileExplorer";
import { ShellPanel } from "./ShellPanel";
import { InboxPanel } from "./InboxPanel";
import { SettingsDialog, openSettings } from "./settings/SettingsDialog";

const SECTION_LIMIT = 3;
const SIDEBAR_DEFAULT_WIDTH = 288;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_COLLAPSED_WIDTH = 56;

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

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const sessionsCursor = useStore((s) => s.sessionsCursor);
  const activeIDs = useStore((s) => s.activeIDs);
  const current = useStore((s) => s.currentSessionID);
  const connected = useStore((s) => s.connected);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [showMore, setShowMore] = useState<Record<string, boolean>>({});
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const home = findHome(sessions.map((s) => s.location?.directory));
    const buckets = new Map<string, typeof sessions>();
    for (const s of sessions) {
      if (q && !(s.title ?? "Untitled session").toLowerCase().includes(q)) continue;
      const key = workspaceName(s.location?.directory, home);
      const list = buckets.get(key) ?? [];
      list.push(s);
      buckets.set(key, list);
    }
    const sorted = [...buckets.entries()].map(([name, list]) => ({
      name,
      list: [...list].sort((a, b) => b.time.updated - a.time.updated),
    }));
    // Stable: keep insertion order of first appearance (newest first already).
    return sorted;
  }, [sessions, query]);

  const hasMore = sessionsCursor != null;

  const toggleWorkspace = (name: string) => {
    const nextCollapsed = !collapsedWorkspaces[name];
    setCollapsedWorkspaces((prev) => ({ ...prev, [name]: nextCollapsed }));
    if (nextCollapsed) setShowMore((prev) => ({ ...prev, [name]: false }));
  };

  const toggleShowMore = (name: string) =>
    setShowMore((prev) => ({ ...prev, [name]: !prev[name] }));

  const createSession = async () => {
    setBusy(true);
    try {
      await newSession();
    } finally {
      setBusy(false);
    }
  };

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
            <Button variant="default" size="icon" disabled={busy} onClick={() => void createSession()} title="New session">
              <Plus />
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Expand sidebar">
              <PanelLeftOpen />
            </Button>
          </>
        ) : (
          <div className="flex min-w-0 items-center gap-1">
            <Button variant="ghost" size="icon" onClick={toggleSidebar} title="Collapse sidebar">
              <PanelLeftClose />
            </Button>
            <Button variant="default" size="sm" disabled={busy} onClick={() => void createSession()}>
              <Plus />
              <span className="truncate">New session</span>
            </Button>
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
                className="h-7 pl-7"
              />
            </div>
          </div>

          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <div className="w-full min-w-0 max-w-full p-2">
              {groups.length === 0 && (
                <p className="px-2.5 py-4 text-xs text-[var(--text-weak)]">
                  {sessions.length === 0 ? "No sessions yet." : "No matches."}
                </p>
              )}
              {groups.map((group) => {
                const isCollapsed = !!collapsedWorkspaces[group.name];
                const isShowingMore = !!showMore[group.name];
                const visible = isCollapsed ? [] : isShowingMore ? group.list : group.list.slice(0, SECTION_LIMIT);
                const moreCount = group.list.length - visible.length;
                return (
                  <section key={group.name} className="mb-4 w-full min-w-0 max-w-full last:mb-1">
                    <div className="mb-1 flex min-w-0 items-center gap-2 border-b border-[var(--border-weak-base)] px-2 py-1.5">
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleWorkspace(group.name)}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[11px] font-medium tracking-wide text-[var(--text-weaker)] uppercase hover:text-[var(--text-weak)]"
                        title={isCollapsed ? "Expand workspace" : "Collapse workspace"}
                      >
                        <span className="min-w-0 truncate">{group.name}</span>
                        <ChevronDown className={`size-3 shrink-0 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                      </button>
                      <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{group.list.length}</span>
                    </div>
                    {visible.map((s) => {
                      const active = activeIDs.includes(s.id);
                      return (
                        <SessionRow
                          key={s.id}
                          id={s.id}
                          title={s.title ?? "Untitled session"}
                          updated={s.time.updated}
                          active={active}
                          selected={s.id === current}
                          onSelect={() => void selectSession(s.id)}
                        />
                      );
                    })}
                    {!isCollapsed && moreCount > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleShowMore(group.name)}
                        className="mt-1 w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-xs text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-weak)]"
                      >
                        Show {moreCount} more…
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

          <SidebarFooter
            sessionCount={sessions.length}
            onFiles={() => setFilesOpen(true)}
            onInbox={() => setInboxOpen(true)}
          />
        </>
      )}

      {sidebarCollapsed && (
        <div className="flex flex-col items-center gap-1 border-t border-border p-2">
          <button type="button" onClick={() => setFilesOpen(true)} className="inline-flex cursor-pointer rounded-md p-1.5 text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground" title="Files">
            <FolderTree className="size-4" />
          </button>
          <ShellPanel
            trigger={
              <button
                type="button"
                className="inline-flex cursor-pointer rounded-md p-1.5 text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground"
                title="Shell"
              >
                <Terminal className="size-4" />
              </button>
            }
          />
          <button type="button" onClick={openSettings} className="inline-flex cursor-pointer rounded-md p-1.5 text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground" title="Settings">
            <SettingsIcon className="size-4" />
          </button>
          <button type="button" onClick={() => setInboxOpen(true)} className="inline-flex cursor-pointer rounded-md p-1.5 text-[var(--text-weak)] hover:bg-[var(--surface-base-hover)] hover:text-foreground" title="Inbox">
            <Inbox className="size-4" />
          </button>
          <span className="font-mono text-[10px] text-[var(--text-weaker)]" title={`${sessions.length} sessions`}>{sessions.length}</span>
        </div>
      )}
      <SlotOutlet slot="sidebar" />
      <FileExplorer open={filesOpen} onOpenChange={setFilesOpen} />
      <InboxPanel open={inboxOpen} onOpenChange={setInboxOpen} />
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
  sessionCount,
  onFiles,
  onInbox,
}: {
  sessionCount: number;
  onFiles: () => void;
  onInbox: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs text-[var(--text-weak)]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={onFiles} className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
          <FolderTree className="size-3" />
          Files
        </button>
        <ShellPanel
          trigger={
            <button type="button" className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
              <Terminal className="size-3" />
              Shell
            </button>
          }
        />
        <button type="button" onClick={openSettings} className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
          <SettingsIcon className="size-3" />
          Settings
        </button>
        <button type="button" onClick={onInbox} className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground">
          <Inbox className="size-3" />
          Inbox
        </button>
      </div>
      <span className="shrink-0">{sessionCount} sessions</span>
    </div>
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
  onSelect,
}: {
  id: string;
  title: string;
  updated: number;
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="group relative mb-0.5 w-full min-w-0 max-w-full">
      <a
        href={sessionHref(id)}
        title={title}
        aria-current={selected ? "page" : undefined}
        onClick={(event) => handleSessionLinkClick(event, onSelect)}
        className={`block w-full min-w-0 max-w-full overflow-hidden rounded-md px-2.5 py-2 pr-12 transition-colors ${
          selected ? "bg-[var(--surface-raised-base)]" : "hover:bg-[var(--surface-base-hover)]"
        }`}
      >
        <div className="flex min-w-0 max-w-full items-center gap-2">
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
  );
}
