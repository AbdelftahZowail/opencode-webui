/**
 * Extension-facing code-block renderer registry (R14).
 *
 * The core markdown pipeline routes a fenced block by its info-string through
 * this one seam. A renderer is just a `contribute` entry in the
 * "markdown.codeBlock" collection (AGENTS rule 3: widen an axis — a
 * collection, not a new kind), so it inherits the registry's ordering,
 * hot-swap, and peer composition for free.
 *
 * Resolution: `getContributions` sorts ascending by `order` (then id); the
 * FIRST contribution whose `languages` includes the lowercased fence language
 * wins. That ordering IS the override story — an extension takes over
 * `mermaid` by contributing at a lower order than the built-in
 * `markdown.mermaid` / `markdown.latex` entries (both order 100).
 *
 * The built-in consumers (R1 `CodeBlock`, R2 `MermaidBlock`/`LatexBlock`) use
 * this same seam, so shipping and extension code are one path.
 */
import type { ReactNode } from "react";
import {
  getContributions,
  getRegisteredIds,
  register,
  unregisterIds,
  type CodeBlockRenderContext,
  type CodeBlockRendererContribution,
} from "../../extensions/registry";

/** The collection id — contract (versioned like every target/collection id). */
export const CODE_BLOCK_COLLECTION = "markdown.codeBlock";

/**
 * The winning renderer for a fence language, or null when none claims it
 * (core then renders the syntax-highlighted `CodeBlock`). The language is
 * trimmed + lowercased before comparison.
 */
export function resolveCodeBlockRenderer(
  lang: string | undefined,
): CodeBlockRendererContribution | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  const contributions = getContributions<CodeBlockRendererContribution>(CODE_BLOCK_COLLECTION);
  for (const c of contributions) {
    const langs = c.item?.languages;
    if (!Array.isArray(langs)) continue;
    // Defensive: a malformed RAW contribution (`languages: [123]`) must not
    // throw here — the resolver runs outside the core render try/catch, so a
    // throw would blank the message part. Non-string entries are ignored.
    if (langs.some((l) => typeof l === "string" && l.trim().toLowerCase() === key)) return c.item;
  }
  return null;
}

export interface RegisterCodeBlockRendererOptions {
  /** Stable entry id. Omit to derive a unique one (the returned unregister still works). */
  id?: string;
  /** Lower runs first; the first match overrides. Defaults to 100. */
  order?: number;
}

let derivedSeq = 0;
function deriveId(languages: string[]): string {
  const base = `markdown.codeBlock.auto.${languages.join("+") || "any"}`;
  if (!getRegisteredIds().includes(base)) return base;
  let id = base;
  do {
    id = `${base}#${++derivedSeq}`;
  } while (getRegisteredIds().includes(id));
  return id;
}

/**
 * Register a fence renderer. The typed, extension-API-facing form of
 * `register({ kind:"contribute", collection:"markdown.codeBlock", … })`.
 * Returns an idempotent unregister that prunes exactly this entry.
 *
 * `languages` is one info-string or a list (matched case-insensitively).
 * A caller that passes no `id` gets a derived, collision-free one.
 */
export function registerCodeBlockRenderer(
  languages: string | string[],
  render: (ctx: CodeBlockRenderContext) => ReactNode,
  opts: RegisterCodeBlockRendererOptions = {},
): () => void {
  const normalized = (Array.isArray(languages) ? languages : [languages])
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const id = opts.id ?? deriveId(normalized);
  register({
    kind: "contribute",
    id,
    collection: CODE_BLOCK_COLLECTION,
    item: { languages: normalized, render } satisfies CodeBlockRendererContribution,
    order: opts.order ?? 100,
  });
  return () => unregisterIds([id]);
}
