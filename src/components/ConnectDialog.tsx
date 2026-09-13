import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";
import { ScrollArea } from "./ui/scroll-area";
import { IntegrationsSection } from "./settings/IntegrationsSection";

/**
 * TUI-style `/connect`: a dedicated surface (no Settings tab) for connecting
 * model providers via API key, OAuth, or CLI command. Opened by the composer's
 * /connect slash command and the command palette. Mounted app-wide; the Radix
 * dialog only mounts its content (and the section's pollers) while open.
 */
let openRequest: (() => void) | null = null;

export function openConnect() {
  openRequest?.();
}

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid h-[min(84vh,660px)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-3xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

export function ConnectDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    openRequest = () => setOpen(true);
    return () => {
      openRequest = null;
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={contentCls}>
          <DialogHeader className="pr-8">
            <DialogTitle>Connect</DialogTitle>
            <p className="text-xs text-[var(--text-weaker)]">
              Connect model providers — API keys, OAuth, or CLI. Same catalog as the TUI’s /connect.
            </p>
          </DialogHeader>

          <ScrollArea className="min-h-0 flex-1 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-3">
            <IntegrationsSection />
          </ScrollArea>

          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogClose>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
