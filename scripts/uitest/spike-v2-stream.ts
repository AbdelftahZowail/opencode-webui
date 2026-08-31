/**
 * SPIKE (throwaway): experimental per-session log + session.wait + session.view.
 * Verifies, against the LIVE engine:
 *   A) /api/experimental/session/{sid}/log — wire shape, cursor exclusivity,
 *      resume-without-gap on reconnect, cross-process durability (old session).
 *   B) POST /session/{sid}/wait — resolution latency vs the log's terminal
 *      event; behavior on an idle session.
 *   C) POST /session/{sid}/view — what the ack does; active-map re-probe (§4.4).
 */
import { Service } from "@opencode-ai/client/service";

const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- pick a PRE-BOOT session for the durability check -------------------
const engineBoot = new Date(Date.now() - (Date.now() % 86_400_000) + 17 * 3_600_000).getTime(); // ~17:00 local today
const sessions = (await j("/api/session?limit=100")).body?.data ?? [];
const preBoot = sessions
  .filter((s: { time: { updated: number } }) => s.time.updated < engineBoot)
  .sort((a: { time: { updated: number } }, b: { time: { updated: number } }) => a.time.updated - b.time.updated)[0];
console.log(`[durability] sessions listed: ${sessions.length}, pre-boot candidates: ${sessions.filter((s: { time: { updated: number } }) => s.time.updated < engineBoot).length}`);
if (preBoot) {
  const r = await fetch(`${B}/api/experimental/session/${preBoot.id}/log?after=0&follow=false`, { headers: H as never });
  const text = r.status === 200 ? await r.text() : "";
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  console.log(`[durability] OLD session ${preBoot.id} (updated ${new Date(preBoot.time.updated).toISOString()}) -> status ${r.status}, ${lines.length} event(s)`);
  if (lines[0]) console.log(`[durability] first: ${lines[0].slice(0, 160)}`);
}

// ---- fresh pinned session ----------------------------------------------
const agents = (await j("/api/agent")).body?.data ?? [];
const primary = agents.find((a: { mode: string; hidden?: boolean }) => a.mode === "primary" && !a.hidden);
let model = primary?.model;
if (!model) {
  const models = (await j("/api/model")).body?.data ?? [];
  const enabled = models.filter((m: { enabled?: boolean }) => m.enabled);
  model = enabled[0] ? { providerID: enabled[0].providerID, id: enabled[0].modelID } : undefined;
}
const sid = (await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model, location: null }) })).body?.data?.id;
console.log(`[run] session ${sid} model=${model?.id}`);

