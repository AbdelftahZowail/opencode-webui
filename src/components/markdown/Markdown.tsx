/**
 * Core markdown renderer — the single ReactMarkdown pipeline for the
 * transcript. Everything markdown-shaped lives here so `MessageItem` stays
 * about message chrome:
 *
 *  - Tables (`components.table/th/td`) — a first-class framed grid that
 *    scrolls horizontally INSIDE its own container, honoring GFM alignment.
 *  - Tilde fences (`~~~html/svg/pdf/image` + `live-*` aliases) — live inline
 *    previews in a sandboxed iframe / native viewer. Backtick fences always
 *    stay code; the two are told apart by the raw document offset of the
 *    fence (see `fence.ts`).
 *  - Shelf link chips — `/api/shelf/file/…` links become a small file chip.
 *
 * The whole thing is one memoized component (`Markdown`) so a streaming
 * parent commit never re-parses unchanged history.
 */
import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openImage } from "../ImageViewer";
import { Table, Th, Td } from "./Table";
import { ShelfChip } from "./ShelfChip";
import { PreviewBlock, PreviewPausedBlock } from "./PreviewBlock";
import { getLiveFence } from "./fence";
import { useMarkdownRendering } from "./controls";

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

/** Fenced-code visual, used whenever a `pre` is NOT a live tilde fence. */
const PRE_CLS =
  "my-2 max-w-full overflow-x-auto rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-inset-base)] p-3 font-mono text-xs text-[var(--text-base)] [&_code]:bg-transparent [&_code]:p-0 [&_code]:break-normal [&_code]:text-inherit";

/** Inline codespan visual. */
const INLINE_CODE_CLS =
  "rounded bg-[var(--surface-base)] px-1 py-0.5 font-mono text-[0.85em] break-all text-[var(--text-base)]";

/**
 * The markdown body. `text` is the raw markdown source; the raw string is also
 * what live fences need for their offset check, so it is threaded through a
 * per-render context-free prop instead of a module variable (streaming may
 * render several bodies concurrently).
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const enabled = useMarkdownRendering();
  const components = useMemo(
    () => buildComponents(text, enabled),
    [text, enabled],
  );
  return (
    <div
      onClick={(e) => {
        // Markdown images (`![..](..)`, incl. engine-emitted data: URIs) open
        // in the same viewer as attachments instead of navigating away.
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLImageElement && t.src) {
          e.preventDefault();
          openImage(t.src, t.alt);
        }
      }}
      className={`min-w-0 text-sm leading-relaxed break-words text-[var(--text-base)] [&_h1]:text-[var(--text-strong)] [&_h2]:text-[var(--text-strong)] [&_h3]:text-[var(--text-strong)] [&_strong]:text-[var(--text-strong)] [&_a:not([data-oc-shelf-chip])]:text-[var(--text-interactive-base)] [&_a:not([data-oc-shelf-chip])]:underline [&_a:not([data-oc-shelf-chip])]:underline-offset-2 [&_a]:break-all [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-weak-base)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-weak)] [&_img]:max-h-96 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-[color:var(--border-weak-base)]`}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

type Components = NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>;

function buildComponents(text: string, renderingEnabled: boolean): Components {
  return {
    table: (props) => <Table {...props} />,
    th: (props) => <Th {...props} />,
    td: (props) => <Td {...props} />,
    a: ShelfLink,
    pre: (props) => <PreOrPreview {...props} text={text} renderingEnabled={renderingEnabled} />,
    code: Code,
  };
}

/**
 * A `pre` is either a live tilde fence (→ PreviewBlock, by default) or plain
 * fenced code (→ the normal styled block). A fence's raw offset in the source
 * string is what distinguishes `~~~` from ```; ReactMarkdown's default `pre`
 * shape (nested `code`) is preserved for the plain case so existing CSS-style
 * targeting keeps working.
 */
function PreOrPreview({
  text,
  renderingEnabled,
  node,
  children,
  ...rest
}: ComponentPropsWithoutRef<"pre"> & { text: string; renderingEnabled: boolean; node?: unknown }) {
  const offset = (node as { position?: { start?: { offset?: number } } } | undefined)?.position?.start?.offset;
  const live = useMemo(() => getLiveFence(text, offset), [text, offset]);
  if (live) {
    // A live tilde fence: the browser handles the tilde convention. When the
    // user has paused previews, show the source with a clear "paused" frame
    // instead of silently dropping the convention.
    return renderingEnabled ? <PreviewBlock info={live} /> : <PreviewPausedBlock info={live} />;
  }
  return (
    <pre {...rest} className={PRE_CLS}>
      {children}
    </pre>
  );
}

/** Inline and fenced code. Fenced code arrives with a `language-*` class. */
function Code({ className, children, node, ...rest }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const isBlock = typeof className === "string" && className.includes("language-");
  if (isBlock) {
    return (
      <code {...rest} className={className}>
        {children}
      </code>
    );
  }
  return (
    <code {...rest} className={`${INLINE_CODE_CLS} ${className ?? ""}`}>
      {children}
    </code>
  );
}

/**
 * A markdown `<a>`: shelf links become a chip; everything else stays a normal
 * link. Anchor behaviour is preserved so extension hooks and copy affordances
 * keep finding an `<a>`.
 */
function ShelfLink({ href, children, node, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  if (typeof href === "string" && href.startsWith("/api/shelf/file/")) {
    return <ShelfChip href={href}>{children}</ShelfChip>;
  }
  return (
    <a {...rest} href={href}>
      {children}
    </a>
  );
}
