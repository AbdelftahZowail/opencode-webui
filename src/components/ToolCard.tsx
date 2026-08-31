import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { MessageInfo, ToolPart, ToolState } from "../api/types";
import { getToolRenderer } from "../extensions/registry";
import { selectSession, useStore } from "../store";
import { getPrefs, subscribePrefs } from "../prefs";
import { DiffView } from "./DiffView";
import { Spinner } from "./ui";

const toolDisclosureState = new Map<string, boolean>();

function rememberToolDisclosure(key: string, value: boolean) {
  toolDisclosureState.delete(key);
  toolDisclosureState.set(key, value);
  while (toolDisclosureState.size > 2_000) {
    const oldest = toolDisclosureState.keys().next().value;
    if (!oldest) break;
    toolDisclosureState.delete(oldest);
  }
}

/**
 * Tool rendering in the v2 TUI's style (packages/tui/src/routes/session):
 * most tools are ONE inline row — icon + short label, muted once complete,
 * spinner while running, red + expandable message on failure. Tools with
 * rich results get a titled block: edit/patch show the actual code diff,
 * write shows the written file, shell shows command + output.
 */
export function ToolCard({ part, stateKey }: { part: ToolPart; stateKey?: string }) {
  const [showDetails, setShowDetails] = useState(getPrefs().showToolDetails);
  useEffect(() => subscribePrefs(() => setShowDetails(getPrefs().showToolDetails)), []);

  const renderer = getToolRenderer(part.name);
  if (renderer) return <>{renderer.render(part)}</>;

  if (!part.state) return null;
  const state = part.state;

  const hasImageContent =
    state.status === "completed" &&
    state.content?.some((c) => c.type === "file" && isImageMime((c as { mime?: string }).mime));
  // TUI parity: with tool details off, finished successful tools disappear.
  if (!showDetails && state.status === "completed" && !hasImageContent) return null;

  const input = state.status === "streaming" ? {} : state.input ?? {};
  const meta = state.status === "streaming" ? {} : ("metadata" in state ? state.metadata ?? {} : {});
  const output =
    state.status === "completed"
      ? textOf(state.content)
      : state.status === "error"
        ? textOf(state.content)
        : undefined;
  const error = state.status === "error" ? state.error : undefined;
  const streamingText = state.status === "streaming" ? state.input : undefined;

  const props: ToolProps = { part, state, stateKey, input, meta, output, error, streamingText };

  switch (part.name) {
    case "edit":
      return <EditTool {...props} />;
    case "write":
      return <WriteTool {...props} />;
    case "shell":
    case "bash":
      return <ShellTool {...props} />;
    case "subagent":
    case "task":
      return <SubagentTool {...props} />;
    case "execute":
      return <ExecuteTool {...props} />;
    case "read":
      return (
        <InlineTool
          {...props}
          icon="→"
          pending="Reading file…"
          label={
            <>
              Read <Path value={input.path} />
              {input.offset !== undefined && (
                <span className="text-[var(--text-weaker)]"> from {String(input.offset)}</span>
              )}
            </>
          }
        />
      );
    case "grep":
      return (
        <InlineTool
          {...props}
          icon="✱"
          pending="Searching content…"
          label={
            <>
              Grep "{input.pattern}" <Path value={input.path} prefix="in " />
              {meta.matches !== undefined && (
                <span className="text-[var(--text-weaker)]"> ({String(meta.matches)} matches)</span>
              )}
            </>
          }
        />
      );
    case "glob":
      return (
        <InlineTool
          {...props}
          icon="✱"
          pending="Finding files…"
          label={
            <>
              Glob "{input.pattern}" <Path value={input.path} prefix="in " />
              {meta.count !== undefined && <span className="text-[var(--text-weaker)]"> ({String(meta.count)})</span>}
            </>
          }
        />
      );
    case "webfetch":
      return (
        <InlineTool
          {...props}
          icon="%"
          pending="Fetching from the web…"
          label={<>{part.name} {input.url}</>}
        />
      );
    case "websearch":
      return (
        <InlineTool
          {...props}
          icon="◈"
          pending="Searching web…"
          label={<>Search "{input.query}"</>}
        />
      );
    default:
      return <GenericTool {...props} name={part.name} />;
  }
}

interface ToolProps {
  part: ToolPart;
  state: ToolState;
  stateKey?: string;
  input: Record<string, unknown>;
  meta: Record<string, unknown>;
  output?: string;
  error?: { type: string; message: string };
  streamingText?: string;
}

