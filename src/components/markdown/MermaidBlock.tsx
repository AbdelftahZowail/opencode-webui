/**
 * ` ```mermaid ` fence renderer (R2).
 *
 * Shows a rendered SVG — never the fence markers, the language keyword, or the
 * source. While the lazy mermaid chunk loads it shows a quiet placeholder; if
 * rendering fails it falls back to the plain source (via `FenceFallback`) so a
 * malformed diagram cannot blank the transcript.
 */
import { useMermaid } from "../../lib/markdown/useMermaid";
import { FenceFallback } from "./BlockBoundary";

export function MermaidBlock({ source }: { source: string }) {
  const { svg, failed } = useMermaid(source);

  if (failed) return <FenceFallback source={source} label="Diagram unavailable" />;

  if (!svg) {
    return (
      <div
        data-oc-mermaid
        data-oc-mermaid-loading
        className="my-2 flex min-h-16 max-w-full items-center justify-center rounded-md border border-dashed border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-3 text-[11px] text-[var(--text-weaker)]"
      >
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      data-oc-mermaid
      className="my-2 max-w-full overflow-x-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
