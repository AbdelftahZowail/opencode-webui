import { useMemo, useState } from "react";
import { ChevronDown, FolderTree, Inbox, Plus, Search, Settings as SettingsIcon, Terminal, X } from "lucide-react";
import { loadMoreSessions, newSession, refreshSessions, selectSession, sessionHref, useStore } from "../store";
import { api } from "../api/client";
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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

  const toggleExpand = (name: string) =>
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));

  return (
    <aside className="flex min-w-0 w-72 shrink-0 flex-col overflow-hidden border-r border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              connected ? "bg-[var(--surface-success-strong)]" : "bg-[var(--surface-warning-strong)]"
            }`}
          />
          <span className="truncate text-sm font-semibold text-foreground">OpenCode</span>
        </div>
        <Button
          variant="default"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await newSession();
            } finally {
              setBusy(false);
            }
          }}
        >
          <Plus />
          New session
        </Button>
      </div>

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
        <div className="w-full min-w-0 max-w-full p-1.5">
          {groups.length === 0 && (
            <p className="px-2.5 py-4 text-xs text-[var(--text-weak)]">
              {sessions.length === 0 ? "No sessions yet." : "No matches."}
            </p>
          )}
          {groups.map((group) => {
            const isExpanded = !!expanded[group.name];
            const visible = isExpanded ? group.list : group.list.slice(0, SECTION_LIMIT);
            const moreCount = group.list.length - visible.length;
            return (
              <section key={group.name} className="mb-2 w-full min-w-0 max-w-full">
                <div className="flex items-center justify-between px-2.5 py-1">
                  <button
                    type="button"
                    onClick={() => toggleExpand(group.name)}
                    className="flex min-w-0 cursor-pointer items-center gap-1 text-[11px] font-medium tracking-wide text-[var(--text-weaker)] uppercase hover:text-[var(--text-weak)]"
                    title={group.name}
                  >
                    <ChevronDown className={`size-3 shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`} />
                    <span className="min-w-0 truncate">{group.name}</span>
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
                {moreCount > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleExpand(group.name)}
                    className="w-full cursor-pointer rounded-md px-2.5 py-1 text-left text-xs text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-weak)]"
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

      <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-[var(--text-weak)]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setFilesOpen(true)}
            className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground"
          >
            <FolderTree className="size-3" />
            Files
          </button>
          <ShellPanel
            trigger={
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground"
              >
                <Terminal className="size-3" />
                Shell
              </button>
            }
          />
          <button
            type="button"
            onClick={openSettings}
            className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground"
          >
            <SettingsIcon className="size-3" />
            Settings
          </button>
          <button
            type="button"
            onClick={() => setInboxOpen(true)}
            className="inline-flex cursor-pointer items-center gap-1.5 hover:text-foreground"
          >
            <Inbox className="size-3" />
            Inbox
          </button>
        </div>
        <span>{sessions.length} sessions</span>
      </div>
      <SlotOutlet slot="sidebar" />
      <FileExplorer open={filesOpen} onOpenChange={setFilesOpen} />
      <InboxPanel open={inboxOpen} onOpenChange={setInboxOpen} />
      <SettingsDialog />
    </aside>
  );
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
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          void onSelect();
        }}
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
