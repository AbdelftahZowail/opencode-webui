/**
 * Mermaid loader (R2) — the heavy half.
 *
 * Reached only through a dynamic `import("./mermaid")`, so mermaid (~1 MB) is
 * its own lazy chunk. `renderMermaid` renders ` ```mermaid ` fence sources to
 * SVG and **rejects** on any failure; the caller (`useMermaid`) turns that into
 * a plain-source fallback so a bad diagram never blanks the transcript.
 *
 * The theme reads resolved values off our design tokens (`--surface-float-base`
 * …) rather than hardcoding colours; mermaid parses colours with real values,
 * so `var(--…)` strings would not survive its colour maths. `background` is
 * forced transparent so the diagram sits on the app surface.
 */
type Mermaid = typeof import("mermaid").default;

let mermaidPromise: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

/** Resolved value of a design token, or null (SSR / missing). */
function cssColor(name: string): string | null {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || null;
  } catch {
    return null;
  }
}

let initialized = false;
let sequence = 0;

function ensureInitialized(mermaid: Mermaid): void {
  if (initialized) return;
  const vars: Record<string, string> = { background: "transparent" };
  const take = (key: string, token: string) => {
    const value = cssColor(token);
    if (value) vars[key] = value;
  };
  take("primaryColor", "--surface-float-base");
  take("primaryBorderColor", "--border-weak-base");
  take("primaryTextColor", "--text-strong");
  take("secondaryColor", "--background-weak");
  take("tertiaryColor", "--background-strong");
  take("lineColor", "--text-weak");
  take("textColor", "--text-base");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    fontFamily: "inherit",
    themeVariables: vars,
  });
  initialized = true;
}

/** Render a mermaid fence body to an SVG string. Throws on parse/render error. */
export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  ensureInitialized(mermaid);
  const id = `oc-mermaid-${++sequence}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    // mermaid can leave its scratch node behind when rendering throws; clean up
    // so a failed diagram leaves no orphan in the DOM.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}
