/**
 * React binding for mermaid (R2).
 *
 * Debounces the source so a streaming diagram is not re-laid-out on every
 * token, keeps the previously rendered SVG visible while the next one is in
 * flight, and reports `failed` when rendering throws so the block can fall back
 * to the plain source.
 */
import { useEffect, useState } from "react";

const DEBOUNCE_MS = 220;

export interface MermaidState {
  svg: string | null;
  failed: boolean;
}

export function useMermaid(source: string): MermaidState {
  const [state, setState] = useState<MermaidState>({ svg: null, failed: false });
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ svg: prev.svg, failed: false }));
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { renderMermaid } = await import("./mermaid");
          const svg = await renderMermaid(source);
          if (alive) setState({ svg, failed: false });
        } catch {
          if (alive) setState({ svg: null, failed: true });
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [source]);
  return state;
}
