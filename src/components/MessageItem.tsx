import { useEffect, useMemo, useState, Fragment, type ReactNode, useSyncExternalStore } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, Check, ChevronRight, Copy, GitBranch, Pencil, Paperclip, User } from "lucide-react";
import type {
  AssistantMessage,
  FileAttachment,
  MessageInfo,
  ShellMessage,
  ToolContent,
  ToolPart,
  UserMessage,
} from "../api/types";
import { api } from "../api/client";
import { editAtMessage, forkAtMessage, useStore } from "../store";
import { notify } from "../lib/notify";
import { historyFilePath, historyImageSrc, isImageMime } from "../lib/attachments";
import { formatModelRef } from "../lib/modelLabel";
import { Spinner } from "./ui";
import { Marker, MarkerContent } from "./ui/marker";
import { getPrefs, subscribePrefs } from "../prefs";
import {
  Target,
  autoRegister,
  getContributions,
  getHooks,
  getService,
  getTargetChain,
  renderTarget,
  subscribeRegistry,
  type ContextMenuContribution,
  type MessageDecorationContribution,
  type MessagePartContribution,
} from "../extensions/registry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";

function useTimestamps(): boolean {
  const [show, setShow] = useState(getPrefs().showTimestamps);
  useEffect(() => subscribePrefs(() => setShow(getPrefs().showTimestamps)), []);
  return show;
}

/**
 * Freshness for late/hot-swapped extension registrations (same pattern as
 * useTimestamps): a local counter bumped by the registry's subscribe — the
 * registry has no exported version snapshot to read via useSyncExternalStore.
 */
function useRegistryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeRegistry(() => setVersion((v) => v + 1)), []);
  return version;
}

// useSyncExternalStore-backed tick for new extension kinds. The registry
// exposes subscribeRegistry but not its internal version, so we maintain a
// module-level counter that bumps on every registry notification. A single
// registry subscription fans out to all local listeners so one registry bump
// increments the version exactly once, regardless of subscriber count.
let _extVersion = 0;
const _extListeners = new Set<() => void>();
let _extSubscribed = false;
function ensureExtSubscribed() {
  if (_extSubscribed) return;
  _extSubscribed = true;
  subscribeRegistry(() => {
    _extVersion++;
    for (const cb of _extListeners) cb();
  });
}
function subscribeExt(cb: () => void) {
  ensureExtSubscribed();
  _extListeners.add(cb);
  return () => _extListeners.delete(cb);
}
function getExtSnapshot() {
  return _extVersion;
}
function getExtServerSnapshot() {
  return 0;
}
function useExtensionVersion(): number {
  return useSyncExternalStore(subscribeExt, getExtSnapshot, getExtServerSnapshot);
}

