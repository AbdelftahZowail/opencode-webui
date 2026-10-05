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

const FENCE_RE = /^(`{3,}|~{3,})/;

/** True when the fence that starts at `offset` is a tilde fence. */
function isTildeFenceAt(source: string, offset: number): boolean {
  if (offset < 0 || offset >= source.length) return false;
  const m = FENCE_RE.exec(source.slice(offset));
  return m !== null && m[1]!.startsWith("~");
}

/**
 * Resolve a fenced block to live info. Returns null for backtick fences, for
 * unknown languages, and whenever the offset check cannot be made (in which
 * case the safe default — code — wins).
 */
export function getLiveFence(source: string, offset: number | undefined): LiveFenceInfo | null {
  if (typeof offset !== "number" || offset < 0) return null;
  if (!isTildeFenceAt(source, offset)) return null;

  // Recover lang + body. The mdast node's own `lang`/`value` are not passed
  // through react-markdown's component props, so parse the raw fence here:
  // marker, info string, newline, then body up to the closing fence.
  const rest = source.slice(offset);
  const header = /^(~{3,})([^\n]*)\r?\n/.exec(rest);
  if (!header) return null;
  const lang = (header[2] ?? "").trim().split(/\s+/)[0]!.toLowerCase();
  const kind = LIVE_KINDS[lang];
  if (!kind) return null;
  const bodyStart = offset + header[0].length;
  const body = source.slice(bodyStart);
  // Closing fence: a line that is only tildes (GFM allows trailing spaces).
  const closeMatch = /(?:^|\n)(~{3,})[ \t]*(?:\r?\n|$)/.exec(body);
  const value = closeMatch ? body.slice(0, closeMatch.index === 0 ? 0 : closeMatch.index + 1) : body;
  return { lang, kind, source: value.replace(/\r?\n$/, "") };
}
