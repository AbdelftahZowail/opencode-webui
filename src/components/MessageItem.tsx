import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, ChevronRight, Paperclip, User } from "lucide-react";
import type {
  AssistantMessage,
  FileAttachment,
  MessageInfo,
  ToolContent,
  ToolPart,
  UserMessage,
} from "../api/types";
import { api } from "../api/client";
import { useStore } from "../store";
import { historyFilePath, historyImageSrc, isImageMime } from "../lib/attachments";
import { ToolCard } from "./ToolCard";
import { Spinner } from "./ui";
import { Marker, MarkerContent } from "./ui/marker";
import { getPrefs, subscribePrefs } from "../prefs";

function useTimestamps(): boolean {
  const [show, setShow] = useState(getPrefs().showTimestamps);
  useEffect(() => subscribePrefs(() => setShow(getPrefs().showTimestamps)), []);
  return show;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageItem({ message, compact = false }: { message: MessageInfo; compact?: boolean }) {
  switch (message.type) {
    case "user":
      return (
        <Row align="right">
          <div className="max-w-[85%]">
            <div className="flex items-center justify-end gap-1.5 text-xs text-[var(--text-weak)]">
              <TimestampIfWanted time={message.time.created} />
              <User className="size-3.5" />
              You
            </div>
            {message.files && message.files.length > 0 && <UserFiles files={message.files} />}
            <div className="mt-1 text-sm leading-relaxed text-[var(--text-strong)] whitespace-pre-wrap">
              {message.text}
            </div>
          </div>
        </Row>
      );
    case "assistant":
      return <AssistantView message={message} compact={compact} />;
    case "system":
    case "synthetic":
      return (
        <Row>
          <div className="w-full rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-3 py-2 text-xs text-[var(--text-weak)]">
            {message.description ?? message.type}
            {message.text && (
              <div className="mt-1 text-[var(--text-base)] whitespace-pre-wrap">{message.text}</div>
            )}
          </div>
        </Row>
      );
    case "skill":
      return (
        <Row>
          <div className="w-full rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-interactive-weak)] px-3 py-2 text-xs text-[var(--text-interactive-base)]">
            Activated skill <b className="font-medium text-[var(--text-strong)]">{message.name}</b>
            {message.text && (
              // The skill's activation note (e.g. "arguments parsed…") was
              // previously invisible; keep it as a muted second line.
              <div className="mt-0.5 whitespace-pre-wrap text-[var(--text-weaker)]">{message.text}</div>
            )}
          </div>
        </Row>
      );
    case "shell":
      return (
        <Row>
          <ShellCard command={message.command} status={message.status} exit={message.exit} />
        </Row>
      );
    case "agent-switched":
      return <Note>Agent switched to <b>{message.agent}</b></Note>;
    case "model-switched":
      return <Note>Model switched to <b>{message.model.providerID}/{message.model.id}</b></Note>;
    case "location-switched":
      return <Note>Moved to <b>{message.location.directory}</b></Note>;
    case "compaction": {
      // Single line: status, then the trigger reason and any engine error —
      // a failed compaction used to render identical to a running one.
      const label =
        message.status === "completed"
          ? "Conversation compacted"
          : message.status === "failed"
            ? "Compaction failed"
            : "Compacting…";
      const reason = message.reason === "auto" || message.reason === "manual" ? ` (${message.reason})` : "";
      return (
        <Note>
          {label}
          {reason}
          {message.status === "failed" && message.error && (
            <span className="text-[var(--text-on-critical-base)]">
              {" — "}
              {message.error.type}: {message.error.message}
            </span>
          )}
        </Note>
      );
    }
    default:
      return null;
  }
}

function Note({ children }: { children: ReactNode }) {
  return (
    <Row>
      <Marker variant="separator">
        <MarkerContent className="text-xs text-[var(--text-weak)] [&_b]:text-[var(--text-base)]">{children}</MarkerContent>
      </Marker>
    </Row>
  );
}

// ---- user message file attachments ---------------------------------------

function UserFiles({ files }: { files: NonNullable<UserMessage["files"]> }) {
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
      {files.map((file, i) => (
        <AttachmentThumb key={`${file.name ?? "file"}:${i}`} file={file} />
      ))}
    </div>
  );
}

