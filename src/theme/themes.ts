export type Theme = {
  id: string;
  label: string;
  vars: Record<string, string>;
};

const STORAGE_KEY = "webui.theme";
const STYLE_ID = "oc-theme";

export const THEMES: Theme[] = [
  { id: "opencode", label: "Opencode", vars: {} },
  {
    id: "catppuccin",
    label: "Catppuccin",
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

export function listThemes(): Theme[] {
  return THEMES;
}

export function getTheme(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return THEMES.find((t) => t.id === saved) ?? THEMES[0]!;
}

export function applyTheme(id: string): Theme {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const entries = Object.entries(theme.vars);
  style.textContent =
    entries.length > 0
      ? `:root:root {\n  ${entries.map(([k, v]) => `${k}: ${v};`).join("\n  ")}\n}`
      : "";
  localStorage.setItem(STORAGE_KEY, theme.id);
  return theme;
}

applyTheme(getTheme().id);
