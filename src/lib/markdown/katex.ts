/**
 * KaTeX loader (R2) — the heavy half.
 *
 * Reached only through a dynamic `import("./katex")`. The KaTeX stylesheet (and
 * its fonts) is imported here too, so it is part of the same lazy chain and is
 * fetched on the first math block instead of on first paint. `renderLatex`
 * throws on malformed input (`throwOnError: true`) so the caller can fall back
 * to the plain source rather than render a broken half-glyph.
 */
type Katex = typeof import("katex").default;

let katexPromise: Promise<Katex> | null = null;

async function loadKatex(): Promise<Katex> {
  // CSS first: katex glyph spans are unstyled without it.
  await import("katex/dist/katex.min.css");
  katexPromise ??= import("katex").then((m) => m.default);
  return katexPromise;
}

/** Render display math from a ` ```latex ` fence to HTML. Throws on error. */
export async function renderLatex(source: string): Promise<string> {
  const katex = await loadKatex();
  return katex.renderToString(source, {
    displayMode: true,
    throwOnError: true,
    output: "htmlAndMathml",
  });
}
