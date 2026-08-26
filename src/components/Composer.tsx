import { useEffect, useMemo, useRef, useState } from "react";
import { ListTree, Send, Terminal, X } from "lucide-react";
import { api } from "../api/client";
import type { FsEntry, PromptFile, PtyInfo, ShellInfo } from "../api/client";
import type { AgentInfo, CommandInfo, ModelInfo, SkillInfo, UserMessage } from "../api/types";
import {
  attachmentPromptFile,
  bytesToBase64,
  imagesToAttachments,
  looksLikeImagePath,
  mimeFromName,
  type PendingAttachment,
} from "../lib/attachments";
import {
  activateSkill,
  backgroundSubagents,
  childSessionsOf,
  compactSession,
  consumeRevertPrompt,
  exportSession,
  forkSession,
  isDraftSession,
  loadSessionDetail,
  materializeDraft,
  newSession,
  closeRunsPanel,
  openRunsPanel,
  redoSession,
  renameSession,
  requestInterrupt,
  selectSession,
  sendCommand,
  sendPromptTo,
  sendPromptWithFiles,
  sendShell,
  signalUI,
  switchAgent,
  undoSession,
  useStore,
  getState,
  type SendPromptOptions,
} from "../store";
import { loadDraft, saveDraft } from "../lib/drafts";
import { getPrefs, setPref, subscribePrefs, type Prefs } from "../prefs";
import { Slot } from "../extensions/registry";
import { openSettings } from "./settings/SettingsDialog";
import { AgentPicker, ModelPicker, VariantPicker } from "./Pickers";
import { FilePicker } from "./FilePicker";
import { downloadTranscript, formatTranscript } from "./SessionMenu";
import { Spinner } from "./ui";
import { Button } from "@/components/ui/button";
import {
  commandMove,
  commandSelectActive,
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

/** TUI /copy — transcript markdown to the clipboard. */
async function copyTranscript(sessionID: string) {
  try {
    const data = await exportSession(sessionID);
    await navigator.clipboard.writeText(formatTranscript(data));
  } catch {
    /* clipboard unavailable (permissions/insecure context) */
  }
}

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
function filterSlashEntries(entries: SlashEntry[], query: string): SlashEntry[] {
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

/** Caret to the very end of a textarea — for programmatic-focus paths. */
function placeCaretEnd(el: HTMLTextAreaElement) {
  const len = el.value.length;
  el.setSelectionRange(len, len);
}

export function Composer({
  sessionID,
  paneKey = "main",
  onNavigate,
}: {
  sessionID: string;
  /** DOM id suffix — every split pane mounts its own composer. */
  paneKey?: string;
  /** In-pane navigation (fork, /sessions, agents menu, Backspace-to-parent). */
  onNavigate?: (sessionID: string | null) => void;
}) {
  // Navigation inside a split must swap THAT pane, not the whole app.
  const go = (sid: string | null) => (onNavigate ? onNavigate(sid) : void selectSession(sid));
  // The unsent message is a silent per-session draft: seeded from storage,
  // saved on every change (typing, history walk, /undo restore), cleared on
  // send. No labels, no UI — switching away and back just works.
  const [text, setText] = useState(() => loadDraft(sessionID));
  const [busy, setBusy] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const prefs = usePrefs();
  // The active-region string present when the menu was last dismissed; the
  // menu stays closed for exactly that region (upstream closes on select and
  // reopens on typing). Keyed on the caret-anchored region rather than the
  // whole buffer so dismissal still lands while trailing text exists.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [pickedFiles, setPickedFiles] = useState<{ path: string; content?: string }[]>([]);
  /** Images staged for the next send (paste / drop / @-pick), as data URIs. */
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragDepth, setDragDepth] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [shellMode, setShellMode] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const running = useStore((s) => s.running[sessionID] ?? false);
  const queued = useStore((s) => !!s.queued[sessionID]);
  const interruptArmed = useStore((s) => s.interruptArmed);
  const messages = useStore((s) => s.messages[sessionID]);
  const detail = useStore((s) => s.sessionDetails[sessionID]);
  // Subagent pages: Backspace-on-empty returns to the parent session.
  const parentID = useStore(
    (s) => s.sessions.find((x) => x.id === sessionID)?.parentID ?? s.sessionDetails[sessionID]?.parentID,
  );
  const sessionLocation = useStore((s) => s.sessions.find((x) => x.id === sessionID)?.location?.directory);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * Caret offset in the textarea. The slash menu anchors on the text BEFORE
   * the caret, so caret movement alone (arrows, click) must reach the render.
   */
  const [caret, setCaret] = useState(0);
  /** Pull the live caret into state — wired to change/select/click/keyup. */
  function syncCaret(el: HTMLTextAreaElement) {
    setCaret(el.selectionStart ?? el.value.length);
  }

  // Per-session prompt history, TUI-style: derived from THIS session's real
  // persisted user messages (newest first), replacing the old global
  // localStorage history. Optimistic copies (msg_local_) are skipped — the
  // poll reconciler swaps them for real messages, which land here naturally.
  const historyTexts = useMemo(
    () =>
      (messages ?? [])
        .filter((m): m is UserMessage => m.type === "user" && !m.id.startsWith("msg_local_"))
        .map((m) => m.text)
        .filter((t) => t && !t.startsWith("/"))
        .reverse(),
    [messages],
  );
  /** Position in historyTexts while walking; null = not navigating. */
  const [histIdx, setHistIdx] = useState<number | null>(null);
  /** Buffer captured when the walk started, restored when walking past the end. */
  const histDraftRef = useRef("");

  /** Which session the current `text` belongs to (guards cross-session saves). */
  const textSessionRef = useRef(sessionID);

  useEffect(() => {
    setHistIdx(null);
    if (textSessionRef.current === sessionID) return;
    textSessionRef.current = sessionID;
    setText(loadDraft(sessionID));
  }, [sessionID]);

  // Persist the buffer whenever it changes — but never attribute a stale
  // buffer to a freshly switched session before its own draft is restored.
  useEffect(() => {
    if (textSessionRef.current !== sessionID) return;
    saveDraft(sessionID, text);
  }, [sessionID, text]);

  // Meta-row run indicators: child/subagent sessions of this session plus
  // live shells (backgrounded / currently-running commands) and PTYs.
  const children = useStore((s) => childSessionsOf(s.sessions, sessionID));
  const runningMap = useStore((s) => s.running);
  const activeIDs = useStore((s) => s.activeIDs);
  const runs = useRunningRuns(sessionLocation);
  const isChildRunning = (id: string) => runningMap[id] || activeIDs.includes(id);
  const runningChildrenCount = children.filter((c) => isChildRunning(c.id)).length;
  const runningShellCount =
    runs.shells.filter((s) => s.status === "running").length + runs.ptys.filter((p) => p.status === "running").length;
  // One chip for both run kinds, opening the shared RunsPanel (same as ↓).
  const shellTotal = runs.shells.length + runs.ptys.length;
  const runsLabel =
    [
      children.length > 0
        ? runningChildrenCount > 0
          ? `${runningChildrenCount}/${children.length} agents`
          : `${children.length} agents`
        : null,
      shellTotal > 0
        ? runningShellCount > 0
          ? `${runningShellCount}/${shellTotal} shells`
          : `${shellTotal} shells`
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || "runs";
  const anyRunning = runningChildrenCount > 0 || runningShellCount > 0;
  const runsPanelOpen = useStore((s) => s.runsPanelOpen);
  const [skillsMenu, setSkillsMenu] = useState(false);
  const skillsMenuRef = useDismiss(skillsMenu, () => setSkillsMenu(false));

  useEffect(() => {
    void api.commands().then(setCommands);
    void api.skills().then(setSkills);
    void loadModels().then(setModels);
    void loadAgents().then(setAgents);
  }, []);

  /** Programmatic refocus: focus plus caret at the buffer's end. */
  function refocusComposer() {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    placeCaretEnd(el);
    setCaret(el.value.length);
  }

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    placeCaretEnd(el);
    // Keep the caret STATE honest too — a restored draft ending in "/" must
    // not flash the slash menu from a stale offset-0 region.
    setCaret(el.value.length);
  }, [sessionID]);

  // /undo hands the reverted message's text back to the composer (TUI puts
  // it into the prompt so it can be edited and re-sent).
  const revertPrompt = useStore((s) => s.revertPrompt);
  useEffect(() => {
    if (revertPrompt) {
      setText(revertPrompt);
      consumeRevertPrompt();
      setCaret(0);
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(0, 0));
    }
  }, [revertPrompt]);

  // The slash menu keys off the ACTIVE REGION — the buffer from index 0 up to
  // the caret. Typing "/" at position 0 of a longer buffer ("/" into "explain
  // this") opens it exactly like a bare "/expl…" would; text after the caret
  // is invisible to the trigger and to the filter query. With the caret at
  // the end the region IS the whole buffer, so the classic rule is unchanged.
  const caretPos = Math.min(caret, text.length);
  const slashRegion = text.slice(0, caretPos);
  const isSlash =
    !shellMode &&
    slashRegion.startsWith("/") &&
    // Upstream hides once a command word is followed by argument text
    // ("/init extra"); a lone trailing space stays open with an empty filter.
    // Both tests read the region only, so "/init" stays open even when the
    // full buffer carries arguments beyond the caret.
    !/^\S+\s+\S/.test(slashRegion) &&
    dismissedAt !== slashRegion;
  const slashQuery = slashRegion.slice(1);

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
        run: () => go(null),
      },
      {
        name: "undo",
        description: "Undo previous message",
        run: () => void undoSession(sessionID),
      },
      {
        name: "redo",
        description: "Redo",
        run: () => void redoSession(sessionID),
      },
      {
        name: "thinking",
        aliases: ["toggle-thinking"],
        description: prefs.showReasoning ? "Collapse all thinking" : "Expand all thinking",
        run: () => setPref("showReasoning", !getPrefs().showReasoning),
      },
      {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
        description: prefs.showTimestamps ? "Hide timestamps" : "Show timestamps",
        run: () => setPref("showTimestamps", !getPrefs().showTimestamps),
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
        run: () => void forkSession(sessionID, { type: "through" }).then((id) => go(id)),
      },
      {
        name: "export",
        description: "Export session transcript",
        run: () => void downloadTranscript(sessionID),
      },
      {
        name: "copy",
        description: "Copy session transcript",
        run: () => void copyTranscript(sessionID),
      },
      {
        name: "compact",
        aliases: ["summarize"],
        description: "Compact session",
        run: () => void compactSession(sessionID, "steer"),
      },
      {
        name: "connect",
        description: "Connect providers & integrations",
        run: () => openSettings("integrations"),
      },
      {
        name: "models",
        aliases: ["mo"],
        description: "Switch model",
        run: () => signalUI("models"),
      },
      {
        name: "variants",
        description: "Switch model variant",
        run: () => signalUI("variants"),
      },
      {
        name: "agents",
        description: "Switch agent",
        run: () => signalUI("agents"),
      },
      {
        name: "themes",
        description: "Switch theme",
        run: () => signalUI("themes"),
      },
      {
        name: "skills",
        description: "Browse skills",
        run: () => setSkillsMenu(true),
      },
      {
        name: "mcps",
        description: "Toggle MCPs",
        run: () => openSettings("mcp"),
      },
      {
        name: "status",
        description: "View status",
        run: () => openSettings("server"),
      },
      {
        name: "diff",
        description: "Open diff viewer",
        run: () => signalUI("explorer"),
      },
      {
        name: "help",
        description: "Help",
        run: () => signalUI("help"),
      },
    ],
    [sessionID, prefs.showReasoning, prefs.showTimestamps],
  );

  // Skills the engine also exposes as commands accept upstream's
  // insert-with-args select action; others use the dedicated skill endpoint.
  const commandNames = useMemo(() => new Set(commands.map((c) => c.name)), [commands]);

  function pickSkill(skill: SkillInfo) {
    if (commandNames.has(skill.name)) {
      setText(`/${skill.name} `);
      setDismissedAt(`/${skill.name} `);
      refocusComposer();
    } else {
      setText("");
      void activateSkill(skill.id);
    }
  }

  // TUI parity: /variants only exists while the current model has variants.
  const currentModel = detail?.model;
  const modelHasVariants = useMemo(() => {
    if (!currentModel) return false;
    return (
      (models.find(
        (m) => m.enabled && m.modelID === currentModel.id && m.providerID === currentModel.providerID,
      )?.variants?.length ?? 0) > 0
    );
  }, [models, currentModel]);

  const slashEntries = useMemo<SlashEntry[]>(() => {
    const entries: SlashEntry[] = [];
    for (const action of slashActions) {
      if (action.name === "variants" && !modelHasVariants) continue;
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
          refocusComposer();
        },
      });
    }
    for (const skill of skills) {
      entries.push({
        key: `skill:${skill.id}`,
        display: `/${skill.name}`,
        names: [skill.name],
        description: skill.description,
        onSelect: () => pickSkill(skill),
      });
    }
    return entries.sort((a, b) => a.display.localeCompare(b.display));
  }, [slashActions, commands, skills, commandNames, modelHasVariants]);

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

  /** Stage an image attachment from raw workspace-file bytes. */
  function attachImageBytes(path: string, buf: ArrayBuffer) {
    const mime = mimeFromName(path) ?? "application/octet-stream";
    setAttachments((prev) => [
      ...prev,
      {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: path.split("/").pop() || path,
        mime,
        uri: `data:${mime};base64,${bytesToBase64(buf)}`,
      },
    ]);
  }

  function handleFilePick(entry: FsEntry) {
    const idx = text.lastIndexOf("@");
    if (idx === -1) return;
    if (entry.type === "file" && looksLikeImagePath(entry.path)) {
      // Images can't ride the @file text-content flow — attach them as real
      // image attachments and remove the "@query" token from the buffer.
      setText(text.slice(0, idx) + text.slice(idx + 1 + (mentionQuery?.length ?? 0)));
      refocusComposer();
      api
        .fsReadBytes(entry.path, sessionLocation)
        .then((buf) => attachImageBytes(entry.path, buf))
        .catch(() => undefined);
      return;
    }
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
    refocusComposer();
  }

  /**
   * Every send kind routes through here so the draft session is materialized
   * exactly once per submission: sends against "__draft__" would otherwise
   * hit api.prompt("__draft__") and fail. Returns the real target id, or
   * null when there is nothing to send to / another submit is already
   * materializing the draft ("draft already materializing" — double-Enter
   * guard; drop silently, same contract as the busy flag).
   */
  async function resolveSendTarget(): Promise<string | null> {
    if (isDraftSession(sessionID)) {
      try {
        return await materializeDraft(text);
      } catch {
        return null;
      }
    }
    return sessionID || null;
  }

  async function submit(opts?: SendPromptOptions) {
    const value = text.trim();
    // Image-only sends (empty text) are allowed — the engine takes {text,
    // files} and a bare attachment prompt is meaningful.
    if ((!value && attachments.length === 0) || busy) return;
    setBusy(true);
    setHistIdx(null);
    try {
      // Built-in slash actions are pure UI operations — they must run WITHOUT
      // materializing the draft ("/new" on a draft would otherwise create an
      // orphan session before opening the next one).
      if (!shellMode && value.startsWith("/")) {
        const parts = value.slice(1).split(" ");
        const name = parts[0]!;
        const action = slashActions.find((a) => a.name === name);
        if (action) {
          // Built-ins are UI actions; the engine's command route would
          // reject them, so dispatch locally with the typed arguments.
          action.run(parts.slice(1).join(" "));
          setText("");
          setPickedFiles([]);
          setAttachments([]);
          return;
        }
      }
      // Resolve the target FIRST: a draft must become a real session before
      // any of the send kinds below may run.
      const sid = await resolveSendTarget();
      if (!sid) return;
      if (shellMode) {
        await sendShell(value.startsWith("!") ? value.slice(1) : value);
      } else if (value.startsWith("!")) {
        await sendShell(value.slice(1));
      } else if (value.startsWith("/")) {
        const parts = value.slice(1).split(" ");
        const name = parts[0]!;
        const args = parts.slice(1).join(" ");
        await sendCommand(name, args || undefined);
      } else if (pickedFiles.length > 0 || attachments.length > 0) {
        // A draft has no server-side location yet — its workspace only lives
        // in the store, so fall back to it for @file URI resolution.
        const draftWorkspace = getState().draftWorkspace;
        const fileBase = sessionLocation ?? draftWorkspace ?? undefined;
        const files: PromptFile[] = [];
        for (const picked of pickedFiles) {
          if (!fileBase) continue;
          const token = `@${picked.path}`;
          const idx = value.indexOf(token);
          files.push({
            uri: `file://${encodeURI(`${fileBase.replace(/\/+$/, "")}/${picked.path}`)}`,
            name: picked.path,
            mention: idx !== -1 ? { start: idx, end: idx + token.length, text: token } : undefined,
          });
        }
        // Pasted/dropped images go out as data: URIs in the same uri-only
        // files field — the engine resolves data: URLs like the TUI's pastes.
        for (const att of attachments) {
          files.push(attachmentPromptFile(att));
        }
        if (files.length > 0) {
          await sendPromptWithFiles(value, files);
        } else {
          await sendPromptTo(sid, value, opts);
        }
      } else {
        await sendPromptTo(sid, value, opts);
      }
      setText("");
      setPickedFiles([]);
      setAttachments([]);
    } catch {
      // Send failed (SendErrorStrip shows the reason) — put the text back so
      // the user can retry without retyping. Attachments are deliberately
      // KEPT (cleared only after a successful send) so they're never lost
      // silently; the strip above the input shows they're still staged.
      setText(value);
    } finally {
      setBusy(false);
      refocusComposer();
    }
  }

  const placeholder = shellMode
    ? "bash — esc to exit"
    : running
      ? "Agent is working… — ↵ steers · ctrl+↵ queues"
      : queued
        ? "Waiting for the agent… — ↵ steers · ctrl+↵ queues"
        : "Message the agent…";

  const hint = shellMode ? (
    <p>
      <span className="font-medium text-[color:var(--surface-brand-base)]">Shell</span> · esc to exit
    </p>
  ) : running && interruptArmed ? (
    // First Esc armed the abort — ask for confirmation until it times out.
    <p className="font-medium text-[color:var(--surface-warning-strong)]">
      Press esc again to interrupt
    </p>
  ) : running || queued ? (
    <p className="flex items-center gap-1.5">
      <Spinner className="size-3" />
      {running ? "Working… · esc to interrupt" : "Waiting…"}
      {text.trim() ? " · ↵ steer · ctrl+↵ queue" : ""}
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
        <div className="relative">
          {skillsMenu && (
            <div
              ref={skillsMenuRef}
              className="absolute bottom-full left-0 z-40 mb-2 max-h-80 w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] p-1 shadow-xl"
            >
              {skills.length === 0 && (
                <p className="px-2.5 py-1.5 text-xs text-[color:var(--text-weaker)]">No skills available</p>
              )}
              {skills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => {
                    setSkillsMenu(false);
                    pickSkill(skill);
                  }}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color:var(--surface-base-hover)]"
                >
                  <span className="shrink-0 font-mono text-xs text-[color:var(--text-strong)]">
                    /{skill.name}
                  </span>
                  {skill.description && (
                    <span className="min-w-0 flex-1 truncate text-xs text-[color:var(--text-weaker)]">
                      {skill.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <Popover open={isSlash}>
          <PopoverAnchor asChild>
            <div
              onDragEnter={(e) => {
                if (Array.from(e.dataTransfer.types).includes("Files")) setDragDepth((d) => d + 1);
              }}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
              }}
              onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
              onDrop={(e) => {
                setDragDepth(0);
                if (e.dataTransfer.files.length === 0) return;
                // Dropping images stages them; non-image files keep the
                // @-mention text flow, so plain file drops do nothing here.
                e.preventDefault();
                void imagesToAttachments(e.dataTransfer.files).then((atts) => {
                  if (atts.length > 0) setAttachments((prev) => [...prev, ...atts]);
                });
              }}
              className={`rounded-lg border bg-[color:var(--input-base)] p-2 transition-colors focus-within:border-[color:var(--border-selected)] ${
                dragDepth > 0 || shellMode
                  ? "border-[color:var(--surface-brand-base)]"
                  : "border-[color:var(--border-base)]"
              }`}
            >
              {/* Extension region: very top inside the composer card. */}
              <Slot region="composer.above" sessionID={sessionID} />
              {attachments.length > 0 && (
                <div className="mb-1.5 flex flex-wrap items-start gap-2 border-b border-[color:var(--border-weak-base)] pb-1.5">
                  {attachments.map((att) => (
                    <span key={att.id} className="relative inline-block" title={`${att.name} (${att.mime})`}>
                      <img
                        src={att.uri}
                        alt={att.name}
                        draggable={false}
                        className="size-12 rounded-md border border-[color:var(--border-weak-base)] object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                        title="Remove attachment"
                        className="absolute -right-1.5 -top-1.5 flex size-4 cursor-pointer items-center justify-center rounded-full border border-[color:var(--border-weak-base)] bg-[color:var(--surface-float-base)] text-[color:var(--text-weak)] transition-colors hover:text-[color:var(--text-strong)]"
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  ))}
                  <span className="self-center text-[11px] text-[color:var(--text-weaker)]">
                    image{attachments.length === 1 ? "" : "s"} attached
                  </span>
                </div>
              )}
              <FilePicker
                // One autocomplete at a time: anchoring "/" at index 0 lets a
                // leading slash region and a later @-query coexist in the
                // buffer, and the slash menu owns the keys while it is open.
                open={mentionQuery !== undefined && !mentionDismissed && !isSlash}
                query={mentionQuery ?? ""}
                location={sessionLocation}
                onOpenChange={setMentionDismissed}
                onPick={handleFilePick}
              >
                <div className="flex items-end gap-2">
                  <Textarea
                    id={`composer-input-${paneKey}`}
                    ref={textareaRef}
                    value={text}
                    placeholder={placeholder}
                    className={`max-h-40 min-h-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-1 text-sm placeholder:text-[color:var(--text-weaker)] focus-visible:ring-0 ${shellMode ? "font-mono" : ""}`}
                    onChange={(e) => {
                      setHistIdx(null);
                      setText(e.target.value);
                      syncCaret(e.currentTarget);
                    }}
                    onSelect={(e) => syncCaret(e.currentTarget)}
                    onClick={(e) => syncCaret(e.currentTarget)}
                    onKeyUp={(e) => syncCaret(e.currentTarget)}
                    onPaste={(e) => {
                      // Image paste (screenshots): stage as attachments.
                      // Only intercept when an image is actually present so
                      // normal text/file pastes keep working untouched.
                      const files: File[] = [];
                      for (const item of Array.from(e.clipboardData?.items ?? [])) {
                        if (item.kind !== "file") continue;
                        const file = item.getAsFile();
                        if (file) files.push(file);
                      }
                      const hasImage = files.some(
                        (f) => f.type.startsWith("image/") || looksLikeImagePath(f.name),
                      );
                      if (!hasImage) return;
                      e.preventDefault();
                      void imagesToAttachments(files).then((atts) => {
                        if (atts.length > 0) setAttachments((prev) => [...prev, ...atts]);
                      });
                    }}
                    onKeyDown={(e) => {
                      if (isSlash) {
                        // While the slash menu is visible the TUI routes
                        // Enter/Tab/Esc to the autocomplete, never to submit.
                        if (e.key === "Escape") {
                          e.preventDefault();
                          // Upstream hide(): wipe the partial "/query" unless
                          // it ends with a space. Text AFTER the caret is the
                          // user's own words — never wiped; there the
                          // dismissal just pins to the active region so
                          // editing the token again reopens the menu.
                          if (caretPos === text.length && !text.endsWith(" ")) {
                            setText("");
                          } else {
                            setDismissedAt(slashRegion);
                          }
                          return;
                        }
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          commandMove(1);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          commandMove(-1);
                          return;
                        }
                        if (e.key === "Enter") {
                          // Any Enter flavor belongs to the menu while it is
                          // visible — never a newline, never a submit.
                          e.preventDefault();
                          commandSelectActive();
                          return;
                        }
                        if (e.key === "Tab") {
                          e.preventDefault();
                          commandSelectActive();
                          return;
                        }
                      }
                      if (mentionQuery !== undefined && !mentionDismissed && !isSlash) {
                        // The @-file menu hosts its own Command instance;
                        // route its keys from the textarea so arrows navigate,
                        // Enter/Tab pick, and no newline is ever inserted.
                        // With ZERO matching rows (e.g. an email address after
                        // "@") the menu is inert — fall through so Enter still
                        // submits the literal text.
                        const hasRows = !!document.querySelector('[data-slot="command-item"]');
                        if (hasRows) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            commandMove(1);
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            commandMove(-1);
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                            e.preventDefault();
                            commandSelectActive();
                            return;
                          }
                        }
                      }
                      if (skillsMenu && e.key === "Escape") {
                        e.preventDefault();
                        setSkillsMenu(false);
                        return;
                      }
                      if (!isSlash && mentionQuery === undefined && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
                        // TUI prompt-history bindings against THIS session's
                        // real messages: up navigates history only from the
                        // very start of the buffer, down only from the very
                        // end; otherwise the caret moves natively.
                        if (e.key === "ArrowUp") {
                          const el = e.currentTarget;
                          if (el.selectionStart === 0 && el.selectionEnd === 0 && historyTexts.length > 0) {
                            e.preventDefault();
                            if (histIdx === null) histDraftRef.current = text;
                            const next = histIdx === null ? 0 : Math.min(histIdx + 1, historyTexts.length - 1);
                            setHistIdx(next);
                            const entry = historyTexts[next] ?? "";
                            setText(entry);
                            setCaret(0);
                            requestAnimationFrame(() => el.setSelectionRange(0, 0));
                          }
                          return;
                        }
                        if (e.key === "ArrowDown") {
                          const el = e.currentTarget;
                          if (el.selectionStart === text.length && el.selectionEnd === text.length) {
                            if (histIdx === null) {
                              e.preventDefault();
                              openRunsPanel();
                            } else if (histIdx <= 0) {
                              // Past the newest entry: restore the draft that
                              // was captured when the walk began.
                              e.preventDefault();
                              setHistIdx(null);
                              setText(histDraftRef.current);
                              setCaret(histDraftRef.current.length);
                              requestAnimationFrame(() =>
                                el.setSelectionRange(histDraftRef.current.length, histDraftRef.current.length),
                              );
                            } else {
                              e.preventDefault();
                              const next = Math.min(histIdx - 1, historyTexts.length - 1);
                              setHistIdx(next);
                              const entry = historyTexts[Math.max(next, 0)] ?? "";
                              setText(entry);
                              setCaret(entry.length);
                              requestAnimationFrame(() => el.setSelectionRange(entry.length, entry.length));
                            }
                          }
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
                          requestInterrupt();
                          return;
                        }
                        return;
                      }
                      if (e.key === "Tab") {
                        e.preventDefault();
                        cycleAgent(e.shiftKey ? -1 : 1);
                        return;
                      }
                      // Subagent page: Backspace on an empty buffer goes back
                      // to the parent — the site-wide binding can't fire while
                      // this textarea owns focus, so it is mirrored here.
                      if (e.key === "Backspace" && !text && parentID) {
                        e.preventDefault();
                        go(parentID);
                        return;
                      }
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.altKey &&
                        (e.ctrlKey || e.metaKey) &&
                        !isSlash &&
                        mentionQuery === undefined
                      ) {
                        // Explicit QUEUE: park after the current turn instead of
                        // steering into the next LLM call. Shell mode keeps its
                        // own meaning for Enter — ctrl+↵ there stays a plain run.
                        e.preventDefault();
                        void submit(shellMode ? undefined : { delivery: "queue" });
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
                      disabled={!text.trim() && attachments.length === 0}
                      onClick={() => void submit()}
                      title={running ? "Send (↵ steer · ctrl+↵ queue)" : "Send (Enter)"}
                    >
                      <Send />
                      Send
                    </Button>
                  )}
                </div>
              </FilePicker>
              <div className="mt-1 flex items-center gap-1 border-t border-[color:var(--border-weak-base)] px-1 pt-1">
                <button
                  type="button"
                  data-runs-panel-trigger
                  onClick={() => (runsPanelOpen ? closeRunsPanel() : openRunsPanel())}
                  title={runsPanelOpen ? "Close subagents & shells (↓)" : "Subagents & shells — opens the runs panel (↓)"}
                  className={`flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 font-mono text-[11px] transition-colors ${
                    anyRunning
                      ? "text-[color:var(--surface-brand-base)] hover:bg-[color:var(--surface-base-hover)]"
                      : "text-[color:var(--text-weaker)] hover:bg-[color:var(--surface-base-hover)] hover:text-[color:var(--text-weak)]"
                  }`}
                >
                  <ListTree className="size-3" />
                  {runsLabel}
                </button>
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
                <VariantPicker sessionID={sessionID} openUp align="left" />
                {contextParts.length > 0 && (
                  <span
                    className="ml-auto font-mono text-[11px] text-[color:var(--text-weaker)]"
                    title="Tokens used · share of model context window · session cost"
                  >
                    {contextParts.join(" · ")}
                  </span>
                )}
              </div>
              {/* Extension region: right after the meta row (the bottom
                  border area of the composer card). */}
              <Slot region="composer.below" sessionID={sessionID} />
            </div>
          </PopoverAnchor>
          <PopoverContent
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
