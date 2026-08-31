import { useEffect, useState } from "react";
import { ArrowLeft, Columns2 } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { Conversation } from "./components/Conversation";
import { HelpDialog } from "./components/HelpDialog";
import { Sidebar } from "./components/Sidebar";
import { ShellPanel } from "./components/ShellPanel";
import { SplitPicker } from "./components/SplitPicker";
import { ActivityStrip } from "./components/ActivityStrip";
import { CommandKeybinds } from "./components/CommandKeybinds";
import { Toasts } from "./components/Toasts";
import { Slot, getPage, getPages, subscribeRegistry } from "./extensions/registry";
import { handCharToComposer } from "./lib/composerHandoff";
import { log } from "./lib/log";
import { useHotkeys } from "./hooks/useHotkeys";
import {
  MAIN_PANE,
  MAX_SPLITS,
  childSessionsOf,
  focusPane,
  focusedPaneKey,
  isDraftSession,
  navigateFocused,
  openRunsPanel,
  openSplitPicker,
  removeSplitPane,
  pendingRequests,
  requestInterrupt,
  revealSubagentComposer,
  selectSession,
  sessionOrSubagentsLive,
  startDraftSession,
  useStore,
} from "./store";

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

  // Extension page route (/ext/{id}): a purely additional branch — when it
  // matches, it replaces the MAIN pane's surface only; the sidebar, splits,
  // footer and all overlays compose exactly as on session routes.
  const pathname = useWindowPathname();
  const extPageID = EXT_ROUTE_RE.exec(pathname)?.[1] ?? null;
  const extPage = extPageID ? getPage(extPageID) : undefined;
  const extPageTitle = extPage?.title;

  // Browser tab mirrors the conversation: the session's title, prefixed
  // with a live dot while that session OR any of its subagents is working
  // or waiting on a send. Extension pages take over the title for their stay.
  useEffect(() => {
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
  }, [sessionID, session?.title, live, extPageTitle]);

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

  // ⌘F / Ctrl+F: jump to the sidebar's session search (the browser's own
  // find is shadowed while the app handles it). No-ops under overlays and
  // when the sidebar is collapsed (no search box rendered).
  function focusSessionSearch() {
    if (overlayOpen()) return;
    const box = document.getElementById("session-search") as HTMLInputElement | null;
    if (!box) return;
    box.focus();
    box.select();
  }

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
  });

  /** Focus follows pointer AND keyboard into a pane; the store no-ops when unchanged. */
  const focusThis = (paneID: string) => () => void focusPane(paneID);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          {/* Main pane: always the routed surface, even while a split holds focus. */}
          <section
            className="flex min-w-0 flex-1 flex-col"
            onPointerDownCapture={focusThis(MAIN_PANE)}
            onFocusCapture={focusThis(MAIN_PANE)}
          >
            {extPageID ? (
              // Extension page: full-page surface replacing the conversation
              // pane; the shell around it stays exactly as-is.
              <ExtensionPageSurface id={extPageID} />
            ) : mainSessionID ? (
              <Conversation
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
                <Conversation
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
      <ActivityStrip />
      <Slot region="footer" />
      <ForeignPendingChip />
      <SplitPicker />
      <CommandPalette />
      <CommandKeybinds />
      <Toasts />
      <HelpDialog />
      {/* The app's ONLY ShellPanel instance: trigger-less (hidden-span
          trigger), opened by requestShellPanel() ticks from the runs panel /
          composer chips — the sidebar no longer hosts one. */}
      <ShellPanel trigger={<span className="hidden" />} />
    </div>
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
  const foreignKey = foreign.map((f) => f.req.id).join(",");
  useEffect(() => {
    if (foreignKey) log("chip", `foreign waiting: ${foreignKey}`);
  }, [foreignKey]);
  if (foreign.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => void selectSession(foreign[0]!.req.sessionID, { history: "push" })}
      title={foreign.map((r) => `${r.kind} — ${r.req.sessionID}`).join("\n")}
      className="fixed right-4 bottom-10 z-40 flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--surface-warning-strong)_45%,transparent)] bg-[var(--surface-float-base)] px-2.5 py-1 text-xs text-[var(--text-weak)] shadow-md transition-colors hover:text-[var(--text-strong)]"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-[color:var(--surface-warning-strong)]" aria-hidden />
      {foreign.length} waiting in other session{foreign.length > 1 ? "s" : ""} — switch
    </button>
  );
}

function EmptyState({ connected }: { connected: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-500">
      <div className={`size-2.5 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`} />
      <p className="text-sm">
        {connected ? "Select or create a session on the left" : "Connecting to the opencode service…"}
      </p>
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
  const page = getPage(id);
  const pages = getPages();

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
              {back}
              <h1 className="truncate text-[var(--font-size-large)] font-medium text-[var(--text-strong)]">
                {page ? page.title : "Unknown extension page"}
              </h1>
            </div>
            {page?.description && (
              <p className="mt-1 text-sm text-[var(--text-weaker)]">{page.description}</p>
            )}
          </div>
        </div>
        <div className="mt-4">
          {page ? (
            page.render({})
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
                        title={p.description ?? p.title}
                        className="text-[var(--text-interactive-base)] underline underline-offset-2"
                      >
                        /ext/{p.id} — {p.title}
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
