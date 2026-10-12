import { useEffect, useRef, useState } from "react";
import { Bug, Copy, FileWarning, Globe } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "./ui/dialog";

/**
 * R11 — Error details dialog (v2 `component/dialog-error-details.tsx`).
 *
 * Presentational: the caller owns the error. It renders the message in a
 * scrollable body, plus an optional source path and reference, and owns two
 * bindings of its own while open:
 *   `c` — copy the full report (message + source + reference + detail)
 *   `i` — "investigate": hand a diagnostic prompt to `onInvestigate`, which the
 *         orchestrator uses to navigate home and seed the composer.
 *
 * Targets: `errorDetails.dialog`.
 */

export interface ErrorDetailsDialogProps {
  open: boolean;
  /** Header label; defaults to "Error details". */
  title?: string;
  /** The user-facing error text (the scrollable body). */
  message: string;
  /** Optional file path / component the error came from. */
  source?: string | null;
  /** Optional reference (line, doc URL, request id…). */
  reference?: string | null;
  /** Optional raw detail (stack, response body). */
  detail?: string | null;
  /** Override the copy side effect (defaults to the async clipboard). */
  onCopy?: (text: string) => void | Promise<void>;
  /** Seed a diagnostic prompt + navigate home; receives the composed prompt. */
  onInvestigate?: (diagnostic: string) => void;
  onClose: () => void;
}

/**
 * The diagnostic prompt `i` hands to the orchestrator: structured so a model
 * can act without the user retyping the error.
 */
function buildDiagnosticPrompt(props: {
  message: string;
  source?: string | null;
  reference?: string | null;
  detail?: string | null;
}): string {
  const lines = ["Investigate this error and propose a fix:", "", "```", props.message.trim(), "```"];
  if (props.source) lines.push("", `Source: ${props.source}`);
  if (props.reference) lines.push(`Reference: ${props.reference}`);
  if (props.detail) lines.push("", "Detail:", "```", props.detail.trim(), "```");
  return lines.join("\n");
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
    /* clipboard unavailable — the text stays selectable in the dialog */
  }
}

export function ErrorDetailsDialog({
  open,
  title = "Error details",
  message,
  source,
  reference,
  detail,
  onCopy,
  onInvestigate,
  onClose,
}: ErrorDetailsDialogProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const report = [message, source ? `Source: ${source}` : "", reference ? `Reference: ${reference}` : "", detail ?? ""]
    .filter(Boolean)
    .join("\n\n");

  const doCopy = () => {
    const write = onCopy ?? copyToClipboard;
    void Promise.resolve(write(report)).finally(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  const doInvestigate = () => {
    onInvestigate?.(buildDiagnosticPrompt({ message, source, reference, detail }));
  };

  // Capture-phase so the site-wide Esc/hotkeys never see these keys while up.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c") {
        e.preventDefault();
        e.stopPropagation();
        doCopy();
      } else if (e.key === "i") {
        e.preventDefault();
        e.stopPropagation();
        doInvestigate();
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
          data-oc-error-details
          className="flex max-h-[80vh] w-[min(40rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-4 py-2.5">
            <FileWarning className="size-4 shrink-0 text-[var(--surface-critical-strong)]" />
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
              {title}
            </DialogTitle>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4" data-oc-error-details-body>
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-[var(--text-base)]">
              {message}
            </pre>

            {(source || reference) && (
              <div className="mt-3 flex flex-col gap-1 text-xs">
                {source && (
                  <div className="flex items-center gap-1.5">
                    <FileWarning className="size-3 shrink-0 text-[var(--text-weaker)]" />
                    <span className="truncate text-[var(--text-weak)]" title={source}>
                      {source}
                    </span>
                  </div>
                )}
                {reference && (
                  <div className="flex items-center gap-1.5">
                    <Globe className="size-3 shrink-0 text-[var(--text-weaker)]" />
                    <span className="truncate text-[var(--text-weak)]" title={reference}>
                      {reference}
                    </span>
                  </div>
                )}
              </div>
            )}

            {detail && (
              <pre className="mt-3 max-h-64 overflow-y-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-weak)]">
                {detail}
              </pre>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-[var(--border-weak-base)] px-4 py-2">
            <button
              type="button"
              data-oc-error-details-copy
              onClick={doCopy}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
            >
              <Copy className="size-3.5" />
              {copied ? "Copied" : "Copy"}
            </button>
            {onInvestigate && (
              <button
                type="button"
                data-oc-error-details-investigate
                onClick={doInvestigate}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
              >
                <Bug className="size-3.5" />
                Investigate
              </button>
            )}
            <span className="flex-1" />
            <span className="font-mono text-[10px] text-[var(--text-weaker)]">
              <span className="text-[var(--text-weak)]">c</span> copy ·{" "}
              <span className="text-[var(--text-weak)]">i</span> investigate ·{" "}
              <span className="text-[var(--text-weak)]">esc</span> close
            </span>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-md border border-[var(--border-weak-base)] px-2 py-1 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
            >
              Close
            </button>
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
  "errorDetails.dialog": (p) => <ErrorDetailsDialog {...(p as unknown as ErrorDetailsDialogProps)} />,
});
