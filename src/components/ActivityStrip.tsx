import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ExternalLink, PictureInPicture2 } from "lucide-react";
import { childSessionsOf, lastLiveSignalAt, navigateFocused, useStore, type LiveAssistant, type LiveContentPart, type LiveTool } from "../store";
import { registerPoller } from "../lib/scheduler";
import type { SessionInfo } from "../api/types";

const COLLAPSED_KEY = "webui.activityStrip.collapsed";
/** activeIDs-only liveness window: the engine's active map lags reality by
 * tens of seconds, so a bare entry counts only while its last live event is
 * this fresh. (running/queued flags and unfinished live entries speak for
 * themselves and need no window.) */
const ACTIVE_ID_FRESH_MS = 15_000;

function workspaceShort(dir: string | undefined): string {
  if (!dir) return "";
  return dir.replace(/\/+$/, "").replace(/^\/(home|Users)\/[^/]+/, "~");
}

function elapsed(started: number): string {
  const s = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function toolLabel(tool: LiveTool): string {
  const name = tool.name || "tool";
  // Streaming input shows JSON shards — truncate.
  if (tool.status === "streaming" && tool.inputText) {
    const one = tool.inputText.replace(/\s+/g, " ").trim().slice(0, 80);
    return one ? `${name} ${one}…` : name;
  }
  const input = tool.input as Record<string, unknown> | undefined;
  if (input) {
    if (typeof input.path === "string") return `${name} ${String(input.path).split("/").pop()}`;
    if (typeof input.command === "string") return `${name} ${String(input.command).slice(0, 48)}`;
    if (typeof input.pattern === "string") return `${name} "${String(input.pattern).slice(0, 32)}"`;
    if (typeof input.description === "string") return `${name} ${(input.description as string).slice(0, 40)}`;
    if (typeof input.agent === "string" && typeof input.description === "string") return `${name} ${String(input.agent)} — ${String(input.description).slice(0, 24)}`;
  }
  if (tool.inputText) {
    try {
      const parsed = JSON.parse(tool.inputText) as Record<string, unknown>;
      if (typeof parsed.path === "string") return `${name} ${String(parsed.path).split("/").pop()}`;
      if (typeof parsed.command === "string") return `${name} ${String(parsed.command).slice(0, 48)}`;
    } catch { /* */ }
    const one = tool.inputText.replace(/\s+/g, " ").trim().slice(0, 80);
    if (one && one !== "{}" && one !== "[]") return `${name} ${one}`;
  }
  return name;
}

function copyStyles(pipWin: Window) {
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    pipWin.document.head.appendChild(node.cloneNode(true) as Node);
  });
  try {
    // @ts-ignore Chrome-only adopted sheets (Tailwind constructable)
    if ((document as unknown as { adoptedStyleSheets?: unknown }).adoptedStyleSheets?.length) {
      // @ts-ignore
      pipWin.document.adoptedStyleSheets = (document as unknown as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets;
    }
  } catch { /* */ }
}

function DenseToolRow({ tool }: { tool: LiveTool }) {
  const running = tool.status === "running" || tool.status === "streaming";
  const failed = tool.status === "error";
  const icon = failed ? "✗" : running ? "⠋" : tool.name === "subagent" ? "→" : tool.name === "shell" || tool.name === "bash" ? "$" : tool.name === "edit" ? "←" : "·";
  return (
    <div className={`flex min-w-0 items-center gap-1.5 truncate py-0.5 text-[11px] ${failed ? "text-[var(--surface-critical-strong)]" : running ? "text-[var(--text-base)]" : "text-[var(--text-weak)]"}`}>
      <span className={`w-3 shrink-0 text-center font-mono text-[10px] ${running ? "animate-pulse" : ""}`}>{running ? "●" : icon}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{toolLabel(tool)}</span>
      {running && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden />}
    </div>
  );
}

