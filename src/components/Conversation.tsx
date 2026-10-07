import React, { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ArrowUp, Menu, X } from "lucide-react";
import {
  applyRevertView,
  childSessionsOf,
  clearHighlightMessage,
  closeStashPanel,
  isDraftSession,
  liveToolPart,
  loadMessages,
  openMobileSidebar,
  pendingRequests,
  revertMarkerFor,
  revealSubagentComposer,
  selectSession,
  stashDeleteEntry,
  stashPopEntry,
  useStore,
  type LiveAssistant,
  type LiveContentPart,
} from "../store";
import type { MessageInfo } from "../api/types";
import { Target, autoRegister } from "../extensions/registry";
import { Slot } from "../extensions/slots";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerVisibility,
} from "./ui/message-scroller";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { useKeyboardOpen } from "../hooks/useKeyboardOpen";
import { McpIndicator } from "./McpIndicator";
import { MessageItem, MessagePart } from "./MessageItem";
import { PendingRequestsPanel } from "./PendingRequestsPanel";
import { QueueStrip } from "./QueueStrip";
import { RunsPanel } from "./RunsPanel";
import { SendErrorStrip } from "./SendErrorStrip";
import { SessionMenu } from "./SessionMenu";
import { SubagentStrip } from "./SubagentStrip";
import { ThemePicker } from "./ThemePicker";
import { WorkspacePicker } from "./WorkspacePicker";

/** In-pane navigation: goes through the focused pane's surface. */
type NavigateFn = (sessionID: string | null) => void;

/**
 * Scroll `viewport` until `element` sits at the requested alignment.
 *
 * A single `scrollTo`/`scrollIntoView` is unreliable in this transcript: the
 * items are `content-visibility:auto`, so a far element's measured offset is
 * only an ESTIMATE (skipped items report their intrinsic placeholder size), and
 * the target drifts as the neighbourhood renders — the "click once, wait, click
 * again" miss. Nudging by the measured delta forces the neighbourhood to
 * render, which makes the next measurement exact, so it lands within a frame or
 * two. Returns a cancel function; a real user scroll (wheel/touch) cancels it.
 */
function convergeScroll(
  viewport: HTMLElement,
  element: HTMLElement,
  {
    align = "start",
    margin = 0,
    deadlineMs = 2500,
  }: { align?: "start" | "center"; margin?: number; deadlineMs?: number } = {},
): () => void {
  const deadline = performance.now() + deadlineMs;
  let raf = 0;
  let stable = 0;
  const cancel = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    viewport.removeEventListener("wheel", cancel);
    viewport.removeEventListener("touchstart", cancel);
  };
  const tick = () => {
    raf = 0;
    if (!element.isConnected) return cancel();
    const vr = viewport.getBoundingClientRect();
    const er = element.getBoundingClientRect();
    const delta =
      align === "center"
        ? er.top - (vr.top + (vr.height - er.height) / 2)
        : er.top - vr.top - margin;
    if (Math.abs(delta) <= 2) {
      // A single zero is not enough: aligning to a content-visibility ESTIMATE
      // can read as aligned, then shift by thousands of px when the buffer
      // renders the items above. Only finish once the position HOLDS.
      if (++stable >= 15) return cancel();
      raf = requestAnimationFrame(tick);
      return;
    }
    stable = 0;
    if (performance.now() > deadline) return cancel();
    const before = viewport.scrollTop;
    viewport.scrollTop = before + delta;
    // Clamped (top of transcript / end of spacer) and can't get closer.
    if (Math.abs(viewport.scrollTop - before) < 1) return cancel();
    raf = requestAnimationFrame(tick);
  };
  viewport.addEventListener("wheel", cancel, { passive: true });
  viewport.addEventListener("touchstart", cancel, { passive: true });
  raf = requestAnimationFrame(tick);
  return cancel;
}

