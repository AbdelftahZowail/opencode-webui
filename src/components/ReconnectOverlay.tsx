import { RefreshCw, WifiOff } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { Spinner } from "./ui";

/**
 * R11 — Reconnecting scrim (v2 `component/reconnecting.tsx`).
 *
 * A full-screen, input-blocking overlay shown while the SSE stream and/or the
 * service endpoint is down. Purely presentational: the store owns
 * `connected`/`serviceOK`; the caller passes them (plus an optional retry).
 * Renders nothing while both are healthy, so it costs one comparison at rest.
 *
 * Targets: `reconnect.overlay`.
 */

export interface ReconnectOverlayProps {
  /** The live SSE stream is attached. */
  connected: boolean;
  /** The proxy can reach the service (`/api/webui/status` ok). */
  serviceOK: boolean;
  /** Optional manual re-probe (the proxy also self-reconnects). */
  onRetry?: () => void;
}

export function ReconnectOverlay({ connected, serviceOK, onRetry }: ReconnectOverlayProps) {
  if (connected && serviceOK) return null;

  const serviceDown = !serviceOK;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={serviceDown ? "Service unavailable" : "Reconnecting"}
      data-oc-reconnect
      data-oc-reconnect-state={serviceDown ? "service" : "stream"}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-[color-mix(in_oklch,var(--background-base)_82%,transparent)] px-6 text-center backdrop-blur-sm duration-150 animate-in fade-in"
    >
      <div className="flex size-12 items-center justify-center rounded-full border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] shadow-lg">
        {serviceDown ? (
          <WifiOff className="size-5 text-[var(--surface-critical-strong)]" />
        ) : (
          <Spinner className="size-5" />
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-[var(--text-strong)]">
          {serviceDown ? "Cannot reach the opencode service" : "Reconnecting…"}
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-[var(--text-weak)]">
          {serviceDown
            ? "The webui proxy is up, but the engine did not answer. It may be starting or restarting."
            : "The event stream dropped. Any running turn continues on the engine; the transcript catches up on reconnect."}
        </p>
      </div>
      {serviceDown && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] px-3 py-1.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
        >
          <RefreshCw className="size-3.5" />
          Retry now
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "reconnect.overlay": (p) => <ReconnectOverlay {...(p as unknown as ReconnectOverlayProps)} />,
});