function DenseLiveView({ assistants }: { assistants: LiveAssistant[] }) {
  if (assistants.length === 0) return <span className="text-[11px] italic text-[var(--text-weaker)]">waiting…</span>;
  // Keep ordered parts; cap to last few to stay compact but show streaming tails.
  const parts = assistants.flatMap((a) => a.content);
  // Show at most 1 reasoning + 2 text tails + all pending/running tools, last 5 tools max.
  const reasoning = parts.filter((p) => p.type === "reasoning").slice(-1) as Extract<LiveContentPart, { type: "reasoning" }>[];
  const texts = parts.filter((p) => p.type === "text").slice(-2) as Extract<LiveContentPart, { type: "text" }>[];
  const tools = parts.filter((p) => p.type === "tool").slice(-6) as Extract<LiveContentPart, { type: "tool" }>[];
  const runningTools = tools.filter((p) => p.tool.status === "running" || p.tool.status === "streaming");
  const otherTools = tools.filter((p) => p.tool.status !== "running" && p.tool.status !== "streaming").slice(-3);
  const toolParts = [...otherTools, ...runningTools];
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {reasoning.length > 0 && (
        <div className="line-clamp-1 truncate text-[11px] italic text-[var(--text-weaker)]">
          {(() => {
            const rt = reasoning[0]!.text.replace(/\s+/g, " ").trim();
            // Tail, not head: the point is FOLLOWING the stream as it grows.
            const tail = rt.length > 140 ? `…${rt.slice(-140)}` : rt;
            return `thought: ${tail}`;
          })()}
        </div>
      )}
      {texts.map((p) => {
        const t = p.text.replace(/\s+/g, " ").trim();
        if (!t) return null;
        const tail = t.length > 220 ? `…${t.slice(-220)}` : t;
        return (
          <div key={`t-${p.ordinal}`} className="line-clamp-2 break-words text-xs leading-snug text-[var(--text-base)]">
            {tail}
          </div>
        );
      })}
      {toolParts.map((p) => (
        <DenseToolRow key={p.tool.id} tool={p.tool} />
      ))}
      {parts.length === 0 && <span className="text-[11px] text-[var(--text-weaker)]">working…</span>}
    </div>
  );
}

function SessionRow({ session, assistants, running, queued, onOpen }: { session: SessionInfo; assistants: LiveAssistant[]; running: boolean; queued: boolean; onOpen: (id: string) => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    return registerPoller({
      name: "activity-row-elapsed",
      minInterval: 1_000,
      run: () => setTick((v) => v + 1),
    });
  }, [running]);
  void tick;
  const started = assistants[0]?.started ?? session.time?.updated ?? Date.now();
  const status: "running" | "queued" | "idle" = running ? "running" : queued ? "queued" : "idle";
  const dotClass =
    status === "running"
      ? "bg-emerald-500 animate-pulse"
      : status === "queued"
        ? "bg-amber-500 animate-pulse"
        : "bg-[var(--border-base)]";
  return (
    <div className="group flex min-w-0 flex-col gap-1 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2 py-1.5 hover:border-[var(--border-base)]">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-strong)]" title={session.title ?? session.id}>
          {session.title || "Untitled session"}
        </span>
        {session.location?.directory && (
          <span className="hidden max-w-[14ch] truncate font-mono text-[10px] text-[var(--text-weaker)] sm:inline" title={session.location.directory}>
            {workspaceShort(session.location.directory)}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{running ? elapsed(started) : queued ? "queued" : ""}</span>
        <button
          type="button"
          onClick={() => onOpen(session.id)}
          title="Open session"
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-transparent px-1 py-0.5 text-[11px] text-[var(--text-weaker)] hover:border-[var(--border-weak-base)] hover:text-[var(--text-strong)]"
        >
          <ExternalLink className="size-3" /> open
        </button>
      </div>
      <div className="min-w-0 pl-3">
        <DenseLiveView assistants={assistants} />
      </div>
    </div>
  );
}

