import { register } from "../../src/extensions/registry";
import { useStore } from "../../src/store";

/** Harvested by ui-extensions/index.ts for hot add/remove pruning. */
export const id = "runtime-status";

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
  kind: "region",
  id: "runtime-status",
  region: "footer",
  render: () => <RuntimeStatus />,
});

// Self-accept so editing this extension hot-swaps it live: the module
// re-executes, re-registers with the same id (registry swaps it in), and
// SlotOutlets repaint — no page reload.
if (import.meta.hot) import.meta.hot.accept();
