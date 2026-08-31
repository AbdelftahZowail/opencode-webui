/**
 * SPIKE 2 (throwaway): pin down /experimental/session/{sid}/log semantics.
 *  - non-follow: cursor bootstrap (log.synced head)?
 *  - does after=<seq>&follow=false REPLAY the backlog (seq+1..head)?
 *  - does after=<seq>&follow=true tail live events?
 *  - exclusivity of `after`.
 */
import { Service } from "@opencode-ai/client/service";

const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;
async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** non-follow or follow fetch returning parsed data lines */
async function logOnce(sid: string, after: string | null) {
  const q = after === null ? "" : `after=${encodeURIComponent(after)}&`;
  const res = await fetch(`${B}/api/experimental/session/${sid}/log?${q}follow=false`, { headers: H as never });
  const text = res.status === 200 ? await res.text() : "";
  return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => {
    try { return JSON.parse(l.slice(5)); } catch { return { parse: "fail" }; }
  });
}

async function tailLog(sid: string, after: string | null, ms: number, onLine: (e: Record<string, unknown>) => void) {
  const q = after === null ? "" : `after=${encodeURIComponent(after)}&`;
  const res = await fetch(`${B}/api/experimental/session/${sid}/log?${q}follow=true`, { headers: H as never });
  console.log(`[tail after=${after}] status=${res.status}`);
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const t0 = Date.now();
  for (;;) {
    const remaining = ms - (Date.now() - t0);
    if (remaining <= 0) break;
    const t = Promise.withResolvers<"t">();
    const timer = setTimeout(() => t.resolve("t"), remaining);
    let chunk: { done: boolean; value?: Uint8Array } | "t";
    try {
      chunk = (await Promise.race([reader.read() as Promise<{ done: boolean; value?: Uint8Array }>, t.promise])) as { done: boolean; value?: Uint8Array } | "t";
    } catch {
      break;
    }
    clearTimeout(timer);
    if (chunk === "t" || chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try { onLine(JSON.parse(line.slice(5))); } catch { /* */ }
    }
  }
  void reader.cancel().catch(() => undefined);
}

// ---- OLD session: is backlog queryable across process lifetimes? --------
const oldSid = "ses_fd15b67ccffeC0NOOm7iFvM44V";
for (const after of ["0", "100", "350", "352"]) {
  const evts = await logOnce(oldSid, after);
  const types = evts.map((e) => (e as { type?: string }).type ?? "?");
  const seqs = evts.map((e) => (e as { seq?: number }).seq ?? (e as { durable?: { seq?: number } }).durable?.seq ?? null);
  console.log(`[old ${oldSid}] after=${after} -> ${evts.length} evt(s) types=${JSON.stringify(types.slice(0, 4))} seqs=${JSON.stringify(seqs.slice(0, 4))}`);
}

// ---- FRESH session: bootstrap -> tail -> replay -------------------------
const agents = (await j("/api/agent")).body?.data ?? [];
const primary = agents.find((a: { mode: string; hidden?: boolean }) => a.mode === "primary" && !a.hidden);
let model = primary?.model;
if (!model) {
  const models = (await j("/api/model")).body?.data ?? [];
  const enabled = models.filter((m: { enabled?: boolean }) => m.enabled);
  model = enabled[0] ? { providerID: enabled[0].providerID, id: enabled[0].modelID } : undefined;
}
const sid = (await j("/api/session", { method: "POST", body: JSON.stringify({ title: null, agent: null, model, location: null }) })).body?.data?.id;
console.log(`[fresh] session ${sid}`);
const head = await logOnce(sid, null);
console.log(`[fresh] bootstrap (after=null): ${JSON.stringify(head.map((e) => ({ type: e.type, seq: e.seq ?? (e as { durable?: { seq?: number } }).durable?.seq })) )}`);

const headSeq = String((head[0] as { seq?: number })?.seq ?? 0);
// tail from the head cursor, then prompt — live events should stream
const live: Array<Record<string, unknown>> = [];
const tailPromise = tailLog(sid, headSeq, 30_000, (e) => live.push(e));
await new Promise((r) => setTimeout(r, 500));
await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Write a 3-line poem about rain." }) });
await tailPromise;
const seqOf = (e: Record<string, unknown>) => (e.seq as number) ?? ((e as { durable?: { seq?: number } }).durable?.seq as number) ?? null;
console.log(`[fresh] tail events: ${live.length}, first 10: ${JSON.stringify(live.slice(0, 10).map((e) => ({ t: (e.type as string) ?? "?", seq: seqOf(e) })))}`);

// replay the whole run non-follow: after=0 and after=<head>
for (const after of ["0", headSeq]) {
  const evts = await logOnce(sid, after);
  const seqs = evts.map(seqOf);
  console.log(`[fresh] non-follow after=${after} -> ${evts.length} evt(s), firstSeq=${seqs[0]} lastSeq=${seqs[seqs.length - 1]} (head was ${headSeq})`);
}

await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(0);
