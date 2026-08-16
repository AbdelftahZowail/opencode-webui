import { CommandPalette } from "./components/CommandPalette";
import { Conversation } from "./components/Conversation";
import { FormModal } from "./components/FormModal";
import { PermissionModal } from "./components/PermissionModal";
import { QuestionModal } from "./components/QuestionModal";
import { Sidebar } from "./components/Sidebar";
import { SlotOutlet } from "./extensions/registry";
import { useHotkeys } from "./hooks/useHotkeys";
import { newSession, useStore } from "./store";

export default function App() {
  const sessionID = useStore((s) => s.currentSessionID);
  const connected = useStore((s) => s.connected);

  useHotkeys({ "ctrl+n": () => void newSession() });

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
      <PermissionModal />
      <FormModal />
      <QuestionModal />
      <CommandPalette />
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