/** Wraps message rows with extension context menus (right-click) plus built-in Edit/Fork for user messages. */
function MessageContextMenu({
  message,
  sessionID,
  children,
}: {
  message: MessageInfo;
  sessionID?: string;
  children: ReactNode;
}) {
  const version = useExtensionVersion();
  const menus = useMemo(() => getContributions<ContextMenuContribution>("contextMenu.message"), [version]);
  const isUser = message.type === "user" && !message.id.startsWith("msg_local_");
  const hasBuiltIn = isUser && !!sessionID && sessionID !== "__draft__";
  if (menus.length === 0 && !hasBuiltIn) return <>{children}</>;
  const messageID = message.id;
  const userText = isUser ? (message as UserMessage).text : "";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* div wrapper preserves block layout while allowing text selection */}
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        {hasBuiltIn && (
          <>
            <ContextMenuItem
              onSelect={() => {
                void editAtMessage(sessionID!, messageID, userText).catch((err) =>
                  notify({
                    title: "Edit failed",
                    description: err instanceof Error ? err.message : String(err),
                    variant: "destructive",
                  }),
                );
              }}
            >
              <Pencil className="size-3.5" /> Edit
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => {
                void forkAtMessage(sessionID!, messageID).catch((err) =>
                  notify({
                    title: "Fork failed",
                    description: err instanceof Error ? err.message : String(err),
                    variant: "destructive",
                  }),
                );
              }}
            >
              <GitBranch className="size-3.5" /> Fork
            </ContextMenuItem>
            {menus.length > 0 && <ContextMenuSeparator />}
          </>
        )}
        {menus.map((item) => (
          <ContextMenuItem
            key={item.id}
            onSelect={() => {
              try {
                item.item.run({ messageID });
              } catch (err) {
                console.error(`[extensions] contextMenu "${item.id}" crashed:`, err);
              }
            }}
          >
            {item.item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Renders per-part decorations inline below a single content part. */
function PartDecorations({
  message,
  part,
  partIndex,
}: {
  message: MessageInfo;
  part: ToolPart;
  partIndex: number;
}) {
  const version = useExtensionVersion();
  const decorations = useMemo(() => getContributions<MessagePartContribution>("message.part"), [version]);
  if (decorations.length === 0) return null;
  const nodes: ReactNode[] = [];
  for (let i = 0; i < decorations.length; i++) {
    const dec = decorations[i]!;
    let node: ReactNode = null;
    try {
      node = dec.item.render({ messageID: message.id, message, part, partIndex });
    } catch (err) {
      console.error(`[extensions] message.part "${dec.id ?? i}" crashed:`, err);
    }
    if (node == null) continue;
    nodes.push(<Fragment key={dec.id ?? i}>{node}</Fragment>);
  }
  if (nodes.length === 0) return null;
  return <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-[var(--text-weak)]">{nodes}</div>;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* insecure context / permission denied — fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function assistantCopyText(message: AssistantMessage): string {
  const parts = message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string" && p.text.trim() !== "")
    .map((p) => p.text);
  return parts.join("\n\n");
}

function UserCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void copyText(text).then((ok) => {
      if (!ok) {
        notify({ title: "Copy failed", variant: "destructive" });
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : "Copy message"}
      className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] text-[var(--text-weak)] shadow-sm transition-colors hover:text-[var(--text-strong)]"
    >
      {copied ? <Check className="size-3.5 text-[var(--text-on-success-base)]" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function AssistantCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void copyText(text).then((ok) => {
      if (!ok) {
        notify({ title: "Copy failed", variant: "destructive" });
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : "Copy response"}
      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] px-1.5 py-1 text-xs text-[var(--text-weaker)] shadow-sm transition-colors hover:text-[var(--text-strong)] opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function MessageItem({ message, compact = false, sessionID, isTail = false, responseText }: { message: MessageInfo; compact?: boolean; sessionID?: string; isTail?: boolean; responseText?: string }) {
  // Extension freshness — read before the body so hooks order is stable.
  const registryVersion = useRegistryVersion();
  // Memoized on the registry version only: decorations are a static list
  // per registration state; per-message work happens in the render calls.
  const decorations = useMemo(() => getContributions<MessageDecorationContribution>("message.decoration"), [registryVersion]);

  // --- extension hook + replace targets (the "do everything" contract) ---
  // `hook:message.render` runs first (observe/mutate), then `replace` on
  // `message:<type>` (exact) or `message:*` (any) can take over the body.
  // First non-null wins; `null` falls through to the built-in body below.
  // Both are version-gated so hot-swaps repaint.
  let effectiveMessage: MessageInfo = message;
  const hooks = useMemo(() => getHooks("message.render"), [registryVersion]);
  if (hooks.length > 0) {
    const ctx: Record<string, unknown> = { message: { ...message }, sessionID };
    for (const h of hooks) {
      try {
        const res = h.handler(ctx, () => {});
        if (res instanceof Promise) void res.catch((err) => console.error(`[extensions] hook "${h.id}" failed:`, err));
      } catch (err) {
        console.error(`[extensions] hook "${h.id}" crashed:`, err);
      }
    }
    effectiveMessage = ctx.message as MessageInfo;
  }
  const messageTarget = useMemo(() => {
    for (const id of [`message:${effectiveMessage.type}`, "message:*"]) {
      const chain = getTargetChain(id);
      if (chain.replaces.length > 0 || chain.wraps.length > 0) return id;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryVersion, effectiveMessage.type, effectiveMessage.id]);
  const defaultBody = () => renderMessageBody(effectiveMessage, compact, sessionID, isTail, responseText);
  let body: ReactNode;
  if (messageTarget) {
    // Crash-isolated inside renderTarget: a throwing replace falls through
    // to the next candidate / core instead of blanking the row.
    const node = renderTarget(messageTarget, { message: effectiveMessage, sessionID });
    body = node ?? defaultBody();
  } else {
    body = defaultBody();
  }

  return (
    <MessageContextMenu message={effectiveMessage} sessionID={sessionID}>
      {/* DOM-stratum anchor (spec §7): stable per-message boundary. The three
          attributes travel together — presence, id, and type. */}
      <div
        data-oc-message
        data-oc-message-id={effectiveMessage.id}
        data-oc-message-type={effectiveMessage.type}
      >
      <>{body}
      {/* Message decorations: a tiny inline row under the body. Guarded by
           a length check so zero registrations cost nothing; individual
           renderers are crash-isolated like target items. */}
      {decorations.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {decorations.map((decoration, i) => {
            let node: ReactNode = null;
            try {
              node = decoration.item.render({ messageID: effectiveMessage.id, message: effectiveMessage });
            } catch (err) {
              console.error(`[extensions] message decoration "${decoration.id ?? i}" crashed:`, err);
            }
            if (node == null) return null;
            return <Fragment key={decoration.id ?? i}>{node}</Fragment>;
          })}
        </div>
      )}
      </>
      </div>
    </MessageContextMenu>
  );
}

/** The per-type body exactly as MessageItem always rendered it. */
function renderMessageBody(message: MessageInfo, compact: boolean, sessionID?: string, isTail?: boolean, responseText?: string): ReactNode {
  switch (message.type) {
    case "user": {
      const canAct = !!sessionID && !message.id.startsWith("msg_local_") && !message.id.startsWith("__draft__");
      const onEdit = () => {
        if (!sessionID) return;
        void import("../store").then(({ startEditAtMessage }) => startEditAtMessage(sessionID, message.id, (message as UserMessage).text ?? ""));
      };
      const onFork = () => {
        if (!sessionID) return;
        void import("../store").then(({ forkAtMessage }) => void forkAtMessage(sessionID, message.id).catch(() => {}));
      };
      return (
        <div className="group flex w-full justify-end mb-3.5">
          <div className="relative max-w-[85%] rounded-lg px-3 py-2">
            {/* Hover actions — anchored to the whole row (group), not just the bubble, so moving the cursor to the buttons doesn't lose hover */}
            {canAct && (
              <div className="absolute top-1/2 right-full mr-3 hidden -translate-y-1/2 items-center gap-1.5 group-hover:flex">
                <Target id="message.copyButton" text={(message as UserMessage).text ?? ""} variant="user" />
                <button type="button" onClick={onEdit} title="Edit from here" className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] text-[var(--text-weak)] shadow-sm hover:text-[var(--text-strong)]">
                  <Pencil className="size-3.5" />
                </button>
                <button type="button" onClick={onFork} title="Fork from here" className="flex size-7 cursor-pointer items-center justify-center rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] text-[var(--text-weak)] shadow-sm hover:text-[var(--text-strong)]">
                  <GitBranch className="size-3.5" />
                </button>
              </div>
            )}
            <div className="flex items-center justify-end gap-1.5 text-xs text-[var(--text-weak)]">
              <Target id="message.timestamp" time={message.time.created} />
              <User className="size-3.5" />
              You
            </div>
            {message.files && message.files.length > 0 && <UserFiles files={message.files} />}
            <div className="mt-1 text-sm leading-relaxed text-[var(--text-strong)] whitespace-pre-wrap">
              {message.text}
            </div>
          </div>
        </div>
      );
    }
    case "assistant": {
      // Only the tail of a finished response gets a copy button — not every
      // compact chunk. A response is consecutive assistant messages; the copy
      // lives once at its end and copies the whole response's prose when
      // provided by the transcript (aggregated), otherwise just this message.
      const isFinished = message.time.completed !== undefined || (message as AssistantMessage).finish !== undefined;
      const showCopy = !!isTail && isFinished;
      const fallback = showCopy ? assistantCopyText(message as AssistantMessage) : "";
      const copyText = showCopy ? (responseText ?? fallback) : "";
      const hasText = copyText.trim().length > 0;
      return <AssistantView message={message} compact={compact} showCopy={showCopy && hasText} copyText={copyText} />;
    }
    case "system":
    case "synthetic": {
      const text = (message as { text?: string; description?: string }).text ?? "";
      const description = (message as { description?: string }).description;
      // TUI shows only "Instructions updated: core/codemode" — the web UI was dumping
      // the entire Code Mode catalog (hundreds of lines) inline. Keep it minimal:
      // first line as the note, full catalog collapsed behind a chevron.
      const isVerboseCatalog = text.length > 500 || text.includes("The Code Mode tool catalog has changed");
      const isInstructionUpdate =
        (description ?? "").startsWith("Instructions updated") || text.startsWith("Instructions updated");
      if ((isVerboseCatalog || isInstructionUpdate) && text.length > 200) {
        return (
          <Row>
            <InstructionCard message={message as { description?: string; text: string }} />
          </Row>
        );
      }
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
    }
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
          <ShellCard message={message as ShellMessage} />
        </Row>
      );
    case "agent-switched":
      return <Note>Agent switched to <b>{message.agent}</b></Note>;
    case "model-switched":
      return <Note>Model switched to <b>{message.model.providerID}/{message.model.id}</b></Note>;
    case "location-switched":
      return <Note>Moved to <b>{message.location.directory}</b></Note>;
    case "compaction": {
      const isRunning = message.status === "running";
      const isFailed = message.status === "failed";
      const label = isFailed ? "Compaction failed" : isRunning ? "Compacting…" : "Conversation compacted";
      const reason = message.reason === "auto" || message.reason === "manual" ? ` (${message.reason})` : "";
      const summary = (message as { summary?: string }).summary;
      const recent = (message as { recent?: string }).recent;
      // Completed/running carry summary+recent from the engine (openapi: required).
      // Show them TUI-style: header line plus collapsible summary. Streaming
      // compaction text arrives via session.compaction.ended's `text` field
      // which surfaces as summary on the completed message.
      if (isFailed) {
        return (
          <Note>
            {label}
            {reason}
            {message.error && (
              <span className="text-[var(--text-on-critical-base)]">
                {" — "}
                {message.error.type}: {message.error.message}
              </span>
            )}
          </Note>
        );
      }
      if (!summary && !recent) {
        return (
          <Note>
            {label}
            {reason}
          </Note>
        );
      }
      return (
        <Row>
          <CompactionCard
            label={label}
            reason={reason}
            summary={summary}
            recent={recent}
            running={isRunning}
          />
        </Row>
      );
    }
    default:
      return null;
  }
}

function InstructionCard({ message }: { message: { description?: string; text: string } }) {
  const [expanded, setExpanded] = useState(false);
  // description holds the TUI line ("Instructions updated: core/codemode") when present;
  // otherwise the first line of text is the title and the rest is the catalog dump.
  const title = message.description ?? message.text.split("\n")[0] ?? "Instructions updated";
  const body = message.description ? message.text : message.text.split("\n").slice(1).join("\n").trim();
  const hasBody = body.length > 0;
  return (
    <div className="w-full overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)]">
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs ${hasBody ? "cursor-pointer hover:bg-[color:var(--surface-base-hover)]" : ""}`}
      >
        <span className="flex-1 truncate text-[var(--text-weak)]">
          <b className="font-medium text-[var(--text-base)]">{title}</b>
        </span>
        {hasBody && <ChevronRight className={`size-3 shrink-0 text-[var(--text-weaker)] transition-transform ${expanded ? "rotate-90" : ""}`} />}
      </button>
      {hasBody && expanded && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-weak)]">
          {body}
        </pre>
      )}
    </div>
  );
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
  // The format consults the "format.timestamp" service — a value override
  // stays stale-proof where a forked component would rot.
  const format = getService<(ms: number) => string>("format.timestamp") ?? formatClock;
  return <span className="font-mono text-[var(--text-weaker)]">{format(time)}</span>;
}

/** Session cost badge, e.g. "$0.0234" — its own target per §5.3. */
function CostBadge({ cost }: { cost: number }) {
  return <span className="font-mono text-[var(--text-weaker)]">${cost.toFixed(4)}</span>;
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

function ShellCard({ message }: { message: ShellMessage }) {
  const { command, status, exit, output } = message;
  const failed = (status === "exited" && exit !== 0) || status === "timeout" || status === "killed";
  const running = status === "running";
  const outputText = output?.output ?? "";
  const hasOutput = outputText.length > 0;
  const [expanded, setExpanded] = useState(false);
  // Same block for running and finished — TUI parity: "$ command" header plus
  // streaming output. The engine has no incremental shell output events; the
  // output grows via GET /api/session/{id}/message polling (LIVE tier ~2s)
  // while running, so "streaming" here is poll-driven, not SSE.
  const statusColor = running ? "" : failed ? "text-[var(--text-on-critical-base)]" : "text-[var(--text-on-success-base)]";
  const shouldCollapse = hasOutput && outputText.split("\n").length > 10;
  const showAll = expanded || !shouldCollapse;
  const displayOutput = showAll ? outputText : outputText.split("\n").slice(0, 10).join("\n");
  const truncated = output?.truncated;

  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-[var(--background-strong)]">
      {/* Header: hover highlights the whole row; click toggles full command when truncated */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Click to collapse" : command}
        className="flex w-full items-center justify-between gap-2 bg-[var(--surface-base)] px-2.5 py-1.5 text-left font-mono text-xs text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)] hover:text-[var(--text-strong)]"
      >
        <span className={`min-w-0 flex-1 ${expanded ? "whitespace-pre-wrap break-all" : "truncate"}`}>
          <span className="text-[var(--text-weaker)]">$</span> {command}
        </span>
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
            {running && <Spinner className="size-3" />}
            {status}
          </span>
          <ChevronRight className={`size-3 shrink-0 text-[var(--text-weaker)] transition-transform ${expanded ? "rotate-90" : ""}`} />
        </span>
      </button>
      {/* Output: same block while running (poll-streamed) and after exit. Capped at 10 lines collapsed, click header or here to expand. */}
      {running && !hasOutput && (
        <div className="px-2.5 py-2 font-mono text-xs text-[var(--text-weaker)]">Running…</div>
      )}
      {hasOutput && (
        <div className="border-t border-[var(--border-weak-base)]">
          <pre
            onClick={() => shouldCollapse && setExpanded((v) => !v)}
            className={`max-h-64 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-xs leading-relaxed text-[var(--text-base)] ${shouldCollapse ? "cursor-pointer hover:bg-[color:var(--surface-base-hover)]" : ""}`}
            title={shouldCollapse ? (expanded ? "Click to collapse" : "Click to expand full output") : undefined}
          >
            {displayOutput}
            {!showAll && shouldCollapse && "\n…"}
            {truncated && <span className="text-[var(--text-weaker)]"> (truncated)</span>}
          </pre>
        </div>
      )}
      {!hasOutput && !running && (
        <div className="border-t border-[var(--border-weak-base)] px-2.5 py-2 font-mono text-xs text-[var(--text-weaker)]">(no output)</div>
      )}
    </div>
  );
}

function CompactionCard({
  label,
  reason,
  summary,
  recent,
  running,
}: {
  label: string;
  reason: string;
  summary?: string;
  recent?: string;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = !!summary && summary.length > 400;
  const showSummary = !shouldCollapse || expanded ? summary : summary ? `${summary.slice(0, 400).trim()}…` : undefined;
  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-lg border border-[var(--border-weak-base)] bg-[var(--background-strong)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 bg-[var(--surface-base)] px-2.5 py-1.5 text-left text-xs text-[var(--text-weak)] transition-colors hover:bg-[color:var(--surface-base-hover)]"
      >
        <span className="flex items-center gap-1.5 font-medium text-[var(--text-strong)]">
          {running && <Spinner className="size-3" />}
          {label}
          <span className="font-normal text-[var(--text-weaker)]">{reason}</span>
        </span>
        {shouldCollapse && <ChevronRight className={`ml-auto size-3 shrink-0 text-[var(--text-weaker)] transition-transform ${expanded ? "rotate-90" : ""}`} />}
      </button>
      {showSummary && (
        <div className="border-t border-[var(--border-weak-base)] px-2.5 py-2 text-xs leading-relaxed text-[var(--text-base)] whitespace-pre-wrap">
          {showSummary}
          {shouldCollapse && !expanded && (
            <button type="button" onClick={() => setExpanded(true)} className="ml-1 cursor-pointer text-[var(--text-interactive-base)] hover:underline">
              show more
            </button>
          )}
        </div>
      )}
      {recent && (
        <div className="border-t border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] px-2.5 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-weaker)]">Recent context</div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--text-weak)]">{recent}</pre>
        </div>
      )}
    </div>
  );
}

function AssistantView({ message, compact, showCopy, copyText }: { message: AssistantMessage; compact: boolean; showCopy?: boolean; copyText?: string }) {
  const showTimestamps = useTimestamps();
  return (
    <Row align="left">
      <div className="group w-full space-y-2.5 text-sm leading-relaxed">
        {!compact && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-weak)]">
            <span className="font-medium text-[var(--text-strong)]">{message.agent ?? "assistant"}</span>
            {message.model && (
              <span className="font-mono text-[var(--text-weaker)]">
                {formatModelRef(message.model)}
              </span>
            )}
            {showTimestamps && <Target id="message.timestamp" time={message.time.created} />}
            {message.cost !== undefined && message.cost > 0 && <Target id="message.cost" cost={message.cost} />}
            {message.tokens && <Target id="message.tokens" tokens={message.tokens} />}
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
          return message.content.map((part, partIndex) => {
            const key =
              part.type === "tool"
                ? `${message.id}:tool:${part.id}`
                : `${message.id}:${part.type}:${ordinal[part.type]++}`;
            return (
              <Fragment key={key}>
                <MessagePart stateKey={key} part={part} messageID={message.id} partIndex={partIndex} message={message} />
                <PartDecorations message={message} part={part as unknown as ToolPart} partIndex={partIndex} />
              </Fragment>
            );
          });
        })()}
        {showCopy && copyText && (
          <div className="flex justify-start pt-1">
            <Target id="message.copyButton" text={copyText} variant="assistant" />
          </div>
        )}
      </div>
    </Row>
  );
}

export function MessagePart({
  part,
  stateKey,
  messageID,
  partIndex,
  message,
}: {
  part: ToolPart | { type: "text"; text: string } | { type: "reasoning"; text: string };
  stateKey?: string;
  messageID?: string;
  partIndex?: number;
  message?: MessageInfo;
}) {
  if (part.type === "reasoning") return <ReasoningBlock text={part.text} stateKey={stateKey} />;
  if (part.type === "tool") return <Target id="tool.card" part={part} stateKey={stateKey} />;
  if (!part.text || !part.text.trim()) return null;
  // Leaf target (R-C1/F1): React-side alternative to DOM injection. Core
  // default below (`message.markdown`) renders <Markdown> byte-identically
  // when unwrapped — TargetErrorBoundary adds no DOM. Extra props
  // (messageID/partIndex/message) are for extensions only; core ignores them.
  // DOM remains the last resort for portals/iframes outside the React tree.
  return <Target id="message.markdown" text={part.text} messageID={messageID} partIndex={partIndex} message={message} />;
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

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3): every tweakable leaf is its own registered
// unit with meaningful props. Parents stay core's — a wrap on one leaf
// (e.g. the timestamp format) still receives maintainer redesigns of the
// header, the token readout, and the cost badge around it.
// ---------------------------------------------------------------------------
autoRegister({
  "message.markdown": (p) => <Markdown text={p.text as string} />,
  "message.timestamp": (p) => <TimestampIfWanted time={p.time as number} />,
  "message.tokens": (p) => (
    <Tokens tokens={p.tokens as NonNullable<AssistantMessage["tokens"]>} />
  ),
  "message.cost": (p) => <CostBadge cost={p.cost as number} />,
  "message.copyButton": (p) =>
    p.variant === "assistant" ? (
      <AssistantCopyButton text={p.text as string} />
    ) : (
      <UserCopyButton text={p.text as string} />
    ),
});
