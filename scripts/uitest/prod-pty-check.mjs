#!/usr/bin/env bun
// Production PTY smoke: create a pty through the proxy, connect the websocket,
// run echo, assert the output round-trips, then clean up.
//   BASE=http://127.0.0.1:4099 bun run scripts/uitest/prod-pty-check.mjs
const BASE = process.env.BASE ?? "http://127.0.0.1:4097";
const MARK = `prod-pty-ok-${Date.now()}`;

const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  return body;
};

const created = await api("/api/pty", {
  method: "POST",
  body: JSON.stringify({ command: "bash", cwd: process.env.HOME, title: "prod-smoke" }),
});
const pty = created.data ?? created;
const ptyID = pty.id ?? pty.ptyID;
if (!ptyID) { console.error("no pty id in response:", JSON.stringify(created).slice(0, 300)); process.exit(1); }
console.log("pty:", ptyID);

try {
  const token = await api(`/api/pty/${ptyID}/connect-token`, { method: "POST", headers: { "x-opencode-ticket": "1" } });
  const ticket = (token.data ?? token).ticket;
  if (!ticket) throw new Error(`no ticket: ${JSON.stringify(token).slice(0, 200)}`);

  const wsURL = `${BASE.replace(/^http/, "ws")}/api/pty/${ptyID}/connect?ticket=${ticket}`;
  const ws = new WebSocket(wsURL);
  let out = "";

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; got: ${JSON.stringify(out.slice(-300))}`)), 15000);
    ws.onopen = () => ws.send(`echo ${MARK}\r`);
    ws.onmessage = (e) => {
      if (typeof e.data === "string") out += e.data; // binary frames are cursor-control, skip
      if (out.includes(MARK)) { clearTimeout(timer); resolve(out); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("websocket error")); };
  });

  console.log("round-trip OK, bytes:", result.length);
  console.log("sample:", JSON.stringify(result.split("\n").find((l) => l.includes(MARK))?.trim().slice(0, 80)));
  process.exitCode = 0;
} finally {
  ws_close: try { /* ws left to GC */ } catch {}
  await api(`/api/pty/${ptyID}`, { method: "DELETE" }).catch((e) => console.error("cleanup:", e.message));
}
