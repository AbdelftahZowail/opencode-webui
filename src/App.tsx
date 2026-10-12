import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Columns2, Menu, Plus } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { HelpDialog } from "./components/HelpDialog";
import { SearchPanel } from "./components/SearchPanel";
import { ShellPanel } from "./components/ShellPanel";
import { SplitPicker } from "./components/SplitPicker";
import { ActivityStrip } from "./components/ActivityStrip";
import { CommandKeybinds } from "./components/CommandKeybinds";
import { Toasts } from "./components/Toasts";
import { ImageViewer } from "./components/ImageViewer";
import { ConnectDialog } from "./components/ConnectDialog";
import { ShelfPage } from "./components/shelf/ShelfPage";
import { copyText } from "./components/markdown/clipboard";
import { api } from "./api/client";
import type { MessageInfo } from "./api/types";
import { Target, getContributions, subscribeRegistry, type PageContribution } from "./extensions/registry";
import { handCharToComposer, setupPasteHandoff } from "./lib/composerHandoff";
import { OPEN_SEARCH_EVENT } from "./lib/uiEvents";
import { log } from "./lib/log";
import { useHotkeys } from "./hooks/useHotkeys";
import { useKeyboardOpen } from "./hooks/useKeyboardOpen";
import {
  MAIN_PANE,
  MAX_SPLITS,
  childSessionsOf,
  closeAllSessionTabs,
  closeDiffViewer,
  closeErrorDetails,
  closeOtherSessionTabs,
  closeSessionTab,
  closeTimeline,
  emptyDiffState,
  focusPane,
  focusedPaneKey,
  forkAtMessage,
  isDraftSession,
  loadStats,
  moveSessionTab,
  navigateFocused,
  openMobileSidebar,
  openRunsPanel,
  openSplitPicker,
  removeSplitPane,
  pendingRequests,
  reopenClosedTab,
  requestInterrupt,
  revealSubagentComposer,
  selectNextTab,
  selectNextUnreadTab,
  selectNumberedTab,
  selectPreviousTab,
  selectPreviousUnreadTab,
  selectSession,
  sessionDirectory,
  sessionOrSubagentsLive,
  setDiffBase,
  setDiffReviewed,
  setDiffSelectedFile,
  setDiffSource,
  setHighlightMessage,
  setTabsEnabled,
  setUpdateNotice,
  checkForUpdate,
  clearSessionSearch,
  createWorktreeForDirectory,
  deleteSession,
  installUpdate,
  loadWorktrees,
  restartUpdate,
  searchSessions,
  toggleSessionSearchAllProjects,
  renameSession,
  toggleSessionPin,
  startDraftSession,
  startEditAtMessage,
  useSessionTabRefs,
  useStore,
  type DiffSource,
} from "./store";
import { filterSessionsToProject } from "./lib/sessionSearch";
import { getDismissedUpdateVersion, setDismissedUpdateVersion } from "./lib/updateNotice";
import type { ProjectInfo } from "./api/client";

/** Extension page routes: /ext/{id} (id auto-derived from the extension id). */
const EXT_ROUTE_RE = /^\/ext\/([A-Za-z0-9_-]+)$/;
/**
 * Fired after an in-app pushState to an /ext/{id} route so the pathname
 * listener below repaints (pushState alone fires no event). Mirrors
 * EXT_NAVIGATE_EVENT in Sidebar.tsx.
 */
const EXT_NAVIGATE_EVENT = "webui:navigate";

/**
 * The current location pathname as render state: tracks browser Back/Forward
 * via popstate and in-app pushes to extension pages via EXT_NAVIGATE_EVENT.
 * Session/new-session routing stays entirely in the store's own machinery.
 */
function useWindowPathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(EXT_NAVIGATE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(EXT_NAVIGATE_EVENT, sync);
    };
  }, []);
  return pathname;
}

