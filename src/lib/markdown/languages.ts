/**
 * Language catalogue for the fenced-code highlighter (R1).
 *
 * One entry per shiki grammar, expressed as a lazy loader so each grammar is
 * its own build chunk — a code block only pays for the language it uses. The
 * fence info-string is resolved through `ALIASES` before lookup, so common
 * spellings (`js`, `ts`, `py`, `c++`, `c#`, `sh`) reach the right grammar.
 *
 * This module is intentionally tiny and dependency-free: the markdown pipeline
 * imports `resolveLanguage`/`specialBlockKind` from the main bundle, while the
 * shiki engine itself stays behind `./shiki` (dynamic import).
 */
export const LANGUAGE_LOADERS = {
  javascript: () => import("shiki/langs/javascript.mjs").then((m) => m.default),
  typescript: () => import("shiki/langs/typescript.mjs").then((m) => m.default),
  jsx: () => import("shiki/langs/jsx.mjs").then((m) => m.default),
  tsx: () => import("shiki/langs/tsx.mjs").then((m) => m.default),
  json: () => import("shiki/langs/json.mjs").then((m) => m.default),
  jsonc: () => import("shiki/langs/jsonc.mjs").then((m) => m.default),
  json5: () => import("shiki/langs/json5.mjs").then((m) => m.default),
  python: () => import("shiki/langs/python.mjs").then((m) => m.default),
  rust: () => import("shiki/langs/rust.mjs").then((m) => m.default),
  go: () => import("shiki/langs/go.mjs").then((m) => m.default),
  java: () => import("shiki/langs/java.mjs").then((m) => m.default),
  c: () => import("shiki/langs/c.mjs").then((m) => m.default),
  cpp: () => import("shiki/langs/cpp.mjs").then((m) => m.default),
  csharp: () => import("shiki/langs/csharp.mjs").then((m) => m.default),
  "objective-c": () => import("shiki/langs/objective-c.mjs").then((m) => m.default),
  ruby: () => import("shiki/langs/ruby.mjs").then((m) => m.default),
  php: () => import("shiki/langs/php.mjs").then((m) => m.default),
  swift: () => import("shiki/langs/swift.mjs").then((m) => m.default),
  kotlin: () => import("shiki/langs/kotlin.mjs").then((m) => m.default),
  scala: () => import("shiki/langs/scala.mjs").then((m) => m.default),
  dart: () => import("shiki/langs/dart.mjs").then((m) => m.default),
  lua: () => import("shiki/langs/lua.mjs").then((m) => m.default),
  perl: () => import("shiki/langs/perl.mjs").then((m) => m.default),
  r: () => import("shiki/langs/r.mjs").then((m) => m.default),
  julia: () => import("shiki/langs/julia.mjs").then((m) => m.default),
  haskell: () => import("shiki/langs/haskell.mjs").then((m) => m.default),
  elixir: () => import("shiki/langs/elixir.mjs").then((m) => m.default),
  erlang: () => import("shiki/langs/erlang.mjs").then((m) => m.default),
  clojure: () => import("shiki/langs/clojure.mjs").then((m) => m.default),
  nix: () => import("shiki/langs/nix.mjs").then((m) => m.default),
  bash: () => import("shiki/langs/bash.mjs").then((m) => m.default),
  fish: () => import("shiki/langs/fish.mjs").then((m) => m.default),
  powershell: () => import("shiki/langs/powershell.mjs").then((m) => m.default),
  sql: () => import("shiki/langs/sql.mjs").then((m) => m.default),
  html: () => import("shiki/langs/html.mjs").then((m) => m.default),
  css: () => import("shiki/langs/css.mjs").then((m) => m.default),
  scss: () => import("shiki/langs/scss.mjs").then((m) => m.default),
  less: () => import("shiki/langs/less.mjs").then((m) => m.default),
  xml: () => import("shiki/langs/xml.mjs").then((m) => m.default),
  yaml: () => import("shiki/langs/yaml.mjs").then((m) => m.default),
  toml: () => import("shiki/langs/toml.mjs").then((m) => m.default),
  ini: () => import("shiki/langs/ini.mjs").then((m) => m.default),
  dockerfile: () => import("shiki/langs/dockerfile.mjs").then((m) => m.default),
  makefile: () => import("shiki/langs/makefile.mjs").then((m) => m.default),
  cmake: () => import("shiki/langs/cmake.mjs").then((m) => m.default),
  markdown: () => import("shiki/langs/markdown.mjs").then((m) => m.default),
  mdx: () => import("shiki/langs/mdx.mjs").then((m) => m.default),
  diff: () => import("shiki/langs/diff.mjs").then((m) => m.default),
  graphql: () => import("shiki/langs/graphql.mjs").then((m) => m.default),
  vue: () => import("shiki/langs/vue.mjs").then((m) => m.default),
  svelte: () => import("shiki/langs/svelte.mjs").then((m) => m.default),
  astro: () => import("shiki/langs/astro.mjs").then((m) => m.default),
  hcl: () => import("shiki/langs/hcl.mjs").then((m) => m.default),
  proto: () => import("shiki/langs/proto.mjs").then((m) => m.default),
  wasm: () => import("shiki/langs/wasm.mjs").then((m) => m.default),
  vim: () => import("shiki/langs/vim.mjs").then((m) => m.default),
  csv: () => import("shiki/langs/csv.mjs").then((m) => m.default),
  coffee: () => import("shiki/langs/coffee.mjs").then((m) => m.default),
  groovy: () => import("shiki/langs/groovy.mjs").then((m) => m.default),
  handlebars: () => import("shiki/langs/handlebars.mjs").then((m) => m.default),
} as const;

export type KnownLanguage = keyof typeof LANGUAGE_LOADERS;

/** Fence info-string aliases → catalogue key. */
const ALIASES: Record<string, KnownLanguage> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  "c#": "csharp",
  cs: "csharp",
  dotnet: "csharp",
  objc: "objective-c",
  "objectivec": "objective-c",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  hs: "haskell",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  console: "bash",
  ps: "powershell",
  ps1: "powershell",
  yml: "yaml",
  md: "markdown",
  gql: "graphql",
  terraform: "hcl",
  tf: "hcl",
  protobuf: "proto",
  docker: "dockerfile",
  make: "makefile",
  mk: "makefile",
  coffee: "coffee",
  coffeescript: "coffee",
  hbs: "handlebars",
};

/** Canonical catalogue key for a fence info-string, or null when unknown. */
export function resolveLanguage(lang: string | undefined): KnownLanguage | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase();
  if (!key) return null;
  const canonical = ALIASES[key] ?? key;
  return canonical in LANGUAGE_LOADERS ? (canonical as KnownLanguage) : null;
}

/** Block renderers keyed by fence info-string (R2), separate from highlighting. */
export type SpecialBlock = "mermaid" | "latex";

const SPECIAL_BLOCKS: Record<string, SpecialBlock> = {
  mermaid: "mermaid",
  mmd: "mermaid",
  latex: "latex",
  tex: "latex",
  math: "latex",
  katex: "latex",
};

export function specialBlockKind(lang: string | undefined): SpecialBlock | null {
  if (!lang) return null;
  return SPECIAL_BLOCKS[lang.trim().toLowerCase()] ?? null;
}
