import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { XIcon } from "lucide-react";
import type { PermissionRequest } from "../api/types";
import { replyPermission, useStore } from "../store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

export function PermissionModal() {
  const currentID = useStore((s) => s.currentSessionID);
  const permissions = useStore((s) => s.permissions);
  const mine = permissions.filter((p) => p.sessionID === currentID);

  if (mine.length === 0) return null;
  const req = mine[0]!;

  return <PermissionDialog key={req.id} req={req} queued={mine.length - 1} />;
}

function PermissionDialog({ req, queued }: { req: PermissionRequest; queued: number }) {
  const [open, setOpen] = useState(true);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) void replyPermission(req.id, "reject");
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={contentCls}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Permission required
              <Badge variant="outline" className="border-[var(--border-weak-base)] text-[var(--surface-warning-strong)]">
                {req.action}
              </Badge>
            </DialogTitle>
          </DialogHeader>
          {req.resources.length > 0 && (
            <div className="space-y-1">
              {req.resources.map((r, i) => (
                <pre
                  key={i}
                  className="overflow-x-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-base)]"
                >
                  {r}
                </pre>
              ))}
            </div>
          )}
          {req.metadata && Object.keys(req.metadata).length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-2.5 font-mono text-xs whitespace-pre-wrap text-[var(--text-weak)]">
              {JSON.stringify(req.metadata, null, 2)}
            </pre>
          )}
          {req.source && (
            <DialogDescription>
              Requested by tool <span className="font-mono text-[var(--text-strong)]">{req.source.id}</span>
            </DialogDescription>
          )}
          <p className="text-xs text-[var(--text-weaker)]">More requests are queued behind this one: {queued}</p>
          <DialogFooter className="rounded-b-lg">
            <Button variant="destructive" onClick={() => void replyPermission(req.id, "reject")}>
              Reject
            </Button>
            <Button variant="secondary" onClick={() => void replyPermission(req.id, "once")}>
              Once
            </Button>
            <Button onClick={() => void replyPermission(req.id, "always")}>Always allow</Button>
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
  );
}
