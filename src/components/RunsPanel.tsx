import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Square } from "lucide-react";
import { api } from "../api/client";
import { childSessionsOf, closeRunsPanel, requestShellPanel, selectSession, setRunsSelection, useStore } from "../store";
import { registerPoller } from "../lib/scheduler";

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

/**
 * Focus this pane's composer and land its caret at the very end of the
 * restored draft — mirrors Composer's placeCaretEnd (duplicated here, too
 * small to warrant a shared module).
 */
function focusComposerEnd(paneKey: string) {
  requestAnimationFrame(() => {
    const el = document.getElementById(`composer-input-${paneKey}`);
    if (!(el instanceof HTMLTextAreaElement)) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  });
}

export function RunsPanel({ sessionID, paneKey = "main" }: { sessionID: string; paneKey?: string }) {
  const sessions = useStore((s) => s.sessions);
  const runningMap = useStore((s) => s.running);
  const activeIDs = useStore((s) => s.activeIDs);
  const open = useStore((s) => s.runsPanelOpen);
  // Last cursor from a previous open — restored below when still valid.
  const storedSelection = useStore((s) => s.runsSelection);
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID]);
  const location = useStore((s) => s.sessions.find((x) => x.id === sessionID)?.location?.directory);

  const [section, setSection] = useState<Section>("subagents");
  // Subagent selection is tracked by ID, not index: the list re-sorts when
  // running states change and is anchored at the parent on subagent pages,
  // so an index could silently point at a different row.
  const [selectedSubID, setSelectedSubID] = useState<string | null>(null);
  const [shellIndex, setShellIndex] = useState(0);
  // One flat list of shells AND ptys (the Shell tab shows both); `kind`
  // says which delete API kills the row.
  const [shells, setShells] = useState<
    { id: string; label: string; running: boolean; kind: "shell" | "pty" }[]
  >([]);
  const boxRef = useRef<HTMLDivElement>(null);

  // From inside a subagent page the interesting list is the parent's
  // children — this session's siblings plus itself.
  const children = childSessionsOf(sessions, session?.parentID ?? sessionID);
  const isRunning = (id: string) => runningMap[id] || activeIDs.includes(id);
  const subagents = [...children].sort((a, b) => Number(isRunning(b.id)) - Number(isRunning(a.id)));
  const selIdx = Math.max(0, subagents.findIndex((c) => c.id === selectedSubID));

  useEffect(() => {
    if (!open) return;
    // Defaults (unchanged behavior): self-if-subagent-page else first row,
    // subagents tab when any exist.
    let nextSection: Section = subagents.length > 0 ? "subagents" : "shells";
    let nextSubID = subagents.some((c) => c.id === sessionID) ? sessionID : (subagents[0]?.id ?? null);
    let nextShellIndex = 0;
    // Restore the previous cursor only while it still points at reality.
    const stored = storedSelection;
    const storedSubID = stored?.section === "subagents" ? stored.subID : null;
    if (storedSubID && subagents.some((c) => c.id === storedSubID)) {
      nextSection = "subagents";
      nextSubID = storedSubID;
    } else if (stored?.section === "shells") {
      // Bounds can't be checked until shells load — clamped below once known.
      nextSection = "shells";
      nextShellIndex = Math.max(0, stored.shellIndex);
    }
    setSection(nextSection);
    setSelectedSubID(nextSubID);
    setShellIndex(nextShellIndex);
    (document.activeElement as HTMLElement | null)?.blur?.();
    requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Write the cursor through on every change so reopening the panel (it
  // unmounts when closed) lands where the user left it. Declared after the
  // init effect, so the initialized values are persisted first.
  useEffect(() => {
    if (!open) return;
    setRunsSelection({ section, subID: selectedSubID, shellIndex });
  }, [open, section, selectedSubID, shellIndex]);

  // A restored shell index can point past a shrunken list — clamp once the
  // rows are known.
  useEffect(() => {
    if (section === "shells" && shells.length > 0 && shellIndex > shells.length - 1) {
      setShellIndex(shells.length - 1);
    }
  }, [section, shellIndex, shells.length]);

  // Loader lives in a callback (not just the effect body) so the kill
  // action can force an immediate reload instead of waiting out the 5s
  // poll — the interval stays as the catch-all reconciler.
  const loadShells = useCallback(async () => {
    try {
      const loc = location ? { directory: location } : undefined;
      const [shellRes, ptyRes] = await Promise.all([api.shellList(loc), api.ptyList(loc)]);
      setShells([
        ...shellRes.data.map((s) => ({
          id: s.id,
          label: s.command || s.shell,
          running: s.status === "running",
          kind: "shell" as const,
        })),
        ...ptyRes.data.map((p) => ({
          id: p.id,
          label: p.title || p.command,
          running: p.status === "running",
          kind: "pty" as const,
        })),
      ]);
    } catch {
      /* transient */
    }
  }, [location]);

  useEffect(() => {
    if (!open) {
      setShells([]);
      return;
    }
    void loadShells();
    // Cadence owned by the scheduler (runs only while this panel is open).
    return registerPoller({
      name: "runs-panel-shells",
      minInterval: 5_000,
      run: () => loadShells(),
    });
  }, [open, loadShells]);

  // Kill a running shell/pty row. TUI parity: immediate, no confirm — the
  // only thing lost is the command itself. Errors are swallowed like the
  // loader's ("transient": a row already dead 404s on DELETE); the reload
  // below (and the 5s poll) reconcile reality either way. The existing
  // clamp effect pulls `shellIndex` back in bounds once the list shrinks.
  const killShellRow = useCallback(
    async (row: { id: string; kind: "shell" | "pty" }) => {
      const loc = location ? { directory: location } : undefined;
      try {
        if (row.kind === "shell") await api.shellDelete(row.id, loc);
        else await api.ptyDelete(row.id, loc);
      } catch {
        /* transient — poll will reconcile */
      }
      void loadShells();
    },
    [location, loadShells],
  );

  // Capture-phase key owner: while open, the panel owns the arrows/enter/
  // esc plus ctrl+k (kill) on the Shell tab.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // ctrl+k kills the SELECTED shell/pty row (Shell tab only). Chosen
      // over a bare letter ("d") on purpose: printable keys belong to the
      // composer via the site-wide type-anywhere handoff
      // (lib/composerHandoff.ts), while ctrl/meta/alt combos are skipped
      // there — and no other binding uses ctrl+k (hotkey map +
      // HelpDialog checked). Killing a non-running row is a no-op.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        if (section === "shells") {
          const row = shells[shellIndex];
          if (row?.running) void killShellRow(row);
        }
        return;
      }
      const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        closeRunsPanel();
        focusComposerEnd(paneKey);
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
          focusComposerEnd(paneKey);
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
  }, [open, section, selIdx, shellIndex, subagents, shells, killShellRow]);

  // Session switched underneath: dismiss.
  const prevSessionID = useRef(sessionID);
  useEffect(() => {
    if (prevSessionID.current !== sessionID) {
      prevSessionID.current = sessionID;
      closeRunsPanel();
    }
  }, [sessionID]);

  // Click-outside dismisses. Clicks on the composer's runs trigger are
  // exempt (data-runs-panel-trigger): that button toggles the panel itself,
  // and the dismiss-then-reopen mousedown/click pair would otherwise leave
  // it stuck open. Focus is NOT stolen back to the composer here — the
  // user clicked somewhere on purpose.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target)) return;
      if (target.closest("[data-runs-panel-trigger]")) return;
      closeRunsPanel();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  if (!open) return null;

  return (
    <div ref={rootRef} className="border-t border-[color:var(--border-weak-base)] px-3 pb-2 pt-2" data-oc-runs-panel>
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
                focusComposerEnd(paneKey);
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
                  label={c.agent && c.title ? `${c.agent} — ${c.title}` : c.title || c.agent || c.id}
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
                  onKill={s.running ? () => void killShellRow(s) : undefined}
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
          {section === "shells" && shells.some((s) => s.running) && (
            <>
              {" · "}
              <span className="text-[color:var(--text-weak)]">ctrl+k</span> kill
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
  onKill,
}: {
  selected: boolean;
  /** The session this row points at is the one being viewed right now. */
  current?: boolean;
  running: boolean;
  label: string;
  hint?: string;
  onClick: () => void;
  /**
   * Kill affordance for RUNNING shell/pty rows only (absent otherwise).
   * Rendered as a SIBLING of the row button — a button inside a button is
   * invalid HTML and breaks the click surface. stopPropagation is belt-
   * and-braces: a click here must never open the row.
   */
  onKill?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  // Arrow-key moves must stay visible in a scrolled list.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="flex w-full items-center gap-1">
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        title={current ? "Currently open session" : undefined}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-left font-mono text-xs transition-colors ${
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
      {onKill !== undefined && (
        <button
          type="button"
          aria-label="Kill"
          title="Kill"
          onClick={(e) => {
            e.stopPropagation();
            onKill();
          }}
          className="shrink-0 cursor-pointer rounded-sm p-0.5 text-[color:var(--text-weaker)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--surface-critical-strong)]"
        >
          <Square className="size-3" />
        </button>
      )}
    </div>
  );
}
