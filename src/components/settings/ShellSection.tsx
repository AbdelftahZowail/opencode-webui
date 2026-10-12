import { useEffect, useState } from "react";
import { Check, RefreshCw, Terminal } from "lucide-react";
import { api, type ConfigEntry } from "../../api/client";
import { autoRegister } from "../../extensions/registry";
import { Button } from "../ui/button";
import { ErrorNote, SectionHeader, useAsync } from "./shared";

/**
 * Settings › Shell (parity R12 — the P4 deferral).
 *
 * The shell preference is GLOBAL (no `location`): the current value is read
 * from the global config document (`GET /api/config` → the `document` entry's
 * `info.shell`) and written with `PATCH /api/experimental/config { shell }`
 * (204). Available shells come from `GET /api/config/shell`.
 *
 * Self-registers the `settings.shell` target; SettingsDialog renders it in a
 * "Shell" tab through `<Target id="settings.shell" />`.
 */

/** The current global shell preference, or null for the engine default. */
function readShellPreference(entries: ConfigEntry[]): string | null {
  for (const entry of entries) {
    if (entry.type !== "document") continue;
    const shell = entry.info.shell;
    if (typeof shell === "string" && shell.length > 0) return shell;
  }
  return null;
}

export function ShellSection() {
  const { data, error, loading, refresh } = useAsync(async () => {
    const [shells, config] = await Promise.all([api.configShells(), api.configGet()]);
    return { shells, current: readShellPreference(config) };
  });
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setCurrent(data.current);
    setSaved(false);
    setSaveError(null);
  }, [data]);

  async function choose(shell: string | null): Promise<void> {
    setBusy(shell ?? "__default__");
    setSaveError(null);
    setSaved(false);
    try {
      await api.configPreferencesUpdate({ shell });
      setCurrent(shell);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorNote message={error} />;

  const shells = data?.shells ?? [];
  const acceptable = shells.filter((s) => s.acceptable);
  const unavailable = shells.filter((s) => !s.acceptable);

  return (
    <div data-oc-shell-section className="space-y-4">
      <SectionHeader
        title="Shell"
        note="the shell the engine runs commands with — a global preference"
        onRefresh={refresh}
        loading={loading}
      />

      {saveError && <ErrorNote message={saveError} />}

      {!data ? (
        <p className="py-6 text-center text-xs text-[var(--text-weaker)]">Loading…</p>
      ) : (
        <div className="space-y-2">
          <ShellRow
            label="Engine default"
            detail="Let the engine pick (no explicit preference)"
            selected={current === null}
            busy={busy === "__default__"}
            onSelect={() => void choose(null)}
          />
          {acceptable.map((shell) => (
            <ShellRow
              key={shell.path}
              label={shell.name}
              detail={shell.path}
              selected={current === shell.path}
              busy={busy === shell.path}
              onSelect={() => void choose(shell.path)}
            />
          ))}
          {unavailable.length > 0 && (
            <div className="pt-1">
              <p className="mb-1 text-[11px] text-[var(--text-weaker)]">
                Not runnable on this host
              </p>
              <div className="space-y-1">
                {unavailable.map((shell) => (
                  <div
                    key={shell.path}
                    className="flex items-center gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-1.5 opacity-60"
                  >
                    <Terminal className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-weaker)]">
                      {shell.path}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {shells.length === 0 && (
            <p className="py-3 text-center text-xs text-[var(--text-weaker)]">
              The engine reported no shells.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1 text-[11px] text-[var(--text-weaker)]">
        <span>
          {saved
            ? "Saved to the global config."
            : current
              ? `Current: ${current}`
              : "Using the engine default."}
        </span>
        <Button variant="ghost" size="xs" disabled={loading} onClick={refresh}>
          <RefreshCw className={loading ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>
    </div>
  );
}

function ShellRow({
  label,
  detail,
  selected,
  busy,
  onSelect,
}: {
  label: string;
  detail: string;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-oc-shell-option
      onClick={onSelect}
      disabled={busy}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors disabled:opacity-60 ${
        selected
          ? "border-[var(--border-selected)] bg-[var(--surface-interactive-weak)]"
          : "border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] hover:border-[var(--border-hover)]"
      }`}
    >
      <Terminal className="size-3.5 shrink-0 text-[var(--text-weak)]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-[var(--text-strong)]">{label}</span>
        <span className="truncate font-mono text-[10px] text-[var(--text-weaker)]">{detail}</span>
      </span>
      {busy ? (
        <RefreshCw className="size-3.5 shrink-0 animate-spin text-[var(--text-weaker)]" />
      ) : (
        selected && <Check className="size-4 shrink-0 text-[var(--border-selected)]" />
      )}
    </button>
  );
}

autoRegister({
  "settings.shell": () => <ShellSection />,
});
