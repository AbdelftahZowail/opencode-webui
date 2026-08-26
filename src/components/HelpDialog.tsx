import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useStore } from "../store";
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";

const KEYBINDS: [string, string][] = [
  ["Enter", "Send · queue while the agent works"],
  ["Esc", "Interrupt the running agent"],
  ["Tab / Shift+Tab", "Next / previous agent"],
  ["↑ / ↓ (input at start/end)", "Prompt history"],
  ["↓ (outside input)", "Subagents & shells dialog"],
  ["← / → (outside input)", "Cycle subagent sessions"],
  ["↑ (outside input)", "Parent session"],
  ["Ctrl+B", "Background synchronous subagents"],
  ["Ctrl+P", "Command palette"],
  ["Ctrl+N", "New session"],
  ["⌘F / Ctrl+F", "Search sessions"],
  ["/", "Slash commands & skills"],
  ["@", "Reference files"],
  ["!", "Shell mode"],
];

export function HelpDialog() {
  const tick = useStore((s) => s.uiSignals.help);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (tick) setOpen(true);
  }, [tick]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay className="bg-black/40" />
        <DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 shadow-xl outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
          <DialogTitle className="mb-3 text-sm font-medium text-[var(--text-strong)]">Keybinds</DialogTitle>
          <dl className="space-y-1.5 text-xs">
            {KEYBINDS.map(([key, desc]) => (
              <div key={key} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 rounded border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-base)]">
                  {key}
                </dt>
                <dd className="text-right text-[var(--text-weak)]">{desc}</dd>
              </div>
            ))}
          </dl>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
