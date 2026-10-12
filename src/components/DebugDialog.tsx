import { useEffect, useMemo, useRef, useState } from "react";
import { Bug, Copy } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "./ui/dialog";

/**
 * R11 — Debug dialog (v2 `component/dialog-debug.tsx`).
 *
 * Shows version/channel, date, OS, session id and model — the facts a bug
 * report needs. `Enter` copies the whole block. Presentational: the caller
 * supplies what it has; the OS/date fall back to the browser and now.
 *
 * Targets: `debug.dialog`.
 */

export interface DebugInfo {
  /** Engine version (e.g. from `GET /api/info`). */
  version?: string | null;
  /** Release channel (stable / beta / dev). */
  channel?: string | null;
  /** Epoch ms; defaults to now when the dialog opens. */
  date?: number | null;
  /** OS/platform string; defaults to the browser's. */
  os?: string | null;
  /** Focused session id. */
  sessionID?: string | null;
  /** Focused `provider/model` label. */
  model?: string | null;
}

export interface DebugDialogProps {
  open: boolean;
  info: DebugInfo;
  /** Override the copy side effect. */
  onCopy?: (text: string) => void | Promise<void>;
  onClose: () => void;
}

function defaultOs(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || navigator.platform || "unknown";
}

function defaultChannel(version: string | null | undefined): string {
  if (!version) return "unknown";
  return /-(beta|alpha|next|dev)/.test(version) ? "pre-release" : "stable";
}

async function copyToClipboard(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
  } catch {
    /* clipboard unavailable */
  }
}

export function DebugDialog({ open, info, onCopy, onClose }: DebugDialogProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Freeze the timestamp for the life of one open so the row is stable.
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  useEffect(() => {
    if (open) {
      setOpenedAt(Date.now());
      setCopied(false);
    }
  }, [open]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const rows = useMemo(() => {
    const version = info.version ?? "unknown";
    return [
      ["Version", version],
      ["Channel", info.channel ?? defaultChannel(info.version)],
      ["Date", new Date(info.date ?? openedAt).toISOString()],
      ["OS", info.os ?? defaultOs()],
      ["Session", info.sessionID ?? "—"],
      ["Model", info.model ?? "—"],
    ] as const;
  }, [info.version, info.channel, info.date, info.os, info.sessionID, info.model, openedAt]);

  const text = useMemo(() => rows.map(([k, v]) => `${k}: ${v}`).join("\n"), [rows]);

  const doCopy = () => {
    void Promise.resolve((onCopy ?? copyToClipboard)(text)).finally(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        doCopy();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogContent
          showCloseButton={false}
          data-oc-debug-dialog
          className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-4 py-2.5">
            <Bug className="size-4 shrink-0 text-[var(--text-interactive-base)]" />
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
              Debug
            </DialogTitle>
          </div>

          <dl className="flex flex-col gap-1.5 p-4 text-xs" data-oc-debug-fields>
            {rows.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-[var(--text-weaker)]">{label}</dt>
                <dd className="min-w-0 truncate font-mono text-[var(--text-strong)]" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          <div className="flex items-center gap-2 border-t border-[var(--border-weak-base)] px-4 py-2">
            <button
              type="button"
              data-oc-debug-copy
              onClick={doCopy}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
            >
              <Copy className="size-3.5" />
              {copied ? "Copied" : "Copy all"}
            </button>
            <span className="flex-1" />
            <span className="font-mono text-[10px] text-[var(--text-weaker)]">
              <span className="text-[var(--text-weak)]">↵</span> copy ·{" "}
              <span className="text-[var(--text-weak)]">esc</span> close
            </span>
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
  "debug.dialog": (p) => <DebugDialog {...(p as unknown as DebugDialogProps)} />,
});
