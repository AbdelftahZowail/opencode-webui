import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { childSessionsOf, selectSession, sendPromptTo, useStore } from "../store";
import { Button } from "./ui/button";

/**
 * In-session subagent surface (TUI parity with the task/subagent views):
 * a compact strip under the conversation header listing the current
 * session's child sessions with running/idle state. Rows open the child
 * (sessions are uniform) or message it inline via sendPromptTo.
 */
export function SubagentStrip({ sessionID }: { sessionID: string }) {
  const children = useStore((s) => childSessionsOf(s.sessions, sessionID));
  const runningMap = useStore((s) => s.running);
  const activeIDs = useStore((s) => s.activeIDs);
  const [open, setOpen] = useState(false);

  if (children.length === 0) return null;
  const runningCount = children.filter((c) => runningMap[c.id] || activeIDs.includes(c.id)).length;

  return (
    <div className="border-b border-[color:var(--border-weak-base)] px-4 py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] text-[color:var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--text-weak)]"
        title="Subagent sessions of this session"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="font-medium">
          Subagents ({children.length})
        </span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-[color:var(--surface-brand-base)]">
            <span className="size-1.5 animate-pulse rounded-full bg-[color:var(--surface-brand-base)]" />
            {runningCount} running
          </span>
        )}
      </button>
      {open && (
        <div className="mt-0.5 mb-1 flex flex-col gap-0.5">
          {children.map((child) => (
            <SubagentRow
              key={child.id}
              id={child.id}
              title={child.title}
              agent={child.agent}
              running={!!runningMap[child.id] || activeIDs.includes(child.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SubagentRow({
  id,
  title,
  agent,
  running,
}: {
  id: string;
  title?: string;
  agent?: string;
  running: boolean;
}) {
  const [messaging, setMessaging] = useState(false);
  const [draft, setDraft] = useState("");

  const send = () => {
    const value = draft.trim();
    if (!value) return;
    void sendPromptTo(id, value);
    setDraft("");
    setMessaging(false);
  };

  return (
    <div className="rounded-md px-1 py-0.5 transition-colors hover:bg-[color:var(--surface-base-hover)]">
      <div className="flex items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            running ? "animate-pulse bg-[color:var(--surface-success-strong)]" : "bg-[color:var(--border-base)]"
          }`}
          title={running ? "Running" : "Idle"}
        />
        <button
          type="button"
          onClick={() => void selectSession(id)}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-[color:var(--text-weak)] hover:text-[color:var(--text-strong)]"
          title={`Open ${title ?? id}`}
        >
          {title || agent || "subagent"}
          <span className="ml-2 hidden font-mono text-[10px] text-[color:var(--text-weaker)] sm:inline">
            {id.slice(0, 12)}
          </span>
        </button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setMessaging((v) => !v);
            setDraft("");
          }}
          title={messaging ? "Cancel" : "Message this subagent"}
        >
          <MessageSquare />
          Message
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void selectSession(id)} title="Open session">
          Open
        </Button>
      </div>
      {messaging && (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMessaging(false);
            }
          }}
          placeholder="message this subagent… (enter to send)"
          className="mt-1 w-full rounded-md border border-[color:var(--border-base)] bg-[color:var(--input-base)] px-2 py-1 font-mono text-xs text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-weaker)] focus:border-[color:var(--border-selected)]"
        />
      )}
    </div>
  );
}
