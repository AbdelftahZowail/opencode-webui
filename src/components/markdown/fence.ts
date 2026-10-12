/**
 * Live tilde-fence detection — the `~~~` convention.
 *
 * The webui renders `~~~lang` fences as live inline previews while ``` fences
 * always stay code. Both reach react-markdown as `code.language-<lang>`, so the
 * fence character itself has to be recovered from the raw source. Every mdast
 * node carries a `position.start.offset` (raw document offset), and the fence
 * marker is the first run of ``` or `~~~` at or after it — a read of at most a
 * few characters, so this is O(1) per fence.
 *
 * Detection runs at render time (react-markdown components mapping) rather
 * than as a remark plugin: one React component per fence, no AST rewriting,
 * crash-isolated by React, and the raw source is already available as the
 * `text` prop threaded from `Markdown`.
 */
export type LiveKind = "html" | "svg" | "pdf" | "image";

export type FenceMarker = "`" | "~";

/** A parsed fenced block recovered from the raw markdown source. */
export interface FencedBlockInfo {
  marker: FenceMarker;
  /** Lowercased first info-string token (may be empty for a bare fence). */
  lang: string;
  /** Full trimmed info-string (language token plus any meta); "" for a bare fence. */
  info: string;
  /** Raw fence body, without the trailing newline. */
  source: string;
}

/** Tilde-fence language tags that trigger LIVE inline rendering. */
const LIVE_KINDS: Record<string, LiveKind> = {
  html: "html",
  live: "html",
  "live-html": "html",
  "live-js": "html",
  svg: "svg",
  "live-svg": "svg",
  pdf: "pdf",
  "live-pdf": "pdf",
  image: "image",
  "live-image": "image",
  "live-img": "image",
};

export interface LiveFenceInfo {
  lang: string;
  kind: LiveKind;
  /** Raw fence body (no trailing newline handling by the consumer). */
  source: string;
}

/** Language + exact source of a fenced block, derived from its rendered AST. */
export interface CodeBlockInfo {
  lang: string;
  source: string;
}

/** Minimal structural view of the hast nodes react-markdown passes through. */
interface HastLike {
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastLike[];
}

/**
 * Read a fenced code block's language and source from its rendered `<pre>`
 * hast node. Using the AST (rather than re-parsing the raw document) is what
 * makes nested fences correct: a fence inside a blockquote or list item carries
 * `> ` / indent markers in the raw source, but the node's text is already
 * marker-free. Returns null when the node is not a fenced `pre > code`.
 */
export function getCodeBlockInfo(node: unknown): CodeBlockInfo | null {
  const pre = node as HastLike | undefined;
  if (!pre || pre.tagName !== "pre") return null;
  const code = pre.children?.find((child) => child.tagName === "code");
  if (!code) return null;
  const raw = code.properties?.className;
  const classes = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/\s+/)
      : [];
  const langClass = classes.find((cls) => cls.startsWith("language-"));
  const lang = langClass ? langClass.slice("language-".length).toLowerCase() : "";
  const source = (code.children ?? [])
    .map((child) => child.value ?? "")
    .join("")
    .replace(/\r?\n$/, "");
  return { lang, source };
}

const FENCE_HEADER_RE = /^(`{3,}|~{3,})([^\n]*)\r?\n/;

/**
 * Recover a fenced block (either ` or ~) from the raw source at `offset`.
 * Returns null for indented code, for offsets that do not point at a fence, and
 * whenever the offset check cannot be made — callers then keep the safe default
 * (render the source as-is).
 */
export function getFencedBlock(source: string, offset: number | undefined): FencedBlockInfo | null {
  if (typeof offset !== "number" || offset < 0 || offset >= source.length) return null;
  const rest = source.slice(offset);
  const header = FENCE_HEADER_RE.exec(rest);
  if (!header) return null;
  const fence = header[1]!;
  const marker: FenceMarker = fence.startsWith("~") ? "~" : "`";
  const info = (header[2] ?? "").trim();
  const lang = info.split(/\s+/)[0]?.toLowerCase() ?? "";
  const bodyStart = offset + header[0].length;
  const body = source.slice(bodyStart);
  // Closing fence: a line that is only the same fence character (GFM allows
  // trailing spaces).
  const close = marker === "~" ? /(?:^|\n)(~{3,})[ \t]*(?:\r?\n|$)/ : /(?:^|\n)(`{3,})[ \t]*(?:\r?\n|$)/;
  const closeMatch = close.exec(body);
  const value = closeMatch ? body.slice(0, closeMatch.index === 0 ? 0 : closeMatch.index + 1) : body;
  return { marker, lang, info, source: value.replace(/\r?\n$/, "") };
}

/**
 * Resolve a fenced block to live info. Returns null for backtick fences, for
 * unknown languages, and whenever the offset check cannot be made (in which
 * case the safe default — code — wins).
 */
export function getLiveFence(source: string, offset: number | undefined): LiveFenceInfo | null {
  const block = getFencedBlock(source, offset);
  if (!block || block.marker !== "~") return null;
  const kind = LIVE_KINDS[block.lang];
  if (!kind) return null;
  return { lang: block.lang, kind, source: block.source };
}