/**
 * One history attachment: inline images render as a thumbnail (click to
 * toggle full size — data: URIs can't be opened in a new tab, browsers block
 * top-level data: navigation); path-form images fall back to a byte fetch;
 * everything else stays a chip.
 */
function AttachmentThumb({ file }: { file: FileAttachment }) {
  const src = historyImageSrc(file);
  const path = src ? null : historyFilePath(file);
  if (!src && !path) return <FileChip name={file.name} mime={file.mime} />;
  if (!src) return <PathImage filePath={path!} name={file.name} />;
  return (
    <ImageView
      src={src}
      name={file.name}
      alt={file.name ?? "attached image"}
    />
  );
}

/** Image with click-to-expand; collapsed size is the shared thumbnail look. */
function ImageView({ src, name, alt }: { src: string; name?: string; alt?: string }) {
  const [full, setFull] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setFull((v) => !v)}
      title={full ? `${name ?? "image"} — click to shrink` : `${name ?? "image"} — click to enlarge`}
      className={`block cursor-pointer ${full ? "" : "cursor-zoom-in"}`}
    >
      <img
        src={src}
        alt={alt ?? name ?? "image"}
        draggable={false}
        className={`rounded-md border border-[color:var(--border-weak-base)] bg-[var(--surface-inset-base)] object-contain ${
          full ? "max-h-[70vh] max-w-full" : "max-h-48 max-w-[16rem]"
        }`}
      />
    </button>
  );
}

/**
 * Path-form history image (file:// URI or bare path): read the bytes through
 * /api/fs/read and show them via an object URL. Absolute paths need no
 * workspace; relative paths resolve against the current session's workspace.
 * Any failure degrades to the chip.
 */
function PathImage({ filePath, name }: { filePath: string; name?: string }) {
  const location = useStore(
    (s) => s.sessions.find((x) => x.id === s.currentSessionID)?.location?.directory,
  );
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    const load = async () => {
      for (const base of [undefined, location]) {
        if (cancelled) return;
        try {
          const buf = await api.fsReadBytes(filePath, base);
          if (cancelled) return;
          created = URL.createObjectURL(new Blob([buf]));
          setSrc(created);
          return;
        } catch {
          /* try the next base */
        }
      }
      if (!cancelled) setFailed(true);
    };
    void load();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [filePath, location]);
  if (failed || !src) return <FileChip name={name} />;
  return <ImageView src={src} name={name} alt={name ?? "attached image"} />;
}

