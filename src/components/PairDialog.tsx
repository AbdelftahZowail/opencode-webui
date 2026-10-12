import { useMemo, type ReactNode } from "react";
import { Copy, Link2, QrCode as QrIcon, ShieldCheck } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { encodeQr, qrPath, type QrMatrix } from "../lib/qr";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "./ui/dialog";

/**
 * R11 — Pairing dialog (v2 `component/dialog-pair.tsx`).
 *
 * Shows "This device" URL, every known service URL, the username and a MASKED
 * password, plus a QR that encodes the public URL for a phone to scan.
 *
 * QR is rendered from our own dependency-free byte-mode encoder
 * (`src/lib/qr.ts`) — no new dependency (AGENTS rule 5). Black-on-white is
 * deliberate: a QR must be high-contrast to scan, and Tailwind's `bg-white` /
 * `fill-black` utilities are tokens-free primitives, not hardcoded hex. If the
 * value is too long to encode we fall back to the URL text rather than a
 * broken square.
 *
 * Targets: `pair.dialog`.
 */

export interface PairInfo {
  /** The origin this browser is on ("This device"). */
  thisUrl: string;
  /** Every advertised service URL. */
  urls: string[];
  /** Login username. */
  username: string;
  /** The password ALREADY masked by the caller — never the real secret. */
  passwordMasked: string;
  /** The URL the QR encodes (the public/tailnet URL to reach from a phone). */
  qrUrl: string;
}

export interface PairDialogProps {
  open: boolean;
  info: PairInfo;
  onCopy?: (text: string) => void | Promise<void>;
  onClose: () => void;
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

export function PairDialog({ open, info, onCopy, onClose }: PairDialogProps) {
  const qr = useMemo(() => {
    try {
      return encodeQr(info.qrUrl, "M");
    } catch {
      return null;
    }
  }, [info.qrUrl]);

  const copy = (text: string) => {
    void Promise.resolve((onCopy ?? copyToClipboard)(text));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogContent
          showCloseButton={false}
          data-oc-pair-dialog
          className="flex w-[min(30rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
        >
          <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-4 py-2.5">
            <QrIcon className="size-4 shrink-0 text-[var(--text-interactive-base)]" />
            <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-strong)]">
              Pair a device
            </DialogTitle>
          </div>

          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-start gap-3">
              <div className="shrink-0 rounded-lg bg-white p-2" data-oc-pair-qr>
                {qr ? <QrSvg matrix={qr} /> : <QrFallback url={info.qrUrl} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-[var(--text-weak)]">
                  Scan from a phone on the same network — it opens this URL.
                </p>
                <p className="mt-1 break-all font-mono text-[10px] text-[var(--text-weaker)]">
                  {info.qrUrl}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5" data-oc-pair-fields>
              <Field
                icon={<Link2 className="size-3.5" />}
                label="This device"
                value={info.thisUrl}
                onCopy={() => copy(info.thisUrl)}
              />
              {info.urls
                .filter((u) => u !== info.thisUrl)
                .map((u) => (
                  <Field key={u} icon={<Link2 className="size-3.5" />} label="URL" value={u} onCopy={() => copy(u)} />
                ))}
              <Field
                icon={<ShieldCheck className="size-3.5" />}
                label="Username"
                value={info.username}
                onCopy={() => copy(info.username)}
              />
              <Field
                icon={<ShieldCheck className="size-3.5" />}
                label="Password"
                value={info.passwordMasked}
                mono={false}
                onCopy={() => copy(info.passwordMasked)}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[var(--border-weak-base)] px-4 py-2">
            <span className="flex-1 font-mono text-[10px] text-[var(--text-weaker)]">
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

function QrSvg({ matrix }: { matrix: QrMatrix }) {
  // 4-module quiet zone, unit grid; scaled by CSS.
  const quiet = 4;
  const side = matrix.size + quiet * 2;
  return (
    <svg
      role="img"
      aria-label="Pairing QR code"
      viewBox={`0 0 ${side} ${side}`}
      className="size-36 fill-black"
      shapeRendering="crispEdges"
    >
      <rect x="0" y="0" width={side} height={side} className="fill-white" />
      <g transform={`translate(${quiet} ${quiet})`}>
        <path d={qrPath(matrix)} />
      </g>
    </svg>
  );
}

function QrFallback({ url }: { url: string }) {
  return (
    <div className="flex size-36 flex-col items-center justify-center gap-2 p-2 text-center">
      <QrIcon className="size-5 text-black/60" />
      <p className="break-all font-mono text-[9px] leading-tight text-black/70">{url}</p>
    </div>
  );
}

function Field({
  icon,
  label,
  value,
  mono = true,
  onCopy,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="shrink-0 text-[var(--text-weaker)]">{icon}</span>
      <span className="w-20 shrink-0 text-[var(--text-weaker)]">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-[var(--text-strong)] ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </span>
      <button
        type="button"
        onClick={onCopy}
        title={`Copy ${label}`}
        aria-label={`Copy ${label}`}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
      >
        <Copy className="size-3" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "pair.dialog": (p) => <PairDialog {...(p as unknown as PairDialogProps)} />,
});
