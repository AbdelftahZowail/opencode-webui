import React, { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";
import {
  applyRevertView,
  childSessionsOf,
  isDraftSession,
  liveToolPart,
  loadMessages,
  revealSubagentComposer,
  selectSession,
  useStore,
  type LiveAssistant,
  type LiveContentPart,
} from "../store";
import type { MessageInfo } from "../api/types";
import { SlotOutlet } from "../extensions/registry";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "./ui/message-scroller";
import { Badge } from "./ui/badge";
import { Composer } from "./Composer";
import { MessageItem, MessagePart } from "./MessageItem";
import { RunsPanel } from "./RunsPanel";
import { SendErrorStrip } from "./SendErrorStrip";
import { SessionMenu } from "./SessionMenu";
import { SubagentStrip } from "./SubagentStrip";
import { ThemePicker } from "./ThemePicker";
import { WorkspacePicker } from "./WorkspacePicker";

export function Conversation({ sessionID }: { sessionID: string }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID]);
  const allMessages = useStore((s) => s.messages[sessionID] ?? []);
  const live = useStore((s) => s.live);
  const running = useStore((s) => s.running[sessionID] ?? false);
  const queued = useStore((s) => !!s.queued[sessionID]);
  const isPanelOpen = useStore((s) => s.runsPanelOpen);
  const composerOpen = useStore((s) => s.subagentComposerOpen);
  // A staged revert rewrites the visible transcript (service keeps full history).
  const messages = useMemo(
    () => applyRevertView(allMessages, (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID),
    [allMessages, session],
  );

  useEffect(() => {
    void loadMessages(sessionID);
  }, [sessionID]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Header
        title={session?.title}
        sessionID={sessionID}
        running={running}
        queued={queued}
        parentID={session?.parentID}
      />
      {!isDraftSession(sessionID) && <SubagentStrip sessionID={sessionID} />}

      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            {/* The 2s poll (mergeFetchedMessages) replaces the messages array
                even when content is identical; without this guard every poll
                re-renders the whole transcript, re-runs the scroller's stick
                logic and toggles its data-autoscrolling attribute — the
                flicker the user sees as data-autoscroll appearing/disappearing. */}
            <TranscriptList messages={messages} live={live} running={running} />
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
          <ScrollToEndOnUserSend sessionID={sessionID} messages={messages} />
        </MessageScroller>
      </MessageScrollerProvider>

      <SendErrorStrip sessionID={sessionID} />
      {isPanelOpen ? (
        <RunsPanel sessionID={sessionID} />
      ) : session?.parentID && !composerOpen ? (
        // Subagent pages open read-only — Enter reveals the composer
        // (site-wide binding in App), Backspace/↑ return to the parent.
        <SubagentGate sessionID={sessionID} parentID={session.parentID} />
      ) : (
        <SlotOutlet slot="composer.replace" fallback={<Composer sessionID={sessionID} />} />
      )}
    </div>
  );
}

/**
 * Sends must land at the bottom: autoScroll only pins the viewport while it
 * is ALREADY near the end, so a message sent while scrolled up into history
 * stayed up there. Lives inside MessageScrollerProvider (useMessageScroller
 * is context-scoped) and renders nothing. The scroller's own "jump to end"
 * button scrolls smooth — same idiom here; scrollToEnd also flips the mode
 * back to following-bottom, re-arming stick for the streaming answer.
 *
 * Poll safety: mergeFetchedMessages swaps the messages array every 2s even
 * when identical, so this effect re-runs on every poll — but it only acts
 * when the LAST message id actually changed to a user message, otherwise it
 * early-returns without touching DOM or scroller state (same contract as the
 * TranscriptList memo guard above). First observation of a session (mount /
 * session switch / initial history load) is skipped: placement then belongs
 * to defaultScrollPosition="end". A fresh session's very first send still
 * fires — its previous last id was null.
 */
function ScrollToEndOnUserSend({
  sessionID,
  messages,
}: {
  sessionID: string;
  messages: MessageInfo[];
}) {
  const { scrollToEnd } = useMessageScroller();
  const lastSeenRef = useRef<{ sessionID: string; id: string | null } | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    const id = last?.id ?? null;
    const prev = lastSeenRef.current;
    lastSeenRef.current = { sessionID, id };
    if (!prev || prev.sessionID !== sessionID || prev.id === id) return;
    if (last?.type === "user") scrollToEnd({ behavior: "smooth" });
  }, [sessionID, messages, scrollToEnd]);
  return null;
}

/**
 * The gated composer surface for subagent pages: deliberately minimal —
 * NOT the runs-panel box. One thin horizontal line of sibling chips (id
 * order, the same order ←/→ cycles through; the open session's chip is
 * highlighted) over the "enter to message this subagent · back to parent"
 * actions. Clicking a chip opens it; typing anywhere hands off to the
 * composer (lib/composerHandoff.ts).
 */
