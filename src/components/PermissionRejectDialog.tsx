import { useEffect, useRef, useState } from "react";
import { ShieldOff } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "./ui/dialog";

/**
 * R8 — reject a permission WITH a message (v2 `routes/session/permission.tsx:284-307`).
 *
 * v2 opens a textarea when you reject and sends the typed reason as the reply
 * body's `message`; the webui always sent `message: null`. This dialog collects
 * the reason and hands it to `onReject`. It is presentational — it never calls
 * the store or `api.*`; the pending-request surface owns the reply so the
 * existing "keep the request pending until the engine accepts it" contract is
 * preserved.
 *
 * Target: `permission.reject`. `ctrl/⌘+Enter` rejects, `esc` cancels.
 *
 * NOTE: the store's `replyPermission` and `api.replyPermission` forward
 * `message` through the reply body (`{decision, message}`) — R8 wired it.
 */
export interface PermissionRejectDialogProps {
  open: boolean;
  /** Optional context shown above the textarea (tool id / action). */
  action?: string | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the (trimmed) reason when Reject is confirmed. Empty when
   *  the user rejects without typing anything. */
  onReject: (message: string) => void;
}

export function PermissionRejectDialog({
  open,
  action,
  onOpenChange,
  onReject,
}: PermissionRejectDialogProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fresh textarea each time the dialog opens.
  useEffect(() => {
    if (open) {
      setMessage("");
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

  function confirm() {
    onReject(message.trim());
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogContent
          showCloseButton={false}
          data-oc-permission-reject
          className="flex w-[min(30rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-4 py-2.5">
            <ShieldOff className="size-4 shrink-0 text-[color:var(--surface-critical-strong)]" />
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
              Reject permission
            </DialogTitle>
          </div>

          <div className="p-4">
            <p className="text-xs text-[var(--text-weak)]">
              Tell the agent why — the reason is sent with the rejection.
              {action ? (
                <>
                  {" "}
                  Request: <span className="font-mono text-[var(--text-strong)]">{action}</span>
                </>
              ) : null}
            </p>
            <Textarea
              ref={textareaRef}
              data-oc-permission-reject-input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  confirm();
                }
              }}
              placeholder="Why are you rejecting this? (optional)"
              className="mt-2 min-h-20 font-mono text-xs"
            />
          </div>

          <div className="flex items-center gap-2 border-t border-[var(--border-weak-base)] px-4 py-2">
            <span className="flex-1 font-mono text-[10px] text-[var(--text-weaker)]">
              <span className="text-[var(--text-weak)]">ctrl/⌘+↵</span> reject ·{" "}
              <span className="text-[var(--text-weak)]">esc</span> cancel
            </span>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" data-oc-permission-reject-confirm onClick={confirm}>
              Reject
            </Button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "permission.reject": (p) => (
    <PermissionRejectDialog {...(p as unknown as PermissionRejectDialogProps)} />
  ),
});
