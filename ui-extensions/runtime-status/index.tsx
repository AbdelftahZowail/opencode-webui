import { register } from "../../src/extensions/registry";
import { useStore } from "../../src/store";

function RuntimeStatus() {
  const connected = useStore((s) => s.connected);
  const serviceOK = useStore((s) => s.serviceOK);
  const activeCount = useStore((s) => s.activeIDs.length);
  const online = connected && serviceOK;

  return (
    <footer className="flex min-h-7 items-center justify-end gap-3 border-t border-[var(--border-weak-base)] bg-[var(--background-base)] px-3 py-1 font-mono text-[10px] text-[var(--text-weaker)]">
      <span className="hidden sm:inline">webui extension</span>
      <span
        className="inline-flex items-center gap-1.5"
        title={online ? "Connected to the OpenCode service" : "Waiting for the OpenCode service"}
      >
        <span
          className={`size-1.5 rounded-full ${
            online ? "bg-[var(--surface-success-strong)]" : "bg-[var(--surface-warning-strong)]"
          }`}
        />
        {online ? "connected" : "offline"}
      </span>
      {activeCount > 0 && <span>{activeCount} active</span>}
    </footer>
  );
}

register({
  id: "runtime-status",
  slot: "footer",
  render: () => <RuntimeStatus />,
});
