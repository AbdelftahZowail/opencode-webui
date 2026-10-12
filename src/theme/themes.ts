/**
 * Theme engine (parity R12).
 *
 * Three axes, deliberately separate so they compose:
 *
 *  1. **Palette** — a named theme's `vars` (the accent/identity tokens). The
 *     built-ins below are dark accents layered on the dark base in
 *     `src/styles.css`; custom themes are discovered from
 *     `<config>/themes/*.json` (see `src/lib/themeFiles.ts`).
 *  2. **Scheme** — `dark` | `light`. This is the *base* palette. The light
 *     base is `LIGHT_BASE` (the web analogue of the TUI's terminal-derived
 *     theme is `prefers-color-scheme`).
 *  3. **Mode** — `dark` | `light` | `system`. `dark`/`light` pin the scheme;
 *     `system` follows the OS. A theme may itself *pin* a scheme via its
 *     `scheme` field (`"dark"`/`"light"`); a theme with no `scheme` (the
 *     default, `"auto"`) is *free* and follows the mode.
 *
 * `applyTheme(id, mode?)` resolves all three and writes ONE `<style id="oc-theme">`
 * element of CSS custom properties. Components never hardcode colours; they
 * consume `var(--…)` tokens (styles.css). The colour values here ARE the
 * token source, exactly as the pre-existing dark themes were.
 *
 * Nested token taxonomy: `TOKEN_GROUPS` is the nested group tree used to
 * classify a theme's vars (structural vs accent) and to drive any token
 * browser. `isStructuralToken` decides which of a free theme's vars survive a
 * light-mode override.
 */

export type ThemeScheme = "dark" | "light";
/** `auto` = free (follow the mode); explicit values pin the theme's scheme. */
export type ThemePinnedScheme = ThemeScheme | "auto";
export type ThemeMode = "dark" | "light" | "system";

export type Theme = {
  id: string;
  label: string;
  /** Tokens; keys are CSS custom-property names (`--…`). */
  vars: Record<string, string>;
  /** `auto` (default) follows the mode; `dark`/`light` pin the theme. */
  scheme?: ThemePinnedScheme;
  /** Where the theme came from — `builtin` unless registered from config. */
  source?: "builtin" | "custom";
};

const STORAGE_KEY = "webui.theme";
const MODE_KEY = "webui.theme.mode";
const STYLE_ID = "oc-theme";

// ---------------------------------------------------------------------------
// Nested token taxonomy
// ---------------------------------------------------------------------------

export type TokenGroup = {
  key: string;
  label: string;
  tokens: string[];
  children?: TokenGroup[];
};

/**
 * The nested taxonomy of the token contract (`src/styles.css`). Groups are
 * data, not renderers — anything that wants to display or classify tokens
 * walks `TOKEN_GROUPS` / `flattenTokenGroups`.
 */
