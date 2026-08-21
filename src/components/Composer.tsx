import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Send, Terminal } from "lucide-react";
import { api } from "../api/client";
import type { FsEntry, PromptFile, PtyInfo, ShellInfo } from "../api/client";
import type { AgentInfo, CommandInfo, ModelInfo, SkillInfo } from "../api/types";
import {
  activateSkill,
  backgroundSubagents,
  childSessionsOf,
  compactSession,
  forkSession,
  interrupt,
  loadSessionDetail,
  newSession,
  renameSession,
  requestShellPanel,
  selectSession,
  sendCommand,
  sendPrompt,
  sendPromptWithFiles,
  sendShell,
  switchAgent,
  useStore,
} from "../store";
import { getPrefs, setPref, subscribePrefs, type Prefs } from "../prefs";
import { AgentPicker, ModelPicker } from "./Pickers";
import { FilePicker } from "./FilePicker";
import { downloadTranscript } from "./SessionMenu";
import { Spinner } from "./ui";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

let modelsCache: Promise<ModelInfo[]> | null = null;
function loadModels(): Promise<ModelInfo[]> {
  modelsCache ??= api.models().catch(() => []);
  return modelsCache;
}

let agentsCache: Promise<AgentInfo[]> | null = null;
function loadAgents(): Promise<AgentInfo[]> {
  agentsCache ??= api.agents().catch(() => []);
  return agentsCache;
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// ---- slash menu (v2 TUI autocomplete parity) -----------------------------
//
// Upstream (packages/tui/src/component/prompt/autocomplete.tsx) shows ONE
// flat list for "/" mode: built-in palette actions that have a slashName and
// server commands, sorted alphabetically by display, capped at 10 items,
// fuzzy-filtered over [name, description, aliases]. Built-ins execute
// immediately on select; server commands insert "/<name> " into the input
// (insert-with-args). Rows show the display text plus a muted trailing
// description — no icons, no group headings.

const SLASH_MENU_LIMIT = 10;

interface SlashEntry {
  key: string;
  display: string;
  /** Primary name first, then aliases — matched without the leading "/". */
  names: string[];
  description?: string;
  onSelect: () => void;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/**
 * Approximation of the TUI's fuzzysort.go over keys [display/value,
 * description, aliases] with threshold 0 and the ×2 boost for targets that
 * start with the typed query: prefix > alias-prefix > substring >
 * subsequence > description. Deterministic and dependency-free.
 */
export function filterSlashEntries(entries: SlashEntry[], query: string): SlashEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, SLASH_MENU_LIMIT);
  const hits: { entry: SlashEntry; score: number }[] = [];
  for (const entry of entries) {
    let score = 0;
    const primary = `/${entry.names[0]}`;
    if (primary.startsWith(`/${q}`)) {
      score = 1000;
    } else if (primary.includes(q)) {
      score = 600;
    } else if (isSubsequence(q, primary)) {
      score = 200;
    } else {
      for (const alias of entry.names.slice(1)) {
        const target = `/${alias}`;
        if (target.startsWith(`/${q}`)) {
          score = Math.max(score, 800);
        } else if (target.includes(q)) {
          score = Math.max(score, 400);
        }
      }
    }
    // Description matching mirrors upstream's slash-only description key.
    if (score < 100 && entry.description?.toLowerCase().includes(q)) score = 100;
    if (score > 0) hits.push({ entry, score });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.display.localeCompare(b.entry.display));
  return hits.slice(0, SLASH_MENU_LIMIT).map((hit) => hit.entry);
}

/** A built-in slash action wired to a UI capability (TUI palette parity). */
interface SlashAction {
  name: string;
  aliases?: string[];
  description?: string;
  /** Executes immediately when selected or submitted as "/name args". */
  run: (args: string) => void;
}

function usePrefs(): Prefs {
  const [prefs, setPrefs] = useState<Prefs>(getPrefs);
  useEffect(() => subscribePrefs(() => setPrefs(getPrefs())), []);
  return prefs;
}

/**
 * Live shells (backgrounded or currently-running commands) and PTYs for the
 * session's workspace. Light 5s poll, paused while the tab is hidden — the
 * same cadence ShellPanel uses when its dialog is open.
 */
