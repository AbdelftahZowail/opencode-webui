import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../api/client";
import { childSessionsOf, closeRunsPanel, requestShellPanel, selectSession, useStore } from "../store";

/**
 * Subagents & shells panel, styled after the v2 TUI's bottom widget: a
 * left-accent-bordered strip docked above the composer (not a modal). Tabs
 * switch groups, ←/→ wrap between them, ↓/↑ move the selection (↑ at the
 * top dismisses), Enter opens, Esc dismisses. Keys are consumed in the
 * window CAPTURE phase so global session-navigation hotkeys stay idle while
 * the panel is open.
 *
 * Opened from a subagent page the list is anchored at the PARENT: the
 * session's siblings plus itself, with the open session pre-highlighted
 * (▸) so "where am I" survives arrow-walking away and back. Printable
 * keys are handled SITE-WIDE by lib/composerHandoff.ts (typing anywhere
 * outside an editable target lands in the composer, closing this panel
 * on the way).
 */

type Section = "subagents" | "shells";

export function RunsPanel({ sessionID }: { sessionID: string }) {
  const sessions = useStore((s) => s.sessions);
  const runningMap = useStore((s) => s.running);
  const activeIDs = useStore((s) => s.activeIDs);
  const open = useStore((s) => s.runsPanelOpen);
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID]);
  const location = useStore((s) => s.sessions.find((x) => x.id === sessionID)?.location?.directory);

  const [section, setSection] = useState<Section>("subagents");
  // Subagent selection is tracked by ID, not index: the list re-sorts when
  // running states change and is anchored at the parent on subagent pages,
  // so an index could silently point at a different row.
  const [selectedSubID, setSelectedSubID] = useState<string | null>(null);
  const [shellIndex, setShellIndex] = useState(0);
  const [shells, setShells] = useState<{ id: string; label: string; running: boolean }[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  // From inside a subagent page the interesting list is the parent's
  // children — this session's siblings plus itself.
  const children = childSessionsOf(sessions, session?.parentID ?? sessionID);
  const isRunning = (id: string) => runningMap[id] || activeIDs.includes(id);
  const subagents = [...children].sort((a, b) => Number(isRunning(b.id)) - Number(isRunning(a.id)));
  const selIdx = Math.max(0, subagents.findIndex((c) => c.id === selectedSubID));

  useEffect(() => {
    if (!open) return;
    setSection(subagents.length > 0 ? "subagents" : "shells");
    // Start on the session being viewed when it is one of the listed
    // subagents (panel opened from a subagent page); else the first row.
    setSelectedSubID(
      subagents.some((c) => c.id === sessionID) ? sessionID : (subagents[0]?.id ?? null),
    );
    setShellIndex(0);
    (document.activeElement as HTMLElement | null)?.blur?.();
    requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) {
      setShells([]);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const loc = location ? { directory: location } : undefined;
        const [shellRes, ptyRes] = await Promise.all([api.shellList(loc), api.ptyList(loc)]);
        if (cancelled) return;
        setShells([
          ...shellRes.data.map((s) => ({
            id: s.id,
            label: s.command || s.shell,
            running: s.status === "running",
          })),
          ...ptyRes.data.map((p) => ({
            id: p.id,
            label: p.title || p.command,
            running: p.status === "running",
          })),
        ]);
      } catch {
        /* transient */
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, location]);

  // Capture-phase key owner: while open, the panel owns the arrows/enter/esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        closeRunsPanel();
        requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Two groups wrap onto each other: two lefts come back around.
        setSection((prev) => (prev === "subagents" ? "shells" : "subagents"));
        return;
      }
      if (e.key === "ArrowUp") {
        const atTop =
          section === "subagents"
            ? subagents.length === 0 || selIdx === 0
            : shells.length === 0 || shellIndex === 0;
        if (atTop) {
          closeRunsPanel();
          requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
        } else if (section === "subagents") {
          setSelectedSubID(subagents[selIdx - 1]!.id);
        } else {
          setShellIndex((i) => i - 1);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        if (section === "subagents") {
          if (subagents.length > 0) setSelectedSubID(subagents[(selIdx + 1) % subagents.length]!.id);
        } else if (shells.length > 0) {
          setShellIndex((i) => (i + 1) % shells.length);
        }
        return;
      }
      // Enter
      if (section === "subagents" && subagents[selIdx]) {
        closeRunsPanel();
        void selectSession(subagents[selIdx]!.id);
      } else if (section === "shells" && shells[shellIndex]) {
        closeRunsPanel();
        requestShellPanel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, section, selIdx, shellIndex, subagents, shells]);

  // Session switched underneath: dismiss.
  const prevSessionID = useRef(sessionID);
  useEffect(() => {
    if (prevSessionID.current !== sessionID) {
      prevSessionID.current = sessionID;
      closeRunsPanel();
    }
  }, [sessionID]);

  if (!open) return null;

  return (
    <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-2 pt-2">
      <div className="mx-auto max-w-3xl">
        <div
          ref={boxRef}
          tabIndex={-1}
          className="min-h-44 max-h-64 overflow-y-auto border-l-2 border-[color:var(--border-strong)] bg-[color:var(--background-strong)] px-4 py-2 font-mono text-sm outline-none"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <TabButton active={section === "subagents"} onClick={() => setSection("subagents")}>
                Subagents
              </TabButton>
              <TabButton active={section === "shells"} onClick={() => setSection("shells")}>
                Shell
              </TabButton>
            </div>
            <button
              type="button"
              onClick={() => {
                closeRunsPanel();
                requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
              }}
              className="cursor-pointer font-mono text-xs text-[color:var(--text-weaker)] hover:text-[color:var(--text-weak)]"
            >
              esc
            </button>
          </div>

          {section === "subagents" &&
            (subagents.length === 0 ? (
              <p className="pt-2 text-[color:var(--text-weak)]">No active subagents</p>
            ) : (
              subagents.map((c, i) => (
                <Row
                  key={c.id}
                  selected={i === selIdx}
                  current={c.id === sessionID}
                  running={isRunning(c.id)}
                  label={c.title || c.id}
                  hint={c.agent}
                  onClick={() => {
                    closeRunsPanel();
                    void selectSession(c.id);
                  }}
                />
              ))
            ))}

          {section === "shells" &&
            (shells.length === 0 ? (
              <p className="pt-2 text-[color:var(--text-weak)]">No shell commands</p>
            ) : (
              shells.map((s, i) => (
                <Row
                  key={s.id}
                  selected={i === shellIndex}
                  running={s.running}
                  label={s.label}
                  onClick={() => {
                    closeRunsPanel();
                    requestShellPanel();
                  }}
                />
              ))
            ))}
        </div>
        <p className="mt-1 pl-1 font-mono text-[10px] text-[color:var(--text-weaker)]">
          tabs <span className="text-[color:var(--text-weak)]">←/→</span>
          {(section === "subagents" ? subagents.length : shells.length) > 0 && (
            <>
              {" · "}↑↓ select{" · "}
              <span className="text-[color:var(--text-weak)]">↵</span> open
            </>
          )}
          {" · "}
          <span className="text-[color:var(--text-weak)]">type</span> → composer
        </p>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer bg-transparent p-0 font-mono text-sm transition-colors ${
        active
          ? "font-bold text-[color:var(--text-strong)]"
          : "font-normal text-[color:var(--text-weaker)] hover:text-[color:var(--text-weak)]"
      }`}
    >
      {children}
    </button>
  );
}

function Row({
  selected,
  current,
  running,
  label,
  hint,
  onClick,
}: {
  selected: boolean;
  /** The session this row points at is the one being viewed right now. */
  current?: boolean;
  running: boolean;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // Arrow-key moves must stay visible in a scrolled list.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={current ? "Currently open session" : undefined}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-left font-mono text-xs transition-colors ${
        selected
          ? // Raised-active is clearly distinct from hover (base-hover is a
            // ~4% white wash that read as "nothing happened" while walking).
            "bg-[color:var(--surface-raised-base-active)] text-[color:var(--text-strong)]"
          : "text-[color:var(--text-base)] hover:bg-[color:var(--surface-base-hover)]"
      }`}
    >
      <span
        className={`size-1.5 shrink-0 rounded-full ${running ? "bg-emerald-500" : "bg-[color:var(--text-weaker)]"}`}
      />
      {current && (
        <ChevronRight
          className="size-3 shrink-0 text-[color:var(--text-weak)]"
          aria-label="current session"
        />
      )}
      <span
        className={`min-w-0 flex-1 truncate ${current && !selected ? "font-medium text-[color:var(--text-strong)]" : ""}`}
      >
        {label}
      </span>
      {hint && <span className="shrink-0 font-mono text-[10px] text-[color:var(--text-weaker)]">{hint}</span>}
    </button>
  );
}
