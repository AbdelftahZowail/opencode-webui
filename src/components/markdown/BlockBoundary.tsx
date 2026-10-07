/**
 * Crash isolation for the R2 block renderers (mermaid / LaTeX).
 *
 * React error boundaries only catch synchronous render throws; the blocks'
 * async pipeline reports its own failures through hook state. This component
 * covers the synchronous case (a library throwing during render) so a broken
 * renderer shows the plain source in a framed block instead of blanking the
 * transcript. `FenceFallback` is the shared fallback visual, also used directly
 * by the blocks when their async render fails.
 */
import { Component, type ReactNode } from "react";

export function FenceFallback({ source, label }: { source: string; label?: string }) {
  return (
    <div
      data-oc-block-fallback
      className="my-2 max-w-full overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)]"
    >
      {label && (
        <div className="border-b border-[var(--border-weak-base)] px-3 py-1 text-[11px] text-[var(--text-weaker)]">{label}</div>
      )}
      <pre className="m-0 max-h-96 max-w-full overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre text-[var(--text-base)]">
        {source}
      </pre>
    </div>
  );
}

export class BlockBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[markdown] block render error:", error);
  }

  render() {
    if (this.state.failed) return <FenceFallback source={this.props.source} label="Preview unavailable" />;
    return this.props.children;
  }
}