// ---- shared building blocks ----------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function textOf(content: { type: string; text?: string }[] | undefined): string | undefined {
  const text = (content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();
  return text || undefined;
}

/** Workspace-relative path display, like the TUI's pathFormatter. */
function Path({ value, prefix }: { value: unknown; prefix?: string }) {
  const path = str(value);
  if (!path) return null;
  const display = path.startsWith("/") ? path.replace(/^\/home\/[^/]+/, "~") : path;
  return (
    <span className="font-mono">
      {prefix}
      {display}
    </span>
  );
}

/**
 * One-line tool row: icon + label. Running = spinner + bright text,
 * complete = muted, failed = red with a click-to-expand error.
 */
function InlineTool({
  icon,
  label,
  pending,
  streamingText,
  error,
  output,
  complete = true,
  onClick,
  children,
  state,
  runningLabel,
  runningIcon,
  input,
  part,
}: ToolProps & {
  icon: string;
  label?: ReactNode;
  pending: string;
  complete?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  /**
   * In-flight body override (status "running"/"streaming"): lets a row show
   * a LIVE label (subagent: what the child session is doing) instead of the
   * generic spinner+"pending…" line — the caller moves the spinner to the
   * gutter via runningIcon so it sits where the ✓ lands on completion.
   */
  runningLabel?: ReactNode;
  /** In-flight gutter replacement — e.g. a Spinner in place of the "│". */
  runningIcon?: ReactNode;
}) {
  const [showError, setShowError] = useState(false);
  const [showStreaming, setShowStreaming] = useState(false);
  const failed = !!error;
  const running = state.status === "running";
  const inFlight = running || state.status === "streaming";
  const streamingPreview = (() => {
    const entries = Object.entries((input ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== "");
    if (entries.length > 0) {
      const pairs: string[] = [];
      for (const [k, v] of entries) {
        if (pairs.length >= 3) break;
        const raw = typeof v === "string" ? v : (() => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } })();
        if (!raw || raw === "{}" || raw === "[]") continue;
        pairs.push(`[${k}=${oneLine(raw, 40)}]`);
      }
      if (pairs.length > 0) return pairs.join(" ");
    }
    if (streamingText && streamingText.trim()) return oneLine(streamingText, 80);
    return undefined;
  })();
  const body = inFlight && runningLabel !== undefined ? (
    <span className="text-[var(--text-base)]">{runningLabel}</span>
  ) : inFlight ? (
    <span className="flex items-center gap-2 text-[var(--text-base)]">
      <Spinner className="size-3" />
      <span className="font-medium">{part.name}</span>
      {streamingPreview ? (
        <span className="truncate font-mono text-[var(--text-weaker)]">{streamingPreview}</span>
      ) : (
        <span className="text-[var(--text-weaker)]">{pending}</span>
      )}
    </span>
  ) : (
    <span className={failed ? "" : complete ? "text-[var(--text-weak)]" : "text-[var(--text-base)]"}>
      {label ?? children}
    </span>
  );
  const expandableStreaming = !failed && !onClick && streamingText !== undefined && streamingText.trim().length > 0;
  const clickable = !!(onClick || failed || expandableStreaming);

  return (
    <div className="py-0.5 pl-1 text-xs">
      <div
        role={clickable ? "button" : undefined}
        onClick={() => {
          if (failed) setShowError((v) => !v);
          else if (expandableStreaming) setShowStreaming((v) => !v);
          else onClick?.();
        }}
        className={`flex min-w-0 items-center gap-2 ${
          clickable ? "cursor-pointer rounded px-1 -mx-1 hover:bg-[color:var(--surface-base-hover)]" : ""
        } ${failed ? "text-[color:var(--surface-critical-strong)]" : ""}`}
      >
        <span
          className={`w-3 shrink-0 text-center font-mono ${
            failed ? "text-[color:var(--surface-critical-strong)]" : "text-[var(--text-weaker)]"
          }`}
        >
          {inFlight && runningIcon !== undefined ? runningIcon : icon}
        </span>
        <span className="min-w-0 flex-1 truncate">{body}</span>
        {expandableStreaming && (
          <ChevronRight className={`size-3 shrink-0 text-[var(--text-weaker)] transition-transform ${showStreaming ? "rotate-90" : ""}`} />
        )}
      </div>
      {failed && showError && (
        <pre className="ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[var(--surface-critical-weak)] p-2 font-mono text-[10px] text-[color:var(--surface-critical-strong)]">
          {error!.type}: {error!.message}
        </pre>
      )}
      {/* Failed tools often carry partial output before dying — the TUI keeps
           it visible (capped) instead of dropping the lines entirely. */}
      {failed && !showError && output && <FailedOutput output={output} />}
      {expandableStreaming && showStreaming && (
        <pre className="ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[color-mix(in_oklch,var(--border-selected)_20%,transparent)] bg-[var(--background-strong)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-weak)]">
          {streamingText}
        </pre>
      )}
    </div>
  );
}

