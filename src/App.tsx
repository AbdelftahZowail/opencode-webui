import { CommandPalette } from "./components/CommandPalette";
import { Conversation } from "./components/Conversation";
import { FormModal } from "./components/FormModal";
import { PermissionModal } from "./components/PermissionModal";
import { QuestionModal } from "./components/QuestionModal";
import { Sidebar } from "./components/Sidebar";
import { SlotOutlet } from "./extensions/registry";
import { useHotkeys } from "./hooks/useHotkeys";
import { interrupt, newSession, selectSession, useStore } from "./store";

export default function App() {
  const sessionID = useStore((s) => s.currentSessionID);
  const connected = useStore((s) => s.connected);
  const running = useStore((s) => (s.currentSessionID ? s.running[s.currentSessionID] ?? false : false));

  useHotkeys({
    "ctrl+n": () => void newSession(),
    escape: (e) => {
      // Site-wide Esc interrupts the active run, EXCEPT when a composer or an
      // overlay owns the key: the composer handles its own shell-mode/run Esc,
      // and dialogs/dropdowns/menus need Esc to close themselves.
      const target = e?.target as HTMLElement | null;
      if (
        target &&
        (target.id === "composer-input" ||
          target.closest(
            '[role="dialog"], [data-radix-popper-content-wrapper], [cmdk-root], [data-slot="command"]',
          ))
      ) {
        return;
      }
      if (running) void interrupt();
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
      <ForeignPendingChip />
      <PermissionModal />
      <FormModal />
      <QuestionModal />
      <CommandPalette />
    </div>
  );
}

function ForeignPendingChip() {
  const currentID = useStore((s) => s.currentSessionID);
  const permissions = useStore((s) => s.permissions);
  const forms = useStore((s) => s.forms);
  const questions = useStore((s) => s.questions);
  const foreign = [...permissions, ...forms, ...questions].filter((r) => r.sessionID !== currentID);
  if (foreign.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => void selectSession(foreign[0]!.sessionID, { history: "push" })}
      className="fixed right-4 bottom-10 z-40 rounded-full border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] px-2.5 py-1 text-xs text-[var(--text-weak)] shadow-md transition-colors hover:text-[var(--text-strong)]"
    >
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
