#!/usr/bin/env bun
/**
 * Regenerates the "Region markers" table in ui-extensions/README.md by
 * scanning src .tsx files for <Slot region="..."> placements. Keeps the
 * extension docs honest — the table can never drift from the code.
 *
 * Usage: bun run regions
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const glob = new Bun.Glob("**/*.tsx");
const rows: { region: string; where: string }[] = [];

for await (const rel of glob.scan({ cwd: join(ROOT, "src") })) {
  const abs = join(ROOT, "src", rel);
  const lines = readFileSync(abs, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart();
    if (rel.includes("extensions/registry")) continue; // its docblock teaches the syntax
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue; // comments
    const re = /<Slot\b[^>]*\bregion="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i]!)) !== null) {
      rows.push({ region: m[1]!, where: `src/${rel}:${i + 1}` });
    }
  }
}

rows.sort((a, b) => a.region.localeCompare(b.region) || a.where.localeCompare(b.where));

const table = [
  "| Region | Render point |",
  "| --- | --- |",
  ...rows.map((r) => `| \`${r.region}\` | \`${r.where}\` |`),
].join("\n");

const START = "<!-- regions:auto:start -->";
const END = "<!-- regions:auto:end -->";
const section = `${START}\n${table}\n${END}`;

const readmePath = join(ROOT, "ui-extensions", "README.md");
const readme = readFileSync(readmePath, "utf8");

let next: string;
if (readme.includes(START) && readme.includes(END)) {
  const startIdx = readme.indexOf(START);
  const endIdx = readme.indexOf(END) + END.length;
  next = readme.slice(0, startIdx) + section + readme.slice(endIdx);
} else {
  next = `${readme.trimEnd()}\n\n## Region markers\n\nDrop-in render points addressed by string. Empty regions cost nothing;\nregister against one with \`{ kind: "region", region: "...", render }\`.\n\n${section}\n`;
}

writeFileSync(readmePath, next);
console.log(`[regions] ${rows.length} markers across ${new Set(rows.map((r) => r.where.split(":")[0])).size} files`);
for (const r of rows) console.log(`  ${r.region.padEnd(32)} ${r.where}`);