export const TOKEN_GROUPS: TokenGroup[] = [
  {
    key: "surfaces",
    label: "Surfaces",
    tokens: [],
    children: [
      {
        key: "background",
        label: "Background",
        tokens: [
          "--background-base",
          "--background-weak",
          "--background-strong",
          "--background-stronger",
        ],
      },
      {
        key: "surface",
        label: "Surface",
        tokens: [
          "--surface-base",
          "--surface-base-hover",
          "--surface-base-active",
          "--surface-inset-base",
          "--surface-inset-strong",
          "--surface-raised-base",
          "--surface-raised-base-hover",
          "--surface-raised-base-active",
          "--surface-raised-strong",
          "--surface-raised-strong-hover",
          "--surface-raised-stronger",
          "--surface-raised-stronger-hover",
          "--surface-raised-stronger-non-alpha",
          "--surface-float-base",
          "--surface-float-base-hover",
          "--surface-weak",
          "--surface-weaker",
          "--surface-strong",
        ],
      },
      {
        key: "border",
        label: "Border",
        tokens: [
          "--border-base",
          "--border-hover",
          "--border-active",
          "--border-selected",
          "--border-disabled",
          "--border-focus",
          "--border-weak-base",
          "--border-strong-base",
          "--border-strong-hover",
          "--border-strong-active",
          "--border-strong-selected",
          "--border-strong-disabled",
          "--border-strong-focus",
        ],
      },
    ],
  },
  {
    key: "content",
    label: "Content",
    tokens: [],
    children: [
      {
        key: "text",
        label: "Text",
        tokens: [
          "--text-base",
          "--text-weak",
          "--text-weaker",
          "--text-strong",
          "--text-interactive-base",
          "--text-on-brand-base",
          "--text-on-interactive-base",
        ],
      },
      {
        key: "input",
        label: "Input",
        tokens: [
          "--input-base",
          "--input-hover",
          "--input-active",
          "--input-selected",
          "--input-focus",
          "--input-disabled",
        ],
      },
      {
        key: "button",
        label: "Button",
        tokens: [
          "--button-primary-base",
          "--button-secondary-base",
          "--button-secondary-hover",
          "--button-ghost-hover",
          "--button-ghost-hover2",
        ],
      },
    ],
  },
  {
    key: "status",
    label: "Status",
    tokens: [],
    children: [
      { key: "brand", label: "Brand", tokens: ["--surface-brand-base", "--surface-brand-hover"] },
      {
        key: "interactive",
        label: "Interactive",
        tokens: ["--surface-interactive-base", "--surface-interactive-weak"],
      },
      {
        key: "success",
        label: "Success",
        tokens: [
          "--surface-success-base",
          "--surface-success-weak",
          "--surface-success-strong",
          "--text-on-success-base",
        ],
      },
      {
        key: "warning",
        label: "Warning",
        tokens: ["--surface-warning-base", "--surface-warning-weak", "--surface-warning-strong"],
      },
      {
        key: "critical",
        label: "Critical",
        tokens: [
          "--surface-critical-base",
          "--surface-critical-weak",
          "--surface-critical-strong",
          "--text-on-critical-base",
          "--text-on-critical-weak",
          "--text-on-critical-strong",
        ],
      },
      {
        key: "info",
        label: "Info",
        tokens: ["--surface-info-base", "--surface-info-weak", "--surface-info-strong"],
      },
      {
        key: "diff-text",
        label: "Diff text",
        tokens: [
          "--text-diff-add-base",
          "--text-diff-add-strong",
          "--text-diff-delete-base",
          "--text-diff-delete-strong",
        ],
      },
    ],
  },
  {
    key: "diff",
    label: "Diff surfaces",
    tokens: [
      "--surface-diff-unchanged-base",
      "--surface-diff-skip-base",
      "--surface-diff-hidden-base",
      "--surface-diff-hidden-weak",
      "--surface-diff-hidden-weaker",
      "--surface-diff-hidden-strong",
      "--surface-diff-hidden-stronger",
      "--surface-diff-add-base",
      "--surface-diff-add-weak",
      "--surface-diff-add-weaker",
      "--surface-diff-add-strong",
      "--surface-diff-add-stronger",
      "--surface-diff-delete-base",
      "--surface-diff-delete-weak",
      "--surface-diff-delete-weaker",
      "--surface-diff-delete-strong",
      "--surface-diff-delete-stronger",
    ],
  },
];