function SubagentGate({ sessionID, parentID }: { sessionID: string; parentID: string }) {
  const sessions = useStore((s) => s.sessions);
  const runningMap = useStore((s) => s.running);
  const activeIDs = useStore((s) => s.activeIDs);
  const parentTitle = useStore(
    (s) => s.sessions.find((x) => x.id === parentID)?.title ?? s.sessionDetails[parentID]?.title,
  );

  const isRunning = (id: string) => runningMap[id] || activeIDs.includes(id);
  // Id order — identical to App.cycleChild's, so the highlight visibly
  // walks the strip left/right as the arrows are pressed.
  const siblings = [...childSessionsOf(sessions, parentID)].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );

  return (
    <div className="border-t border-[var(--border-base)] px-4 py-1.5">
      <div className="mx-auto flex max-w-3xl flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          {siblings.map((c) => (
            <GateChip
              key={c.id}
              id={c.id}
              label={c.title || c.agent || c.id}
              current={c.id === sessionID}
              running={isRunning(c.id)}
            />
          ))}
        </div>
        <div className="flex items-center justify-center gap-2 text-xs text-[var(--text-weaker)]">
          <button
            type="button"
            onClick={() => revealSubagentComposer()}
            className="cursor-pointer rounded-md border border-dashed border-[var(--border-weak-base)] px-1.5 py-0.5 font-mono transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
            title="Show the message composer"
          >
            enter
          </button>
          <span>to message this subagent</span>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => void selectSession(parentID)}
            title={`Back to parent${parentTitle ? `: ${parentTitle}` : ""}`}
            className="flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] px-1.5 py-0.5 transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
          >
            <ArrowUp className="size-3" />
            back to parent
          </button>
          <span aria-hidden>·</span>
          <span className="font-mono text-[10px]">←/→ switch</span>
        </div>
      </div>
    </div>
  );
}