function FileChip({ name, mime }: { name?: string; mime?: string }) {
  return (
    <span
      title={mime}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[color:var(--border-weak-base)] bg-[var(--surface-inset-base)] px-2 py-1 text-xs text-[var(--text-weak)]"
    >
      <Paperclip className="size-3 shrink-0" />
      <span className="truncate">{name ?? "file"}</span>
      {mime && <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">{mime}</span>}
    </span>
  );
}

function TimestampIfWanted({ time }: { time: number }) {
  const show = useTimestamps();
  if (!show) return null;
  return <span className="font-mono text-[var(--text-weaker)]">{formatClock(time)}</span>;
}

/** Compact per-message usage next to the cost, e.g. "1.2k in / 3.4k out". */
function Tokens({ tokens }: { tokens: NonNullable<AssistantMessage["tokens"]> }) {
  const input = tokens.input + tokens.cache.read + tokens.cache.write;
  const output = tokens.output + tokens.reasoning;
  if (input === 0 && output === 0) return null;
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return (
    <span
      className="font-mono text-[10px] text-[var(--text-weaker)]"
      title={`${input.toLocaleString()} in · ${output.toLocaleString()} out`}
    >
      {fmt(input)} in / {fmt(output)} out
    </span>
  );
}

function ShellCard({
  command,
  status,
  exit,
}: {
  command: string;
  status: string;
  exit?: number;
}) {
  // ShellMessage statuses are running|exited|timeout|killed — there is no
  // "completed"/"error"; the old map never colored anything but running.
  const failed = (status === "exited" && exit !== 0) || status === "timeout" || status === "killed";
  const statusColor = status === "running" ? "" : failed ? "text-[var(--text-on-critical-base)]" : "text-[var(--text-on-success-base)]";
  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-md border border-[var(--border-weak-base)]">
      <div className="flex items-center justify-between gap-2 bg-[var(--surface-base)] px-3 py-1.5 font-mono text-xs text-[var(--text-weak)]">
        <span className="truncate">$ {command}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {failed && typeof exit === "number" && (
            <span className="rounded-sm bg-[color-mix(in_oklch,var(--surface-critical-strong)_12%,transparent)] px-1 py-px text-[10px] text-[color:var(--surface-critical-strong)]">
              exit {exit}
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 ${statusColor}`}
            title={status === "timeout" ? "Command timed out" : status === "killed" ? "Command was killed" : undefined}
          >
            {status === "running" && <Spinner className="size-3" />}
            {status}
          </span>
        </span>
      </div>
    </div>
  );
}

function AssistantView({ message, compact }: { message: AssistantMessage; compact: boolean }) {
  const showTimestamps = useTimestamps();
  return (
    <Row align="left">
      <div className="w-full space-y-2.5 text-sm leading-relaxed">
        {!compact && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-weak)]">
            <span className="font-medium text-[var(--text-strong)]">{message.agent ?? "assistant"}</span>
            {message.model && (
              <span className="font-mono text-[var(--text-weaker)]">
                {message.model.providerID}/{message.model.id}
                {message.model.variant && message.model.variant !== "default" ? `@${message.model.variant}` : ""}
              </span>
            )}
            {showTimestamps && (
              <span className="font-mono text-[var(--text-weaker)]">{formatClock(message.time.created)}</span>
            )}
            {message.cost !== undefined && message.cost > 0 && (
              <span className="font-mono text-[var(--text-weaker)]">${message.cost.toFixed(4)}</span>
            )}
            {message.tokens && <Tokens tokens={message.tokens} />}
            {message.finish && message.finish !== "stop" && (
              <span className="rounded-sm border border-[var(--border-weak-base)] px-1 py-px font-mono text-[10px] text-[var(--text-weak)]">
                {message.finish}
              </span>
            )}
          </div>
        )}
        {message.error && (
          <div className="rounded-md border border-[color-mix(in_oklch,var(--surface-critical-strong)_40%,transparent)] bg-[var(--surface-critical-weak)] px-3 py-2 text-xs text-[var(--text-on-critical-strong)]">
            {message.error.type}: {message.error.message}
          </div>
        )}
        {(() => {
          const ordinal = { text: 0, reasoning: 0 };
          return message.content.map((part) => {
            const key =
              part.type === "tool"
                ? `${message.id}:tool:${part.id}`
                : `${message.id}:${part.type}:${ordinal[part.type]++}`;
            return <MessagePart key={key} stateKey={key} part={part} />;
          });
        })()}
      </div>
    </Row>
  );
}

export function MessagePart({
  part,
  stateKey,
}: {
  part: ToolPart | { type: "text"; text: string } | { type: "reasoning"; text: string };
  stateKey?: string;
}) {
  if (part.type === "reasoning") return <ReasoningBlock text={part.text} stateKey={stateKey} />;
  if (part.type === "tool") return <ToolCard part={part} stateKey={stateKey} />;
  if (!part.text || !part.text.trim()) return null;
  return <Markdown text={part.text} />;
}

const disclosureState = new Map<string, boolean>();

function rememberDisclosure(key: string, value: boolean) {
  disclosureState.delete(key);
  disclosureState.set(key, value);
  while (disclosureState.size > 2_000) {
    const oldest = disclosureState.keys().next().value;
    if (!oldest) break;
    disclosureState.delete(oldest);
  }
}

function ReasoningBlock({ text, stateKey }: { text: string; stateKey?: string }) {
  const [showReasoning, setShowReasoning] = useState(getPrefs().showReasoning);
  /**
   * null = follow the global /thinking toggle; boolean = this block was
   * clicked individually. A global toggle re-takes control of every block,
   * so /thinking always expands/collapses ALL thinking blocks at once.
   */
  const [manualOpen, setManualOpen] = useState<boolean | null>(() =>
    stateKey ? (disclosureState.get(stateKey) ?? null) : null,
  );
  useEffect(
    () =>
      subscribePrefs(() => {
        setShowReasoning(getPrefs().showReasoning);
        setManualOpen(null);
      }),
    [],
  );
  const open = manualOpen ?? showReasoning;
  if (!text) return null;
  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)]">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setManualOpen(next);
          if (stateKey) rememberDisclosure(stateKey, next);
        }}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-[var(--text-weak)] transition-colors hover:text-[var(--text-base)]"
      >
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Brain className="size-3.5 shrink-0" />
        Reasoning
      </button>
      {open && (
        <div className="border-t border-[var(--border-weak-base)] px-2.5 py-2 text-xs leading-relaxed text-[var(--text-weak)] italic whitespace-pre-wrap">{text}</div>
      )}
    </div>
  );
}

/**
 * Allow image data URIs through react-markdown's sanitizer (the engine and
 * tools emit `![Image](data:image/png;base64,…)` for screenshots); everything
 * else keeps the default safe-protocol rules (http/https/relative).
 */
function markdownUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (/^data:image\/[a-z0-9.+-]+;/i.test(trimmed)) return trimmed;
  return defaultUrlTransform(url);
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed text-[var(--text-base)] [&_h1]:text-[var(--text-strong)] [&_h2]:text-[var(--text-strong)] [&_h3]:text-[var(--text-strong)] [&_strong]:text-[var(--text-strong)] [&_a]:text-[var(--text-interactive-base)] [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-weak-base)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-weak)] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[var(--border-weak-base)] [&_pre]:bg-[var(--surface-inset-base)] [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:text-[var(--text-base)] [&_code]:rounded [&_code]:bg-[var(--surface-base)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-[var(--text-base)] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit [&_img]:max-h-96 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-[color:var(--border-weak-base)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function ToolContentView({ content }: { content?: ToolContent[] }) {
  if (!content || content.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {content.map((c, i) => {
        if (c.type === "text") {
          return (
            <pre key={i} className="max-h-64 overflow-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-2.5 font-mono text-xs leading-relaxed text-[var(--text-base)] whitespace-pre-wrap">
              {c.text}
            </pre>
          );
        }
        if (isImageMime(c.mime) && c.data) {
          return (
            <ImageView
              key={i}
              src={`data:${c.mime};base64,${c.data}`}
              name={c.name ?? "image"}
              alt={c.name ?? "tool image"}
            />
          );
        }
        return (
          <div key={i} className="flex items-center gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-2.5 py-1.5 text-xs text-[var(--text-weak)]">
            <Paperclip className="size-3 shrink-0" />
            {c.name ?? "file"} <span className="font-mono text-[var(--text-weaker)]">{c.mime}</span>
          </div>
        );
      })}
    </div>
  );
}

function Row({ align = "left", children }: { align?: "left" | "right"; children: ReactNode }) {
  return (
    <div className={`mb-3.5 flex w-full ${align === "right" ? "justify-end" : "justify-start"}`}>
      {children}
      {align === "right" && <span className="sr-only">user message</span>}
    </div>
  );
}
