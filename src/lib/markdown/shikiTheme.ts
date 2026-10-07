/**
 * The highlighter theme (R1).
 *
 * Colours are `var(--…)` design tokens, not hex: shiki emits them verbatim
 * into each token's inline `style`, so highlighted code follows the app palette
 * and any future theme change for free (the browser resolves the variable in
 * the transcript's context).
 *
 * The scope → token mapping intentionally borrows the same accents the rest of
 * the UI treats as text (`--text-interactive-base`, the `-strong` status
 * colours) so a code block reads as part of the app, not a foreign theme.
 */
export const OPENCODE_THEME_NAME = "opencode";

export const opencodeTheme = {
  name: OPENCODE_THEME_NAME,
  type: "dark" as const,
  colors: {
    "editor.background": "var(--surface-inset-base)",
    "editor.foreground": "var(--text-base)",
  },
  settings: [
    { settings: { foreground: "var(--text-base)", background: "var(--surface-inset-base)" } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "var(--text-weaker)", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new"], settings: { foreground: "var(--text-interactive-base)" } },
    { scope: ["string", "constant.other.symbol", "string.regexp", "punctuation.definition.string"], settings: { foreground: "var(--surface-success-strong)" } },
    { scope: ["constant.numeric", "constant.language", "constant.character", "support.constant"], settings: { foreground: "var(--surface-brand-base)" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call", "variable.function"], settings: { foreground: "var(--surface-info-strong)" } },
    { scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "support.type", "support.class", "storage.type.class"], settings: { foreground: "var(--surface-warning-strong)" } },
    { scope: ["entity.name.tag", "support.type.property-name", "meta.tag"], settings: { foreground: "var(--surface-critical-strong)" } },
    { scope: ["variable", "variable.other", "variable.parameter", "meta.definition.variable", "entity.other.attribute-name"], settings: { foreground: "var(--text-base)" } },
    { scope: ["constant.other.color", "support.constant.property-value"], settings: { foreground: "var(--surface-brand-base)" } },
    { scope: ["punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator"], settings: { foreground: "var(--text-weak)" } },
    { scope: ["markup.heading", "entity.name.section"], settings: { foreground: "var(--text-strong)", fontStyle: "bold" } },
    { scope: ["markup.bold"], settings: { foreground: "var(--text-strong)", fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { foreground: "var(--text-base)", fontStyle: "italic" } },
    { scope: ["markup.inserted", "diff.inserted"], settings: { foreground: "var(--text-diff-add-base)" } },
    { scope: ["markup.deleted", "diff.deleted"], settings: { foreground: "var(--text-diff-delete-base)" } },
  ],
};
