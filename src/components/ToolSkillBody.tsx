/**
 * `skill` tool body (parity R10) — an inline `Skill "<name>"` row
 * (`routes/session/index.tsx:3511-3518`).
 *
 * Registered as the `tool.skill` target. The skill name is read from the
 * handful of free-form input/metadata fields the tool has shipped.
 */

import type { ToolState } from "../api/types";
import { autoRegister } from "../extensions/registry";
import { Spinner } from "./ui";

interface SkillBodyProps {
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

function skillNameOf(input: Record<string, unknown>, meta: Record<string, unknown>): string | undefined {
  return (
    str(input.name) ??
    str(input.skill) ??
    str(input.id) ??
    str(meta.name) ??
    str(meta.skill)
  );
}

export function ToolSkillBody(props: SkillBodyProps) {
  const name = skillNameOf(props.input, props.meta);
  const inFlight = props.state.status === "streaming" || props.state.status === "running";

  return (
    <div data-oc-tool-skill className="py-0.5 pl-1 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-3 shrink-0 text-center font-mono text-[var(--text-weaker)]">✦</span>
        {inFlight ? (
          <span className="flex items-center gap-2 text-[var(--text-base)]">
            <Spinner className="size-3" />
            <span className="font-medium">Skill</span>
            <span className="font-mono">{name ? `"${name}"` : "…"}</span>
          </span>
        ) : (
          <span className="text-[var(--text-weak)]">
            <span className="font-medium">Skill</span>
            {name ? <span className="font-mono"> "{name}"</span> : <span className="text-[var(--text-weaker)]"> …</span>}
          </span>
        )}
      </div>
    </div>
  );
}

autoRegister({
  "tool.skill": (p) => <ToolSkillBody {...(p as unknown as SkillBodyProps)} />,
});