export default function App() {
  // currentSessionID ALWAYS mirrors the FOCUSED pane's session (store
  // invariant), so tab title / Esc / hotkeys stay keyed on it unchanged.
  const sessionID = useStore((s) => s.currentSessionID);
  const connected = useStore((s) => s.connected);
  const serviceOK = useStore((s) => s.serviceOK);
  const session = useStore((s) =>
    s.currentSessionID
      ? s.sessions.find((x) => x.id === s.currentSessionID) ?? s.sessionDetails[s.currentSessionID]
      : undefined,
  );
  const sessions = useStore((s) => s.sessions);
  const isPanelOpen = useStore((s) => s.runsPanelOpen);
  // Live for the tab dot: the focused session itself OR any of its active
  // subagent children (running OR queued — the site-wide "live" idiom).
  const live = useStore((s) => sessionOrSubagentsLive(s, sessionID));
  // panes[0] is the routed main surface; entries 1..n are pinned splits.
  const mainSessionID = useStore((s) => s.panes[0]?.sessionID ?? null);
  const splits = useStore((s) => s.panes.slice(1));
  const focusedPane = useStore((s) => s.focusedPane);
  // Mobile keyboard open = only the input box stays above it; the
  // app-level activity strip below gates on this (hidden <sm while typing).
  const kbOpen = useKeyboardOpen();
  // Global search overlay (search panel) — opened by ⌘F/Ctrl+F or the
  // sidebar's search button (which fires OPEN_SEARCH_EVENT).
  const [searchOpen, setSearchOpen] = useState(false);

  // Extension page route (/ext/{id}): a purely additional branch — when it
  // matches, it replaces the MAIN pane's surface only; the sidebar, splits,
  // footer and all overlays compose exactly as on session routes.
  const pathname = useWindowPathname();
  const extPageID = EXT_ROUTE_RE.exec(pathname)?.[1] ?? null;
  const extPage = extPageID
    ? getContributions<PageContribution>("pages").find((c) => c.id === extPageID)
    : undefined;
  const extPageTitle = extPage?.item.title;
  // Native core page: the file shelf browser. Purely additional, like /ext/{id}.
  const shelfRoute = pathname === "/shelf";
  // Native core page: usage stats (R6). Same additive branch as /shelf.
  const statsRoute = pathname === "/stats";

  // Browser tab mirrors the conversation: the session's title, prefixed
  // with a live dot while that session OR any of its subagents is working
  // or waiting on a send. Extension pages take over the title for their stay.
  useEffect(() => {
    if (statsRoute) {
      document.title = "Stats";
      return;
    }
    if (shelfRoute) {
      document.title = "File shelf";
      return;
    }
    if (extPageTitle !== undefined) {
      document.title = extPageTitle;
      return;
    }
    document.title = !sessionID
      ? "OpenCode Web"
      : `${live ? "● " : ""}${
          isDraftSession(sessionID)
            ? "New session"
            : (session?.title ?? "Untitled session")
        }`;
  }, [sessionID, session?.title, live, extPageTitle, shelfRoute, statsRoute]);

  // TUI session-level arrow bindings — active only OUTSIDE inputs (in the
  // composer, up/down walk prompt history and left/right move the caret):
  //   ↑        parent session
  //   ← / →    previous / next subagent sibling (wraps)
  //   ↓        subagents & shells panel (RunsPanel owns keys while open)
  function overlayOpen() {
    return !!document.querySelector('[role="dialog"]') || isPanelOpen;
  }

  // All hotkey navigation happens INSIDE the focused pane: main → real
  // navigation, a split → swap that pane in place (never yank the app).
  const go = (sid: string | null) => void navigateFocused(sid);

  function cycleChild(direction: 1 | -1) {
    if (!sessionID || !session?.parentID || overlayOpen()) return;
    // TUI moveChild: cycle the parent's subagent children in id order —
    // the same order the gate strip renders, so → walks the chips
    // left-to-right and ← walks them back.
    const siblings = childSessionsOf(sessions, session.parentID)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (siblings.length === 0) return;
    const idx = siblings.findIndex((x) => x.id === sessionID);
    const next = ((((idx === -1 ? 0 : idx) + direction) % siblings.length) + siblings.length) % siblings.length;
    go(siblings[next]!.id);
  }

  // Type-anywhere: a printable keystroke pressed while focus sits on a
  // non-editable surface (messages list, sidebar, the runs panel box)
  // belongs to the composer — focus it and let the key land natively.
  // Skipped while anything that owns the keyboard is up: dialogs (incl.
  // the pending-request popup), the command palette, menus/popovers —
  // and of course when an input/textarea/contenteditable/xterm already
  // has focus. Runs via handCharToComposer, which also dismisses the
  // runs panel (it replaces the composer in its render slot).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.metaKey) return;
      const altGr = e.ctrlKey && e.altKey; // AltGr layouts: ctrl+alt + char
      if ((e.ctrlKey && !altGr) || (e.altKey && !altGr)) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.closest("input, textarea, select, [contenteditable=true]"))
      ) {
        return;
      }
      if (
        document.querySelector(
          '[role="dialog"], [cmdk-root], [data-radix-popper-content-wrapper], [role="menu"], [role="listbox"]',
        )
      ) {
        return;
      }
      handCharToComposer(e.key, focusedPaneKey());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Paste-anywhere: mirrors type-anywhere for paste — a paste that would
  // land on a non-editable surface goes to the composer instead, preserving
  // both text and image attachment staging.
  useEffect(() => setupPasteHandoff(), []);

  // ⌘F / Ctrl+F (or the sidebar button): open the search overlay. The old
  // always-visible sidebar field is gone; the browser's own find is still
  // shadowed while the app handles it. No-ops under other overlays.
  function focusSessionSearch() {
    if (overlayOpen()) return;
    setSearchOpen(true);
  }

  useEffect(() => {
    const onOpen = () => setSearchOpen(true);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
  }, []);

  // R3 tab hotkeys are Alt-modified, so they can fire while focus sits in the
  // composer — run them through the same overlay guard the other keys use.
  const tabKey = (fn: () => void) => () => {
    if (overlayOpen()) return;
    fn();
  };

  useHotkeys({
    arrowup: () => {
      if (!session?.parentID || !sessionID || overlayOpen()) return;
      go(session.parentID);
    },
    arrowdown: () => {
      if (!sessionID || overlayOpen()) return;
      openRunsPanel();
    },
    arrowleft: () => cycleChild(-1),
    arrowright: () => cycleChild(1),
    enter: () => {
      // Subagent pages gate the composer behind a hint strip; Enter
      // reveals it (the composer then owns Enter for sending).
      if (!session?.parentID || !sessionID || overlayOpen()) return;
      revealSubagentComposer();
    },
    backspace: () => {
      // Subagent page: Backspace goes back to the parent — while the gate
      // is up, and also with the composer revealed (as long as it has no
      // text; focused editing is skipped by the editable-target rule).
      // The lookup targets the FOCUSED pane's input — every pane mounts one.
      if (!session?.parentID || !sessionID || overlayOpen()) return;
      const box = document.getElementById(
        `composer-input-${focusedPaneKey()}`,
      ) as HTMLTextAreaElement | null;
      if (box && box.value !== "") return;
      go(session.parentID);
    },
    "ctrl+n": () => startDraftSession(null),
    "ctrl+\\": () => openSplitPicker(),
    "meta+f": focusSessionSearch,
    "ctrl+f": focusSessionSearch,
    escape: (e) => {
      // Site-wide Esc arms/confirm-interrupts the active run, EXCEPT when any
      // overlay owns the key: dialogs (incl. the pending-request popup) close
      // themselves on Esc, the composer handles its own shell-mode/run Esc,
      // and dropdowns/menus/popovers need Esc to dismiss. Every pane's
      // composer id shares the "composer-input" prefix.
      const target = e?.target as HTMLElement | null;
      if (
        document.querySelector('[role="dialog"]') ||
        (target &&
          (target.id.startsWith("composer-input") ||
            target.closest('[data-radix-popper-content-wrapper], [cmdk-root], [data-slot="command"]')))
      ) {
        return;
      }
      requestInterrupt();
    },
    "alt+pagedown": tabKey(selectNextTab),
    "alt+pageup": tabKey(selectPreviousTab),
    "alt+shift+pagedown": tabKey(selectNextUnreadTab),
    "alt+shift+pageup": tabKey(selectPreviousUnreadTab),
    "alt+w": tabKey(() => {
      if (sessionID) closeSessionTab(sessionID);
    }),
    "alt+shift+t": tabKey(reopenClosedTab),
    "alt+1": tabKey(() => selectNumberedTab(1)),
    "alt+2": tabKey(() => selectNumberedTab(2)),
    "alt+3": tabKey(() => selectNumberedTab(3)),
    "alt+4": tabKey(() => selectNumberedTab(4)),
    "alt+5": tabKey(() => selectNumberedTab(5)),
    "alt+6": tabKey(() => selectNumberedTab(6)),
    "alt+7": tabKey(() => selectNumberedTab(7)),
    "alt+8": tabKey(() => selectNumberedTab(8)),
    "alt+9": tabKey(() => selectNumberedTab(9)),
    "alt+0": tabKey(() => selectNumberedTab(10)),
  });

  /** Focus follows pointer AND keyboard into a pane; the store no-ops when unchanged. */
  const focusThis = (paneID: string) => () => void focusPane(paneID);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Target id="sidebar" />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* R3 session-tab rail — additive chrome above the pane row. */}
          <SessionTabsHost />
          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {/* Main pane: always the routed surface, even while a split holds focus. */}
          <section
            className="flex min-w-0 flex-1 flex-col"
            onPointerDownCapture={focusThis(MAIN_PANE)}
            onFocusCapture={focusThis(MAIN_PANE)}
          >
            {statsRoute ? (
              // Native stats page (R6): full-page surface replacing the
              // conversation pane; the shell around it stays exactly as-is.
              <StatsHost />
            ) : shelfRoute ? (
              // Native file-shelf page: full-page surface replacing the
              // conversation pane; the shell around it stays exactly as-is.
              <ShelfPage />
            ) : extPageID ? (
              // Extension page: full-page surface replacing the conversation
              // pane; the shell around it stays exactly as-is.
              <ExtensionPageSurface id={extPageID} />
            ) : mainSessionID ? (
              <Target
                id="conversation"
                key={mainSessionID}
                sessionID={mainSessionID}
                paneKey="main"
                focused={focusedPane === MAIN_PANE}
                onNavigate={go}
              />
            ) : (
              <EmptyState connected={connected} />
            )}
          </section>
          {splits.map((pane) => (
            <section
              key={pane.id}
              className="pane-surface hidden min-w-0 border-l border-[var(--border-base)] lg:flex"
              style={{ flex: "1 1 0", maxWidth: "50%" }}
              onPointerDownCapture={focusThis(pane.id)}
              onFocusCapture={focusThis(pane.id)}
            >
              {pane.sessionID ? (
                <Target
                  id="conversation"
                  key={`${pane.id}:${pane.sessionID}`}
                  sessionID={pane.sessionID}
                  paneKey={pane.id}
                  focused={focusedPane === pane.id}
                  onClose={() => void removeSplitPane(pane.id)}
                  onNavigate={go}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-weaker)]">
                  Empty pane
                </div>
              )}
            </section>
          ))}
          {/* Slim rail at the strip's right end: the only split-open control. */}
          <div className="hidden w-9 shrink-0 flex-col items-center border-l border-[var(--border-base)] pt-2 lg:flex">
            <button
              type="button"
              onClick={openSplitPicker}
              disabled={splits.length >= MAX_SPLITS}
              title="Split view — open a session beside this one"
              className="flex size-7 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)] disabled:pointer-events-none disabled:opacity-40"
            >
              <Columns2 className="size-4" />
            </button>
          </div>
          </div>
        </div>
      </div>
      {/* Mobile keyboard: the activity strip docks away while typing — only
          the input box rides above the keyboard. Desktop unaffected. */}
      <div className={kbOpen ? "hidden sm:block" : ""}>
        <ActivityStrip />
      </div>
      <ForeignPendingChip />
      <SplitPicker />
      <CommandPalette />
      <SearchPanel open={searchOpen} onClose={() => setSearchOpen(false)} />
      <CommandKeybinds />
      <Toasts />
      <ImageViewer />
      <ConnectDialog />
      <HelpDialog />
      <DiffViewerHost />
      <TimelineHost />
      {/* R11 overlays: reconnect scrim, error details, debug, pairing, update. */}
      <Target id="reconnect.overlay" connected={connected} serviceOK={serviceOK} />
      <ErrorDetailsHost />
      <DebugHost />
      <PairHost />
      <UpdateNoticeHost />
      {/* R11a mounted dialogs: the session list + the open/recents picker. */}
      <SessionListHost />
      <OpenPickerHost />
      {/* The app's ONLY ShellPanel instance: trigger-less (hidden-span
          trigger), opened by requestShellPanel() ticks from the runs panel /
          composer chips — the sidebar no longer hosts one. */}
      <ShellPanel trigger={<span className="hidden" />} />
    </div>
  );
}

