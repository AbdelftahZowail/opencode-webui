import { useEffect, useMemo } from "react";
import { Square } from "lucide-react";
import type { StructuredError } from "../api/types";
import { interrupt, liveToolPart, loadMessages, selectSession, useStore, type LiveTool } from "../store";
import { SlotOutlet } from "../extensions/registry";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Composer } from "./Composer";
import { MessageItem, MessagePart } from "./MessageItem";
import { AgentPicker, ModelPicker } from "./Pickers";
import { SessionMenu } from "./SessionMenu";
import { ThemePicker } from "./ThemePicker";
import { WorkspacePicker } from "./WorkspacePicker";

export function Conversation({ sessionID }: { sessionID: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID]);
  const messages = useStore((s) => s.messages[sessionID] ?? []);
  const live = useStore((s) => s.live);
  const running = useStore((s) => s.running[sessionID] ?? false);
  const queued = useStore((s) => !!s.queued[sessionID]);

  useEffect(() => {
    void loadMessages(sessionID);
  }, [sessionID]);

  // During streaming the engine emits one assistant message per step (tool,
  // reasoning, text…). Merge all live assistants for the current session into
  // a single growing block so it reads like one assistant message instead of
  // a pile of partial bubbles.
  const mergedLive = useMemo(() => {
    if (live.length === 0) return null;
    const reasoning = live
      .map((m) => m.reasoning)
      .filter((t) => t && t.trim())
      .join("\n\n");
    const text = live
      .map((m) => m.text)
      .filter((t) => t && t.trim())
      .join("\n\n");
    const tools: LiveTool[] = live.flatMap((m) => [...m.tools.values()]);
    const error = live.find((m) => m.error)?.error;
    return { reasoning, text, tools, error };
  }, [live]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Header title={session?.title} sessionID={sessionID} running={running} queued={queued} />

      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
              {messages.length === 0 && !mergedLive && !running && (
                <MessageScrollerItem>
                  <EmptyHint />
                </MessageScrollerItem>
              )}
              {(() => {
                let prevAssistant = false;
                return messages.map((m) => {
                  const isAssistant = m.type === "assistant";
                  const compact = isAssistant && prevAssistant;
                  prevAssistant = isAssistant;
                  return (
                    <MessageScrollerItem key={m.id} messageId={m.id}>
                      <MessageItem message={m} compact={compact} />
                    </MessageScrollerItem>
                  );
                });
              })()}
              {mergedLive && (
                <MessageScrollerItem>
                  <LiveAssistantView content={mergedLive} running={running} />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

      <SlotOutlet slot="composer.replace" fallback={<Composer sessionID={sessionID} />} />
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="flex justify-center pt-16">
      <div className="flex max-w-md flex-col items-center gap-1.5 rounded-lg border border-[var(--border-weak-base)] bg-[var(--background-weak)] px-8 py-10 text-center">
        <h1 className="text-[var(--font-size-large)] font-medium text-[var(--text-base)]">
          Start a conversation
        </h1>
        <p className="text-[var(--font-size-base)] text-[var(--text-weaker)]">
          The agent can read, edit, and run commands in the session workspace.
        </p>
      </div>
    </div>
  );
}

function Header({ title, sessionID, running, queued }: { title?: string; sessionID: string; running: boolean; queued: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border-base)] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="mr-1 cursor-pointer text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)] lg:hidden"
          onClick={() => void selectSession(null)}
        >
          ←
        </button>
        <span className="truncate text-[var(--font-size-base)] font-medium text-[var(--text-strong)]">
          {title ?? "Untitled session"}
        </span>
        <span className="hidden font-mono text-xs text-[var(--text-weaker)] sm:inline">
          {sessionID.slice(0, 12)}
        </span>
        {queued && !running && (
          <Badge
            className="border-transparent bg-[var(--surface-warning-weak)] text-[var(--surface-warning-strong)]"
            title="Message sent — waiting for the agent to start responding"
          >
            waiting
          </Badge>
        )}
        {running && (
          <Badge className="border-transparent bg-[var(--surface-interactive-weak)] text-[var(--text-interactive-base)]">
            working
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <AgentPicker sessionID={sessionID} />
        <ModelPicker sessionID={sessionID} />
        <WorkspacePicker sessionID={sessionID} />
        <ThemePicker />
        <SessionMenu sessionID={sessionID} />
        {running && (
          <Button variant="destructive" size="sm" onClick={() => void interrupt()}>
            <Square /> Stop
          </Button>
        )}
      </div>
    </div>
  );
}

function LiveAssistantView({
  content,
  running,
}: {
  content: { reasoning: string; text: string; tools: LiveTool[]; error?: StructuredError };
  running: boolean;
}) {
  const parts = [
    ...(content.reasoning.trim() ? [{ type: "reasoning" as const, text: content.reasoning }] : []),
    ...(content.text.trim() ? [{ type: "text" as const, text: content.text }] : []),
    ...content.tools.map(liveToolPart),
  ];
  if (parts.length === 0 && !running && !content.error) return null;
  return (
    <div className="border-l-2 border-[color-mix(in_oklch,var(--border-selected)_40%,transparent)] pl-3">
      {content.error && (
        <div className="mb-2 rounded-md border border-[color-mix(in_oklch,var(--surface-critical-strong)_40%,transparent)] bg-[var(--surface-critical-weak)] px-3 py-2 text-xs text-[var(--text-on-critical-strong)]">
          <span className="font-medium">{content.error.type}</span>
          <div className="mt-0.5">{content.error.message}</div>
        </div>
      )}
      {parts.length === 0 && running && !content.error && (
        <div className="flex items-center gap-2 py-1 text-[var(--font-size-base)] text-[var(--text-weak)] animate-pulse">
          thinking…
        </div>
      )}
      {parts.map((p, i) => (
        <MessagePart key={i} part={p as never} />
      ))}
    </div>
  );
}
