#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
/**
 * Regenerates skills/webui/SKILL.md from ui-extensions/README.md.
 *
 * The skill IS the agent-context injection: its frontmatter description is
 * always visible to every opencode agent (bodies load on demand), so the
 * description makes agents aware of the webui without bloat. The extension
 * tables in the body are EXTRACTED from ui-extensions/README.md so they can
 * never drift from the authoring guide.
 *
 * Deterministic: extraction follows source document order, output has no
 * timestamps, and re-running produces byte-identical output.
 *
 * Usage: bun run gen:skill
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "ui-extensions", "README.md");
const TARGET = join(ROOT, "skills", "webui", "SKILL.md");

/**
 * ONE tight line that triggers when: the user mentions the webui/web
 * frontend, asks about webui extensions, or wants to report a webui bug.
 * Keep under ~200 chars — this is the always-visible injection.
 */
const DESCRIPTION =
  "opencode-webui — the browser frontend for the OpenCode engine. Load when the user mentions the webui/web frontend, asks about webui extensions, or wants to report a webui bug (/report does it).";

// ---------------------------------------------------------------------------
// Extraction helpers (ui-extensions/README.md is the single source of truth)
// ---------------------------------------------------------------------------

/** A markdown table: the line matching `header`, then every `|`-led line after. */
function extractTable(src: string, header: RegExp, label: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) throw new Error(`gen-skill: ${label} header not found in ${SOURCE}`);
  const rows: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (!line.trimStart().startsWith("|")) break;
    rows.push(line);
  }
  if (rows.length < 3) throw new Error(`gen-skill: ${label} table looks truncated`);
  return rows.join("\n");
}

/** Content between two literal markers (the regions:auto block), trimmed. */
function extractBetween(src: string, startMarker: string, endMarker: string, label: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start)
    throw new Error(`gen-skill: ${label} markers not found in ${SOURCE}`);
  return src.slice(start + startMarker.length, end).trim();
}

/** A `## …` section's content (heading excluded) up to the next `## ` heading. */
function extractSection(src: string, heading: string, label: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`gen-skill: ${label} section not found in ${SOURCE}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim(); // +1: drop the heading itself
}

const readme = readFileSync(SOURCE, "utf8");

const kindTable = extractTable(
  readme,
  /^\| Kind \| What it does \|/,
  "kind contract",
);
const hookTable = extractTable(
  readme,
  /^\| Event \| `?ctx.*shape.*\|/i,
  "hook events",
);
const regionTable = extractBetween(
  readme,
  "<!-- regions:auto:start -->",
  "<!-- regions:auto:end -->",
  "regions",
);
const addRemoveDisable = extractSection(
  readme,
  "## Add / remove / disable",
  "add/remove/disable",
);

// ---------------------------------------------------------------------------

const skill = `---
name: webui
description: ${DESCRIPTION}
---

# OpenCode webui (opencode-webui)

The browser frontend for the OpenCode engine — same engine, same sessions as
the \`opencode\` TUI, with a Bun proxy in front so the browser never holds
service credentials. One port for UI + \`/api/*\`: http://localhost:4097
(\`WEBUI_PROXY_PORT\`).

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| \`WEBUI_PASSWORD\` | generated on first boot, printed once | Shared login passphrase. |
| \`WEBUI_HOST\` | \`127.0.0.1\` | Bind address — a wildcard is refused without a password. |
| \`WEBUI_PROXY_PORT\` | \`4097\` | Port for the UI and \`/api/*\`. |
| \`WEBUI_DEBUG\` | unset | \`1\` — server/proxy debug logs to stdout. |
| \`WEBUI_DEBUG_LOG\` | \`/tmp/webui-debug.log\` | File the frontend log sink (\`POST /api/debug\`) appends to. |

## What you can do for the user

- **File a webui bug** — the composer ships a built-in \`/report\` command that
  bundles diagnostics (build version, user agent, enabled extension ids, error
  ring) into a prefilled GitHub issue for AbdelftahZowail/opencode-webui (see
  Reporting bugs below).
- **Explain the extension system** from the tables below — they are extracted
  verbatim from the authoring guide (\`ui-extensions/README.md\`), which is the
  source of truth.
- **Author a user-dir extension** for the user — a folder, no build step, no
  restart.

### Minimal user-dir extension

Drop a folder — \`~/.config/opencode/webui-extensions/<name>/main.tsx\`
(per-user) or \`<project>/.opencode/webui-extensions/<name>/main.tsx\`
(per-project). The proxy bundles it and the page loads it within a poll cycle
(~8s); toggle per extension in Settings › Extensions. Runtime extensions reach
the app ONLY through the versioned \`window.__opencodeUI\` bridge (\`register\`,
\`react\`, \`useStore\`, \`api\`, \`notify\`, \`getHooks\`):

\`\`\`tsx
// ~/.config/opencode/webui-extensions/hello/main.tsx
const { register, react } = window.__opencodeUI;

register({
  kind: "region",
  id: "hello",
  region: "footer",
  render: () => react.createElement("span", null, "hello from a user extension"),
});
\`\`\`

## Extension kinds (the contract)

${kindTable}

### Hook events

${hookTable}

## Regions (render points)

${regionTable}

## Add / remove / disable (app repo)

${addRemoveDisable}

## Reporting bugs

\`/report\` in the composer files a prefilled GitHub issue against
AbdelftahZowail/opencode-webui with a diagnostics bundle (build version, user
agent, enabled extension ids, window error ring). \`--agent\` hands the same
bundle to the session agent instead: when the user asks you to file it and
\`gh\` is authenticated, create the issue yourself from the bundle — the webui
never holds GitHub credentials. The engine's built-in \`/report\` skill is a
different thing (different repo, different diagnostics).
`;

writeFileSync(TARGET, skill);
console.log(`[gen-skill] wrote ${TARGET} (${skill.length} bytes, description ${DESCRIPTION.length} chars)`);
