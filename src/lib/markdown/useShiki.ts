/**
 * React binding for the code highlighter (R1).
 *
 * Deliberately light: it imports only the language resolver and reaches the
 * shiki engine through a dynamic `import("./shiki")`, so the engine, wasm and
 * grammars stay out of the main bundle. Returns `null` while loading and for
 * unknown languages, which is exactly the plain-text state the block renders.
 */
import { useEffect, useState } from "react";
import { resolveLanguage } from "./languages";

/** Coalesce streaming token bursts so a growing block is not re-highlighted per commit. */
const DEBOUNCE_MS = 80;

export function useHighlightedHtml(code: string, lang: string | undefined): string | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    const resolved = resolveLanguage(lang);
    if (!resolved) {
      setHtml(null);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { highlightCode } = await import("./shiki");
          const out = await highlightCode(code, resolved);
          if (alive) setHtml(out);
        } catch {
          if (alive) setHtml(null);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [code, lang]);
  return html;
}
