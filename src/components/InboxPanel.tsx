import { useCallback, useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Inbox as InboxIcon, Send, Trash2, XIcon } from "lucide-react";
import { api } from "../api/client";
import type { InboxInfo } from "../api/types";
import { useStore } from "../store";
import { registerPoller } from "../lib/scheduler";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";

const contentCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

export function InboxPanel({
  open: openProp,
  onOpenChange,
}: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp ?? openInternal;
  const setOpen = (o: boolean) => {
    setOpenInternal(o);
    onOpenChange?.(o);
  };

  const currentSessionID = useStore((s) => s.currentSessionID);
  const [items, setItems] = useState<InboxInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!currentSessionID) return;
    try {
      const res = await api.inboxList(currentSessionID);
      setItems(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentSessionID]);

  useEffect(() => {
    if (!open || !currentSessionID) return;
    void load();
    // Cadence owned by the scheduler (runs only while this panel is open).
    return registerPoller({
      name: "inbox-panel",
      minInterval: 5_000,
      run: () => load(),
    });
  }, [open, currentSessionID, load]);

  const run = async (fn: () => Promise<unknown>) => {
    if (!currentSessionID) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendSteer = async () => {
    const text = message.trim();
    if (!text || !currentSessionID) return;
    await run(async () => {
      await api.inboxPrompt(currentSessionID!, text);
    });
    setMessage("");
  };

  const queued = items.filter((i) => i.delivery === "queue").length;

  const itemText = (item: InboxInfo) => {
    const payload = item.payload as { text?: string } | undefined;
    if (payload?.text) return payload.text;
    if (item.type === "compaction") return "Context compaction";
    if (item.type === "move") return "Workspace move";
    return "";
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={contentCls}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <InboxIcon className="size-4 text-[var(--text-weak)]" />
              Inbox
              <Badge variant="outline" className="border-[var(--border-weak-base)] text-[var(--surface-warning-strong)]">
                {queued} queued
              </Badge>
            </DialogTitle>
          </DialogHeader>
          {currentSessionID && (
            <p className="-mt-2 font-mono text-xs text-[var(--text-weaker)]">{currentSessionID}</p>
          )}
          {error && <p className="text-xs text-[var(--text-on-critical-base)]">{error}</p>}
          <ScrollArea className="h-64 rounded-md border border-[var(--border-weak-base)]">
            <div className="divide-y divide-[var(--border-weak-base)]">
              {items.length === 0 && (
                <p className="p-3 text-xs text-[var(--text-weaker)]">No pending messages for this session.</p>
              )}
              {items.map((item) => (
                <div key={item.id} className="space-y-2 p-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="border-[var(--border-weak-base)] text-[var(--text-weak)]">
                      {item.type}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={
                        item.delivery === "queue"
                          ? "border-[var(--border-weak-base)] text-[var(--surface-warning-strong)]"
                          : "border-[var(--border-weak-base)] text-[var(--text-interactive-base)]"
                      }
                    >
                      {item.delivery}
                    </Badge>
                    <span className="ml-auto font-mono text-[10px] text-[var(--text-weaker)]">
                      {new Date(item.timeCreated).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-xs whitespace-pre-wrap text-[var(--text-base)]">{itemText(item)}</p>
                  <div className="flex gap-1.5">
                    {item.delivery === "queue" ? (
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() => void run(() => api.inboxSteer(item.sessionID, item.id))}
                      >
                        Steer
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void run(() => api.inboxQueue(item.sessionID, item.id))}
                      >
                        Queue
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-[var(--text-on-critical-base)]"
                      disabled={busy}
                      onClick={() => void run(() => api.inboxDelete(item.sessionID, item.id))}
                    >
                      <Trash2 className="size-3" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter className="gap-2 rounded-b-lg sm:flex-row">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendSteer();
                }
              }}
              placeholder="Type a message to queue for this session"
              className="flex-1 font-mono text-xs"
            />
            <Button disabled={busy || !message.trim()} onClick={() => void sendSteer()}>
              <Send className="size-3.5" />
              Queue message
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
  );
}