/**
 * R3 session-tab rail host: reads the resolved tab view model + the open
 * slice's enabled/closed state and renders the registered `session.tabs`
 * target, so extensions can wrap or replace the rail without touching App.
 */
function SessionTabsHost() {
  const refs = useSessionTabRefs();
  const current = useStore((s) => s.currentSessionID);
  const enabled = useStore((s) => s.tabs.enabled);
  const closed = useStore((s) => s.tabs.closed.length);
  return (
    <Target
      id="session.tabs"
      tabs={refs}
      current={current}
      tabsEnabled={enabled}
      canReopen={closed > 0}
      onSelect={(id: string) => void selectSession(id)}
      onClose={closeSessionTab}
      onReopen={reopenClosedTab}
      onReorder={moveSessionTab}
      onCloseOthers={closeOtherSessionTabs}
      onCloseAll={closeAllSessionTabs}
      onToggleTabs={() => setTabsEnabled(!enabled)}
    />
  );
}

/**
 * R11 error-details host: reads the store's `errorDetails` (or null) and
 * renders the registered `errorDetails.dialog`. `i`/Investigate just closes
 * the dialog — no new store action (the diagnostic-seeding flow is deferred).
 */
function ErrorDetailsHost() {
  const err = useStore((s) => s.errorDetails);
  return (
    <Target
      id="errorDetails.dialog"
      open={!!err}
      {...(err ?? {})}
      onInvestigate={closeErrorDetails}
      onClose={closeErrorDetails}
    />
  );
}

