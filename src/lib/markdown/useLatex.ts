/**
 * React binding for KaTeX (R2).
 *
 * Mirrors `useMermaid`: keeps the last good render while a new one is in
 * flight, and flags `failed` on a throw so the block falls back to its source.
 */
import { useEffect, useState } from "react";

export interface LatexState {
  html: string | null;
  failed: boolean;
}

export function useLatex(source: string): LatexState {
  const [state, setState] = useState<LatexState>({ html: null, failed: false });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ html: prev.html, failed: false }));
    void (async () => {
      try {
        const { renderLatex } = await import("./katex");
        const html = await renderLatex(source);
        if (alive) setState({ html, failed: false });
      } catch {
        if (alive) setState({ html: null, failed: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [source]);
  return state;
}
