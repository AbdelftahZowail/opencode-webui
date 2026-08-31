#!/usr/bin/env bun
/**
 * Cursor-replay swap readiness probe — THE trigger for the final step of the
 * v2 graduation (recorder → engine-log catch-up).
 *
 * The engine keeps a DURABLE per-session event log
 * (GET /api/experimental/session/{sid}/log?after=<seq>[&follow=true]). The
 * swap replaces the proxy's ring-buffer replay with this log the moment the
 * engine actually streams backlog. On beta-18684 follow=true streams zero
 * bytes and follow=false returns only the head marker (log.synced) — so the
 * verdict is NOT READY until a fixed build lands.
 *
 * Run after every engine bump (or `bun run check:swap`). Exit codes:
 *   0 = READY — backlog flows; do the swap (see runbook in the output)
 *   1 = NOT READY — engine still cannot serve backlog
 *   2 = endpoint gone/changed — remap the probe first
 */
import { Service } from "@opencode-ai/client/service";

const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;

// Newest real session (subagents excluded) — it must have history so backlog
// is provable: after=0 against a session with events either streams them or
// (on a broken build) nothing at all.
const sessions = (await fetch(`${B}/api/session?limit=50&order=desc`, { headers: H as never }).then(
  (r) => r.json() as Promise<{ data?: Array<{ id: string; parentID?: string | null }> }>,
)).data ?? [];
const sid = sessions.find((s) => !s.parentID)?.id;
if (!sid) {
  console.log("no sessions to probe against");
  process.exit(2);
}
console.log("probing session:", sid);

const captured: string[] = [];
let backlogLines = 0;

// Attempt A — follow=false&after=0: if a fixed build serves the backlog as a
// plain request/response, this is the whole catch-up channel (head marker +
// events, no stream to close).
{
  const res = await fetch(
    `${B}/api/experimental/session/${sid}/log?after=0&follow=false`,
    { headers: H as never },
  );
  if (res.status === 404 || res.status === 401) {
    console.log(`endpoint changed (status ${res.status}) — remap this probe first`);
    process.exit(2);
  }
  const text = res.ok ? await res.text() : "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const evt = JSON.parse(line.slice(5).trim()) as { type?: string };
      if (evt.type === "log.synced") continue; // head marker, not backlog
    } catch {
      /* counted below as unknown shape */
    }
    backlogLines++;
    if (captured.length < 5) captured.push(line.slice(0, 200));
  }
  console.log(`A) follow=false after=0  -> status ${res.status}, backlog lines: ${backlogLines}`);
}

// Attempt B — follow=true&after=0: a fixed build streams backlog + live.
// Bounded window; capture raw shapes for the client-side parser work.
if (backlogLines === 0) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${B}/api/experimental/session/${sid}/log?after=0&follow=true`, {
      headers: H as never,
      signal: ctrl.signal,
    });
    console.log(`B) follow=true  after=0  -> status ${res.status}`);
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          backlogLines++;
          if (captured.length < 5) captured.push(line.slice(0, 200));
        }
      }
    }
  } catch {
    /* window elapsed */
  }
  console.log(`B) follow=true  after=0  -> backlog lines: ${backlogLines}`);
}

if (captured.length > 0) {
  console.log("\ncaptured wire shapes (first lines):");
  for (const c of captured) console.log("  ", c);
}

if (backlogLines === 0) {
  console.log("\nVERDICT: NOT READY — the engine still serves no backlog from the log.");
  console.log("Keep the proxy recorder as the catch-up channel; re-run after engine bumps.");
  process.exit(1);
}

console.log(`
VERDICT: READY — the engine streams backlog. The swap is now mechanical:

  1. Map the captured shapes to the reducer's EventEnvelope (seq + embedded
     event) in src/store.ts: extend fetchReplay to also pull
     log?after=<lastLogSeq> and feed normalized events through the normal
     event path (id-based dedupe makes overlaps harmless).
  2. Bump lastLogSeq from the log.synced head each pull (logHeadSeq map
     already tracks it).
  3. Once proven: delete the proxy recorder + GET /api/webui/replay +
     fetchReplay's recorder branch (scripts/uitest/catchup-check.ts must
     still pass — it exercises the late-join path end-to-end).
`);
process.exit(0);
