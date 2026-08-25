#!/usr/bin/env bun
// Diff the committed OpenAPI snapshot (docs/reference/openapi.json) against
// the live service. Prints a human summary and exits 1 on drift (CI mode).
//   bun run scripts/diff-openapi.ts            # pretty summary to stdout
//   bun run scripts/diff-openapi.ts --json     # machine-readable JSON
//   bun run scripts/diff-openapi.ts --check    # exit 1 if added/removed/modified
import { Service } from "@opencode-ai/client/service";

const SNAP_PATH = new URL("../docs/reference/openapi.json", import.meta.url).pathname;
const asJson = process.argv.includes("--json");
const check = process.argv.includes("--check");

async function loadSnapshot(): Promise<any> {
  const file = Bun.file(SNAP_PATH);
  if (!(await file.exists())) {
    console.error(`snapshot not found: ${SNAP_PATH}`);
    process.exit(2);
  }
  return await file.json();
}

async function loadLive(): Promise<any> {
  const ep = await Service.ensure();
  const res = await fetch(`${ep.url}/openapi.json`, { headers: Service.headers(ep) });
  if (!res.ok) {
    console.error(`live fetch failed: ${res.status} ${res.statusText} @ ${ep.url}`);
    process.exit(2);
  }
  return await res.json();
}

function sortedKeys(o: Record<string, any> | undefined): string[] {
  return Object.keys(o ?? {}).sort();
}

const snap = await loadSnapshot();
const live = await loadLive();

const snapPaths = new Set<string>(sortedKeys(snap.paths));
const livePaths = new Set<string>(sortedKeys(live.paths));
const snapSchemas = new Set<string>(sortedKeys(snap.components?.schemas));
const liveSchemas = new Set<string>(sortedKeys(live.components?.schemas));

const onlySnap = sortedKeys(snap.paths).filter((p) => !livePaths.has(p));
const onlyLive = sortedKeys(live.paths).filter((p) => !snapPaths.has(p));
const common = sortedKeys(snap.paths).filter((p) => livePaths.has(p));

const modified: string[] = [];
for (const p of common) {
  if (JSON.stringify(snap.paths[p]) !== JSON.stringify(live.paths[p])) modified.push(p);
}

const newSchemas = sortedKeys(live.components?.schemas).filter((s) => !snapSchemas.has(s));
const removedSchemas = sortedKeys(snap.components?.schemas).filter((s) => !liveSchemas.has(s));

if (asJson) {
  console.log(
    JSON.stringify(
      {
        snapshot: { paths: snapPaths.size, schemas: snapSchemas.size },
        live: { paths: livePaths.size, schemas: liveSchemas.size },
        onlySnap,
        onlyLive,
        modified,
        newSchemas,
        removedSchemas,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`snapshot: ${snapPaths.size} paths / ${snapSchemas.size} schemas`);
  console.log(`live:     ${livePaths.size} paths / ${liveSchemas.size} schemas`);
  console.log("");
  if (onlyLive.length) {
    console.log(`+ ONLY_LIVE (${onlyLive.length}) — new upstream routes not in snapshot:`);
    for (const p of onlyLive) {
      const ops = live.paths[p] as Record<string, any>;
      const detail = Object.entries(ops)
        .map(([m, op]: any) => `${m.toUpperCase()} ${op.operationId ?? ""}`)
        .join(", ");
      console.log(`  + ${p}  [${detail}]`);
    }
    console.log("");
  } else {
    console.log("  no new paths");
    console.log("");
  }
  if (onlySnap.length) {
    console.log(`- ONLY_SNAP (${onlySnap.length}) — snapshot routes removed upstream:`);
    for (const p of onlySnap) console.log(`  - ${p}`);
    console.log("");
  } else {
    console.log("  no removed paths");
    console.log("");
  }
  if (modified.length) {
    console.log(`~ MODIFIED (${modified.length}) — same path, body changed (often just schema inlining):`);
    for (const p of modified) console.log(`  ~ ${p}`);
    console.log("");
  } else {
    console.log("  no modified paths");
    console.log("");
  }
  if (newSchemas.length) {
    console.log(`+ new schemas (${newSchemas.length}): ${newSchemas.join(", ")}`);
  }
  if (removedSchemas.length) {
    console.log(`- removed schemas (${removedSchemas.length}): ${removedSchemas.join(", ")}`);
  }
  console.log("");
  console.log("hint: bun run scripts/fetch-openapi.ts  → refresh snapshot to live");
  console.log("      git diff docs/reference/openapi.json  → see the raw contract diff");
}

if (check && (onlyLive.length || onlySnap.length || modified.length)) process.exit(1);
