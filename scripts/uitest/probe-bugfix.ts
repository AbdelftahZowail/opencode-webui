#!/usr/bin/env bun
// Ground truth for three reported bugs:
//  A) steer delivery: does the inbox item leave GET /inbox after delivery? which event fires, with which fields?
//  B) run end: which terminal events fire (execution.* / session.status / session.idle)?
//  C) edit flow: revert/stage -> prompt -> does the engine auto-commit? what does GET /session report?
import { Service } from "@opencode-ai/client/service";

const ep = await Service.ensure();
const H = { ...Service.headers(ep), "content-type": "application/json" };
const B = ep.url;

async function j(path: string, init?: RequestInit) {
  const res = await fetch(`${B}${path}`, { headers: H as never, ...init });
  const t = await res.text();
  let b: unknown = t;
  try { b = JSON.parse(t); } catch {}
  return { status: res.status, body: b as any };
}

// capture ALL events for our sessions
const events: { type: string; data: any }[] = [];
const ac = new AbortController();
fetch(`${B}/api/event`, { headers: H as never, signal: ac.signal }).then(async (res) => {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith("data: ")) {
        try {
          const d = JSON.parse(line.slice(6));
          events.push({ type: d.type, data: d.data });
        } catch {}
      }
    }
  }
}).catch(() => {});

await new Promise((r) => setTimeout(r, 300));

// ---- create session ----
const created = await j("/api/session", {
  method: "POST",
  body: JSON.stringify({ title: null, agent: null, model: null, location: null }),
});
const sid = created.body.data.id;
console.log("SESSION:", sid);

// ---- prompt: keep busy ~20s with a shell sleep ----
const p1 = await j(`/api/session/${sid}/prompt`, {
  method: "POST",
  body: JSON.stringify({ text: "Run this exact shell command and nothing else: sleep 20. After it finishes reply with exactly: FIRST-DONE" }),
});
console.log("PROMPT1:", p1.status, JSON.stringify(p1.body).slice(0, 200));

// wait until busy
let busy = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const active = await j("/api/session/active");
  if (active.body?.data?.[sid]) { busy = true; break; }
}
console.log("BUSY:", busy, "active:", JSON.stringify((await j("/api/session/active")).body).slice(0, 200));

// ---- steer while busy ----
const steer = await j(`/api/session/${sid}/prompt`, {
  method: "POST",
  body: JSON.stringify({ text: "After the sleep, ALSO reply with exactly: STEER-RECEIVED" }),
});
console.log("STEER POST:", steer.status, "resp:", JSON.stringify(steer.body).slice(0, 300));

const inboxDuring = await j(`/api/session/${sid}/inbox`);
console.log("INBOX during:", JSON.stringify(inboxDuring.body).slice(0, 500));

// poll inbox until it empties (delivered), log the transition + events
let emptiedAt = -1;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const ib = await j(`/api/session/${sid}/inbox`);
  const n = (ib.body?.data ?? []).length;
  if (n === 0 && i > 1) { emptiedAt = i; break; }
}
console.log("INBOX emptied after ~", emptiedAt, "s");

// wait for run end (idle)
let idleAt = -1;
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const active = await j("/api/session/active");
  if (!active.body?.data?.[sid]) { idleAt = i; break; }
}
console.log("IDLE after ~", idleAt, "s; active:", JSON.stringify((await j("/api/session/active")).body).slice(0, 200));
console.log("INBOX after end:", JSON.stringify((await j(`/api/session/${sid}/inbox`)).body).slice(0, 400));

// ---- B) edit/revert flow ground truth (no engine run needed) ----
console.log("\n---- REVERT FLOW ----");
const msgs = (await j(`/api/session/${sid}/message`)).body.data ?? [];
const msgsAsc = [...msgs].reverse();
const firstUser = msgsAsc.find((m: any) => m.type === "user");
console.log("messages:", msgsAsc.length, "first user:", firstUser?.id);
if (firstUser) {
  const staged = await j(`/api/session/${sid}/revert/stage`, { method: "POST", body: JSON.stringify({ messageID: firstUser.id }) });
  console.log("STAGE:", staged.status, JSON.stringify(staged.body).slice(0, 200));
  const detail1 = await j(`/api/session/${sid}`);
  console.log("DETAIL after stage:", JSON.stringify(detail1.body?.data ?? detail1.body).slice(0, 400));
  // now send a new prompt: does the engine auto-commit?
  const p2 = await j(`/api/session/${sid}/prompt`, { method: "POST", body: JSON.stringify({ text: "Reply with exactly: SECOND-TURN" }) });
  console.log("PROMPT2:", p2.status);
  await new Promise((r) => setTimeout(r, 3000));
  const detail2 = await j(`/api/session/${sid}`);
  console.log("DETAIL 3s after prompt:", JSON.stringify(detail2.body?.data ?? detail2.body).slice(0, 400));
  // wait for idle
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const active = await j("/api/session/active");
    if (!active.body?.data?.[sid]) break;
  }
  const detail3 = await j(`/api/session/${sid}`);
  console.log("DETAIL after run:", JSON.stringify(detail3.body?.data ?? detail3.body).slice(0, 400));
  const msgs2 = (await j(`/api/session/${sid}/message`)).body.data ?? [];
  console.log("history count after edit+prompt:", msgs2.length, "(was", msgsAsc.length, ")");
  for (const m of [...msgs2].reverse().slice(0, 6)) console.log("  ", m.type, JSON.stringify((m.text ?? "").slice(0, 60)));
}

// ---- event dump relevant to our session ----
console.log("\n---- EVENTS ----");
for (const e of events) {
  if (e.data?.sessionID !== sid) continue;
  if (/revert|inbox|execution|status|idle|step\.(started|ended|failed)|error/.test(e.type)) {
    console.log(e.type, JSON.stringify(e.data).slice(0, 220));
  }
}
ac.abort();
await j(`/api/session/${sid}`, { method: "DELETE" }).catch(() => {});
process.exit(0);