function useRunningRuns(location?: string): { shells: ShellInfo[]; ptys: PtyInfo[] } {
  const [runs, setRuns] = useState<{ shells: ShellInfo[]; ptys: PtyInfo[] }>({ shells: [], ptys: [] });
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const loc = location ? { directory: location } : undefined;
        const [shells, ptys] = await Promise.all([api.shellList(loc), api.ptyList(loc)]);
        if (cancelled) return;
        setRuns({ shells: shells.data, ptys: ptys.data });
      } catch {
        /* transient; keep last lists */
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [location]);
  return runs;
}

/** Close-on-outside-click ref for the meta-row dropdowns. */
function useDismiss(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, onClose]);
  return ref;
}

export function Composer({ sessionID }: { sessionID: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const prefs = usePrefs();
  // The text present when the menu was last dismissed; the menu stays closed
  // for exactly this text (upstream closes on select and reopens on typing).
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [pickedFiles, setPickedFiles] = useState<{ path: string; content?: string }[]>([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [shellMode, setShellMode] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const running = useStore((s) => s.running[sessionID] ?? false);
  const queued = useStore((s) => !!s.queued[sessionID]);
  const messages = useStore((s) => s.messages[sessionID]);
  const detail = useStore((s) => s.sessionDetails[sessionID]);
  const sessionLocation = useStore((s) => s.sessions.find((x) => x.id === sessionID)?.location?.directory);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Meta-row run indicators: child/subagent sessions of this session plus
  // live shells (backgrounded / currently-running commands) and PTYs.
  const children = useStore((s) => childSessionsOf(s.sessions, sessionID));
  const runningMap = useStore((s) => s.running);
  const activeIDs = useStore((s) => s.activeIDs);
  const runs = useRunningRuns(sessionLocation);
  const isChildRunning = (id: string) => runningMap[id] || activeIDs.includes(id);
  const sortedChildren = useMemo(
    () => [...children].sort((a, b) => Number(isChildRunning(b.id)) - Number(isChildRunning(a.id))),
    [children, runningMap, activeIDs],
  );
  const runningChildrenCount = children.filter((c) => isChildRunning(c.id)).length;
  const runningShellCount =
    runs.shells.filter((s) => s.status === "running").length + runs.ptys.filter((p) => p.status === "running").length;
  const [runMenu, setRunMenu] = useState<"agents" | "shells" | null>(null);
  const runMenuRef = useDismiss(runMenu !== null, () => setRunMenu(null));
  const [openShellId, setOpenShellId] = useState<string | null>(null);
  const [shellOutput, setShellOutput] = useState<Record<string, string>>({});

  async function toggleShellOutput(id: string) {
    if (openShellId === id) {
      setOpenShellId(null);
      return;
    }
    setOpenShellId(id);
    if (!shellOutput[id]) {
      try {
        const res = await api.shellOutput(id, { limit: 8000 });
        setShellOutput((prev) => ({ ...prev, [id]: res.data.output || "(no output)" }));
      } catch {
        setShellOutput((prev) => ({ ...prev, [id]: "(output unavailable)" }));
      }
    }
  }

  useEffect(() => {
    void api.commands().then(setCommands);
    void api.skills().then(setSkills);
    void loadModels().then(setModels);
    void loadAgents().then(setAgents);
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [sessionID]);

  const isSlash =
    !shellMode &&
    text.startsWith("/") &&
    // Upstream hides once a command word is followed by argument text
    // ("/init extra"); a lone trailing space stays open with an empty filter.
    !/^\S+\s+\S/.test(text) &&
    dismissedAt !== text;
  const slashQuery = text.slice(1);

  const slashActions = useMemo<SlashAction[]>(
    () => [
      {
        name: "new",
        aliases: ["clear"],
        description: "New session",
        run: () => void newSession(),
      },
      {
        name: "sessions",
        aliases: ["resume", "continue"],
        description: "Switch session",
        run: () => void selectSession(null),
      },
      {
        name: "thinking",
        aliases: ["toggle-thinking"],
        description: prefs.showReasoning ? "Collapse thinking" : "Expand thinking",
        run: () => setPref("showReasoning", !getPrefs().showReasoning),
      },
      {
        name: "rename",
        description: "Rename session",
        run: (args) => {
          const title = args.trim();
          if (title) void renameSession(sessionID, title);
        },
      },
      {
        name: "fork",
        description: "Fork session",
        run: () => void forkSession(sessionID, { type: "through" }).then((id) => void selectSession(id)),
      },
      {
        name: "export",
        description: "Export session transcript",
        run: () => void downloadTranscript(sessionID),
      },
      {
        name: "compact",
        aliases: ["summarize"],
        description: "Compact session",
        run: () => void compactSession(sessionID, "steer"),
      },
    ],
    [sessionID, prefs.showReasoning],
  );

  // Skills the engine also exposes as commands accept upstream's
  // insert-with-args select action; others use the dedicated skill endpoint.
  const commandNames = useMemo(() => new Set(commands.map((c) => c.name)), [commands]);

  const slashEntries = useMemo<SlashEntry[]>(() => {
    const entries: SlashEntry[] = [];
    for (const action of slashActions) {
      entries.push({
        key: `action:${action.name}`,
        display: `/${action.name}`,
        names: [action.name, ...(action.aliases ?? [])],
        description: action.description,
        onSelect: () => {
          setText("");
          action.run("");
        },
      });
    }
    for (const command of commands) {
      entries.push({
        key: `command:${command.name}`,
        display: `/${command.name}`,
        names: [command.name],
        description: command.description,
        onSelect: () => {
          setText(`/${command.name} `);
          setDismissedAt(`/${command.name} `);
          textareaRef.current?.focus();
        },
      });
    }
    for (const skill of skills) {
      const known = commandNames.has(skill.name);
      entries.push({
        key: `skill:${skill.id}`,
        display: `/${skill.name}`,
        names: [skill.name],
        description: skill.description,
        onSelect: () => {
          if (known) {
            setText(`/${skill.name} `);
            setDismissedAt(`/${skill.name} `);
            textareaRef.current?.focus();
          } else {
            setText("");
            void activateSkill(skill.id);
          }
        },
      });
    }
    return entries.sort((a, b) => a.display.localeCompare(b.display));
  }, [slashActions, commands, skills, commandNames]);

  const filteredSlash = useMemo(
    () => filterSlashEntries(slashEntries, slashQuery),
    [slashEntries, slashQuery],
  );

  const mentionQuery = useMemo(() => {
    const idx = text.lastIndexOf("@");
    if (idx === -1) return undefined;
    const before = idx === 0 ? "" : text[idx - 1]!;
    const after = text.slice(idx + 1);
    if ((idx === 0 || /\s/.test(before)) && !/\s/.test(after)) return after;
    return undefined;
  }, [text]);

  useEffect(() => {
    setMentionDismissed(false);
  }, [text]);

  // Context readout, TUI-style: usage of the last assistant message against
  // the current model's context limit, plus session cost.
  const currentModel = detail?.model;
  const lastAssistant = useMemo(() => {
    const list = messages ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!;
      if (m.type === "assistant") return m;
    }
    return undefined;
  }, [messages]);
  const usage = lastAssistant?.type === "assistant" ? lastAssistant.tokens : undefined;
  const tokensTotal = usage ? usage.input + usage.output + usage.reasoning + usage.cache.read + usage.cache.write : undefined;
  const cost = ((lastAssistant?.type === "assistant" ? lastAssistant.cost : undefined) ?? detail?.cost) ?? 0;
  const contextLimit = models.find(
    (m) => m.enabled && m.modelID === currentModel?.id && m.providerID === currentModel?.providerID,
  )?.limit?.context;
  const pct = tokensTotal && contextLimit ? Math.round((tokensTotal / contextLimit) * 100) : undefined;
  const contextParts = [
    tokensTotal !== undefined ? `${fmtTokens(tokensTotal)} tok` : undefined,
    pct !== undefined ? `${pct}% ctx` : undefined,
    cost > 0 ? `$${cost.toFixed(4)}` : undefined,
  ].filter(Boolean) as string[];

  const currentAgent = detail?.agent;
  function cycleAgent(dir: 1 | -1) {
    const primaries = agents.filter((a) => a.mode === "primary" && !a.hidden);
    if (primaries.length === 0) return;
    const idx = primaries.findIndex((a) => a.id === currentAgent);
    const next = primaries[(((idx === -1 ? 0 : idx) + dir) % primaries.length + primaries.length) % primaries.length]!;
    void switchAgent(sessionID, next.id).then(() => void loadSessionDetail(sessionID));
  }

  function handleFilePick(entry: FsEntry) {
    const idx = text.lastIndexOf("@");
    if (idx === -1) return;
    const token = `@${entry.path}`;
    setText(text.slice(0, idx) + token + " ");
    setPickedFiles((prev) => [...prev, { path: entry.path }]);
    if (sessionLocation) {
      void api
        .fsRead(entry.path, sessionLocation)
        .then((content) =>
          setPickedFiles((prev) => prev.map((f) => (f.path === entry.path ? { path: f.path, content } : f))),
        )
        .catch(() => undefined);
    }
    textareaRef.current?.focus();
  }

  function selectActiveSlashItem() {
    // The vendored Command marks the active row with data-selected; clicking
    // it runs its onSelect (same path as ArrowUp/Down + Enter).
    const el = popRef.current?.querySelector<HTMLElement>(
      '[data-slot="command-item"][data-selected="true"]',
    );
    el?.click();
  }

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      if (shellMode) {
        await sendShell(value.startsWith("!") ? value.slice(1) : value);
      } else if (value.startsWith("!")) {
        await sendShell(value.slice(1));
      } else if (value.startsWith("/")) {
        const parts = value.slice(1).split(" ");
        const name = parts[0]!;
        const args = parts.slice(1).join(" ");
        const action = slashActions.find((a) => a.name === name);
        if (action) {
          // Built-ins are UI actions; the engine's command route would
          // reject them, so dispatch locally with the typed arguments.
          action.run(args);
        } else {
          await sendCommand(name, args || undefined);
        }
      } else if (pickedFiles.length > 0) {
        const files: PromptFile[] = [];
        for (const picked of pickedFiles) {
          if (!sessionLocation) continue;
          const token = `@${picked.path}`;
          const idx = value.indexOf(token);
          files.push({
            uri: `file://${encodeURI(`${sessionLocation.replace(/\/+$/, "")}/${picked.path}`)}`,
            name: picked.path,
            mention: idx !== -1 ? { start: idx, end: idx + token.length, text: token } : undefined,
          });
        }
        if (files.length > 0) {
          await sendPromptWithFiles(value, files);
        } else {
          await sendPrompt(value);
        }
      } else {
        await sendPrompt(value);
      }
      setText("");
      setPickedFiles([]);
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  }

  const placeholder = shellMode
    ? "bash — esc to exit"
    : running
      ? "Agent is working… (press Enter to queue)"
      : queued
        ? "Waiting for the agent… (press Enter to queue more)"
        : "Message the agent…";

  const hint = shellMode ? (
    <p>
      <span className="font-medium text-[color:var(--surface-brand-base)]">Shell</span> · esc to exit
    </p>
  ) : running || queued ? (
    <p className="flex items-center gap-1.5">
      <Spinner className="size-3" />
      {running ? "Working… · press esc to stop" : "Waiting…"}
    </p>
  ) : (
    <p>
      <span className="font-medium text-[color:var(--text-weak)]">Tab</span> agent,{" "}
      <span className="font-medium text-[color:var(--text-weak)]">/</span> commands,{" "}
      <span className="font-medium text-[color:var(--text-weak)]">@</span> files,{" "}
      <span className="font-medium text-[color:var(--text-weak)]">!</span> bash
    </p>
  );

  const cwd = sessionLocation?.split("/").filter(Boolean).pop();

  return (
    <div className="border-t border-[color:var(--border-weak-base)] px-3 pb-2.5 pt-2">
      <div className="mx-auto max-w-3xl">
        <Popover open={isSlash}>
          <PopoverAnchor asChild>
            <div
              className={`rounded-lg border bg-[color:var(--input-base)] p-2 transition-colors focus-within:border-[color:var(--border-selected)] ${
                shellMode ? "border-[color:var(--surface-brand-base)]" : "border-[color:var(--border-base)]"
              }`}
            >
              <FilePicker
                open={mentionQuery !== undefined && !mentionDismissed}
                query={mentionQuery ?? ""}
                location={sessionLocation}
                onOpenChange={setMentionDismissed}
                onPick={handleFilePick}
              >
                <div className="flex items-end gap-2">
                  <Textarea
                    id="composer-input"
                    ref={textareaRef}
                    value={text}
                    placeholder={placeholder}
                    className={`max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-1 text-sm placeholder:text-[color:var(--text-weaker)] focus-visible:ring-0 ${shellMode ? "font-mono" : ""}`}
                    onChange={(e) => {
                      setText(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (isSlash) {
                        // While the slash menu is visible the TUI routes
                        // Enter/Tab/Esc to the autocomplete, never to submit.
                        if (e.key === "Escape") {
                          e.preventDefault();
                          // Upstream hide(): wipe the partial "/query" unless
                          // it ends with a space.
                          if (!text.endsWith(" ")) {
                            setText("");
                          } else {
                            setDismissedAt(text);
                          }
                          return;
                        }
                        if (e.key === "Enter") {
                          e.preventDefault();
                          return;
                        }
                        if (e.key === "Tab") {
                          e.preventDefault();
                          selectActiveSlashItem();
                          return;
                        }
                      }
                      if (e.key.toLowerCase() === "b" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                        // TUI parity: ctrl+b = session.background — background
                        // this session's synchronous (task-tool) subagents so
                        // they keep running after the parent step ends. Only
                        // meaningful while a run is active; the TUI enables
                        // the bind only with foreground tasks present.
                        if (!isSlash) {
                          e.preventDefault();
                          if (running || queued) void backgroundSubagents(sessionID);
                        }
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        if (shellMode) {
                          setShellMode(false);
                          return;
                        }
                        if (running) {
                          void interrupt();
                          return;
                        }
                        return;
                      }
                      if (e.key === "Tab") {
                        e.preventDefault();
                        cycleAgent(e.shiftKey ? -1 : 1);
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  {busy ? (
                    <Spinner className="mb-1.5 mr-2" />
                  ) : (
                    <Button
                      variant="default"
                      size="sm"
                      disabled={!text.trim()}
                      onClick={() => void submit()}
                      title={running ? "Queue (Enter)" : "Send (Enter)"}
                    >
                      <Send />
                      Send
                    </Button>
                  )}
                </div>
              </FilePicker>
              <div className="mt-1 flex items-center gap-1 border-t border-[color:var(--border-weak-base)] px-1 pt-1">
                {(children.length > 0 || runs.shells.length + runs.ptys.length > 0) && (
                  <div ref={runMenuRef} className="relative flex items-center gap-1">
                    {children.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setRunMenu(runMenu === "agents" ? null : "agents")}
                        title="Subagent sessions — pick one to open"
                        className={`flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[11px] transition-colors ${
                          runMenu === "agents" || runningChildrenCount > 0
                            ? "text-[color:var(--surface-brand-base)] hover:bg-[color:var(--surface-base-hover)]"
                            : "text-[color:var(--text-weaker)] hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--text-weak)]"
                        }`}
                      >
                        <ChevronRight className="size-3" />
                        {runningChildrenCount > 0
                          ? `${runningChildrenCount}/${children.length} agents`
                          : `${children.length} agents`}
                      </button>
                    )}
                    {runs.shells.length + runs.ptys.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setRunMenu(runMenu === "shells" ? null : "shells")}
                        title="Running & backgrounded shell commands, plus terminals"
                        className={`flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[11px] transition-colors ${
                          runMenu === "shells" || runningShellCount > 0
                            ? "text-[color:var(--surface-brand-base)] hover:bg-[color:var(--surface-base-hover)]"
                            : "text-[color:var(--text-weaker)] hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--text-weak)]"
                        }`}
                      >
                        <Terminal className="size-3" />
                        {runningShellCount > 0
                          ? `${runningShellCount}/${runs.shells.length + runs.ptys.length} shells`
                          : `${runs.shells.length + runs.ptys.length} shells`}
                      </button>
                    )}
                    {runMenu !== null && (
                      <div className="absolute bottom-full left-0 z-50 mb-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] shadow-xl">
                        {runMenu === "agents" &&
                          sortedChildren.map((c) => {
                            const active = isChildRunning(c.id);
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => {
                                  setRunMenu(null);
                                  void selectSession(c.id);
                                }}
                                className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-[color:var(--surface-base-hover)]"
                              >
                                <span
                                  className={`size-1.5 shrink-0 rounded-full ${active ? "bg-emerald-500" : "bg-[color:var(--text-weaker)]"}`}
                                />
                                <span className="min-w-0 flex-1 truncate text-[color:var(--text-strong)]">
                                  {c.title || c.id}
                                </span>
                                {c.agent && (
                                  <span className="font-mono text-[10px] text-[color:var(--text-weaker)]">{c.agent}</span>
                                )}
                              </button>
                            );
                          })}
                        {runMenu === "shells" && (
                          <>
                            <p className="px-2.5 pt-2 text-[10px] uppercase tracking-wide text-[color:var(--text-weaker)]">
                              Shell commands — click for output
                            </p>
                            {runs.shells.map((s) => (
                              <div key={s.id}>
                                <button
                                  type="button"
                                  onClick={() => void toggleShellOutput(s.id)}
                                  className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-[color:var(--surface-base-hover)]"
                                >
                                  <span
                                    className={`size-1.5 shrink-0 rounded-full ${
                                      s.status === "running" ? "bg-emerald-500" : "bg-[color:var(--text-weaker)]"
                                    }`}
                                  />
                                  <span className="min-w-0 flex-1 truncate font-mono text-[color:var(--text-strong)]">
                                    {s.command || s.shell}
                                  </span>
                                  <span className="font-mono text-[10px] text-[color:var(--text-weaker)]">
                                    {s.pid ? `pid ${s.pid}` : s.status}
                                  </span>
                                </button>
                                {openShellId === s.id && (
                                  <pre className="mx-2 mb-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--border-weak-base)] bg-[color:var(--background-strong)] p-2 font-mono text-[10px] text-[color:var(--text-weak)]">
                                    {shellOutput[s.id] ?? "loading…"}
                                  </pre>
                                )}
                              </div>
                            ))}
                            {runs.shells.length === 0 && (
                              <p className="px-2.5 py-1.5 text-xs text-[color:var(--text-weaker)]">No shell commands</p>
                            )}
                            {runs.ptys.length > 0 && (
                              <>
                                <p className="border-t border-[color:var(--border-weak-base)] px-2.5 pt-2 text-[10px] uppercase tracking-wide text-[color:var(--text-weaker)]">
                                  Terminals
                                </p>
                                {runs.ptys.map((p) => (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() => {
                                      setRunMenu(null);
                                      requestShellPanel();
                                    }}
                                    className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left text-xs transition-colors hover:bg-[color:var(--surface-base-hover)]"
                                  >
                                    <span
                                      className={`size-1.5 shrink-0 rounded-full ${
                                        p.status === "running" ? "bg-emerald-500" : "bg-[color:var(--text-weaker)]"
                                      }`}
                                    />
                                    <span className="min-w-0 flex-1 truncate text-[color:var(--text-strong)]">
                                      {p.title || p.command}
                                    </span>
                                  </button>
                                ))}
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  title="Shell mode (! command)"
                  onClick={() => setShellMode((v) => !v)}
                  className={`flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors ${
                    shellMode
                      ? "bg-[color:var(--surface-brand-weak)] text-[color:var(--surface-brand-strong)]"
                      : "text-[color:var(--text-weaker)] hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--text-weak)]"
                  }`}
                >
                  <Terminal className="size-3.5" />
                </button>
                <AgentPicker sessionID={sessionID} openUp align="left" />
                <ModelPicker sessionID={sessionID} openUp align="left" />
                {contextParts.length > 0 && (
                  <span
                    className="ml-auto font-mono text-[11px] text-[color:var(--text-weaker)]"
                    title="Tokens used · share of model context window · session cost"
                  >
                    {contextParts.join(" · ")}
                  </span>
                )}
              </div>
            </div>
          </PopoverAnchor>
          <PopoverContent
            ref={popRef}
            side="top"
            align="start"
            sideOffset={8}
            className="w-[min(26rem,calc(100vw-2rem))] p-0"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <Command>
              <CommandList>
                {filteredSlash.map((entry) => (
                  <CommandItem key={entry.key} value={entry.key} onSelect={entry.onSelect}>
                    <span className="font-mono text-[color:var(--text-base)]">{entry.display}</span>
                    {entry.description && (
                      <span className="ml-auto max-w-[55%] truncate pl-3 text-xs text-[color:var(--text-weaker)]">
                        {entry.description}
                      </span>
                    )}
                  </CommandItem>
                ))}
                {filteredSlash.length === 0 && <CommandEmpty>No matching items</CommandEmpty>}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-[color:var(--text-weaker)]">
          {hint}
          {cwd && <p className="hidden truncate font-mono sm:block">{cwd}</p>}
        </div>
      </div>
    </div>
  );
}
