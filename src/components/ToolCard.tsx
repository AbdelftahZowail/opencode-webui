import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolPart, ToolState } from "../api/types";
import { getToolRenderer } from "../extensions/registry";
import { Badge, formatTime } from "./ui";
import { ToolContentView } from "./MessageItem";
import { getPrefs, subscribePrefs } from "../prefs";

const toolDisclosureState = new Map<string, boolean>();

function rememberToolDisclosure(key: string, value: boolean) {
  toolDisclosureState.delete(key);
  toolDisclosureState.set(key, value);
  while (toolDisclosureState.size > 2_000) {
    const oldest = toolDisclosureState.keys().next().value;
    if (!oldest) break;
    toolDisclosureState.delete(oldest);
  }
}

export function ToolCard({ part, stateKey }: { part: ToolPart; stateKey?: string }) {
  const [expanded, setExpanded] = useState(() => (stateKey ? toolDisclosureState.get(stateKey) ?? true : true));
  const [showToolDetails, setShowToolDetails] = useState(getPrefs().showToolDetails);
  useEffect(() => subscribePrefs(() => setShowToolDetails(getPrefs().showToolDetails)), []);

  const renderer = getToolRenderer(part.name);
  if (renderer) return <>{renderer.render(part)}</>;

  if (!part.state) return null;
  const state = part.state;

  const open = expanded && showToolDetails;

  const status = state.status;
  const input = renderInput(state);
  const output = state.status === "completed" ? state.content : state.status === "error" ? state.content : undefined;
  const error = state.status === "error" ? state.error : undefined;

  return (
    <div className="overflow-hidden rounded-lg border border-(color:--border-weak-base) bg-(--background-strong)">
      <button
        type="button"
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (stateKey) rememberToolDisclosure(stateKey, next);
        }}
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left hover:bg-(--surface-base-hover) cursor-pointer"
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot status={status} />
          <span className="truncate font-mono text-xs text-(color:--text-strong)">{part.name}</span>
          <span className="shrink-0 text-[10px] text-(color:--text-weak)">{status}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-[10px] text-(color:--text-weaker)">
          {part.time.ran && <span>{formatTime(part.time.ran)}</span>}
          <ChevronRight className={`size-3 transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      {open && (
        <div className="border-t border-(color:--border-weak-base) bg-(--surface-base) p-2.5">
          {error && (
            <div className="mb-2 rounded-md bg-(--surface-critical-base) px-2.5 py-1.5 font-mono text-xs text-(color:--surface-critical-strong)">
              {error.type}: {error.message}
            </div>
          )}
          {input !== undefined && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-(color:--text-weaker)">Input</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-(--surface-inset-base) p-2.5 font-mono text-xs text-(color:--text-base)">
                {input}
              </pre>
            </div>
          )}
          <ToolContentView content={output} />
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: ToolState["status"] }) {
  const cls =
    status === "completed"
      ? "bg-(--surface-success-strong)"
      : status === "error"
        ? "bg-(--surface-critical-strong)"
        : status === "running"
          ? "bg-(--text-interactive-base) animate-pulse"
          : "bg-(--border-weak-base)";
  return <span className={`size-2 shrink-0 rounded-full ${cls}`} />;
}

function renderInput(state: ToolState): string | undefined {
  if (state.status === "streaming") return state.input || "…";
  return JSON.stringify(state.input, null, 2);
}

export function ToolStatusBadge({ status }: { status: ToolState["status"] }) {
  return <Badge tone={status === "completed" ? "green" : status === "error" ? "red" : status === "running" ? "blue" : "neutral"}>{status}</Badge>;
}