/** Capped partial-output block for failed tools (same cap as shell blocks). */
function FailedOutput({ output }: { output: string }) {
  const lines = output.split("\n");
  const capped = lines.slice(0, 10).join("\n") + (lines.length > 10 ? "\n…" : "");
  return (
    <pre className="ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[color-mix(in_oklch,var(--border-selected)_20%,transparent)] bg-[var(--background-strong)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-weak)]">
      {capped}
    </pre>
  );
}

/** Titled result block (diffs, written files, command output). */
function BlockTool({
  title,
  children,
  collapsible,
  collapsedByDefault,
  stateKey,
}: {
  title: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  collapsedByDefault?: boolean;
  stateKey?: string;
}) {
  const [open, setOpen] = useState(() =>
    collapsible ? (stateKey ? toolDisclosureState.get(stateKey) ?? !collapsedByDefault : !collapsedByDefault) : true,
  );
  if (!collapsible) return <BlockFrame title={title}>{children}</BlockFrame>;
  return (
    <BlockFrame
      title={
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
            if (stateKey) rememberToolDisclosure(stateKey, !open);
          }}
          className="flex w-full cursor-pointer items-center gap-1 text-left"
        >
          <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </button>
      }
    >
      {open && children}
    </BlockFrame>
  );
}

function BlockFrame({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="my-1 overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-[var(--background-strong)]">
      <div className="flex items-center gap-1.5 border-b border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-1.5 text-xs text-[var(--text-weak)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max) + "…" : line;
}

function isImageMime(mime: string | undefined): boolean {
  return !!mime && mime.startsWith("image/");
}

function toolImageParts(content: import("../api/types").ToolContent[] | undefined) {
  if (!content) return [];
  return content.filter(
    (c): c is Extract<import("../api/types").ToolContent, { type: "file" }> =>
      c.type === "file" && isImageMime((c as { mime?: string }).mime),
  );
}

function toolImageSrc(part: Extract<import("../api/types").ToolContent, { type: "file" }>): string | undefined {
  if (part.uri) return part.uri;
  if (part.data) return `data:${part.mime};base64,${part.data}`;
  return undefined;
}

function ToolImages({ content }: { content: import("../api/types").ToolContent[] | undefined }) {
  const images = toolImageParts(content);
  if (images.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2 pl-1">
      {images.map((part, i) => {
        const src = toolImageSrc(part);
        if (!src) return null;
        return <ToolImageView key={i} src={src} name={part.name} />;
      })}
    </div>
  );
}

function ToolImageView({ src, name }: { src: string; name?: string }) {
  const [full, setFull] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setFull((v) => !v)}
      title={full ? `${name ?? "image"} — click to shrink` : `${name ?? "image"} — click to enlarge`}
      className={`block cursor-pointer ${full ? "" : "cursor-zoom-in"}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name ?? "image"}
        draggable={false}
        className={`rounded-md border border-[color:var(--border-weak-base)] bg-[var(--surface-inset-base)] object-contain ${
          full ? "max-h-[70vh] max-w-full" : "max-h-48 max-w-[16rem]"
        }`}
      />
    </button>
  );
}

// ---- per-tool renderers ---------------------------------------------------

function EditTool(props: ToolProps) {
  const files = Array.isArray(props.meta.files)
    ? (props.meta.files as { file?: string; patch?: string; additions?: number; deletions?: number; status?: string }[])
    : [];
  const path = str(props.input.path);

  if (files.length > 0) {
    return (
      <>
        {files.map((f, i) => (
          <BlockTool
            key={f.file ?? i}
            title={
              <>
                <span className="font-mono">←</span>
                {"Edit "}
                <span className="font-mono text-[var(--text-base)]">{f.file ?? path}</span>
                {f.additions !== undefined && f.deletions !== undefined && (
                  <span className="ml-auto shrink-0 font-mono text-[10px]">
                    <span className="text-[color:var(--text-diff-add-base)]">+{f.additions}</span>{" "}
                    <span className="text-[color:var(--text-diff-delete-base)]">−{f.deletions}</span>
                  </span>
                )}
              </>
            }
          >
            {f.patch ? (
              <DiffView diff={f.patch} className="max-h-80 overflow-y-auto py-1" />
            ) : (
              <p className="px-2.5 py-2 text-xs text-[var(--text-weaker)]">
                {f.status === "deleted" ? "File deleted" : "(no diff)"}
              </p>
            )}
          </BlockTool>
        ))}
      </>
    );
  }

  return (
    <InlineTool
      {...props}
      icon="←"
      pending="Preparing edit…"
      label={
        <>
          Edit <Path value={props.input.path} />
          {props.input.replaceAll != null && props.input.replaceAll !== false && (
            <span className="text-[var(--text-weaker)]"> (replace all)</span>
          )}
        </>
      }
    />
  );
}

function WriteTool(props: ToolProps) {
  const content = str(props.input.content);
  const path = str(props.input.path);

  if (props.state.status === "completed" && content !== undefined) {
    return (
      <BlockTool
        title={
          <>
            <span className="font-mono">#</span>
            {"Wrote "}
            <span className="font-mono text-[var(--text-base)]">{path}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">
              {content.split("\n").length} lines
            </span>
          </>
        }
        collapsible
        stateKey={props.stateKey}
      >
        <CodeBlock code={content} />
      </BlockTool>
    );
  }

  return (
    <InlineTool
      {...props}
      icon="←"
      pending="Preparing write…"
      label={
        <>
          Write <Path value={props.input.path} />
        </>
      }
    />
  );
}

function ShellTool(props: ToolProps) {
  const command = str(props.input.command);
  const exit = props.meta.exit;

  if (props.state.status === "completed") {
    return (
      <BlockTool
        title={
          <>
            <span className="font-mono">$</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-base)]">{command}</span>
            {typeof exit === "number" && exit !== 0 && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-[color:var(--surface-critical-strong)]">
                exit {exit}
              </span>
            )}
          </>
        }
        collapsible
        collapsedByDefault={!!props.output && props.output.split("\n").length > 10}
        stateKey={props.stateKey}
      >
        {props.output ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-xs leading-relaxed text-[var(--text-base)]">
            {props.output}
          </pre>
        ) : (
          <p className="px-2.5 py-2 text-xs text-[var(--text-weaker)]">(no output)</p>
        )}
      </BlockTool>
    );
  }

  return (
    <InlineTool
      {...props}
      icon="$"
      pending="Writing command…"
      label={<span className="font-mono">{command}</span>}
    />
  );
}

/**
 * Newest meaningful text from a session's stored messages — the same "what
 * is this run doing" cue the RunsPanel rows show, derived read-only from
 * the store. Newest-first, so live assistant progress beats the opening
 * task prompt once the child starts talking.
 */
function latestMessageSnippet(messages: MessageInfo[] | undefined): string | undefined {
  const list = messages ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (!message) continue;
    if (message.type === "user") {
      if (message.text.trim()) return message.text;
    } else if (message.type === "assistant") {
      const text = message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim();
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Subagent delegation row. While the child session runs, the label goes
 * live: agent + the child's current title (or its latest message text,
 * mirroring how RunsPanel names subagent rows), with a gutter spinner where
 * the ✓ lands on completion. Clicking still opens the child session.
 */
function SubagentTool(props: ToolProps) {
  const agent = str(props.input.agent) ?? "subagent";
  const description = str(props.input.description);
  const sessionID = str(props.meta.sessionID) ?? str(props.input.sessionID);

  // Resolve the child session like RunsPanel does (read-only): the polled
  // session list first, then the authoritative details cache.
  const child = useStore((s) =>
    sessionID ? s.sessions.find((x) => x.id === sessionID) ?? s.sessionDetails[sessionID] : undefined,
  );
  const childMessages = useStore((s) => (sessionID ? s.messages[sessionID] : undefined));

  const inFlight = props.state.status === "running" || props.state.status === "streaming";
  const liveText = str(child?.title) ?? latestMessageSnippet(childMessages);
  // Live title/snippet wins; description is the parsed-input fallback.
  const detail = liveText ?? description;

  const rowLabel = (detailText: string | undefined) => (
    <>
      <span className="font-medium">{agent}</span>
      {detailText && <span> — {detailText}</span>}
      {sessionID && <span className="ml-1 text-[10px] text-[var(--text-weaker)]">↗ open</span>}
    </>
  );

  return (
    <InlineTool
      {...props}
      icon={props.state.status === "completed" ? "✓" : "│"}
      runningIcon={inFlight ? <Spinner className="size-3" /> : undefined}
      pending="Delegating…"
      onClick={
        sessionID
          ? () => {
              void selectSession(sessionID);
            }
          : undefined
      }
      label={rowLabel(description)}
      runningLabel={inFlight ? (detail ? rowLabel(detail) : <>Delegating…</>) : undefined}
    />
  );
}

// ---- execute (multi-tool runner) -------------------------------------------

/**
 * Nested tool-call entry inside an execute run. Runtime entries carry more
 * fields (input/output/error) than the static shape shows — everything is
 * parsed defensively so an unexpected shape just renders `↳ tool`.
 */
type ExecuteCall = {
  tool?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
};

/** JSON.stringify that never throws (cyclic/BigInt input → String()). */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** ` [k=oneLine(v)]` argument preview for a nested call (max 3 pairs; empty
 *  values skipped) — the row's truncate class clips any overflow. */
function executeArgPreview(input: unknown): string {
  if (input == null) return "";
  const entries: [string, unknown][] =
    typeof input === "object" && !Array.isArray(input)
      ? Object.entries(input as Record<string, unknown>)
      : [["input", input]];
  const pairs: string[] = [];
  for (const [key, value] of entries) {
    if (pairs.length >= 3) break;
    if (value === undefined || value === null || value === "") continue;
    const raw = typeof value === "string" ? value : jsonText(value);
    if (!raw || raw === "{}" || raw === "[]") continue;
    pairs.push(`[${key}=${oneLine(raw, 80)}]`);
  }
  return pairs.length > 0 ? ` ${pairs.join(" ")}` : "";
}

/** Full input text for the expanded view: pretty JSON, or the raw string. */
function executeInputText(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined;
  if (input == null) return undefined;
  try {
    const pretty = JSON.stringify(input, null, 2);
    return pretty && pretty !== "{}" ? pretty : undefined;
  } catch {
    return jsonText(input);
  }
}

/** Output/result text: plain string, arbitrary JSON, or an array of
 *  {type:"text",text} parts — flattened to displayable text. */
function executeOutputText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text?: unknown }).text;
          if (typeof t === "string") return t;
        }
        return jsonText(part);
      })
      .join("\n")
      .trim();
    return text || undefined;
  }
  if (typeof value === "string") return value.trim() || undefined;
  try {
    const pretty = JSON.stringify(value, null, 2);
    return pretty && pretty !== "{}" ? pretty : undefined;
  } catch {
    return String(value);
  }
}

/** Error detail from a call's own error field (string | {type,message} | …). */
function executeErrorText(value: unknown): string | undefined {
  if (value == null || value === false) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "object") {
    const e = value as { type?: unknown; message?: unknown; text?: unknown };
    const message = str(e.message) ?? str(e.text);
    if (message) {
      const type = str(e.type);
      return type ? `${type}: ${message}` : message;
    }
    return executeOutputText(value);
  }
  return String(value);
}

const EXECUTE_BLOCK_CLASSES =
  "ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[color-mix(in_oklch,var(--border-selected)_20%,transparent)] bg-[var(--background-strong)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-weak)]";

/** One nested call row: `↳ tool [k=v] …` — clickable to reveal full
 *  input/output/error when the entry carries any; static text otherwise. */
function ExecuteCallRow({
  call,
  index,
  stateKey,
}: {
  call: ExecuteCall;
  index: number;
  stateKey?: string;
}) {
  // Persist per-row open state only when the parent gave us a stable key.
  const key = stateKey ? `${stateKey}:call:${index}` : undefined;
  const [open, setOpen] = useState(() => (key ? toolDisclosureState.get(key) ?? false : false));

  const inputText = executeInputText(call.input);
  const outputText = executeOutputText(call.output ?? call.result);
  const errorText = executeErrorText(call.error);
  const expandable = !!(inputText || outputText || errorText);

  return (
    <div>
      <div
        role={expandable ? "button" : undefined}
        onClick={
          expandable
            ? () => {
                setOpen((v) => {
                  if (key) rememberToolDisclosure(key, !v);
                  return !v;
                });
              }
            : undefined
        }
        className={`flex min-w-0 items-center gap-1 ${
          expandable
            ? "-mx-1 cursor-pointer rounded px-1 transition-colors hover:bg-[color:var(--surface-base-hover)]"
            : ""
        }`}
      >
        <span className="ml-5 min-w-0 flex-1 truncate text-[var(--text-weaker)]">
          ↳ {str(call.tool) ?? "tool"}
          {executeArgPreview(call.input)}
          {call.status === "error" && (
            <span className="text-[color:var(--surface-critical-strong)]"> (failed)</span>
          )}
        </span>
        {expandable && (
          <ChevronRight
            className={`size-3 shrink-0 text-[var(--text-weaker)] transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </div>
      {expandable && open && (
        <>
          {inputText && <pre className={EXECUTE_BLOCK_CLASSES}>{inputText}</pre>}
          {outputText && <pre className={EXECUTE_BLOCK_CLASSES}>{outputText}</pre>}
          {errorText && (
            <pre className="ml-5 mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[var(--surface-critical-weak)] p-2 font-mono text-[10px] text-[color:var(--surface-critical-strong)]">
              {errorText}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function ExecuteTool(props: ToolProps) {
  const calls = Array.isArray(props.meta.toolCalls) ? (props.meta.toolCalls as ExecuteCall[]) : [];
  // metadata.error arrives as a boolean flag OR an object ({type,message})
  // depending on which layer produced the failure — handle both.
  const metaError =
    typeof props.meta.error === "object" && props.meta.error !== null
      ? (props.meta.error as { type?: string; message?: string })
      : undefined;
  const hasError = props.meta.error === true || !!metaError?.message || !!props.error;
  // The state-level error is the authoritative detail; metadata.error is the
  // fallback when only metadata carried it.
  const errorDetail = props.error ?? (metaError?.message ? { type: metaError.type ?? "error", message: metaError.message } : undefined);

  return (
    <div className="py-0.5 pl-1 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`w-3 shrink-0 text-center font-mono ${
            hasError ? "text-[color:var(--surface-critical-strong)]" : "text-[var(--text-weaker)]"
          }`}
        >
          {hasError ? "✗" : props.state.status === "completed" ? "✓" : "│"}
        </span>
        {props.state.status === "completed" ? (
          <span className="text-[var(--text-weak)]">execute</span>
        ) : (
          <span className="flex items-center gap-2 text-[var(--text-base)]">
            <Spinner className="size-3" /> execute
          </span>
        )}
      </div>
      {calls.map((call, i) => (
        <ExecuteCallRow key={i} call={call} index={i} stateKey={props.stateKey} />
      ))}
      {errorDetail && (
        <pre className="ml-5 mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-[color:var(--surface-critical-strong)]">
          {errorDetail.type}: {errorDetail.message}
        </pre>
      )}
      {hasError && props.output && errorDetail === undefined && (
        <pre className="ml-5 mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-[color:var(--surface-critical-strong)]">
          {props.output.split("\n").slice(0, 4).join("\n")}
        </pre>
      )}
      <ToolImages
        content={
          props.state.status === "completed" || props.state.status === "error"
            ? props.state.content
            : undefined
        }
      />
    </div>
  );
}

function GenericTool(props: ToolProps & { name: string }) {
  const summary = Object.entries(props.input)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${oneLine(String(v), 40)}`)
    .join("  ");

  return (
    <div>
      <InlineTool
        {...props}
        icon="⚙"
        pending={`${props.name}…`}
        label={
          <>
            <span className="font-medium">{props.name}</span>
            {summary && <span className="font-mono text-[var(--text-weaker)]"> {summary}</span>}
          </>
        }
      />
      {props.state.status === "completed" && props.output && (
        <BlockTool title={`${props.name} output`} collapsible stateKey={props.stateKey}>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-xs leading-relaxed text-[var(--text-base)]">
            {props.output}
          </pre>
        </BlockTool>
      )}
      <ToolImages
        content={
          props.state.status === "completed" || props.state.status === "error"
            ? props.state.content
            : undefined
        }
      />
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const lines = code.split("\n");
  return (
    <div className="max-h-64 overflow-auto font-mono text-xs leading-relaxed">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td className="w-10 shrink-0 select-none border-r border-[var(--border-weak-base)] pr-2 text-right align-top text-[var(--text-weaker)]">
                {i + 1}
              </td>
              <td className="whitespace-pre-wrap break-all pl-2.5 text-[var(--text-base)]">{line || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