export interface ConversationProps {
  sessionID: string;
  /** Which split pane this instance renders — namespaces its DOM ids. */
  paneKey?: string;
  /** Only the focused pane owns global chrome (runs panel, gate swap). */
  focused?: boolean;
  /** Present only in split panes — renders the ✕ close affordance. */
  onClose?: () => void;
  /** In-pane navigation; defaults to global selectSession for safety. */
  onNavigate?: NavigateFn;
}

export function Conversation({
  sessionID,
  paneKey = "main",
  focused = true,
  onClose,
  onNavigate,
}: ConversationProps) {
  // Every in-pane navigation routes through onNavigate when provided so a
  // split pane swaps ITS content instead of yanking the whole app.
  const go: NavigateFn = (sid) => (onNavigate ? onNavigate(sid) : void selectSession(sid));
  // Pane root: scopes DOM lookups so split panes (which can hold the same
  // session) never resolve each other's elements.
  const rootRef = useRef<HTMLDivElement>(null);
  // Cancels the in-flight highlight scroll convergence.
  const cancelHighlight = useRef<() => void>(() => {});
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID]);
  const allMessages = useStore((s) => s.messages[sessionID] ?? []);
  // Per-pane isolation: this pane renders ONLY its own session's live
  // projection, never another pane's streaming entries.
  const live = useStore((s) => s.live.filter((a) => a.sessionID === sessionID));
  const running = useStore((s) => s.running[sessionID] ?? false);
  const queued = useStore((s) => !!s.queued[sessionID]);
  const isPanelOpen = useStore((s) => s.runsPanelOpen);
  const isStashOpen = useStore((s) => s.stashPanelOpen);
  const stashEntries = useStore((s) => s.stashEntries);
  const composerOpen = useStore((s) => s.subagentComposerOpen);
  // A pending permission/question/form for THIS session takes the composer
  // slot over (focused pane only — background panes keep their composer).
  const ownPending = useStore((s) =>
    focused ? pendingRequests(s).some((r) => r.req.sessionID === sessionID) : false,
  );
  // A staged revert rewrites the visible transcript (service keeps full
  // history). The marker is event/local-owned (see State.revertMarkers) —
  // reading the detail's field directly here would resurrect a cleared cut.
  const revertMarker = useStore((s) => revertMarkerFor(s, sessionID));
  // Mobile keyboard open = only the input box stays above it; the strips
  // below gate on this (hidden <sm while typing).
  const kbOpen = useKeyboardOpen();
  const messages = useMemo(
    () => applyRevertView(allMessages, revertMarker),
    [allMessages, revertMarker],
  );

  useEffect(() => {
    void loadMessages(sessionID);
  }, [sessionID]);

  // Scroll + text-level highlight when Sidebar search navigates to a specific message.
  const highlightID = useStore((s) => s.highlightMessageID);
  const highlightSID = useStore((s) => s.highlightSessionID);
  const highlightQuery = useStore((s) => s.highlightQuery);
  const highlightTick = useStore((s) => s.highlightTick);
  useEffect(() => {
    if (!highlightID || highlightSID !== sessionID) return;

    let cancelled = false;

    const clearPrevious = () => {
      const scope: ParentNode = rootRef.current ?? document;
      scope.querySelectorAll('[data-search-highlight="true"]').forEach((el) => {
        const parent = el.parentNode;
        if (!parent) return;
        // Unwrap: replace the highlight span with its text content.
        const text = document.createTextNode(el.textContent ?? "");
        parent.replaceChild(text, el);
        // Merge adjacent text nodes to keep DOM tidy.
        (parent as Element).normalize?.();
      });
    };

    const highlightIn = (root: HTMLElement, query: string): HTMLElement | null => {
      const qLower = query.toLowerCase();
      if (!qLower) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      // Collect text nodes first so we can mutate safely.
      const nodes: Text[] = [];
      while ((node = walker.nextNode() as Text | null)) {
        // Skip already-highlighted or hidden source nodes.
        if ((node.parentElement as HTMLElement | null)?.closest('[data-search-highlight="true"]')) continue;
        if (!node.nodeValue || node.nodeValue.trim() === "") continue;
        nodes.push(node);
      }
      for (const textNode of nodes) {
        const text = textNode.nodeValue ?? "";
        const idx = text.toLowerCase().indexOf(qLower);
        if (idx === -1) continue;
        const before = text.slice(0, idx);
        const match = text.slice(idx, idx + query.length);
        const after = text.slice(idx + query.length);
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        const mark = document.createElement("span");
        mark.setAttribute("data-search-highlight", "true");
        mark.textContent = match;
        frag.appendChild(mark);
        if (after) frag.appendChild(document.createTextNode(after));
        textNode.parentNode?.replaceChild(frag, textNode);
        return mark;
      }
      return null;
    };

    const tryScroll = (): boolean => {
      const pane = rootRef.current;
      if (!pane) return false;
      // Scoped to THIS pane (split panes can show the same session, so a
      // document-wide id lookup could grab the other pane's node).
      const container =
        pane.querySelector<HTMLElement>(`#${CSS.escape(`msg-${highlightID}`)}`) ??
        pane.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(highlightID)}"]`);
      if (!container) return false;
      const viewport = container.closest<HTMLElement>('[data-slot="message-scroller-viewport"]');
      clearPrevious();
      cancelHighlight.current();
      // If we have a query, highlight the matched substring and scroll to it;
      // otherwise fall back to scrolling the message block itself. Either way we
      // CONVERGE (see convergeScroll) so a content-visibility estimate can't
      // leave the hit off screen — the search-click twin of the rail's jump.
      if (highlightQuery) {
        const mark = highlightIn(container, highlightQuery);
        if (mark) {
          if (viewport) cancelHighlight.current = convergeScroll(viewport, mark, { align: "center" });
          // Fade out then unwrap so the DOM returns to its original state.
          setTimeout(() => {
            const parent = mark.parentNode;
            if (parent) {
              const text = document.createTextNode(mark.textContent ?? "");
              parent.replaceChild(text, mark);
              (parent as Element).normalize?.();
            }
          }, 2800);
          // Consume the request: without this the `messages` dependency re-runs
          // the effect on every poll (and after each send) and keeps yanking the
          // view back up to the same hit. The DOM highlight fades on its own.
          clearHighlightMessage();
          return true;
        }
      }
      // Fallback: scroll to the message and apply a subtle whole-message ring
      // as a secondary cue when text-level match was not found.
      if (viewport) cancelHighlight.current = convergeScroll(viewport, container, { align: "center" });
      container.classList.add("ring-1", "ring-[var(--surface-warning-strong)]", "rounded-lg");
      setTimeout(() => container.classList.remove("ring-1", "ring-[var(--surface-warning-strong)]", "rounded-lg"), 1800);
      // Same consume-once rule as the text-match branch above.
      clearHighlightMessage();
      return true;
    };

    // RAF-scheduled retry loop: waits for React to mount the transcript
    // (and for loadMessages to resolve) without the 150ms jitter of setInterval.
    let raf = 0;
    let tries = 0;
    const maxTries = 60; // ~1s at 60fps; loadMessages may take longer
    const tick = () => {
      if (cancelled) return;
      if (tryScroll()) return;
      if (++tries >= maxTries) return;
      raf = requestAnimationFrame(tick);
    };
    // First try on next frame so the DOM from the messages dependency has painted.
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      // Do not clearPrevious on unmount — let the highlight's own timer finish
      // so the user sees the fade even if the component re-renders.
    };
    // messages ensures we re-attempt if the transcript was still loading;
    // tick ensures re-click on the same hit (same ID, same query) re-fires.
  }, [sessionID, highlightID, highlightSID, highlightQuery, highlightTick, messages]);

  // Cancel an in-flight highlight scroll only on unmount — the effect above
  // re-runs on every poll, and cancelling there would abort the convergence
  // the moment `clearHighlightMessage()` cleared the id.
  useEffect(() => () => cancelHighlight.current(), []);

  return (
    <div ref={rootRef} className="pane-surface flex min-h-0 min-w-0 flex-1 flex-col">
      <Target
        id="conversation.header"
        title={session?.title}
        sessionID={sessionID}
        running={running}
        queued={queued}
        parentID={session?.parentID}
        go={go}
        onClose={onClose}
      />
      {!isDraftSession(sessionID) && <SubagentStrip sessionID={sessionID} onNavigate={onNavigate} />}

      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              {/* The 2s poll (mergeFetchedMessages) replaces the messages array
                  even when content is identical; without this guard every poll
                  re-renders the whole transcript, re-runs the scroller's stick
                  logic and toggles its data-autoscrolling attribute — the
                  flicker the user sees as data-autoscroll appearing/disappearing. */}
              <TranscriptList
                sessionID={sessionID}
                messages={messages}
                live={live}
                running={running}
              />
            </MessageScrollerViewport>
            <MessageScrollerButton direction="end" />
            <ScrollToEndOnUserSend sessionID={sessionID} messages={messages} />
          </MessageScroller>
          <UserMessageRail messages={messages} />
        </div>
      </MessageScrollerProvider>

      {/* Mobile keyboard: every strip above the input box docks away while
          typing — only the input field rides above the keyboard. Wrappers
          stay mounted (state-safe), hidden <sm only; desktop unaffected. */}
      <div className={kbOpen ? "hidden sm:block" : ""}>
        <SendErrorStrip sessionID={sessionID} />
      </div>
      {/* Pending busy-sends (steer/queue) — above the whole composer slot so
          it also shows while RunsPanel/gate replace the composer. */}
      <div className={kbOpen ? "hidden sm:block" : ""}>
        <QueueStrip sessionID={sessionID} />
      </div>
      {/* Extension contributions above the composer. Deliberately OUTSIDE the
          composer swap below: the Composer is REPLACED by the pending-request
          panel, RunsPanel and the StashPanel, so a contribution rendered
          inside it (where this slot used to live) disappears precisely when it
          is needed — a permission countdown unmounting the instant a
          permission arrives. Placement is the slot id's whole meaning. */}
      {focused && (
        <div className={kbOpen ? "hidden sm:block" : ""}>
          <Slot id="composer.above" sessionID={sessionID} />
        </div>
      )}
      {!focused ? (
        // Unfocused panes stream their own live projection but carry none of
        // the focused pane's global chrome — always the plain composer,
        // never the runs-panel/gate swaps.
        <Target id="composer" sessionID={sessionID} paneKey={paneKey} />
      ) : ownPending ? (
        // This session's pending permission/question/form REPLACES the
        // composer until resolved — the agent is blocked on it (panel owns
        // Esc). RunsPanel state survives underneath and returns after.
        <PendingRequestsPanel sessionID={sessionID} />
      ) : isPanelOpen ? (
        <RunsPanel sessionID={sessionID} paneKey={paneKey} />
      ) : isStashOpen ? (
        // P6: the prompt stash also replaces the composer, and owns Esc while
        // it is up. Only the focused pane renders it (same rule as RunsPanel).
        <Target
          id="stash.panel"
          entries={stashEntries}
          onPop={stashPopEntry}
          onDelete={stashDeleteEntry}
          onClose={closeStashPanel}
        />
      ) : session?.parentID && !composerOpen ? (
        // Subagent pages open read-only — Enter reveals the composer
        // (site-wide binding in App), Backspace/↑ return to the parent.
        <SubagentGate sessionID={sessionID} parentID={session.parentID} go={go} />
      ) : (
        <Target id="composer" sessionID={sessionID} paneKey={paneKey} />
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
function SubagentGate({
  sessionID,
  parentID,
  go,
}: {
  sessionID: string;
  parentID: string;
  go: (sessionID: string | null) => void;
}) {
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
    <div className="border-t border-[var(--border-base)] px-2.5 py-1.5 sm:px-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
          {siblings.map((c) => (
            <GateChip
              key={c.id}
              id={c.id}
              label={c.title || c.agent || c.id}
              current={c.id === sessionID}
              running={isRunning(c.id)}
              go={go}
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
            onClick={() => go(parentID)}
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
  go,
}: {
  id: string;
  label: string;
  current: boolean;
  running: boolean;
  go: (sessionID: string | null) => void;
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
      onClick={() => go(id)}
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
  sessionID: string;
  messages: MessageInfo[];
  live: LiveAssistant[];
  running: boolean;
}

function areTranscriptsEqual(a: TranscriptProps, b: TranscriptProps): boolean {
  return (
    a.sessionID === b.sessionID &&
    a.running === b.running &&
    transcriptFingerprint(a.messages, a.live) === transcriptFingerprint(b.messages, b.live)
  );
}

/**
 * Memoized on CONTENT (fingerprint), not array identity: identical-content
 * polls must not touch the DOM at all, so the scroller's MutationObserver
 * never fires and its autoscroll/stick cycle stays quiescent.
 */
const TranscriptList = React.memo(function TranscriptList({ sessionID, messages, live, running }: TranscriptProps) {
  return (
    <MessageScrollerContent className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-4 sm:py-6" data-oc-transcript>
      {messages.length === 0 && live.length === 0 && !running && (
        <>
          {/* The empty state IS the `conversation.empty` target's core default
              (registered at the bottom of this file) — render it through the
              Target so wraps/replaces apply, and once only. The Slot of the
              same id below is the placement point for extensions that add
              content alongside it. */}
          <MessageScrollerItem>
            <Target id="conversation.empty" sessionID={sessionID} />
          </MessageScrollerItem>
          <Slot id="conversation.empty" sessionID={sessionID} />
        </>
      )}
      {(() => {
        let prevAssistant = false;
        const rows: ReactNode[] = [];

        // Model-switched notes render like their agent/location
        // siblings (muted one-liner in MessageItem); dropping them
        // hid real history events.
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i]!;
          const isAssistant = message.type === "assistant";
          const compact = isAssistant && prevAssistant;
          prevAssistant = isAssistant;
          const next = messages[i + 1] as MessageInfo | undefined;
          const isTail = isAssistant && next?.type !== "assistant";
          let responseText: string | undefined;
          if (isTail) {
            // Walk backwards to collect the whole consecutive assistant block
            // so the copy at its tail copies the entire response, not just the final chunk.
            const parts: string[] = [];
            for (let j = i; j >= 0; j--) {
              const m = messages[j] as MessageInfo;
              if (m.type !== "assistant") break;
              const textParts = (m as { content?: { type: string; text?: string }[] }).content
                ?.filter((p) => p.type === "text" && p.text?.trim())
                .map((p) => p.text!.trim());
              if (textParts && textParts.length > 0) parts.unshift(textParts.join("\n\n"));
            }
            const combined = parts.join("\n\n");
            if (combined) responseText = combined;
          }
          rows.push(
            <MessageScrollerItem key={message.id} messageId={message.id} id={`msg-${message.id}`}>
              <MessageItem message={message} compact={compact} sessionID={sessionID} isTail={isTail} responseText={responseText} />
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
    <div className="flex justify-center px-2 pt-10 sm:pt-16">
      <div className="flex w-full max-w-md flex-col items-center gap-1.5 rounded-lg border border-[var(--border-weak-base)] bg-[var(--background-weak)] px-5 py-8 text-center sm:px-8 sm:py-10">
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
export interface HeaderProps {
  title?: string;
  sessionID: string;
  running: boolean;
  queued: boolean;
  parentID?: string;
  go: (sessionID: string | null) => void;
  onClose?: () => void;
}

function Header({
  title,
  sessionID,
  running,
  queued,
  parentID,
  go,
  onClose,
}: HeaderProps) {
  const parentTitle = useStore((s) => s.sessionDetails[parentID ?? ""]?.title);
  // The draft has no server-side session yet — show its target workspace
  // instead of a title/id pair.
  const isDraft = isDraftSession(sessionID);
  const draftWorkspace = useStore((s) => s.draftWorkspace);
  return (
    <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-base)] bg-[var(--background-base)] px-2.5 py-2 sm:px-4 sm:py-2.5" data-oc-session-header>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
        {/* Mobile navigation: opens the sessions drawer (sidebar is off-canvas <md). */}
        <button
          type="button"
          onClick={openMobileSidebar}
          title="Open sessions"
          aria-label="Open sessions"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)] md:hidden"
        >
          <Menu className="size-4" />
        </button>
        {parentID && (
          <button
            type="button"
            onClick={() => go(parentID)}
            title={`Back to parent session${parentTitle ? `: ${parentTitle}` : ""}`}
            className="cursor-pointer rounded-md border border-[var(--border-weak-base)] px-1.5 py-0.5 text-xs text-[var(--text-weak)] transition-colors hover:border-[var(--border-selected)] hover:text-[var(--text-strong)]"
          >
            ↑ Parent
          </button>
        )}
        <button
          type="button"
          className="mr-1 cursor-pointer text-[var(--text-weaker)] transition-colors hover:text-[var(--text-strong)] lg:hidden"
          // In a split pane the mobile back arrow closes the pane instead
          // of navigating away from its pinned session.
          onClick={() => (onClose ? onClose() : go(null))}
        >
          ←
        </button>
        <span className="truncate text-[var(--font-size-base)] font-medium text-[var(--text-strong)]">
          {isDraft ? "New session" : (title ?? "Untitled session")}
        </span>
        {isDraft ? (
          // Sidebar groups by workspace with the same "~" collapse; mirror it
          // so the draft's target reads exactly like the sidebar entry.
          <span className="hidden truncate font-mono text-xs text-[var(--text-weaker)] lg:inline">
            {draftWorkspace ? workspaceLabel(draftWorkspace) : "default workspace"}
          </span>
        ) : (
          <span className="hidden font-mono text-xs text-[var(--text-weaker)] lg:inline">
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
      <div className="flex shrink-0 items-center gap-0.5 sm:gap-1.5">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close split"
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
          >
            <X className="size-3.5" />
          </button>
        )}
        <McpIndicator />
        <WorkspacePicker sessionID={sessionID} />
        <ThemePicker />
        <SessionMenu sessionID={sessionID} />
        <Slot id="conversation.header.actions" sessionID={sessionID} />
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

/**
 * Vertical message rail — one dot per user turn, pinned to the right edge of
 * the transcript.
 *
 * ARCHITECTURE (why it stays fast AND reliable):
 * - It is a pure projection of the message MODEL (`messages`), never of the
 *   DOM. `loadMessages` fetches the whole history up front precisely so the
 *   rail and search see every user turn — so the rail knows about turns the
 *   browser has not painted, and it can't be broken by ids that don't exist
 *   yet or by duplicate `msg-` ids across split panes.
 * - "Which turn am I on" comes from the scroller's own visibility store (one
 *   IntersectionObserver rooted at the viewport → O(visible)), mapped back
 *   through the model. No per-message measurement, no scroll listeners.
 * - Render cost is decoupled by `content-visibility:auto` on each item: every
 *   item exists, but off-screen ones cost ~nothing to lay out or paint, so
 *   nothing here needs the transcript to be virtualized.
 * - Navigation uses `scrollToMessage`, which owns the target's geometry (and
 *   the end spacer, so even the last turn can reach the top). A target that is
 *   not mounted still navigates via a proportional fallback, and the exact
 *   placement is re-asserted once the layout settles.
 */
function UserMessageRail({ messages }: { messages: MessageInfo[] }) {
  const userMsgs = useMemo(() => messages.filter((m) => m.type === "user"), [messages]);
  // A single turn is not navigation — one dot is noise. Two or more is where
  // the rail starts earning its space.
  if (userMsgs.length < 2) return null;
  return <MessageRail messages={messages} userMsgs={userMsgs} />;
}

interface RailDotProps {
  id: string;
  index: number;
  total: number;
  active: boolean;
  text: string;
  onJump: (id: string) => void;
}

/**
 * One dot. Memoized so a poll (the store swaps the message array every ~2s
 * even when identical) or a visibility tick only renders the dots whose props
 * actually moved — never the whole rail. Its preview is a portal'd tooltip, so
 * a long message can't be clipped by the transcript's `overflow-hidden` and
 * Radix keeps it inside the viewport.
 */
const RailDot = React.memo(function RailDot({ id, index, total, active, text, onJump }: RailDotProps) {
  // Collapse whitespace for a tidy preview. Done here (inside the memoized
  // dot) rather than in the rail, so the store's ~2s array swaps only re-run it
  // for the dots whose text actually changed.
  const preview = text.replace(/\s+/g, " ").trim();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onJump(id)}
          aria-label={`Go to your message ${index + 1} of ${total}`}
          aria-current={active ? "true" : undefined}
          className="group flex size-4 shrink-0 cursor-pointer items-center justify-center"
        >
          <span
            className={`rounded-full ring-1 transition-all ${
              active
                ? "size-3 bg-[var(--surface-brand-base)] ring-[var(--surface-brand-base)] shadow-sm"
                : "size-2 bg-[var(--text-weaker)] ring-[var(--border-weak-base)] group-hover:size-2.5 group-hover:bg-[var(--text-strong)]"
            }`}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        sideOffset={12}
        className="block max-w-[26rem] rounded-xl border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] px-4 py-3 text-left text-sm leading-relaxed text-[var(--text-weak)] shadow-xl [&>svg]:hidden"
      >
        <div className="mb-1 text-[10px] font-medium tracking-wide text-[var(--text-weaker)] uppercase">
          Your message {index + 1} of {total}
        </div>
        <div className="line-clamp-[8] break-words whitespace-pre-wrap">{preview || "(empty message)"}</div>
      </TooltipContent>
    </Tooltip>
  );
});

function MessageRail({
  messages,
  userMsgs,
}: {
  messages: MessageInfo[];
  userMsgs: MessageInfo[];
}) {
  const { scrollToMessage } = useMessageScroller();
  const { visibleMessageIds } = useMessageScrollerVisibility();
  const railRef = useRef<HTMLDivElement>(null);
  const cancelJump = useRef<() => void>(() => {});

  // Model lookup: a message id → its index in the transcript.
  const order = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((m, i) => map.set(m.id, i));
    return map;
  }, [messages]);

  // Latest values for the stable click handler (below), so dot props stay
  // referentially stable and memoization holds.
  const latest = useRef({ messages, order, scrollToMessage });
  latest.current = { messages, order, scrollToMessage };

  // Active = the last user turn at or above the topmost visible message.
  // Deriving it from viewport visibility (not `getElementById`) keeps it
  // correct across session switches, reverts and split panes.
  const activeId = useMemo(() => {
    let pivot = Number.POSITIVE_INFINITY;
    for (const id of visibleMessageIds) {
      const idx = order.get(id);
      if (idx != null && idx < pivot) pivot = idx;
    }
    if (!Number.isFinite(pivot)) return null;
    let active: string | null = null;
    for (const m of userMsgs) {
      const idx = order.get(m.id);
      if (idx == null) continue;
      if (idx > pivot) break;
      active = m.id;
    }
    return active;
  }, [visibleMessageIds, order, userMsgs]);

  const activeIndex = useMemo(
    () => (activeId == null ? -1 : userMsgs.findIndex((m) => m.id === activeId)),
    [userMsgs, activeId],
  );

  // Keep the active dot inside the rail's own scroll window as you read. The
  // effect keys on the INDEX (a primitive), so a poll that recomputes `dots`
  // with the same active turn does not re-scroll.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || activeIndex < 0) return;
    const dot = rail.querySelector<HTMLElement>('[aria-current="true"]');
    if (!dot) return;
    const railBox = rail.getBoundingClientRect();
    const dotBox = dot.getBoundingClientRect();
    if (dotBox.top < railBox.top) rail.scrollBy({ top: dotBox.top - railBox.top, behavior: "smooth" });
    else if (dotBox.bottom > railBox.bottom)
      rail.scrollBy({ top: dotBox.bottom - railBox.bottom, behavior: "smooth" });
  }, [activeIndex]);

  useEffect(() => () => cancelJump.current(), []);

  const jumpTo = useCallback((id: string) => {
    cancelJump.current();
    const { messages: list, order: idxOf, scrollToMessage: scroll } = latest.current;
    const pane = railRef.current?.closest(".pane-surface") as HTMLElement | null;
    const viewport =
      pane?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]') ?? null;
    const selector = `[data-message-id="${CSS.escape(id)}"]`;

    if (pane?.querySelector(selector)) {
      // Mounted (always today): let the scroller own the landing — it also
      // grows the end spacer so even the last turn can reach the top.
      scroll(id, { align: "start", behavior: "smooth" });
    } else {
      // Not mounted (a future virtualized transcript): land proportionally so
      // the click still moves, then converge below once the item mounts.
      const idx = idxOf.get(id);
      if (viewport && idx != null && list.length > 1) {
        const max = viewport.scrollHeight - viewport.clientHeight;
        if (max > 0) viewport.scrollTo({ top: (idx / (list.length - 1)) * max, behavior: "smooth" });
      }
    }

    // Converge onto the exact position: a far target's measured offset is only
    // a content-visibility estimate, so one jump can miss (the "click once,
    // wait, click again" bug). Starting immediately takes over from the
    // scroller's smooth animation and holds the target through the buffer
    // settling.
    if (!viewport) return;
    const el = pane?.querySelector<HTMLElement>(selector) ?? null;
    const cancelConverge = el ? convergeScroll(viewport, el, { align: "start" }) : null;
    cancelJump.current = () => cancelConverge?.();
  }, []);

  return (
    // `inset-y-3` (not top-1/2/translate) gives this box a DEFINITE height —
    // the transcript area minus its margins — so `max-h-full` on the pill can
    // resolve against it. That keeps the whole rail inside the pane even when
    // the bottom activity strip squeezes the transcript short; a 70vh cap did
    // not, and let the top dots clip under the header.
    <div className="pointer-events-none absolute inset-y-3 right-3 hidden flex-col items-center justify-center md:flex">
      <div className="pointer-events-auto relative flex max-h-full min-h-0 flex-col items-center rounded-full border border-[var(--border-weak-base)] bg-[var(--background-base)]/95 px-2 py-3 shadow-md backdrop-blur">
        <div aria-hidden className="pointer-events-none absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-[var(--border-weak-base)]" />
        <div
          ref={railRef}
          className="flex min-h-0 flex-col items-center gap-2 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {userMsgs.map((m, i) => (
            <RailDot
              key={m.id}
              id={m.id}
              index={i}
              total={userMsgs.length}
              active={m.id === activeId}
              text={(m as { text?: string }).text ?? ""}
              onJump={jumpTo}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function livePartKey(assistantID: string, part: LiveContentPart): string {
  return part.type === "tool"
    ? `${assistantID}:tool:${part.tool.id}`
    : `${assistantID}:${part.type}:${part.ordinal}`;
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  conversation: (p) => <Conversation {...(p as unknown as ConversationProps)} />,
  "conversation.header": (p) => <Header {...(p as unknown as HeaderProps)} />,
  "conversation.empty": (p) => <EmptyHint {...(p as unknown as Record<string, never>)} />,
});
