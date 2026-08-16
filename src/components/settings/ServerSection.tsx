import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Power, XIcon } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "../ui/dialog";
import { Empty, ErrorNote, SectionHeader, useAsync } from "./shared";

const dialogCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

export function ServerSection() {
  const { data, error, loading, refresh } = useAsync(() => api.serverInfo());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopResult, setStopResult] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <SectionHeader title="Server" note="Backend service" onRefresh={refresh} loading={loading} />
        {error && <ErrorNote message={error} />}
        {!error && data && data.urls.length === 0 && <Empty>No server endpoints.</Empty>}
        <div className="space-y-1">
          {data?.urls.map((u) => (
            <div
              key={u}
              className="flex items-center gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-1.5"
            >
              <span className="min-w-0 truncate font-mono text-xs text-[var(--text-strong)]">
                {u}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[13px] font-medium text-[var(--text-strong)]">Stop service</p>
            <p className="text-[11px] text-[var(--text-weaker)]">
              Request the managed opencode service to shut down. The web UI itself keeps running.
            </p>
          </div>
          <Button variant="destructive" onClick={() => setConfirmOpen(true)} disabled={stopping}>
            <Power />
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        </div>
        {stopResult && <p className="text-xs text-[var(--text-base)]">{stopResult}</p>}
        {stopError && <ErrorNote message={stopError} />}
      </div>

      {confirmOpen && (
        <Dialog open onOpenChange={(o) => !o && setConfirmOpen(false)}>
          <DialogPortal>
            <DialogOverlay className="bg-black/60" />
            <DialogPrimitive.Content data-slot="dialog-content" className={dialogCls}>
              <DialogHeader>
                <DialogTitle>Stop the service?</DialogTitle>
                <p className="text-xs text-[var(--text-weaker)]">
                  This stops the background opencode service. Running sessions will be interrupted.
                </p>
              </DialogHeader>
              <DialogFooter className="rounded-b-lg">
                <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={stopping}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={stopping}
                  onClick={() => {
                    setStopping(true);
                    setStopResult(null);
                    setStopError(null);
                    api
                      .serviceStop()
                      .then((r) => {
                        setStopResult(
                          r.accepted
                            ? "Stop accepted — the service is shutting down."
                            : "Stop not accepted — this instance is not the service owner.",
                        );
                      })
                      .catch((e: unknown) =>
                        setStopError(e instanceof Error ? e.message : String(e)),
                      )
                      .finally(() => {
                        setStopping(false);
                        setConfirmOpen(false);
                      });
                  }}
                >
                  Stop service
                </Button>
              </DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Button>
              </DialogClose>
            </DialogPrimitive.Content>
          </DialogPortal>
        </Dialog>
      )}
    </div>
  );
}