/**
 * R11 debug host: reads the `uiSignals.debug` open tick and the focused
 * session/model, fetches the engine version once, and renders the registered
 * `debug.dialog`. Closing is local only — mirroring HelpDialog (the tick is a
 * one-shot open request, not a controlled open flag).
 */
function DebugHost() {
  const tick = useStore((s) => s.uiSignals.debug);
  const sessionID = useStore((s) => s.currentSessionID);
  const model = useStore((s) => {
    const sid = s.currentSessionID;
    if (!sid) return null;
    return (
      s.pendingModels[sid] ??
      s.sessionDetails[sid]?.model ??
      s.sessions.find((x) => x.id === sid)?.model ??
      null
    );
  });
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (tick) setOpen(true);
  }, [tick]);
  useEffect(() => {
    if (!open || version) return;
    void api
      .serverInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {});
  }, [open, version]);
  const modelLabel = model ? `${model.providerID}/${model.id}` : null;
  return (
    <Target
      id="debug.dialog"
      open={open}
      info={{ version, sessionID, model: modelLabel }}
      onClose={() => setOpen(false)}
    />
  );
}

/**
 * R11 pairing host: reads the `uiSignals.pair` open tick and the engine's
 * advertised URLs (fetched once per open), and renders the registered
 * `pair.dialog`. The password is always shown masked — never the real secret.
 */
