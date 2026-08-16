#!/usr/bin/env bun
/**
 * Replay a captured /api/event log through the real store reducer and print
 * the live-assistant state exactly as the transcript would render it.
 * This is the *UI-side* correctness check for streaming: it proves text/
 * reasoning/tool deltas accumulate into a live assistant and that the
 * finished-message settle ("reload history, keep anything not yet persisted")
 * works across multiple sequential runs.
 *
 * Usage:
 *   bun scripts/uitest/replay-store.mjs <events-file> <session-id> [base-url]
 *
 * The harness proxies the store's own REST calls (/api/...) to the real
 * proxy so the settle step gets the true persisted history when available.
 */
import { liveToolPart, selectSession, handleEvent, getState } from "../../src/store.ts";

const file = process.argv[2];
const sid = process.argv[3];
const base = process.argv[4] ?? "http://127.0.0.1:4097";

if (!file || !sid) {
  console.error("usage: replay-store.mjs <events-file> <session-id> [base-url]");
  process.exit(1);
}

const origFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : "";
  if (u.startsWith("/")) url = base + u;
  return origFetch(url, init);
};

await selectSession(sid);

const events = [];
for (const line of (await Bun.file(file).text()).split("\n")) {
  if (!line.startsWith("data: ")) continue;
  let j;
  try {
    j = JSON.parse(line.slice("data: ".length));
  } catch {
    continue;
  }
  if (j.type === "server.connected" || j.type === "server.heartbeat") continue;
  if (j.data?.sessionID !== sid) continue;
  events.push({ id: j.id ?? "", created: j.created ?? Date.now(), type: j.type, data: j.data });
}

function liveSnapshot(label) {
  const live = getState().live;
  const rows = live.map((m) => {
    const bits = [];
    if (m.reasoning) bits.push(`reasoning:${m.reasoning.length}`);
    if (m.text) bits.push(`text:${m.text.length}`);
    if (m.tools.size) {
      for (const t of m.tools.values()) {
        // Build the exact renderable part the UI passes to ToolCard.
        const part = liveToolPart(t);
        bits.push(`tool:${t.name}(part.state=${part.state.status},input=${JSON.stringify(part.state.input).slice(0, 20)})`);
      }
    }
    return `    ${m.id === "pending" ? "pending" : m.id.slice(0, 16)} ${bits.length ? bits.join(" ") : "(empty)"}`;
  });
  console.log(`  live[${label}] count=${live.length}${rows.length ? "\n" + rows.join("\n") : ""}`);
}

console.log(`replaying ${events.length} events for ${sid}\n`);
let deltas = 0;
for (const ev of events) {
  handleEvent(ev);
  if (ev.type.endsWith(".delta")) {
    deltas += 1;
    if (deltas % 20 === 0) liveSnapshot(`after ${deltas} deltas`);
  }
  if (ev.type === "session.execution.started") liveSnapshot("execution.started");
  if (ev.type === "session.text.ended" || ev.type === "session.reasoning.ended") liveSnapshot(ev.type);
  if (ev.type === "session.execution.succeeded" || ev.type === "session.execution.failed") {
    liveSnapshot("execution finished (pre-settle)");
    await new Promise((r) => setTimeout(r, 1800)); // let settle + retry land
    liveSnapshot("execution finished (settled)");
  }
}

console.log("\n--- final ---");
liveSnapshot("final");
const st = getState();
const msgs = st.messages[sid] ?? [];
console.log(`  messages in store for this session: ${msgs.length}`);
for (const m of msgs.slice(-4)) {
  if (m.type === "user") console.log(`    [user]     ${(m.text ?? "").slice(0, 60)}`);
  if (m.type === "assistant")
    console.log(`    [assistant] ${m.content?.map((p) => (p.type === "text" ? `text:${p.text.slice(0, 40)}` : p.type)).join(", ") || "(no content)"} finish=${m.finish}`);
}
console.log(`\nstreamed ${deltas} delta events total`);