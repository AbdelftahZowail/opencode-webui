import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api, type WebuiTelemetry } from "../../api/client";
import { autoRegister } from "../../extensions/registry";
import { Switch } from "../ui/switch";
import { ErrorNote, SectionHeader } from "./shared";

/**
 * Settings › Telemetry (anonymous usage).
 *
 * The opt-out control for the proxy's anonymous usage heartbeat
 * (server/telemetry.ts). Reads/writes `/api/webui/telemetry`; the running
 * process applies the toggle live (no restart). When `WEBUI_TELEMETRY=false`
 * pins it off, or the build is not a published release, the switch is locked
 * and the reason is shown — the same "why is this locked" shape as Settings ›
 * Security. Copy stays low-key and factual, mirroring Quickly's telemetry pane.
 *
 * Self-registers the `settings.telemetry` target; Settings › About renders it as
 * its "Usage data" block through `<Target id="settings.telemetry" heading={false} />`
 * (the About section supplies the heading). `heading` defaults to true, so any
 * other host keeps the original section header.
 */
export function TelemetrySection({ heading = true }: { heading?: boolean } = {}) {
  const [state, setState] = useState<WebuiTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.webuiTelemetry());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.webuiTelemetryUpdate(next));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !state) return <ErrorNote message={error} />;
  if (!state) {
    return <p className="py-6 text-center text-xs text-[var(--text-weaker)]">Loading…</p>;
  }

  const locked = state.envDisabled;
  const status = state.envDisabled
    ? "Off — pinned by WEBUI_TELEMETRY, which wins over this switch."
    : !state.release
      ? "Inactive — a dev, binary or sandbox build never sends."
      : !state.configured
        ? "Inactive — no hub key is configured."
        : state.enabled
          ? "On — a coarse heartbeat is sent about every 12 hours."
          : "Off — nothing is sent.";

  return (
    <div data-oc-telemetry-section className="space-y-4">
      <div>
        {heading && <SectionHeader title="Telemetry" note="anonymous usage — opt out any time" />}
        <p className="mb-2 text-[11px] leading-relaxed text-[var(--text-weaker)]">
          A coarse, non-identifying heartbeat: a random per-install id (used only to
          de-duplicate), the app version, deployment form (docker/bare), OS and CPU
          family, CPU count, RAM rounded up to whole GB, uptime, and aggregate counts
          (sessions, installed extensions). No hostnames, exact OS/kernel or disk
          details, environment variables, IP addresses, file paths, session titles,
          prompts, message content, or model output. Enabled by default; turn it off
          here.
        </p>
        <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[13px] text-[var(--text-strong)]">
              <Activity className="size-3.5" />
              Send anonymous usage data
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--text-weaker)]">{status}</p>
          </div>
          <div data-oc-telemetry-toggle className="shrink-0">
            <Switch
              checked={state.enabled && !locked}
              disabled={busy || locked}
              title={locked ? "Pinned off by WEBUI_TELEMETRY" : "Anonymous usage data"}
              aria-label="Send anonymous usage data"
              onCheckedChange={(v) => void toggle(v)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-[11px] text-[var(--text-weaker)]">
          Hub: <code className="font-mono">{state.url}</code>
        </p>
        <p className="text-[11px] text-[var(--text-weaker)]">
          Install id: <code className="font-mono">{state.instanceId}</code> · version{" "}
          <code className="font-mono">{state.version}</code>
        </p>
      </div>

      {error && <ErrorNote message={error} />}
    </div>
  );
}

autoRegister({
  "settings.telemetry": (p) => <TelemetrySection heading={p.heading !== false} />,
});
