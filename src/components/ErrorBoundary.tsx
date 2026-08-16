import { Component, type ReactNode } from "react";

/**
 * Last-resort safety net: a render error must never silently blank the whole
 * app (which read as "it refreshed / stopped streaming"). Show the error and
 * offer a one-click retry instead.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[app] render error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex size-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <p className="text-sm text-foreground">The UI hit a render error.</p>
          <pre className="max-h-48 max-w-full overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}