function PairHost() {
  const tick = useStore((s) => s.uiSignals.pair);
  const [open, setOpen] = useState(false);
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    if (tick) setOpen(true);
  }, [tick]);
  useEffect(() => {
    if (!open || urls.length) return;
    void api
      .serverInfo()
      .then((info) => setUrls(info.urls ?? []))
      .catch(() => {});
  }, [open, urls.length]);
  return (
    <Target
      id="pair.dialog"
      open={open}
      info={{
        thisUrl: window.location.origin,
        urls,
        username: "opencode",
        passwordMasked: "••••••••",
        qrUrl: window.location.origin,
      }}
      onClose={() => setOpen(false)}
    />
  );
}

/**
 * R11 update-notice host: renders the registered `update.notice` only while the
 * store carries a notice. R11b wires the real check/install/restart actions; the
 * dismissed version is persisted via `lib/updateNotice` and Skip records it.
 */
function UpdateNoticeHost() {
  const notice = useStore((s) => s.updateNotice);
  if (!notice) return null;
  return (
    <Target
      id="update.notice"
      {...notice}
      dismissedVersion={getDismissedUpdateVersion()}
      onSkip={(version: string) => {
        setDismissedUpdateVersion(version);
        setUpdateNotice(null);
      }}
      onUpdate={() => void installUpdate()}
      onRestart={() => void restartUpdate()}
      onRetry={() => void checkForUpdate()}
      onClose={() => setUpdateNotice(null)}
    />
  );
}

/**
 * R11a session-list host: reads the `uiSignals.sessionList` open tick, the
 * server-search slice, and the SAME R3 pins the sidebar uses, then renders the
 * registered `sessionList.dialog`. "This project" scoping is applied
 * client-side (the engine's search is global); pinned sessions are always
 * retained so the quick-slot column stays complete.
 */