function GateChip({
  id,
  label,
  current,
  running,
}: {
  id: string;
  label: string;
  current: boolean;
  running: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // With many siblings the strip wraps — keep "you are here" on screen.
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => void selectSession(id)}
      title={current ? "Currently open — ←/→ to switch" : label}
      className={`flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
        current
          ? "bg-[color:var(--surface-raised-base-active)] font-medium text-[color:var(--text-strong)]"
          : "text-[color:var(--text-weaker)] hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--text-weak)]"
      }`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${
          running ? "animate-pulse bg-emerald-500" : "bg-[color:var(--border-base)]"
        }`}
      />
      <span className="max-w-44 truncate">{label}</span>
    </button>
  );
}

/** Cheap content identity for a transcript: ids + per-part lengths. */
function transcriptFingerprint(messages: MessageInfo[], live: LiveAssistant[]): string {
  const parts: string[] = [];
  const push = (s: string | number) => parts.push(String(s));
  for (const m of messages) {
    push(m.id);
    if (m.type === "assistant") {
      push(m.content.length);
      push(m.finish ?? "");
      for (const p of m.content) {
        if (p.type === "tool") {
          push(`t${p.id}:${p.state.status}`);
          if (p.state.status === "streaming") push(p.state.input.length);
          else {
            push(len(p.state.input));
            // Metadata (tool titles, result summaries) can change within the
            // same status — ToolCard renders it, so it must invalidate.
            if ("metadata" in p.state) push(len(p.state.metadata));
            if ("content" in p.state && p.state.content) push(p.state.content.length);
            if (p.state.status === "error") push(len(p.state.error));
          }
        } else {
          push(`${p.type}:${p.text.length}`);
        }
      }
    } else if ("text" in m && typeof m.text === "string") {
      push(m.text.length);
      if ("files" in m && m.files) push(m.files.length);
    } else {
      // Text-less rows (shell/agent/model/location notes): any state change
      // shows in their serialized size.
      push(len(m));
    }
  }
  for (const a of live) {
    push(`live:${a.id}:${a.content.length}`);
    // Error notes render above the parts — their appearance must invalidate.
    push(a.error ? `${a.error.type}:${len(a.error.message)}` : "");
    for (const p of a.content) {
      if (p.type === "tool")
        push(
          `t${p.tool.id}:${p.tool.status}:${p.tool.executed ? 1 : 0}:` +
            `${len(p.tool.inputText)}:${len(p.tool.metadata)}:` +
            `${p.tool.content?.length ?? 0}:` +
            `${p.tool.error ? len(p.tool.error.message) : 0}`,
        );
      else push(`${p.type}:${p.ordinal}:${p.text.length}`);
    }
  }
  return parts.join("|");
}

function len(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return -1;
  }
}

interface TranscriptProps {
  messages: MessageInfo[];
  live: LiveAssistant[];
  running: boolean;
}

function areTranscriptsEqual(a: TranscriptProps, b: TranscriptProps): boolean {
  return (
    a.running === b.running &&
    transcriptFingerprint(a.messages, a.live) === transcriptFingerprint(b.messages, b.live)
  );
}

/**
 * Memoized on CONTENT (fingerprint), not array identity: identical-content
 * polls must not touch the DOM at all, so the scroller's MutationObserver
 * never fires and its autoscroll/stick cycle stays quiescent.
 */
const TranscriptList = React.memo(function TranscriptList({ messages, live, running }: TranscriptProps) {
  return (
    <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
      {messages.length === 0 && live.length === 0 && !running && (
        <MessageScrollerItem>
          <EmptyHint />
        </MessageScrollerItem>
      )}
      {(() => {
        let prevAssistant = false;
        const rows: ReactNode[] = [];

        // Model-switched notes render like their agent/location
        // siblings (muted one-liner in MessageItem); dropping them
        // hid real history events.
        for (const message of messages) {
          const isAssistant = message.type === "assistant";
          const compact = isAssistant && prevAssistant;
          prevAssistant = isAssistant;
          rows.push(
            <MessageScrollerItem key={message.id} messageId={message.id}>
              <MessageItem message={message} compact={compact} />
            </MessageScrollerItem>,
          );
        }

        // The live projection ALWAYS renders below the entire persisted
        // transcript. Anything fully persisted is history; whatever is
        // still streaming is "now". Anchor placements that compared
        // message timestamps against live[].started mixed client/server
        // clocks and let stale live entries float the block ABOVE fresh
        // messages — the "response renders above my message" bug. Steps
        // of one run stay ordered among themselves whether they render
        // from the transcript or the live block, because the poll
        // retires a live entry exactly when its persisted copy appears.
        if (live.length > 0) {
          rows.push(
            <MessageScrollerItem key="live">
              <LiveAssistantView assistants={live} running={running} />
            </MessageScrollerItem>,
          );
        }
        return rows;
      })()}
    </MessageScrollerContent>
  );
}, areTranscriptsEqual);

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

/** Sidebar-style workspace label: collapse /home/<user> to "~", else full path. */
function workspaceLabel(directory: string): string {
  return directory.replace(/\/+$/, "").replace(/^\/(home|Users)\/[^/]+/, "~");
}
function Header({
  title,
  sessionID,
  running,
  queued,
  parentID,
}: {
  title?: string;
  sessionID: string;
  running: boolean;
  queued: boolean;
  parentID?: string;
}) {
  const parentTitle = useStore((s) => s.sessionDetails[parentID ?? ""]?.title);
  // The draft has no server-side session yet — show its target workspace
  // instead of a title/id pair.
  const isDraft = isDraftSession(sessionID);
  const draftWorkspace = useStore((s) => s.draftWorkspace);
  return (
    <div className="flex items-center justify-between border-b border-[var(--border-base)] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        {parentID && (
          <button
            type="button"
            onClick={() => void selectSession(parentID)}
            title={`Back to parent session${parentTitle ? `: ${parentTitle}` : ""}`}
            className="cursor-pointer rounded-md border border-[var(--border-weak-base)] px-1.5 py-0.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
          >
            ↑ Parent
          </button>
        )}
        <button
          type="button"
          className="mr-1 cursor-pointer text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)] lg:hidden"
          onClick={() => void selectSession(null)}
        >
          ←
        </button>
        <span className="truncate text-[var(--font-size-base)] font-medium text-[var(--text-strong)]">
          {isDraft ? "New session" : (title ?? "Untitled session")}
        </span>
        {isDraft ? (
          // Sidebar groups by workspace with the same "~" collapse; mirror it
          // so the draft's target reads exactly like the sidebar entry.
          <span className="hidden truncate font-mono text-xs text-[var(--text-weaker)] sm:inline">
            {draftWorkspace ? workspaceLabel(draftWorkspace) : "default workspace"}
          </span>
        ) : (
          <span className="hidden font-mono text-xs text-[var(--text-weaker)] sm:inline">
            {sessionID.slice(0, 12)}
          </span>
        )}
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
  // Every errored step gets its own note — a multi-step run can fail twice
  // (e.g. a retry then a hard stop) and the first error must not mask later ones.
  const errors = assistants
    .filter((assistant) => assistant.error)
    .map((assistant) => ({ id: assistant.id, error: assistant.error! }));
  if (parts.length === 0 && !running && errors.length === 0) return null;
  return (
    <div>
      {errors.map(({ id, error }) => (
        <div
          key={id}
          className="mb-2 rounded-md border border-[color-mix(in_oklch,var(--surface-critical-strong)_40%,transparent)] bg-[var(--surface-critical-weak)] px-3 py-2 text-xs text-[var(--text-on-critical-strong)]"
        >
          <span className="font-medium">{error.type}</span>
          <div className="mt-0.5">{error.message}</div>
        </div>
      ))}
      {parts.length === 0 && running && errors.length === 0 && (
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
