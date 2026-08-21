import { useEffect, type ReactNode } from "react";
import { Square } from "lucide-react";
import {
  interrupt,
  liveToolPart,
  loadMessages,
  selectSession,
  useStore,
  type LiveAssistant,
  type LiveContentPart,
} from "../store";
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
import { SessionMenu } from "./SessionMenu";
import { SubagentStrip } from "./SubagentStrip";
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Header title={session?.title} sessionID={sessionID} running={running} queued={queued} />
      <SubagentStrip sessionID={sessionID} />

      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
              {messages.length === 0 && live.length === 0 && !running && (
                <MessageScrollerItem>
                  <EmptyHint />
                </MessageScrollerItem>
              )}
              {(() => {
                let prevAssistant = false;
                let insertedLive = false;
                const hasLocalMessage = messages.some((m) => m.id.startsWith("msg_local_"));
                const liveStarted =
                  !hasLocalMessage && live.length > 0
                    ? Math.min(...live.map((assistant) => assistant.started))
                    : Infinity;
                const rows: ReactNode[] = [];
                const addLive = () => {
                  if (insertedLive || live.length === 0) return;
                  rows.push(
                    <MessageScrollerItem key="live">
                      <LiveAssistantView assistants={live} running={running} />
                    </MessageScrollerItem>,
                  );
                  insertedLive = true;
                  prevAssistant = true;
                };

                for (const message of messages) {
                  if (!insertedLive && message.time.created > liveStarted) addLive();
                  const isAssistant = message.type === "assistant";
                  const compact = isAssistant && prevAssistant;
                  prevAssistant = isAssistant;
                  rows.push(
                    <MessageScrollerItem key={message.id} messageId={message.id}>
                      <MessageItem message={message} compact={compact} />
                    </MessageScrollerItem>,
                  );
                }
                addLive();
                return rows;
              })()}
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
  assistants,
  running,
}: {
  assistants: LiveAssistant[];
  running: boolean;
}) {
  const parts = assistants.flatMap((assistant) =>
    assistant.content.map((part) => ({
      key: livePartKey(assistant.id, part),
      part,
    })),
  );
  const error = assistants.find((assistant) => assistant.error)?.error;
  if (parts.length === 0 && !running && !error) return null;
  return (
    <div className="border-l-2 border-[color-mix(in_oklch,var(--border-selected)_40%,transparent)] pl-3">
      {error && (
        <div className="mb-2 rounded-md border border-[color-mix(in_oklch,var(--surface-critical-strong)_40%,transparent)] bg-[var(--surface-critical-weak)] px-3 py-2 text-xs text-[var(--text-on-critical-strong)]">
          <span className="font-medium">{error.type}</span>
          <div className="mt-0.5">{error.message}</div>
        </div>
      )}
      {parts.length === 0 && running && !error && (
        <div className="flex items-center gap-2 py-1 text-[var(--font-size-base)] text-[var(--text-weak)] animate-pulse">
          thinking…
        </div>
      )}
      {parts.map(({ key, part }) => (
        <MessagePart
          key={key}
          stateKey={key}
          part={part.type === "tool" ? liveToolPart(part.tool) : part}
        />
      ))}
    </div>
  );
}

function livePartKey(assistantID: string, part: LiveContentPart): string {
  return part.type === "tool"
    ? `${assistantID}:tool:${part.tool.id}`
    : `${assistantID}:${part.type}:${part.ordinal}`;
}