function SessionListHost() {
  const tick = useStore((s) => s.uiSignals.sessionList);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (tick) setOpen(true);
  }, [tick]);

  const sessions = useStore((s) => s.sessions);
  const currentSessionID = useStore((s) => s.currentSessionID);
  const running = useStore((s) => s.running);
  const queued = useStore((s) => s.queued);
  const pins = useStore((s) => s.tabs.pins);
  const results = useStore((s) => s.sessionSearch.results);
  const searching = useStore((s) => s.sessionSearch.searching);
  const allProjects = useStore((s) => s.sessionSearch.allProjects);
  const projectDirectory = useStore((s) =>
    s.currentSessionID ? sessionDirectory(s.currentSessionID) : null,
  );

  const scopedSessions = useMemo(
    () => filterSessionsToProject(sessions, allProjects ? null : projectDirectory, pins),
    [sessions, allProjects, projectDirectory, pins],
  );
  const scopedResults = useMemo(
    () => (results && !allProjects ? filterSessionsToProject(results, projectDirectory) : results),
    [results, allProjects, projectDirectory],
  );
  const live = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const s of sessions) if (running[s.id] || queued[s.id]) out[s.id] = true;
    return out;
  }, [sessions, running, queued]);

  return (
    <Target
      id="sessionList.dialog"
      open={open}
      sessions={scopedSessions}
      currentSessionID={currentSessionID}
      live={live}
      searchResults={scopedResults}
      searching={searching}
      pinned={pins}
      allProjects={allProjects}
      onSearch={(q: string, all: boolean) => void searchSessions(q, all)}
      onToggleAllProjects={toggleSessionSearchAllProjects}
      onTogglePin={(id: string) => toggleSessionPin(id)}
      onSelect={(id: string) => void selectSession(id)}
      onRename={(id: string, title: string) => void renameSession(id, title)}
      onDelete={(id: string) => void deleteSession(id)}
      onClose={() => {
        setOpen(false);
        clearSessionSearch();
      }}
    />
  );
}

/**
 * R11a open-picker host: reads the `uiSignals.openPicker` open tick, loads the
 * project list on open, and renders the registered `open.picker`. Drilling a
 * project loads its worktrees through the existing store action; ctrl+n creates
 * one inline; Enter on a directory opens a fresh draft session there.
 */
function OpenPickerHost() {
  const tick = useStore((s) => s.uiSignals.openPicker);
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  useEffect(() => {
    if (tick) setOpen(true);
  }, [tick]);
  useEffect(() => {
    if (!open) return;
    void api
      .projectList()
      .then((list) => setProjects(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [open]);

  const sessions = useStore((s) => s.sessions);
  const currentSessionID = useStore((s) => s.currentSessionID);
  const running = useStore((s) => s.running);
  const queued = useStore((s) => s.queued);
  const worktrees = useStore((s) => s.worktrees);
  const worktreesBusy = useStore((s) => s.worktreesBusy);
  const currentDirectory = useStore((s) =>
    s.currentSessionID ? sessionDirectory(s.currentSessionID) : null,
  );
  const live = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const s of sessions) if (running[s.id] || queued[s.id]) out[s.id] = true;
    return out;
  }, [sessions, running, queued]);

  return (
    <Target
      id="open.picker"
      open={open}
      sessions={sessions}
      projects={projects}
      currentSessionID={currentSessionID}
      currentDirectory={currentDirectory}
      live={live}
      worktrees={worktrees}
      worktreesLoading={worktreesBusy}
      onOpenSession={(id: string) => void selectSession(id)}
      onOpenDirectory={(directory: string) => startDraftSession(directory)}
      onDrillProject={(directory: string) => void loadWorktrees(directory)}
      onCreateWorktree={(directory: string) => createWorktreeForDirectory(directory)}
      onClose={() => setOpen(false)}
    />
  );
}

/**
 * The P2 diff viewer's store-connected host: reads the open session's diff
 * slice and renders the registered `diff.viewer` target, so extensions can
 * wrap or replace the viewer without touching App. Mounted app-wide rather
 * than inside FileExplorer — the viewer is a full dialog and its trigger can
 * live anywhere.
 */
function DiffViewerHost() {
  const sessionID = useStore((s) => s.diffViewerSessionID);
  const slice = useStore((s) => (s.diffViewerSessionID ? s.diffs[s.diffViewerSessionID] : undefined));
  if (!sessionID) return null;
  const diff = slice ?? emptyDiffState();
  return (
    <Target
      id="diff.viewer"
      sessionID={sessionID}
      files={diff.files}
      source={diff.source}
      loading={diff.loading}
      error={diff.error}
      reviewed={diff.reviewed}
      selectedFile={diff.selectedFile}
      base={diff.base}
      branches={diff.branches}
      baseRef={diff.baseRef}
      location={sessionDirectory(sessionID)}
      onSelectSource={(source: DiffSource) => setDiffSource(sessionID, source)}
      onSelectFile={(file: string | null) => setDiffSelectedFile(sessionID, file)}
      onToggleReviewed={(file: string, reviewed: boolean) => setDiffReviewed(sessionID, file, reviewed)}
      onSelectBase={(branch: string | null) => setDiffBase(sessionID, branch)}
      onClose={closeDiffViewer}
    />
  );
}

