/**
 * ` ```latex ` (and `tex`/`math`) fence renderer (R2).
 *
 * Renders display math to glyphs via KaTeX — the fence markers, the language
 * keyword, and the raw source are all hidden. Malformed math falls back to the
 * plain source so a bad formula cannot blank the transcript.
 */
import { useLatex } from "../../lib/markdown/useLatex";
import { FenceFallback } from "./BlockBoundary";

export function LatexBlock({ source }: { source: string }) {
  const { html, failed } = useLatex(source);

  if (failed) return <FenceFallback source={source} label="Math unavailable" />;

  if (!html) {
    return <div data-oc-latex data-oc-latex-loading className="my-1 min-h-6 max-w-full overflow-x-auto" />;
  }

  return (
    <div
      data-oc-latex
      className="my-2 max-w-full overflow-x-auto text-[var(--text-strong)] [&_.katex-display]:my-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
