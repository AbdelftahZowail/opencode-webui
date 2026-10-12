/**
 * `apply_patch` / `patch` tool body (parity R10) — a unified-diff-ish block.
 *
 * Registered as the `tool.patch` target; ToolCard routes both tool names here.
 * The engine's `apply_patch` input shape is not pinned by the OpenAPI snapshot
 * (tool input is free-form), so the patch text is read from the handful of
 * fields the tool has shipped (`patchText`/`patch`/`diff`/`text`, or a `files`
 * array), and a `---`/`+++`/`@@`-bearing text output is accepted as a fallback.
 * Diff-looking text renders through the shared `DiffView`; anything else is a
 * plain preformatted body — never lost.
 */

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolState } from "../api/types";
import { autoRegister } from "../extensions/registry";
import { DiffView } from "./DiffView";
import { Spinner } from "./ui";

interface PatchBodyProps {
  state: ToolState;
  stateKey?: string;
  input: Record<string, unknown>;
  meta: Record<string, unknown>;
  output?: string;
  denied?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function looksLikeDiff(text: string): boolean {
  let sawHeader = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) return true;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) sawHeader = true;
  }
  return sawHeader;
}

interface PatchEntry {
  file?: string;
  patch: string;
}

/** Pull one or more patch bodies out of the tool part, defensively. */
function patchEntries(props: PatchBodyProps): PatchEntry[] {
  const files = props.input.files;
  if (Array.isArray(files)) {
    const entries: PatchEntry[] = [];
    for (const item of files) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const patch = str(o.patch) ?? str(o.patchText) ?? str(o.diff);
      if (patch) entries.push({ file: str(o.file) ?? str(o.path), patch });
    }
    if (entries.length > 0) return entries;
  }
  const patch =
    str(props.input.patch) ??
    str(props.input.patchText) ??
    str(props.input.diff) ??
    str(props.input.text) ??
    str(props.meta.patch) ??
    str(props.meta.diff);
  if (patch) return [{ file: str(props.input.path), patch }];
  if (props.output && looksLikeDiff(props.output)) return [{ patch: props.output }];
  return [];
}

export function ToolPatchBody(props: PatchBodyProps) {
  const entries = patchEntries(props);
  const pending = props.state.status === "streaming" || props.state.status === "running";

  if (entries.length === 0) {
    return (
      <PatchRow
        pending={pending}
        label={
          <>
            <span className="font-medium">Patch</span>
            {props.output && <span className="font-mono text-[var(--text-weaker)]"> {props.output.split("\n").length} lines</span>}
          </>
        }
      />
    );
  }

  return (
    <div data-oc-tool-patch>
      {entries.map((entry, i) => (
        <PatchBlock key={entry.file ?? i} file={entry.file} patch={entry.patch} />
      ))}
    </div>
  );
}

function PatchBlock({ file, patch }: { file?: string; patch: string }) {
  const [open, setOpen] = useState(patch.length < 4_000 && patch.split("\n").length <= 60);
  return (
    <div className="my-1 overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-[var(--background-strong)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 border-b border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-1.5 text-left text-xs text-[var(--text-weak)]"
      >
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="font-mono">±</span>
        <span className="min-w-0 flex-1 truncate">
          Patch{" "}
          {file ? <span className="font-mono text-[var(--text-base)]">{file}</span> : <span>changes</span>}
        </span>
      </button>
      {open &&
        (looksLikeDiff(patch) ? (
          <DiffView diff={patch} className="max-h-80 overflow-y-auto py-1" />
        ) : (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-xs leading-relaxed text-[var(--text-base)]">
            {patch}
          </pre>
        ))}
    </div>
  );
}

/** Minimal inline row for a patch with no body yet — matches the card's rows. */
function PatchRow({ pending, label }: { pending: boolean; label: ReactNode }) {
  return (
    <div className="py-0.5 pl-1 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-3 shrink-0 text-center font-mono text-[var(--text-weaker)]">±</span>
        {pending ? (
          <span className="flex items-center gap-2 text-[var(--text-base)]">
            <Spinner className="size-3" />
            {label}
          </span>
        ) : (
          <span className="text-[var(--text-weak)]">{label}</span>
        )}
      </div>
    </div>
  );
}

autoRegister({
  "tool.patch": (p) => <ToolPatchBody {...(p as unknown as PatchBodyProps)} />,
});
