/**
 * Shiki loader (R1) — the heavy half.
 *
 * This module pulls in the Oniguruma engine, the wasm binary and the theme; it
 * is only reached through a dynamic `import("./shiki")` from `useShiki.ts`, so
 * it becomes its own build chunk and the initial bundle never pays for it.
 *
 * The Oniguruma (wasm) engine is chosen over the JavaScript-regex engine for
 * token precision — the JS engine mis-scopes some grammars. It is a lazy chunk
 * and the app sets no CSP, so wasm instantiation is safe. `highlightCode`
 * resolves to `null` on any failure (unknown language, engine load, grammar
 * error) and the caller degrades to plain text.
 */
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { OPENCODE_THEME_NAME, opencodeTheme } from "./shikiTheme";
import { LANGUAGE_LOADERS, type KnownLanguage } from "./languages";

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

let highlighterPromise: Promise<Highlighter> | null = null;

/** Single shared highlighter; the engine + theme load once per page. */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighterCore({
    themes: [opencodeTheme],
    langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return highlighterPromise;
}

/**
 * Highlight `code` as `lang`. Returns the shiki HTML fragment, or `null` when
 * the language has no grammar / anything throws — never rejects.
 */
export async function highlightCode(code: string, lang: KnownLanguage): Promise<string | null> {
  try {
    const highlighter = await getHighlighter();
    await highlighter.loadLanguage(LANGUAGE_LOADERS[lang]);
    return highlighter.codeToHtml(code, { lang, theme: OPENCODE_THEME_NAME });
  } catch (error) {
    // Non-fatal: the block renders as plain text. Keep the console signal so a
    // genuinely broken grammar is diagnosable.
    console.warn("[markdown] highlight failed:", error);
    return null;
  }
}

/**
 * Optional boot warm (desktop-only, from `main.tsx`'s idle block): instantiate
 * the engine + wasm now so the first code block highlights without the
 * plain→highlight swap. Never rejects and does nothing visible on failure.
 */
export function warmHighlighter(): void {
  void getHighlighter().catch(() => {});
}