/**
 * The R6 stats route's store-connected host: reads the stats slice and renders
 * the registered `stats.panel` target, so extensions can wrap or replace the
 * panel without touching App. Mounted app-wide for the `/stats` branch.
 */
function StatsHost() {
  const data = useStore((s) => s.statsData);
  const loading = useStore((s) => s.statsLoading);
  const error = useStore((s) => s.statsError);
  useEffect(() => {
    if (!data && !loading) void loadStats();
  }, []);
  return <Target id="stats.panel" data={data} loading={loading} error={error} onRetry={loadStats} />;
}

/**
 * The R4 timeline dialog's store-connected host: reads the open session's
 * transcript slice and renders the registered `timeline.dialog` target, so
 * extensions can wrap or replace it without touching App.
 */
const EMPTY_MESSAGES: MessageInfo[] = [];
function TimelineHost() {
  const sessionID = useStore((s) => s.timelineSessionID);
  const messages = useStore((s) => (sessionID ? s.messages[sessionID] ?? EMPTY_MESSAGES : EMPTY_MESSAGES));
  if (!sessionID) return null;
  return (
    <Target
      id="timeline.dialog"
      sessionID={sessionID}
      messages={messages}
      onJump={(messageID: string) => setHighlightMessage(sessionID, messageID)}
      onRevert={(messageID: string, text: string) => startEditAtMessage(sessionID, messageID, text)}
      onCopy={(text: string) => void copyText(text)}
      onFork={(messageID: string) => void forkAtMessage(sessionID, messageID)}
      onClose={closeTimeline}
    />
  );
}

/**
 * Corner notifier for requests raised by sessions OTHER than the focused
 * one (the focused session's own requests replace its composer in
 * PendingRequestsPanel). Deliberately small but never absent while
 * something waits — a blocked agent must stay discoverable. Click switches
 * to the oldest waiting session.
 */
function ForeignPendingChip() {
  const foreign = useStore((s) => pendingRequests(s).filter((r) => r.req.sessionID !== s.currentSessionID));
  // Fixed-position chip would float above the mobile keyboard — dock it away
  // while typing (<sm only); it returns when the keyboard closes.
  const kbOpen = useKeyboardOpen();
  // Sessions, then a memoized id-set — NOT `useStore((s) => new Set(...))`:
  // shallow-equality compares own enumerable keys, and a Set has none, so every
  // Set compares equal and the selector freezes at its mount value (labelling
  // every foreign session "(closed)").
  const sessions = useStore((s) => s.sessions);
  const known = useMemo(() => new Set(sessions.map((x) => x.id)), [sessions]);
  // One line per SESSION, not per request: three permissions in one session is
  // "one session is blocked", and the old tooltip printed that session id three
  // times, which read as three separate problems.
  const groups = useMemo(() => {
    const byId = new Map<string, { count: number; kinds: Set<string> }>();
    for (const item of foreign) {
      const entry = byId.get(item.req.sessionID) ?? { count: 0, kinds: new Set<string>() };
      entry.count += 1;
      entry.kinds.add(item.kind);
      byId.set(item.req.sessionID, entry);
    }
    return [...byId.entries()];
  }, [foreign]);
  const total = foreign.length;
  const foreignKey = foreign.map((f) => f.req.id).join(",");
  useEffect(() => {
    if (foreignKey) log("chip", `foreign waiting: ${foreignKey}`);
  }, [foreignKey]);
  if (total === 0) return null;
  const title = groups
    .map(([sessionID, entry]) => {
      const what = waitingOn(entry.kinds);
      const known2 = known.has(sessionID) ? "" : " (closed)";
      return `${what}${known2} — ${entry.count} waiting`;
    })
    .join("\n");
  return (
    <button
      type="button"
      onClick={() => void selectSession(foreign[0]!.req.sessionID, { history: "push" })}
      title={title}
      className={`${kbOpen ? "hidden sm:flex" : "flex"} fixed right-4 bottom-10 z-40 items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--surface-warning-strong)_45%,transparent)] bg-[var(--surface-float-base)] px-2.5 py-1 text-xs text-[var(--text-weak)] shadow-md transition-colors hover:text-[var(--text-strong)]`}
    >
      <span className="size-1.5 animate-pulse rounded-full bg-[color:var(--surface-warning-strong)]" aria-hidden />
      {total} waiting in {groups.length === 1 ? "another session" : "other sessions"} — switch
    </button>
  );
}

