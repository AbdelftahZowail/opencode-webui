#!/usr/bin/env bun
/**
 * `check:ext <dir>` — extension pre-flight, no browser (B-T1/T2 related).
 *
 *   bun scripts/check-ext.ts <extension-dir>
 *
 * Catches F4-class failures in seconds instead of model round-trips:
 *
 *   manifest   manifest.json parses; id present non-empty (+ matches the
 *              folder name — the loader falls back to the dir name, so a
 *              mismatch is a WARN); version present semver-ish (WARN if not)
 *   entries    at least one stratum entry exists: index.tsx/index.ts/
 *              main.tsx/main.ts (browser), dom.ts (DOM), server.ts or
 *              server/index.ts (proxy), engine/ (payload)
 *   engine     when engine/ exists: package.json parses; index.js exists and
 *              statically exports the v2 `{ id, setup }` shape (CJS
 *              module.exports / ESM default-export-with-setup both pass) —
 *              the loader rejects anything else at boot. Hint-only payloads
 *              (default-export fn, no tools — the rich-render shape) pass
 *              with a WARN. Tool execute paths resolving a bare string are
 *              flagged (must be `{ output }`); system hints pushing `{text}`
 *              without `{ type: "text" }` are flagged.
 *   bridge     index/dom bundle SOURCES contain no runtime `src/` imports
 *              (`import type` is erased at build and safe). A runtime src/
 *              import works in-repo (same build) but breaks external copies
 *              (R-F4) — WARN, not FAIL.
 *
 * Exit 0 = no FAILs (WARNs allowed); exit 1 = at least one FAIL.
 * Read-only: never writes, never spawns. New file only (package.json wiring
 * is the parent's: add `"check:ext": "bun run scripts/check-ext.ts"`).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type Level = "PASS" | "FAIL" | "WARN" | "SKIP";
interface Row {
  check: string;
  level: Level;
  detail: string;
}

const BROWSER_CANDIDATES = ["index.tsx", "index.ts", "main.tsx", "main.ts"];
const SERVER_CANDIDATES = ["server.ts", join("server", "index.ts")];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

function main(): number {
  const rows: Row[] = [];
  const dir = process.argv[2] ? resolve(process.argv[2]) : null;
  if (!dir) {
    console.error("usage: bun scripts/check-ext.ts <extension-dir>");
    return 2;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`check:ext: not a directory: ${dir}`);
    return 2;
  }
  const folderName = basename(dir);

  // --- manifest -----------------------------------------------------------
  let manifest: Record<string, unknown> | null = null;
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    rows.push({ check: "manifest present", level: "FAIL", detail: "manifest.json missing" });
  } else {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("top level is not an object");
      }
      manifest = parsed as Record<string, unknown>;
      rows.push({ check: "manifest parses", level: "PASS", detail: "manifest.json is a JSON object" });
    } catch (err) {
      rows.push({
        check: "manifest parses",
        level: "FAIL",
        detail: `manifest.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (manifest) {
    const id = manifest.id;
    if (typeof id !== "string" || id.length === 0) {
      rows.push({ check: "manifest id", level: "FAIL", detail: "`id` missing or empty (loader falls back to folder name — set it explicitly)" });
    } else if (id !== folderName) {
      rows.push({ check: "manifest id", level: "WARN", detail: `id "${id}" ≠ folder "${folderName}" (both work; the manifest id wins, the dir name is the fallback)` });
    } else {
      rows.push({ check: "manifest id", level: "PASS", detail: `id "${id}"` });
    }
    const version = manifest.version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
      rows.push({ check: "manifest version", level: "WARN", detail: `\`version\` missing or not semver-ish (got ${JSON.stringify(version) ?? "∅"})` });
    } else {
      rows.push({ check: "manifest version", level: "PASS", detail: `version "${version}"` });
    }
    for (const field of ["name", "description"]) {
      if (typeof manifest[field] !== "string" || (manifest[field] as string).length === 0) {
        rows.push({ check: `manifest ${field}`, level: "WARN", detail: `\`${field}\` missing (cosmetic, but the catalog reads it)` });
      }
    }
    if (manifest.disabled !== undefined && manifest.disabled !== true && manifest.disabled !== false) {
      rows.push({ check: "manifest disabled", level: "WARN", detail: `\`disabled\` should be boolean true/false (got ${JSON.stringify(manifest.disabled)})` });
    }
  }

  // --- entry presence -------------------------------------------------------
  const foundBrowser = BROWSER_CANDIDATES.find((f) => existsSync(join(dir, f))) ?? null;
  const foundDom = existsSync(join(dir, "dom.ts"));
  const foundServer = SERVER_CANDIDATES.find((f) => existsSync(join(dir, f))) ?? null;
  const foundEngine = existsSync(join(dir, "engine")) && statSync(join(dir, "engine")).isDirectory();
  const strata = [
    foundBrowser ? `browser:${foundBrowser}` : null,
    foundDom ? "dom:dom.ts" : null,
    foundServer ? `proxy:${foundServer}` : null,
    foundEngine ? "engine:engine/" : null,
  ].filter((s): s is string => s !== null);
  if (strata.length === 0) {
    rows.push({
      check: "entry presence",
      level: "FAIL",
      detail: `no stratum entry (want one of: ${BROWSER_CANDIDATES.join("/")} · dom.ts · server.ts · engine/) — the folder would load as nothing`,
    });
  } else {
    rows.push({ check: "entry presence", level: "PASS", detail: strata.join(" + ") });
  }

  // --- engine shape (static only — never executed) ---------------------------
  if (foundEngine) {
    const engDir = join(dir, "engine");
    const pkgPath = join(engDir, "package.json");
    if (!existsSync(pkgPath)) {
      rows.push({ check: "engine package.json", level: "WARN", detail: "engine/package.json absent (conventional metadata; the loader resolves index.js directly — proven loadable without it)" });
    } else {
      try {
        const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (!pkg || typeof pkg !== "object") throw new Error("not an object");
        rows.push({ check: "engine package.json", level: "PASS", detail: `name "${(pkg as Record<string, unknown>).name ?? "?"}"` });
      } catch (err) {
        rows.push({ check: "engine package.json", level: "FAIL", detail: `unparseable: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    const entryJs = join(engDir, "index.js");
    const entryCjs = join(engDir, "index.cjs");
    const entryFile = existsSync(entryJs) ? entryJs : existsSync(entryCjs) ? entryCjs : null;
    if (!entryFile) {
      rows.push({ check: "engine index", level: "FAIL", detail: "engine/index.js missing (loader resolves index.js as the entrypoint)" });
    } else {
      const src = stripComments(readFileSync(entryFile, "utf8"));
      const hasCjsIdSetup =
        /module\.exports\s*=\s*\{[^}]*\bid\b[^}]*\bsetup\b[^}]*\}/s.test(src) ||
        /module\.exports\s*=\s*\{[^}]*\bsetup\b[^}]*\bid\b[^}]*\}/s.test(src) ||
        (/module\.exports\.\s*id\s*=/.test(src) && /module\.exports\.\s*setup\s*=/.test(src)) ||
        (/(^|[^.\w])exports\.\s*id\s*=/.test(src) && /(^|[^.\w])exports\.\s*setup\s*=/.test(src));
      const hasEsmSetup = /export\s+default\s*\{[^}]*\bsetup\b/s.test(src);
      if (hasCjsIdSetup || hasEsmSetup) {
        rows.push({ check: "engine export shape", level: "PASS", detail: `v2 { id, setup } (${entryFile.split("/").pop()}, ${hasCjsIdSetup ? "CJS" : "ESM"} static match)` });
      } else if (/export\s+default/.test(src)) {
        rows.push({
          check: "engine export shape",
          level: "WARN",
          detail: "default export without a static { id, setup } match — hint-only payload (rich-render shape) is fine, but a tools payload in this shape is rejected at boot (v1 {server}/named-export → “must export a default definition with an id and an effect or setup function”)",
        });
      } else {
        rows.push({
          check: "engine export shape",
          level: "FAIL",
          detail: "no static { id, setup } export found — the loader rejects this at boot (“must export a default definition with an id and an effect or setup function”)",
        });
      }
      // Tool-result + hint contracts are checked over ALL engine sources:
      // shells delegate (brother-agent's execute lives in definitions.cjs,
      // returning { output } there), so index.js alone gives false WARNs.
      const engSources: string[] = [];
      {
        try {
          for (const f of readdirSync(engDir)) {
            if (/\.(js|cjs|mjs)$/.test(f) && !/node_modules/.test(f)) {
              try {
                engSources.push(stripComments(readFileSync(join(engDir, f), "utf8")));
              } catch {
                /* unreadable — skip */
              }
            }
          }
        } catch {
          /* engine dir unreadable — index.js findings stand alone */
        }
      }
      const engAll = engSources.join("\n");
      // Tool-result contract: execute paths must resolve { output }, never a bare string.
      if (/\bexecute\b/.test(engAll) || /tools\.add/.test(engAll)) {
        if (/\{\s*output\s*:/.test(engAll)) {
          rows.push({ check: "engine tool results", level: "PASS", detail: "`{ output }` result shape present (across engine sources)" });
        } else {
          rows.push({
            check: "engine tool results",
            level: "WARN",
            detail: "tool registration found but no `{ output: … }` — a bare-string result fails validation (`Unknown tool` in the transcript)",
          });
        }
      } else {
        rows.push({ check: "engine tool results", level: "SKIP", detail: "no tool registration (hint-only payload)" });
      }
      // System-hint contract: pushing an OBJECT part needs { type: "text" }.
      // (Pushing a bare string/variable is the other seam's shape — only an
      // object literal with `text` but no `type` is flagged.)
      {
        const pushes = [...engAll.matchAll(/\.push\(\s*\{[^)]*?\}\s*\)/gs)].map((m) => m[0]);
        const badPush = pushes.find((p) => /text/.test(p) && !/type\s*:/.test(p));
        if (badPush) {
          rows.push({
            check: "engine system hint",
            level: "WARN",
            detail: `pushes a system part with \`text\` but no \`type\` — a bare {text} fails the whole session drain (schema MissingKey): ${badPush.slice(0, 120)}`,
          });
        } else if (/system/.test(engAll) && /\.push\(/.test(engAll)) {
          rows.push({ check: "engine system hint", level: "PASS", detail: "system pushes carry `{ type: \"text\" }` (or a non-object payload for the string seam)" });
        } else {
          rows.push({ check: "engine system hint", level: "SKIP", detail: "no system-prompt hook detected" });
        }
      }
      // tools.* namespace reminder (static signal only).
      if (/tools\.add/.test(src) && !/["']tools\./.test(src)) {
        rows.push({
          check: "engine tool namespace",
          level: "SKIP",
          detail: "tools registered bare (correct) — the MODEL lists them as `tools.<name>`; match on the prefixed name",
        });
      }
    }
  }

  // --- bridge-only imports (index/dom bundle sources) -------------------------
  for (const rel of [...BROWSER_CANDIDATES, "dom.ts"]) {
    const file = join(dir, rel);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    const bad: string[] = [];
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/^\s*import\s+type\b/.test(code)) return; // erased at build — safe
      const m = /(?:import|export)[^"']*from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\)/.exec(code);
      const spec = m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
      if (/(^|\/|\.)src\//.test(spec) || spec.startsWith("@/") || spec.startsWith("src/")) {
        bad.push(`${i + 1}: ${spec}`);
      }
    });
    if (bad.length > 0) {
      rows.push({
        check: `bridge-only ${rel}`,
        level: "WARN",
        detail: `runtime src/ import(s) break external copies (R-F4) — use window.__opencodeUI: ${bad.join("; ").slice(0, 300)}`,
      });
    } else {
      rows.push({ check: `bridge-only ${rel}`, level: "PASS", detail: "no runtime src/ imports" });
    }
  }

  // --- report ------------------------------------------------------------------
  const width = Math.max(...rows.map((r) => r.check.length), 20);
  console.log(`\n=== check:ext ${dir} ===`);
  for (const r of rows) {
    console.log(`${r.level.padEnd(4)} ${r.check.padEnd(width)}  ${r.detail}`);
  }
  const fails = rows.filter((r) => r.level === "FAIL").length;
  const warns = rows.filter((r) => r.level === "WARN").length;
  console.log(`\nRESULT: ${fails} fail · ${warns} warn → exit ${fails > 0 ? 1 : 0}`);
  return fails > 0 ? 1 : 0;
}

process.exit(main());
