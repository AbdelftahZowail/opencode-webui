import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, ChevronRight, Paperclip, User } from "lucide-react";
import type {
  AssistantMessage,
  MessageInfo,
  ToolContent,
  ToolPart,
} from "../api/types";
import { ToolCard } from "./ToolCard";
import { Marker, MarkerContent } from "./ui/marker";
import { getPrefs, subscribePrefs } from "../prefs";

export function MessageItem({ message, compact = false }: { message: MessageInfo; compact?: boolean }) {
  switch (message.type) {
    case "user":
      return (
        <Row align="right">
          <div className="max-w-[85%]">
            <div className="flex items-center justify-end gap-1.5 text-xs text-[var(--text-weak)]">
              <User className="size-3.5" />
              You
            </div>
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
          </div>
        </Row>
      );
    case "shell":
      return (
        <Row>
          <ShellCard command={message.command} status={message.status} />
        </Row>
      );
    case "agent-switched":
      return <Note>Agent switched to <b>{message.agent}</b></Note>;
    case "model-switched":
      return <Note>Model switched to <b>{message.model.providerID}/{message.model.id}</b></Note>;
    case "location-switched":
      return <Note>Moved to <b>{message.location.directory}</b></Note>;
    case "compaction":
      return <Note>{message.status === "completed" ? "Conversation compacted" : message.status === "failed" ? "Compaction failed" : "Compacting…"}</Note>;
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

function ShellCard({ command, status }: { command: string; status: string }) {
  const statusColor =
    status === "running"
      ? "text-[var(--surface-warning-strong)]"
      : status === "completed"
        ? "text-[var(--text-on-success-base)]"
        : status === "error"
          ? "text-[var(--text-on-critical-base)]"
          : "text-[var(--text-weak)]";
  return (
    <div className="w-full max-w-[85%] overflow-hidden rounded-md border border-[var(--border-weak-base)]">
      <div className="flex items-center justify-between gap-2 bg-[var(--surface-base)] px-3 py-1.5 font-mono text-xs text-[var(--text-weak)]">
        <span className="truncate">$ {command}</span>
        <span className={`shrink-0 ${statusColor}`}>{status}</span>
      </div>
    </div>
  );
}

function AssistantView({ message, compact }: { message: AssistantMessage; compact: boolean }) {
  return (
    <Row align="left">
      <div className="w-full space-y-2.5 text-sm leading-relaxed">
        {!compact && (
          <div className="flex items-center gap-2 text-xs text-[var(--text-weak)]">
            <span className="font-medium text-[var(--text-strong)]">{message.agent ?? "assistant"}</span>
            {message.model && (
              <span className="font-mono text-[var(--text-weaker)]">
                {message.model.providerID}/{message.model.id}
                {message.model.variant ? `@${message.model.variant}` : ""}
              </span>
            )}
            {message.cost !== undefined && message.cost > 0 && (
              <span className="font-mono text-[var(--text-weaker)]">${message.cost.toFixed(4)}</span>
            )}
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
        {message.content.map((part, i) => (
          <MessagePart key={i} part={part} />
        ))}
      </div>
    </Row>
  );
}

export function MessagePart({ part }: { part: ToolPart | { type: "text"; text: string } | { type: "reasoning"; text: string } }) {
  if (part.type === "reasoning") return <ReasoningBlock text={part.text} />;
  if (part.type === "tool") return <ToolCard part={part} />;
  if (!part.text || !part.text.trim()) return null;
  return <Markdown text={part.text} />;
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [showReasoning, setShowReasoning] = useState(getPrefs().showReasoning);
  useEffect(() => subscribePrefs(() => setShowReasoning(getPrefs().showReasoning)), []);
  if (!text) return null;
  if (!showReasoning) {
    return (
      <Marker variant="separator">
        <MarkerContent className="text-xs text-[var(--text-weak)]">Reasoning hidden</MarkerContent>
      </Marker>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
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

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed text-[var(--text-base)] [&_h1]:text-[var(--text-strong)] [&_h2]:text-[var(--text-strong)] [&_h3]:text-[var(--text-strong)] [&_strong]:text-[var(--text-strong)] [&_a]:text-[var(--text-interactive-base)] [&_a]:underline [&_a]:underline-offset-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-weak-base)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-weak)] [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[var(--border-weak-base)] [&_pre]:bg-[var(--surface-inset-base)] [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:text-[var(--text-base)] [&_code]:rounded [&_code]:bg-[var(--surface-base)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-[var(--text-base)] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
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