function ActivityStripInner({ onOpen }: { onOpen: (id: string) => void }) {
  const sessions = useStore((s) => s.sessions);
  const running = useStore((s) => s.running);
  const queued = useStore((s) => s.queued);
  const activeIDs = useStore((s) => s.activeIDs);
  const live = useStore((s) => s.live);

  const liveBySession = useMemo(() => {
    const m = new Map<string, LiveAssistant[]>();
    for (const a of live) {
      const arr = m.get(a.sessionID) ?? [];
      arr.push(a);
      m.set(a.sessionID, arr);
    }
    for (const arr of m.values()) arr.sort((x, y) => x.started - y.started);
    return m;
  }, [live]);

  /**
   * Liveness for the strip. A finished-but-not-yet-retired live entry (its
   * run ENDED — `finish` is set) must not read as active, and a bare
   * activeIDs hit only counts while the session's live signal is fresh —
   * both because the engine's active/listing state lags tens of seconds
   * behind reality (verified against the live service).
   */
  const isLive = (id: string) => {
    if (running[id] || queued[id]) return true;
    const entries = liveBySession.get(id) ?? [];
    if (entries.some((a) => a.finish === undefined)) return true;
    return activeIDs.includes(id) && Date.now() - lastLiveSignalAt(id) < ACTIVE_ID_FRESH_MS;
  };

  const groups = useMemo(() => {
    // Top-level sessions that are live or have a live subagent
    const tops = sessions.filter((s) => !s.parentID);
    const result: { parent: SessionInfo; parentLive: boolean; children: SessionInfo[] }[] = [];
    for (const parent of tops) {
      const children = childSessionsOf(sessions, parent.id);
      const liveChildren = children.filter((c) => isLive(c.id));
      const parentLive = isLive(parent.id);
      if (parentLive || liveChildren.length > 0) {
        result.push({ parent, parentLive, children: liveChildren });
      }
    }
    // Orphan live subagents whose parent wasn't in tops (pagination) — show as standalone groups
    const seenChildIds = new Set(result.flatMap((g) => g.children.map((c) => c.id)));
    const orphanLives = sessions.filter((s) => !!s.parentID && isLive(s.id) && !seenChildIds.has(s.id));
    for (const o of orphanLives) {
      // find parent info if any, else fake group
      const parentInfo = (sessions.find((p) => p.id === o.parentID) ?? { id: o.parentID!, title: "Parent", time: { updated: 0 } } as unknown as SessionInfo);
      const existing = result.find((g) => g.parent.id === o.parentID);
      if (existing) continue;
      result.push({ parent: parentInfo, parentLive: false, children: [o] });
    }
    // Also standalone live top-level sessions with no children already covered — sort running first
    result.sort((a, b) => {
      const aRun = a.parentLive && !!running[a.parent.id] ? 1 : a.children.some((c) => !!running[c.id]) ? 1 : 0;
      const bRun = b.parentLive && !!running[b.parent.id] ? 1 : b.children.some((c) => !!running[c.id]) ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return (b.parent.time?.updated ?? 0) - (a.parent.time?.updated ?? 0);
    });
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isLive closes over the slices above
  }, [sessions, running, queued, activeIDs, live, liveBySession]);

  if (groups.length === 0) return <div className="px-3 py-2 text-xs text-[var(--text-weaker)]">No active agents.</div>;

  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => (
        <div key={g.parent.id} className="flex flex-col gap-1">
          {g.parentLive ? (
            <SessionRow session={g.parent} assistants={liveBySession.get(g.parent.id) ?? []} running={!!running[g.parent.id]} queued={!!queued[g.parent.id]} onOpen={onOpen} />
          ) : (
            <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-[var(--text-weaker)]">
              <span className="truncate">{g.parent.title || workspaceShort(g.parent.location?.directory) || g.parent.id.slice(0, 8)}</span>
              <span className="font-mono text-[10px]">· {g.children.length} subagent{g.children.length !== 1 ? "s" : ""}</span>
            </div>
          )}
          {g.children.length > 0 && (
            <div className="ml-3 flex flex-col gap-1 border-l border-[var(--border-weak-base)] pl-2">
              {g.children.map((child) => (
                <SessionRow key={child.id} session={child} assistants={liveBySession.get(child.id) ?? []} running={!!running[child.id]} queued={!!queued[child.id]} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ActivityStrip() {
  const running = useStore((s) => s.running);
  const queued = useStore((s) => s.queued);
  const live = useStore((s) => s.live);
  const activeIDs = useStore((s) => s.activeIDs);
  // Signal-age liveness expires with wall-clock time, not store writes —
  // tick so the strip can hide itself once the freshness window passes.
  // §8.6: the tick used to run every second even while the strip rendered
  // null; it now exists only while the strip has anything to show, and its
  // timer is owned by the scheduler like every other cadence.
  const [, setTick] = useState(0);

  const liveBySession = useMemo(() => {
    const m = new Map<string, LiveAssistant[]>();
    for (const a of live) {
      const arr = m.get(a.sessionID) ?? [];
      arr.push(a);
      m.set(a.sessionID, arr);
    }
    return m;
  }, [live]);

  const isLive = (id: string) => {
    if (running[id] || queued[id]) return true;
    const entries = liveBySession.get(id) ?? [];
    if (entries.some((a) => a.finish === undefined)) return true;
    return activeIDs.includes(id) && Date.now() - lastLiveSignalAt(id) < ACTIVE_ID_FRESH_MS;
  };

  const hasActive = useMemo(() => {
    const ids = new Set([
      ...Object.keys(running),
      ...Object.keys(queued),
      ...activeIDs,
      ...live.map((a) => a.sessionID),
    ]);
    for (const id of ids) if (isLive(id)) return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isLive closes over the slices above
  }, [running, queued, activeIDs, live, liveBySession]);

  useEffect(() => {
    if (!hasActive) return;
    return registerPoller({
      name: "activity-strip-tick",
      minInterval: 1_000,
      run: () => setTick((v) => v + 1),
    });
  }, [hasActive]);

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const [pipContainer, setPipContainer] = useState<HTMLDivElement | null>(null);
  const pipSupported = typeof window !== "undefined" && "documentPictureInPicture" in window;

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch { /* */ }
  }, [collapsed]);

  const count = useMemo(() => {
    const ids = new Set([
      ...Object.keys(running),
      ...Object.keys(queued),
      ...activeIDs,
      ...live.map((a) => a.sessionID),
    ]);
    let n = 0;
    for (const id of ids) if (isLive(id)) n++;
    return n;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isLive closes over the slices above
  }, [running, queued, activeIDs, live, liveBySession]);

  // Auto-hide when completely idle: keep header visible but muted. Spec wants global but not taking space when idle → return null.
  if (!hasActive) return null;
  const onOpen = (id: string) => void navigateFocused(id);

  const togglePiP = async () => {
    if (pipWin) {
      pipWin.close();
      setPipWin(null);
      setPipContainer(null);
      return;
    }
    try {
      // @ts-ignore Chrome-only
      const win: Window = await (window as unknown as { documentPictureInPicture: { requestWindow: (o: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture.requestWindow({ width: 380, height: 560 });
      copyStyles(win);
      win.document.body.style.margin = "0";
      win.document.documentElement.style.background = "var(--background-base)";
      win.document.body.style.background = "var(--background-base)";
      win.document.body.style.fontFamily = getComputedStyle(document.body).fontFamily;
      const container = win.document.createElement("div");
      container.id = "activity-strip-pip-root";
      container.style.height = "100vh";
      container.style.overflow = "auto";
      container.style.background = "var(--background-base)";
      win.document.body.appendChild(container);
      setPipContainer(container);
      setPipWin(win);
      win.addEventListener("pagehide", () => {
        setPipWin(null);
        setPipContainer(null);
      });
    } catch (e) {
      console.warn("PiP failed", e);
    }
  };

  const header = (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-strong)]">
        <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
        {count} active
        <span className="font-normal text-[var(--text-weaker)]">· streaming</span>
      </div>
      <div className="flex items-center gap-1">
        {pipSupported && (
          <button
            type="button"
            onClick={togglePiP}
            title={pipWin ? "Close picture-in-picture" : "Pop out — always on top outside Chrome"}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${pipWin ? "border-[var(--border-selected)] bg-[var(--surface-interactive-weak)] text-[var(--text-interactive-base)]" : "border-[var(--border-weak-base)] text-[var(--text-weaker)] hover:text-[var(--text-strong)]"}`}
          >
            <PictureInPicture2 className="size-3" /> {pipWin ? "popped" : "pop out"}
          </button>
        )}
        {/* Collapse/expand lives at the FAR RIGHT (one toggle, where the X
            used to be) — two controls for the same thing on opposite ends
            read as close-vs-collapse and confused everyone. */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand" : "Collapse"}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-[var(--text-weaker)] hover:bg-[var(--surface-base-hover)] hover:text-[var(--text-strong)]"
        >
          {collapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
      </div>
    </div>
  );

  const body = !collapsed ? (
    <div className="max-h-[42vh] overflow-auto px-2 pb-2">
      <ActivityStripInner onOpen={onOpen} />
    </div>
  ) : null;

  return (
    <>
      <div className="shrink-0 border-t border-[var(--border-base)] bg-[var(--background-base)]">
        {header}
        {body}
      </div>
      {pipWin && pipContainer
        ? createPortal(
            <div className="min-h-screen bg-[var(--background-base)] p-2">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--text-strong)]">Live — {count} active</span>
                <button type="button" onClick={togglePiP} className="rounded-md border border-[var(--border-weak-base)] px-1.5 py-0.5 text-[11px] text-[var(--text-weaker)]">close</button>
              </div>
              <ActivityStripInner onOpen={(id) => { void navigateFocused(id); try { window.focus(); } catch { /* */ } }} />
            </div>,
            pipContainer,
          )
        : null}
    </>
  );
}