// ---- log follower -------------------------------------------------------
type Seen = { seq: number | null; type: string; at: number; raw: string };
const seen: Seen[] = [];
let followAbort = new AbortController();
let firstChunkPrinted = false;
async function followLog(label: string, after: string, abort: AbortController, deadlineMs = 120_000) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${B}/api/experimental/session/${sid}/log?after=${encodeURIComponent(after)}&follow=true`, {
      headers: H as never,
      signal: abort.signal,
    });
    console.log(`[${label}] log status=${res.status} content-type=${res.headers.get("content-type")}`);
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const remaining = deadlineMs - (Date.now() - t0);
      if (remaining <= 0) break;
      const t = Promise.withResolvers<"t">();
      const timer = setTimeout(() => t.resolve("t"), remaining);
      let chunk: { done: boolean; value?: Uint8Array } | "t";
      try {
        chunk = (await Promise.race([reader.read() as Promise<{ done: boolean; value?: Uint8Array }>, t.promise])) as { done: boolean; value?: Uint8Array } | "t";
      } catch (e) {
        console.log(`[${label}] read ended: ${e instanceof Error ? e.message : e}`);
        break;
      }
      clearTimeout(timer);
      if (chunk === "t" || chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      if (!firstChunkPrinted) {
        firstChunkPrinted = true;
        console.log(`[${label}] RAW first bytes: ${JSON.stringify(buf.slice(0, 220))}`);
      }
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim()) as { type?: string; seq?: number; id?: string | number; durable?: { seq?: number }; data?: { type?: string } };
          const type = evt.type ?? evt.data?.type ?? "?";
          const seq = (evt.seq ?? evt.durable?.seq ?? (typeof evt.id === "number" ? evt.id : null)) as number | null;
          seen.push({ seq, type, at: Date.now(), raw: line.slice(5, 90) });
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    console.log(`[${label}] follower error: ${e instanceof Error ? e.message : e}`);
  }
}

followAbort = new AbortController();
const followPromise = followLog("A", "0", followAbort);

// ---- run + wait ---------------------------------------------------------
await new Promise((r) => setTimeout(r, 300));
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Think about rain for at least 6 sentences, then write a 4-line poem about rain." }) });
const promptAt = Date.now();

const waitStart = Date.now();
const waitRes = await fetch(`${B}/api/session/${sid}/wait`, { method: "POST", headers: H as never, signal: AbortSignal.timeout(90_000) }).catch((e) => ({ status: 0, err: String(e) }));
const waitAt = Date.now();
console.log(`[B] wait resolved: status=${(waitRes as { status: number }).status} after ${((waitAt - waitStart) / 1000).toFixed(1)}s (prompt->wait ${((waitStart - promptAt) / 1000).toFixed(1)}s)`);

// terminal event in the log?
const terminal = seen.find((s) => /idle|execution\.(succeeded|failed|interrupted)/.test(s.type));
if (terminal) console.log(`[B] log terminal event "${terminal.type}" at +${((terminal.at - promptAt) / 1000).toFixed(1)}s; wait resolved ${((waitAt - terminal.at) / 1000).toFixed(1)}s after it`);

// ---- active-map disappearance latency (§4.4 re-probe) -------------------
let activeEntry: Record<string, unknown> | null = null;
let goneAt: number | null = null;
for (let i = 0; i < 90; i++) {
  const active = (await j("/api/session/active")).body?.data ?? {};
  const entry = active[sid];
  if (entry) {
    activeEntry = entry as Record<string, unknown>;
    goneAt = null;
  } else if (waitAt < Date.now()) {
    goneAt = Date.now();
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`[C] active map: entry=${activeEntry ? JSON.stringify(activeEntry).slice(0, 200) : "none"} gone=${goneAt ? ((goneAt - waitAt) / 1000).toFixed(1) + "s after wait-resolved" : "STILL LISTED after 90s"}`);

// ---- view ack -----------------------------------------------------------
if (activeEntry) {
  const idle = (activeEntry as { idle?: number }).idle;
  console.log(`[C] view: active entry has idle=${JSON.stringify(idle)}`);
}
const viewBody = { idle: Number((activeEntry as { idle?: number } | null)?.idle ?? 1) };
const viewRes = await fetch(`${B}/api/session/${sid}/view`, { method: "POST", headers: H as never, body: JSON.stringify(viewBody) }).catch((e) => ({ status: 0, err: String(e) }));
console.log(`[C] view(${JSON.stringify(viewBody)}) -> status=${(viewRes as { status: number }).status}`);
const after = (await j("/api/session/active")).body?.data ?? {};
console.log(`[C] active map after view: ${after[sid] ? JSON.stringify(after[sid]).slice(0, 160) : "session absent"}`);

// ---- wait on an IDLE session -------------------------------------------
const t2 = Date.now();
const idleWait = await fetch(`${B}/api/session/${sid}/wait`, { method: "POST", headers: H as never, signal: AbortSignal.timeout(8_000) }).then((r) => ({ status: r.status })).catch((e) => ({ status: -1, err: String(e) }));
console.log(`[B] wait on idle session -> status=${idleWait.status} after ${((Date.now() - t2) / 1000).toFixed(1)}s ${idleWait.status === -1 ? "(client timeout)" : ""}`);

// ---- resume WITHOUT gap -------------------------------------------------
const lastSeq = seen.length ? seen[seen.length - 1].seq : null;
const beforeCount = seen.length;
followAbort.abort();
await followPromise;
seen.length = 0;
firstChunkPrinted = false;
followAbort = new AbortController();
const p2 = followLog("A2", String(lastSeq ?? 0), followAbort, 6_000);
await p2;
const seqs = seen.map((s) => s.seq);
const overlap = seqs.filter((q) => lastSeq !== null && q !== null && q <= lastSeq);
console.log(`[A] first pass: ${beforeCount} events, lastSeq=${lastSeq}`);
console.log(`[A] resume after=${lastSeq}: ${seen.length} new events, seqs=${JSON.stringify(seqs.slice(0, 12))}, overlap=${overlap.length}, gapFree=${overlap.length === 0}`);

// ---- cursor exclusivity -------------------------------------------------
const excl = await fetch(`${B}/api/experimental/session/${sid}/log?after=${encodeURIComponent(String(lastSeq ?? 0))}&follow=false`, { headers: H as never });
const exclText = excl.status === 200 ? await excl.text() : "";
const exclLines = exclText.split("\n").filter((l) => l.startsWith("data:"));
const exclSeqs = exclLines.map((l) => { try { const e = JSON.parse(l.slice(5)); return e.seq ?? e.durable?.seq ?? null; } catch { return null; } });
console.log(`[A] non-follow after=${lastSeq}: ${exclLines.length} event(s), firstSeq=${exclSeqs[0]} (exclusive if > ${lastSeq})`);

await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(0);
