import { useEffect } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Conversation } from "./components/Conversation";
import { HelpDialog } from "./components/HelpDialog";
import { PendingRequestsModal } from "./components/PendingRequestsModal";
import { Sidebar } from "./components/Sidebar";
import { SlotOutlet } from "./extensions/registry";
import { handCharToComposer } from "./lib/composerHandoff";
import { useHotkeys } from "./hooks/useHotkeys";
import {
  childSessionsOf,
  isDraftSession,
  openRunsPanel,
  requestInterrupt,
  revealSubagentComposer,
  selectSession,
  startDraftSession,
  useStore,
} from "./store";

export default function App() {
  const sessionID = useStore((s) => s.currentSessionID);
  const connected = useStore((s) => s.connected);
  const session = useStore((s) =>
    s.currentSessionID
      ? s.sessions.find((x) => x.id === s.currentSessionID) ?? s.sessionDetails[s.currentSessionID]
      : undefined,
  );
  const sessions = useStore((s) => s.sessions);
  const isPanelOpen = useStore((s) => s.runsPanelOpen);
  const running = useStore((s) => (sessionID ? (s.running[sessionID] ?? false) : false));
  const queued = useStore((s) => (sessionID ? !!s.queued[sessionID] : false));

  // Browser tab mirrors the conversation: the session's title, prefixed
  // with a live dot while that session is working or waiting on a send.
  useEffect(() => {
    document.title = !sessionID
      ? "OpenCode Web"
      : `${running || queued ? "● " : ""}${
          isDraftSession(sessionID)
            ? "New session"
            : (session?.title ?? "Untitled session")
        }`;
  }, [sessionID, session?.title, running, queued]);

  // TUI session-level arrow bindings — active only OUTSIDE inputs (in the
  // composer, up/down walk prompt history and left/right move the caret):
  //   ↑        parent session
  //   ← / →    previous / next subagent sibling (wraps)
  //   ↓        subagents & shells panel (RunsPanel owns keys while open)
  function overlayOpen() {
    return !!document.querySelector('[role="dialog"]') || isPanelOpen;
  }

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
    void selectSession(siblings[next]!.id);
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
      handCharToComposer(e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useHotkeys({
    arrowup: () => {
      if (!session?.parentID || !sessionID || overlayOpen()) return;
      void selectSession(session.parentID);
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
      if (!session?.parentID || !sessionID || overlayOpen()) return;
      const box = document.getElementById("composer-input") as HTMLTextAreaElement | null;
      if (box && box.value !== "") return;
      void selectSession(session.parentID);
    },
    "ctrl+n": () => startDraftSession(null),
    escape: (e) => {
      // Site-wide Esc arms/confirm-interrupts the active run, EXCEPT when any
      // overlay owns the key: dialogs (incl. the pending-request popup) close
      // themselves on Esc, the composer handles its own shell-mode/run Esc,
      // and dropdowns/menus/popovers need Esc to dismiss.
      const target = e?.target as HTMLElement | null;
      if (
        document.querySelector('[role="dialog"]') ||
        (target &&
          (target.id === "composer-input" ||
            target.closest('[data-radix-popper-content-wrapper], [cmdk-root], [data-slot="command"]')))
      ) {
        return;
      }
      requestInterrupt();
    },
  });

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {sessionID ? (
            <Conversation key={sessionID} sessionID={sessionID} />
          ) : (
            <EmptyState connected={connected} />
          )}
        </main>
      </div>
      <SlotOutlet slot="footer" />
      <PendingRequestsModal />
      <CommandPalette />
      <HelpDialog />
    </div>
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
