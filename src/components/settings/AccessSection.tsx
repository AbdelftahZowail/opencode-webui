import { useEffect, useState } from "react";
import { AlertTriangle, Info, Lock, RotateCw, ShieldCheck } from "lucide-react";
import {
  api,
  type WebuiConfigPatch,
  type WebuiConfigShape,
  type WebuiExposure,
} from "../../api/client";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { CopyButton, ErrorNote, SectionHeader, inputCls, useAsync } from "./shared";

/**
 * Settings › Access — the ONE place serve/security settings are edited.
 *
 * Reads and writes `~/.config/opencode/webui/config.json` through
 * `/api/webui/settings`; the running process keeps the values it booted with,
 * so a save shows a "restart to apply" bar rather than pretending to hot-apply.
 * Values pinned by environment variables are shown locked with a reason.
 */
export function AccessSection() {
  const { data, error, loading, refresh } = useAsync(() => api.webuiSettings());
  const [draft, setDraft] = useState<WebuiConfigShape | null>(null);
  const [hostsText, setHostsText] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmExposure, setConfirmExposure] = useState<WebuiExposure | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDraft({ ...data.file });
    // Env-pinned fields show what is ACTUALLY in effect, not the shadowed file value.
    const hosts = data.envPinned.allowedHosts ? data.effective.allowedHosts : data.file.allowedHosts;
    setHostsText(hosts.join(", "));
    setPassword("");
    setPassword2("");
    setRemovePassword(false);
    setSaved(false);
  }, [data]);

  if (error) return <ErrorNote message={error} />;
  if (!data || !draft) return <p className="py-6 text-center text-xs text-[var(--text-weaker)]">{loading ? "Loading…" : "No settings."}</p>;

  const settings = data;
  const cfg = draft;
  const file = settings.file;
  const eff = settings.effective;
  /** The env var pinning this key, or null when the file is authoritative. */
  const envOf = (key: string): string | null => settings.envPinned[key] ?? null;
  const set = (patch: Partial<WebuiConfigShape>) => setDraft({ ...cfg, ...patch });
  const passwordMismatch = password.length > 0 && password !== password2;
  const passwordTooShort = password.length > 0 && password.length < 8;

  function buildPatch(): WebuiConfigPatch {
    const patch: WebuiConfigPatch = {};
    // Env-pinned keys are not editable here (env wins); never send them.
    if (!envOf("host") && cfg.host !== file.host) patch.host = cfg.host;
    if (!envOf("port") && cfg.port !== file.port) patch.port = cfg.port;
    if (!envOf("auth") && cfg.auth !== file.auth) patch.auth = cfg.auth;
    if (!envOf("trustProxy") && cfg.trustProxy !== file.trustProxy) patch.trustProxy = cfg.trustProxy;
    if (!envOf("autostart") && cfg.autostart !== file.autostart) patch.autostart = cfg.autostart;
    if (!envOf("publicUrl") && (cfg.publicUrl ?? "") !== (file.publicUrl ?? "")) patch.publicUrl = cfg.publicUrl || null;
    if (!envOf("allowedHosts")) {
      const hosts = hostsText.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (hosts.join(",") !== file.allowedHosts.join(",")) patch.allowedHosts = hosts;
    }
    if (!envOf("auth") && removePassword) patch.clearPassword = true;
    if (!envOf("auth") && password.length > 0) patch.password = password;
    return patch;
  }

  const dirty = Object.keys(buildPatch()).length > 0;

  async function save(confirm: boolean): Promise<void> {
    setBusy(true);
    setSaveError(null);
    const result = await api.webuiSettingsUpdate(buildPatch(), confirm);
    setBusy(false);
    if (!result.ok) {
      if ("needConfirm" in result && result.needConfirm) {
        setConfirmExposure(result.exposure);
        return;
      }
      if ("error" in result) setSaveError(result.error);
      return;
    }
    setConfirmExposure(null);
    setSaved(true);
    refresh();
  }

  function reset() {
    setDraft({ ...file });
    setHostsText((envOf("allowedHosts") ? eff.allowedHosts : file.allowedHosts).join(", "));
    setPassword("");
    setPassword2("");
    setRemovePassword(false);
    setSaved(false);
  }

  const exposure = settings.exposure;
  const exposureTone =
    exposure.level === "danger"
      ? "border-[var(--surface-critical-base)] bg-[var(--surface-critical-weak)] text-[var(--surface-critical-strong)]"
      : exposure.level === "warn"
        ? "border-[var(--surface-warning-base)] bg-[var(--surface-warning-weak)] text-[var(--surface-warning-strong)]"
        : "border-[var(--surface-success-base)] bg-[var(--surface-success-weak)] text-[var(--surface-success-strong)]";

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Access"
        note="who can reach this webui, and how they sign in"
        onRefresh={refresh}
        loading={loading}
      />

      {settings.runtime.dev && (
        <div className="flex items-start gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-interactive-weak)] px-2.5 py-2 text-[11px] text-[var(--text-interactive-base)]">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <strong>Dev mode:</strong> Vite serves this UI on{" "}
            <span className="font-mono">:{settings.runtime.vitePort ?? 5173}</span> and proxies <code>/api</code> to the
            proxy on <span className="font-mono">:{settings.runtime.port}</span> — two ports. The bind address and allowed
            hosts below apply to Vite too, so a phone opens{" "}
            <span className="font-mono">http://&lt;this-machine&gt;:{settings.runtime.vitePort ?? 5173}</span>. In
            production the proxy serves the UI on the port below.
          </span>
        </div>
      )}

      <p className="flex flex-wrap items-center gap-1 text-[11px] text-[var(--text-weaker)]">
        Saved in <code className="font-mono text-[var(--text-weak)]">{settings.runtime.configPath}</code>
        <CopyButton text={settings.runtime.configPath} />
        <span className="basis-full">
          Environment variables override this file. A field pinned by the environment is locked and names its variable
          — unset that variable and restart to edit it here.
        </span>
      </p>

      <div className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${exposureTone}`}>
        {exposure.level === "ok" ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
        <span>
          {exposure.level === "ok"
            ? `Loopback-only${cfg.auth === "password" ? " and password-protected" : ""} — nothing to fix.`
            : exposure.message}
        </span>
      </div>

      <Card title="Serving" note="where the proxy listens">
        <Field label="Bind address" envVar={envOf("host")}>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              className={inputCls}
              value={envOf("host") ? eff.host : cfg.host}
              disabled={!!envOf("host")}
              onChange={(e) => set({ host: e.target.value })}
              spellCheck={false}
            />
            <Chip onClick={() => set({ host: "127.0.0.1" })} disabled={!!envOf("host")}>127.0.0.1</Chip>
            <Chip onClick={() => set({ host: "0.0.0.0" })} disabled={!!envOf("host")}>0.0.0.0</Chip>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-weaker)]">
            Loopback is safest. A wildcard/other address reaches the network — pair it with a password or a trusted proxy.
          </p>
        </Field>
        <Field label="Proxy port" envVar={envOf("port")}>
          <input
            className={`${inputCls} max-w-32`}
            type="number"
            min={1}
            max={65535}
            value={envOf("port") ? eff.port : cfg.port}
            disabled={!!envOf("port")}
            onChange={(e) => set({ port: Number(e.target.value) })}
          />
          <p className="mt-1 text-[11px] text-[var(--text-weaker)]">
            The port the Bun proxy listens on. In production this is the URL you open; in dev it is internal (Vite is
            what you open). Don't set it to Vite's port.
          </p>
        </Field>
        <p className="text-[11px] text-[var(--text-weaker)]">
          Currently running on <span className="font-mono">{settings.runtime.host}:{settings.runtime.port}</span>.
        </p>
      </Card>

      <Card title="Authentication" note="one shared password for the whole UI">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] text-[var(--text-strong)]">Require a password</p>
            <p className="text-[11px] text-[var(--text-weaker)]">
              {settings.effective.passwordSet
                ? "A password is set. Leave the fields below blank to keep it."
                : "No password set — a generated one is used. Set your own below, or turn this off."}
            </p>
          </div>
          <Switch
            checked={cfg.auth === "password"}
            disabled={!!envOf("auth")}
            onCheckedChange={(checked) => set({ auth: checked ? "password" : "none" })}
          />
        </div>

        {cfg.auth === "none" ? (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-[var(--surface-warning-base)] bg-[var(--surface-warning-weak)] px-2.5 py-2 text-[11px] text-[var(--surface-warning-strong)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              No login. Anyone who can reach this port controls your sessions, files, and credentials. Use only on a
              private network (e.g. Tailscale) or with a trusted reverse proxy that authenticates for you.
            </span>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="New password">
                <input
                  className={inputCls}
                  type="password"
                  autoComplete="new-password"
                  placeholder="leave blank to keep"
                  value={password}
                  disabled={!!envOf("auth")}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Confirm">
                <input
                  className={inputCls}
                  type="password"
                  autoComplete="new-password"
                  value={password2}
                  disabled={!!envOf("auth")}
                  onChange={(e) => setPassword2(e.target.value)}
                />
              </Field>
            </div>
            {passwordTooShort && <p className="text-[11px] text-[var(--surface-critical-strong)]">Use at least 8 characters.</p>}
            {passwordMismatch && <p className="text-[11px] text-[var(--surface-critical-strong)]">Passwords do not match.</p>}
            {settings.effective.passwordSet && (
              <label className="flex items-center gap-2 text-[11px] text-[var(--text-weak)]">
                <input type="checkbox" checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} />
                Remove the saved password (fall back to a generated one)
              </label>
            )}
          </div>
        )}
      </Card>

      <Card title="Allowed hosts" note="extra Host header names accepted (comma-separated)">
        <Field label="Hostnames / IPs" envVar={envOf("allowedHosts")}>
          <input
            className={inputCls}
            placeholder="192.168.1.5, myserver.lan"
            value={hostsText}
            disabled={!!envOf("allowedHosts")}
            onChange={(e) => setHostsText(e.target.value)}
            spellCheck={false}
          />
        </Field>
        {hostsText.split(",").map((s) => s.trim()).includes("*") && (
          <p className="mt-1 text-[11px] text-[var(--surface-warning-strong)]">
            <code>*</code> accepts ANY Host header — only with a trusted reverse proxy.
          </p>
        )}
        <p className="mt-1 text-[11px] text-[var(--text-weaker)]">
          Loopback names and the bind address are always allowed; this is only for reaching the UI by another name.
        </p>
      </Card>

      <Card title="Reverse proxy" note="honor X-Forwarded-Host / Proto">
        <Toggle
          label="Trust X-Forwarded-* headers"
          note="Enable only when a reverse proxy you control sits in front. Without it those headers are ignored (spoofing-safe)."
          checked={envOf("trustProxy") ? eff.trustProxy : cfg.trustProxy}
          disabled={!!envOf("trustProxy")}
          onChange={(v) => set({ trustProxy: v })}
        />
      </Card>

      <Card title="Startup" note="run the webui with OpenCode">
        <Toggle
          label="Install the command + lifecycle plugin"
          note="First-run setup: a global `opencode-webui` command and the OpenCode plugin that starts the webui when you use OpenCode."
          checked={envOf("autostart") ? eff.autostart : cfg.autostart}
          disabled={!!envOf("autostart")}
          onChange={(v) => set({ autostart: v })}
        />
      </Card>

      <Card title="Public URL" note="optional — for the banner and reverse-proxy setups">
        <Field label="Canonical URL" envVar={envOf("publicUrl")}>
          <input
            className={inputCls}
            placeholder="https://webui.example.ts.net"
            value={(envOf("publicUrl") ? eff.publicUrl : cfg.publicUrl) ?? ""}
            disabled={!!envOf("publicUrl")}
            onChange={(e) => set({ publicUrl: e.target.value })}
            spellCheck={false}
          />
        </Field>
      </Card>

      {saveError && <ErrorNote message={saveError} />}

      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] px-2.5 py-2">
        <span className="text-[11px] text-[var(--text-weaker)]">
          {settings.restartRequired
            ? "Saved to disk — restart to apply."
            : saved
              ? "Saved."
              : dirty
                ? "Unsaved changes."
                : "Settings are applied."}
        </span>
        <div className="flex items-center gap-1.5">
          {settings.restartRequired && (
            <Button
              variant="secondary"
              size="sm"
              disabled={restarting}
              onClick={() => {
                setRestarting(true);
                void api.webuiRestart().catch(() => undefined);
                // Same-port restarts come straight back; reload once it's up
                // (a changed port needs the user to navigate to the new one).
                setTimeout(() => window.location.reload(), 2500);
              }}
            >
              <RotateCw className={restarting ? "animate-spin" : ""} />
              {restarting ? "Restarting…" : "Restart now"}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={!dirty || busy} onClick={reset}>
            Reset
          </Button>
          <Button
            size="sm"
            disabled={!dirty || busy || passwordMismatch || passwordTooShort}
            onClick={() => void save(false)}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {confirmExposure && (
        <ConfirmExposureDialog
          exposure={confirmExposure}
          busy={busy}
          onCancel={() => setConfirmExposure(null)}
          onConfirm={() => void save(true)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-3">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[13px] font-medium text-[var(--text-strong)]">{title}</h4>
        {note && <span className="text-[11px] text-[var(--text-weaker)]">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  envVar,
  children,
}: {
  label: string;
  /** The environment variable pinning this field, if any. */
  envVar?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-[var(--text-base)]">{label}</span>
        {envVar && (
          <span
            className="inline-flex items-center gap-1 rounded-sm border border-[var(--border-weak-base)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-weaker)]"
            title={`This value comes from the ${envVar} environment variable, which overrides the config file.`}
          >
            <Lock className="size-2.5" /> {envVar}
          </span>
        )}
      </div>
      {children}
      {envVar && (
        <p className="mt-1 text-[11px] text-[var(--surface-warning-strong)]">
          Overridden by <code>{envVar}</code> in the environment — there is no file for it; unset it where you launch
          the webui (or run <code>opencode-webui restart</code> from a shell that does not set it) to edit this here.
        </p>
      )}
    </div>
  );
}

function Chip({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2 py-1 font-mono text-[11px] text-[var(--text-weak)] transition-colors hover:text-[var(--text-strong)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Toggle({
  label,
  note,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  note?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-[13px] text-[var(--text-strong)]">{label}</p>
        {note && <p className="text-[11px] text-[var(--text-weaker)]">{note}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function ConfirmExposureDialog({
  exposure,
  busy,
  onCancel,
  onConfirm,
}: {
  exposure: WebuiExposure;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md space-y-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm">
        <div className="flex items-start gap-2 text-[var(--surface-critical-strong)]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium text-[var(--text-strong)]">Open the webui without a password?</p>
            <p className="mt-1 text-xs text-[var(--text-weak)]">{exposure.message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? "Saving…" : "I understand — save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