/** What a session is blocked on, for the chip's tooltip. */
function waitingOn(kinds: Set<string>): string {
  if (kinds.has("permission")) return "needs permission";
  if (kinds.has("question")) return "asked a question";
  if (kinds.has("form")) return "needs input";
  return "waiting";
}

function EmptyState({ connected }: { connected: boolean }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Mobile top bar: the sidebar is off-canvas <md and the conversation
          header (which owns the drawer button) isn't mounted with no session
          open — without this the user has no way to reach their sessions. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-base)] bg-[var(--background-base)] px-2.5 py-2 md:hidden">
        <button
          type="button"
          onClick={openMobileSidebar}
          title="Open sessions"
          aria-label="Open sessions"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
        >
          <Menu className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[var(--font-size-base)] font-medium text-[var(--text-strong)]">
          OpenCode
        </span>
        <button
          type="button"
          onClick={() => void startDraftSession(null)}
          title="New session"
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-[var(--button-primary-base)] px-2.5 text-xs font-medium text-[var(--background-base)]"
        >
          <Plus className="size-3.5" />
          New
        </button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-neutral-500">
        <div className={`size-2.5 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
        <p className="text-sm">
          {connected ? "Select or create a session on the left" : "Connecting to the opencode service…"}
        </p>
        <button
          type="button"
          onClick={openMobileSidebar}
          className="cursor-pointer rounded-md border border-[var(--border-weak-base)] px-3 py-1.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)] md:hidden"
        >
          Browse sessions
        </button>
      </div>
    </div>
  );
}

/**
 * Full-page surface for an extension page (/ext/{id}): a centered column
 * with a back button + title + description header and the page's render
 * output. Re-reads the registry every render (cheap filters) — the local
 * version counter below re-renders this component when pages hot-register.
 * Unknown ids render the same shell with the list of available pages.
 */
function ExtensionPageSurface({ id }: { id: string }) {
  // Subscribe for hot (re-)registration of pages; the counter itself is
  // only the repaint trigger.
  useRegistryVersion();
  const pages = getContributions<PageContribution>("pages");
  const page = pages.find((c) => c.id === id);

  const back = (
    <button
      type="button"
      onClick={() => window.history.back()}
      title="Go back"
      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-1.5 py-0.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
    >
      <ArrowLeft className="size-3" />
      Back
    </button>
  );

  return (
    <div className="pane-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {/* Mobile sessions drawer: extension pages replace the
                  conversation pane (which owns the drawer button), so expose
                  it here — otherwise no way to reach sessions on mobile. */}
              <button
                type="button"
                onClick={openMobileSidebar}
                title="Open sessions"
                aria-label="Open sessions"
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)] md:hidden"
              >
                <Menu className="size-4" />
              </button>
              {back}
              <h1 className="truncate text-[var(--font-size-large)] font-medium text-[var(--text-strong)]">
                {page ? page.item.title : "Unknown extension page"}
              </h1>
            </div>
            {page?.item.description && (
              <p className="mt-1 text-sm text-[var(--text-weaker)]">{page.item.description}</p>
            )}
          </div>
        </div>
        <div className="mt-4">
          {page ? (
            page.item.render({})
          ) : (
            <div className="flex flex-col gap-2 text-sm text-[var(--text-weak)]">
              <p>No extension registered “{id}”. Available pages:</p>
              {pages.length === 0 ? (
                <p className="text-[var(--text-weaker)]">No extension pages are registered.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {pages.map((p) => (
                    <li key={p.id}>
                      <a
                        href={`/ext/${p.id}`}
                        title={p.item.description ?? p.item.title}
                        className="text-[var(--text-interactive-base)] underline underline-offset-2"
                      >
                        /ext/{p.id} — {p.item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Freshness for late/hot-swapped extension registrations (same pattern as
 * MessageItem/Sidebar): subscribe on mount, bump a counter to re-render.
 */
function useRegistryVersion(): readonly [number] {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeRegistry(() => setVersion((v) => v + 1)), []);
  return [version] as const;
}
