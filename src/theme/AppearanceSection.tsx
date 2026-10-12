import { useEffect, useState } from "react";
import { Check, Monitor, Moon, RefreshCw, Sun } from "lucide-react";
import { autoRegister } from "../extensions/registry";
import { Button } from "../components/ui/button";
import { loadCustomThemes } from "../lib/themeFiles";
import {
  activeScheme,
  getTheme,
  getThemeMode,
  listAllThemes,
  resolveScheme,
  selectTheme,
  setThemeMode,
  subscribeTheme,
  themeScheme,
  themeVars,
  type Theme,
  type ThemeMode,
} from "./themes";

/**
 * Settings › Appearance (parity R12).
 *
 * The theme control: a dark/light/system mode selector (the web analogue of
 * the TUI's terminal-derived theme is `prefers-color-scheme`) + the theme list
 * (built-ins and custom themes discovered from `<config>/themes/*.json`).
 * Selecting a theme and switching the mode both repaint immediately.
 *
 * Self-registers the `settings.appearance` target; SettingsDialog renders it
 * in a "Themes / Appearance" tab through `<Target id="settings.appearance" />`.
 * (The header ThemePicker remains the quick switcher — this is the full
 * control, matching v2's settings dialog.)
 */

const MODES: { id: ThemeMode; label: string; icon: typeof Moon }[] = [
  { id: "dark", label: "Dark", icon: Moon },
  { id: "light", label: "Light", icon: Sun },
  { id: "system", label: "System", icon: Monitor },
];

export function AppearanceSection() {
  const [, setVersion] = useState(0);
  const [mode, setMode] = useState<ThemeMode>(getThemeMode());
  const [currentId, setCurrentId] = useState(getTheme().id);
  const [themes, setThemes] = useState<Theme[]>(() => listAllThemes());
  const [customCount, setCustomCount] = useState(0);
  const [loadingCustom, setLoadingCustom] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeTheme(() => {
        setVersion((v) => v + 1);
        setMode(getThemeMode());
        setCurrentId(getTheme().id);
        setThemes(listAllThemes());
      }),
    [],
  );

  async function refreshCustom(): Promise<void> {
    setLoadingCustom(true);
    setCustomError(null);
    try {
      const result = await loadCustomThemes();
      setCustomCount(result.themes.length);
      setCustomError(result.errors.length > 0 ? result.errors.join("\n") : null);
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingCustom(false);
    }
  }

  // Load custom themes on first open (they may already be loaded by the
  // boot-time call; reloading is cheap and reconciles the count).
  useEffect(() => {
    void refreshCustom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheme = activeScheme();
  const system = resolveScheme("system");

  function pickMode(next: ThemeMode): void {
    setMode(setThemeMode(next));
  }

  function pickTheme(id: string): void {
    selectTheme(id);
    setCurrentId(id);
  }

  return (
    <div data-oc-appearance-section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className="shrink-0 text-[13px] font-medium text-[var(--text-strong)]">Appearance</h3>
          <span className="truncate text-[11px] text-[var(--text-weaker)]">
            theme palette + dark/light/system
          </span>
        </div>
      </div>

      <section className="space-y-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[13px] text-[var(--text-strong)]">Mode</p>
            <p className="text-[11px] text-[var(--text-weaker)]">
              {mode === "system"
                ? `Following the OS — currently ${system} (effective ${scheme})`
                : `Pinned to ${scheme}`}
            </p>
          </div>
          <div
            data-oc-theme-mode
            role="radiogroup"
            aria-label="Colour scheme"
            className="flex shrink-0 rounded-md border border-[var(--border-weak-base)] p-0.5"
          >
            {MODES.map((m) => {
              const Icon = m.icon;
              const on = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-oc-theme-mode-option={m.id}
                  title={m.label}
                  onClick={() => pickMode(m.id)}
                  className={`flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                    on
                      ? "bg-[var(--surface-raised-strong)] text-[var(--text-strong)]"
                      : "text-[var(--text-weak)] hover:text-[var(--text-strong)]"
                  }`}
                >
                  <Icon className="size-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] text-[var(--text-weak)]">
            Themes{customCount > 0 ? ` · ${customCount} custom` : ""}
          </p>
          <Button variant="ghost" size="xs" disabled={loadingCustom} onClick={() => void refreshCustom()}>
            <RefreshCw className={loadingCustom ? "animate-spin" : ""} /> Reload custom
          </Button>
        </div>

        {customError && (
          <p className="whitespace-pre-wrap rounded-md border border-[var(--surface-warning-base)] bg-[var(--surface-warning-weak)] px-2.5 py-1.5 text-[11px] text-[var(--surface-warning-strong)]">
            {customError}
          </p>
        )}

        <div className="space-y-1.5">
          {themes.map((theme) => (
            <ThemeRow
              key={theme.id}
              theme={theme}
              mode={mode}
              selected={theme.id === currentId}
              onSelect={() => pickTheme(theme.id)}
            />
          ))}
        </div>

        <p className="text-[11px] text-[var(--text-weaker)]">
          Custom themes are read from <code className="font-mono">&lt;config&gt;/themes/*.json</code>.
          A file may pin <code className="font-mono">scheme: "light"</code> or{" "}
          <code className="font-mono">"dark"</code>.
        </p>
      </section>
    </div>
  );
}

function ThemeRow({
  theme,
  mode,
  selected,
  onSelect,
}: {
  theme: Theme;
  mode: ThemeMode;
  selected: boolean;
  onSelect: () => void;
}) {
  const scheme = themeScheme(theme, mode);
  const vars = themeVars(theme, scheme);
  const brand = vars["--surface-brand-base"] ?? "var(--surface-brand-base)";
  const accent = vars["--border-selected"] ?? "var(--border-selected)";
  const pinned = theme.scheme === "dark" || theme.scheme === "light";
  return (
    <button
      type="button"
      data-oc-theme-option={theme.id}
      onClick={onSelect}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
        selected
          ? "border-[var(--border-selected)] bg-[var(--surface-interactive-weak)]"
          : "border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] hover:border-[var(--border-hover)]"
      }`}
    >
      <span className="flex shrink-0 items-center -space-x-1" aria-hidden>
        <span className="size-4 rounded-full border border-[var(--border-weak-base)]" style={{ background: brand }} />
        <span className="size-4 rounded-full border border-[var(--border-weak-base)]" style={{ background: accent }} />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px] text-[var(--text-strong)]">{theme.label}</span>
        <span className="shrink-0 rounded-sm border border-[var(--border-weak-base)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--text-weaker)]">
          {theme.source === "custom" ? "custom" : scheme}
        </span>
        {pinned && (
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-[var(--text-weaker)]">
            pinned
          </span>
        )}
      </span>
      {selected && <Check className="size-4 shrink-0 text-[var(--border-selected)]" />}
    </button>
  );
}

autoRegister({
  "settings.appearance": () => <AppearanceSection />,
});