/** Every token name, depth-first. */
export function flattenTokenGroups(groups: TokenGroup[] = TOKEN_GROUPS): string[] {
  const out: string[] = [];
  for (const group of groups) {
    out.push(...group.tokens);
    if (group.children) out.push(...flattenTokenGroups(group.children));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in palettes (dark accents — the pre-existing themes, unchanged)
// ---------------------------------------------------------------------------

export const THEMES: Theme[] = [
  { id: "opencode", label: "Opencode", vars: {}, scheme: "auto", source: "builtin" },
  {
    id: "catppuccin",
    label: "Catppuccin",
    scheme: "auto",
    source: "builtin",
    vars: {
      "--background-base": "#1e1e2e",
      "--surface-float-base": "#181825",
      "--background-weak": "#11111b",
      "--text-strong": "#cdd6f4",
      "--text-weak": "#9399b2",
      "--border-selected": "#89b4fa",
      "--surface-brand-base": "#f5c2e7",
      "--surface-success-strong": "#a6e3a1",
      "--surface-critical-strong": "#f38ba8",
      "--surface-warning-strong": "#f9e2af",
      "--surface-info-strong": "#94e2d5",
    },
  },
  {
    id: "nord",
    label: "Nord",
    scheme: "auto",
    source: "builtin",
    vars: {
      "--background-base": "#2e3440",
      "--surface-float-base": "#3b4252",
      "--background-weak": "#434c5e",
      "--text-strong": "#eceff4",
      "--text-weak": "#8b95a7",
      "--border-selected": "#88c0d0",
      "--surface-brand-base": "#8fbcbb",
      "--surface-success-strong": "#a3be8c",
      "--surface-critical-strong": "#bf616a",
      "--surface-warning-strong": "#d08770",
      "--surface-info-strong": "#88c0d0",
    },
  },
  {
    id: "tokyonight",
    label: "Tokyo Night",
    scheme: "auto",
    source: "builtin",
    vars: {
      "--background-base": "#1a1b26",
      "--surface-float-base": "#1e2030",
      "--background-weak": "#222436",
      "--text-strong": "#c8d3f5",
      "--text-weak": "#828bb8",
      "--border-selected": "#82aaff",
      "--surface-brand-base": "#ff966c",
      "--surface-success-strong": "#c3e88d",
      "--surface-critical-strong": "#ff757f",
      "--surface-warning-strong": "#ffc777",
      "--surface-info-strong": "#82aaff",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    scheme: "auto",
    source: "builtin",
    vars: {
      "--background-base": "#282a36",
      "--surface-float-base": "#21222c",
      "--background-weak": "#44475a",
      "--text-strong": "#f8f8f2",
      "--text-weak": "#6272a4",
      "--border-selected": "#bd93f9",
      "--surface-brand-base": "#8be9fd",
      "--surface-success-strong": "#50fa7b",
      "--surface-critical-strong": "#ff5555",
      "--surface-warning-strong": "#f1fa8c",
      "--surface-info-strong": "#ffb86c",
    },
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    scheme: "auto",
    source: "builtin",
    vars: {
      "--background-base": "#282828",
      "--surface-float-base": "#3c3836",
      "--background-weak": "#504945",
      "--text-strong": "#ebdbb2",
      "--text-weak": "#928374",
      "--border-selected": "#83a598",
      "--surface-brand-base": "#8ec07c",
      "--surface-success-strong": "#b8bb26",
      "--surface-critical-strong": "#fb4934",
      "--surface-warning-strong": "#fe8019",
      "--surface-info-strong": "#fabd2f",
    },
  },
  {
    id: "github",
    label: "GitHub",
    scheme: "auto",
    source: "builtin",
    vars: {
      "--background-base": "#0d1117",
      "--surface-float-base": "#010409",
      "--background-weak": "#161b22",
      "--text-strong": "#c9d1d9",
      "--text-weak": "#8b949e",
      "--border-selected": "#58a6ff",
      "--surface-brand-base": "#39c5cf",
      "--surface-success-strong": "#3fb950",
      "--surface-critical-strong": "#f85149",
      "--surface-warning-strong": "#e3b341",
      "--surface-info-strong": "#d29922",
    },
  },
];

/**
 * The light base palette — the structural tokens for a light scheme. A free
 * theme contributes only its accents on top of this; a theme that pins
 * `scheme: "light"` supplies its own tokens and this is the fallback.
 */
export const LIGHT_BASE: Record<string, string> = {
  "--background-base": "#ffffff",
  "--background-weak": "#f5f5f5",
  "--background-strong": "#ffffff",
  "--background-stronger": "#fafafa",
  "--surface-base": "rgba(0, 0, 0, 0.031)",
  "--surface-base-hover": "rgba(0, 0, 0, 0.039)",
  "--surface-base-active": "rgba(0, 0, 0, 0.059)",
  "--surface-inset-base": "rgba(0, 0, 0, 0.04)",
  "--surface-inset-strong": "rgba(0, 0, 0, 0.07)",
  "--surface-raised-base": "rgba(0, 0, 0, 0.04)",
  "--surface-raised-base-hover": "rgba(0, 0, 0, 0.06)",
  "--surface-raised-base-active": "rgba(0, 0, 0, 0.08)",
  "--surface-raised-strong": "rgba(0, 0, 0, 0.06)",
  "--surface-raised-strong-hover": "rgba(0, 0, 0, 0.1)",
  "--surface-raised-stronger": "rgba(0, 0, 0, 0.1)",
  "--surface-raised-stronger-hover": "rgba(0, 0, 0, 0.14)",
  "--surface-raised-stronger-non-alpha": "#f0f0f0",
  "--surface-float-base": "#ffffff",
  "--surface-float-base-hover": "#f5f5f5",
  "--surface-weak": "rgba(0, 0, 0, 0.05)",
  "--surface-weaker": "rgba(0, 0, 0, 0.08)",
  "--surface-strong": "rgba(0, 0, 0, 0.14)",

  "--surface-brand-base": "#e8853f",
  "--surface-brand-hover": "#d9772f",
  "--surface-interactive-base": "#dbe6ff",
  "--surface-interactive-weak": "#eef3ff",
  "--surface-success-base": "#d7f5d0",
  "--surface-success-weak": "#e9fbe5",
  "--surface-success-strong": "#0f7008",
  "--surface-warning-base": "#fbeecb",
  "--surface-warning-weak": "#fdf6e3",
  "--surface-warning-strong": "#8a6400",
  "--surface-critical-base": "#fbdcd6",
  "--surface-critical-weak": "#fdeae7",
  "--surface-critical-strong": "#c72e18",
  "--surface-info-base": "#f0d9f5",
  "--surface-info-weak": "#f8ebfa",
  "--surface-info-strong": "#863b93",

  "--surface-diff-unchanged-base": "#ffffff",
  "--surface-diff-skip-base": "#00000000",
  "--surface-diff-hidden-base": "#e8f0fe",
  "--surface-diff-hidden-weak": "#eef4ff",
  "--surface-diff-hidden-weaker": "#dbe8ff",
  "--surface-diff-hidden-strong": "#cfdffb",
  "--surface-diff-hidden-stronger": "#2f5fd0",
  "--surface-diff-add-base": "#e6f6e9",
  "--surface-diff-add-weak": "#eefaf0",
  "--surface-diff-add-weaker": "#e6f6e9",
  "--surface-diff-add-strong": "#d3efd9",
  "--surface-diff-add-stronger": "#1a7f37",
  "--surface-diff-delete-base": "#fde7e3",
  "--surface-diff-delete-weak": "#fdeeeb",
  "--surface-diff-delete-weaker": "#fde7e3",
  "--surface-diff-delete-strong": "#fbd5cf",
  "--surface-diff-delete-stronger": "#c72e18",

  "--input-base": "#ffffff",
  "--input-hover": "#f7f7f7",
  "--input-active": "#eef4ff",
  "--input-selected": "#e6efff",
  "--input-focus": "#eef4ff",
  "--input-disabled": "#f0f0f0",

  "--text-base": "rgba(0, 0, 0, 0.62)",
  "--text-weak": "rgba(0, 0, 0, 0.46)",
  "--text-weaker": "rgba(0, 0, 0, 0.32)",
  "--text-strong": "rgba(0, 0, 0, 0.9)",
  "--text-interactive-base": "#2f5fd0",
  "--text-on-brand-base": "rgba(0, 0, 0, 0.62)",
  "--text-on-interactive-base": "#ffffff",
  "--text-on-success-base": "#0f7008",
  "--text-on-critical-base": "#c72e18",
  "--text-on-critical-weak": "#a32612",
  "--text-on-critical-strong": "#7a1608",
  "--text-diff-add-base": "#1a7f37",
  "--text-diff-add-strong": "#0f5c26",
  "--text-diff-delete-base": "#c72e18",
  "--text-diff-delete-strong": "#7a1608",

  "--button-primary-base": "#1a1a1a",
  "--button-secondary-base": "#ffffff",
  "--button-secondary-hover": "rgba(0, 0, 0, 0.04)",
  "--button-ghost-hover": "rgba(0, 0, 0, 0.03)",
  "--button-ghost-hover2": "rgba(0, 0, 0, 0.06)",

  "--border-base": "rgba(0, 0, 0, 0.16)",
  "--border-hover": "rgba(0, 0, 0, 0.24)",
  "--border-active": "rgba(0, 0, 0, 0.36)",
  "--border-selected": "#3b6fe0",
  "--border-disabled": "rgba(0, 0, 0, 0.24)",
  "--border-focus": "rgba(0, 0, 0, 0.36)",
  "--border-weak-base": "#e6e6e6",
  "--border-strong-base": "rgba(0, 0, 0, 0.22)",
  "--border-strong-hover": "rgba(0, 0, 0, 0.22)",
  "--border-strong-active": "rgba(0, 0, 0, 0.22)",
  "--border-strong-selected": "rgba(3, 76, 255, 0.5)",
  "--border-strong-disabled": "rgba(0, 0, 0, 0.12)",
  "--border-strong-focus": "rgba(0, 0, 0, 0.22)",
};

/**
 * Structural (base-palette) tokens. A FREE theme's structural vars are dropped
 * in light mode so the light base wins; its accents (brand/success/critical/
 * info/selected/…) survive the override. A theme that pins a scheme keeps
 * everything (it owns its palette).
 */
const STRUCTURAL_RE =
  /^--(background-|surface-base|surface-inset|surface-raised|surface-float|surface-weak|surface-weaker|surface-strong|input-|button-|border-base|border-hover|border-active|border-disabled|border-focus|border-weak-base|border-strong|text-base|text-weak|text-weaker|text-strong)/;

export function isStructuralToken(name: string): boolean {
  return STRUCTURAL_RE.test(name);
}

/** Split a theme's vars into the accent keys (identity) — a free-theme overlay. */
export function accentVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!isStructuralToken(key)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Custom themes (registered from config files — see src/lib/themeFiles.ts)
// ---------------------------------------------------------------------------

let customThemes: Theme[] = [];
const themeListeners = new Set<() => void>();

function notifyThemeChange(): void {
  for (const fn of themeListeners) fn();
}

/** All themes: built-ins first, then custom (config) themes. */
export function listAllThemes(): Theme[] {
  return [...THEMES, ...customThemes];
}

export function listCustomThemes(): Theme[] {
  return [...customThemes];
}

/** Replace the custom-theme set (config discovery); re-applies if active. */
export function registerCustomThemes(themes: Theme[]): void {
  customThemes = themes.map((t) => ({ ...t, source: "custom" as const }));
  // If the active theme is a custom one that just became available, repaint.
  applyActiveTheme();
  notifyThemeChange();
}

/** Subscribe to theme-list / active-theme changes (for pickers). */
export function subscribeTheme(fn: () => void): () => void {
  themeListeners.add(fn);
  return () => {
    themeListeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// Persistence + resolution
// ---------------------------------------------------------------------------

function readStoredId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === "dark" || raw === "light" || raw === "system") return raw;
  } catch {
    void 0;
  }
  return "dark";
}

export function getThemeMode(): ThemeMode {
  return readStoredMode();
}

export function getTheme(): Theme {
  const saved = readStoredId();
  return listAllThemes().find((t) => t.id === saved) ?? THEMES[0]!;
}

export function findTheme(id: string): Theme | undefined {
  return listAllThemes().find((t) => t.id === id);
}

export function listThemes(): Theme[] {
  return listAllThemes();
}

/**
 * The OS colour-scheme. `prefers-color-scheme` is the browser analogue of the
 * TUI's terminal-derived theme (`theme/system.ts`).
 */
export function systemScheme(): ThemeScheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The scheme a mode resolves to (`system` consults the OS). */
export function resolveScheme(mode: ThemeMode = getThemeMode()): ThemeScheme {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  return systemScheme();
}

/** The scheme actually used by a theme under a mode (a pinned theme wins). */
export function themeScheme(theme: Theme, mode: ThemeMode = getThemeMode()): ThemeScheme {
  if (theme.scheme === "dark" || theme.scheme === "light") return theme.scheme;
  return resolveScheme(mode);
}

/** The theme's tokens for a resolved scheme. */
export function themeVars(theme: Theme, scheme: ThemeScheme): Record<string, string> {
  if (scheme === "light") {
    const accents = theme.scheme === "light" ? theme.vars : accentVars(theme.vars);
    return { ...LIGHT_BASE, ...accents };
  }
  return { ...theme.vars };
}

/** The scheme the UI is actually in right now. */
export function activeScheme(): ThemeScheme {
  return themeScheme(getTheme(), getThemeMode());
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a theme (optionally under a mode) and return it. Writes one style
 * element of CSS vars and toggles the `.dark` class + `color-scheme`.
 * Keeps the pre-existing `applyTheme(id): Theme` contract.
 */
export function applyTheme(id: string, mode?: ThemeMode): Theme {
  const theme = findTheme(id) ?? THEMES[0]!;
  const scheme = themeScheme(theme, mode ?? getThemeMode());
  const vars = themeVars(theme, scheme);

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const entries = Object.entries(vars);
  style.textContent =
    entries.length > 0
      ? `:root:root {\n  ${entries.map(([k, v]) => `${k}: ${v};`).join("\n  ")}\n}`
      : "";

  const root = document.documentElement;
  root.classList.toggle("dark", scheme === "dark");
  root.style.colorScheme = scheme;

  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    void 0;
  }
  return theme;
}

/** Re-apply the stored theme under the stored mode. */
export function applyActiveTheme(): Theme {
  return applyTheme(getTheme().id, getThemeMode());
}

/** Select a theme and notify subscribers (pickers call this). */
export function selectTheme(id: string): Theme {
  const theme = applyTheme(id, getThemeMode());
  notifyThemeChange();
  return theme;
}

/** Persist + apply a new mode. */
export function setThemeMode(mode: ThemeMode): ThemeMode {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    void 0;
  }
  applyActiveTheme();
  notifyThemeChange();
  return mode;
}

/** Re-apply the active theme when the OS scheme changes (only in `system`). */
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mql = window.matchMedia("(prefers-color-scheme: light)");
  const onSchemeChange = () => {
    if (getThemeMode() === "system") {
      applyActiveTheme();
      notifyThemeChange();
    }
  };
  if (typeof mql.addEventListener === "function") mql.addEventListener("change", onSchemeChange);
  else if (typeof (mql as MediaQueryList & { addListener?: unknown }).addListener === "function") {
    (mql as MediaQueryList & { addListener: (fn: () => void) => void }).addListener(onSchemeChange);
  }
}

// Bootstrap: paint before React renders; a stored custom id resolves to the
// dark default until `src/lib/themeFiles.ts` registers it (which re-applies).
applyTheme(getTheme().id, getThemeMode());
