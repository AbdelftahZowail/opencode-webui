import { getService } from "../extensions/registry";
import { timeAgo } from "./ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * The sidebar's unread marker — a self-contained leaf, and the copy that
 * explains the rule lives next to the thing it explains.
 *
 * It deliberately still says one word: "new". The word is unambiguous, it
 * fits the narrow row, and anything longer would compete with the session
 * title. What was missing was not length but an EXPLANATION — the old
 * tooltip ("Finished — not opened yet") described the past tense and gave the
 * user no way to reason about when it would appear or clear. This one states
 * the condition, the age, and the exact thing that clears it.
 *
 * NOT registered as an extension target: it renders inside the row's `<a>`, so
 * a wrap/replace seam would need a target id, and adding one is a contract
 * change. Restyle or relocate it through the `data-oc-session-unseen` anchor
 * (contract — see `webui-extensions/README.md`) instead.
 *
 * The age consults the `format.timestamp` service, so an extension that
 * overrides the timestamp format gets a consistent age here too.
 */
export interface SessionUnseenBadgeProps {
  /** Epoch ms of the session's last engine write — what the age refers to. */
  updated: number;
}

export function SessionUnseenBadge({ updated }: SessionUnseenBadgeProps) {
  const format = getService<(ms: number) => string>("format.timestamp") ?? timeAgo;
  const age = format(updated);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          // Contract anchor: extensions key off this to restyle/relocate the
          // marker without patching the row.
          data-oc-session-unseen="true"
          className="session-unseen inline-flex h-[18px] shrink-0 cursor-help items-center gap-1 rounded-full border border-[color-mix(in_oklch,var(--surface-warning-strong)_26%,transparent)] bg-[color-mix(in_oklch,var(--surface-warning-strong)_13%,transparent)] pl-1.5 pr-1.5 text-[10px] font-semibold tracking-[0.04em] text-[var(--surface-warning-strong)] uppercase select-none"
        >
          <span className="size-1 shrink-0 rounded-full bg-current" />
          <span aria-hidden>new</span>
          <span className="sr-only">: unread output since you last opened this session</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6} className="max-w-64 flex-col items-start gap-1">
        <span className="font-medium">Unread output · {age} ago</span>
        <span className="text-background/70">
          This session wrote new output {age} ago and you have not opened it since.
        </span>
        <span className="text-background/70">
          It clears the moment you open the session — in any tab, with no refresh.
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
