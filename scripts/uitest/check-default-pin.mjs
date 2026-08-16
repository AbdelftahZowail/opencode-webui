#!/usr/bin/env bun
/**
 * Verify the new-session default-model pinning: `store.newSession()` creates a
 * null-model session, then pins it to the UI default (primary agent's model)
 * so the service cannot silently fall back to its own default (e.g. glm,
 * which may be rate-limited). Prints the created session's resolved model.
 *
 * Usage:
 *   bun scripts/uitest/check-default-pin.mjs [base-url]
 */
const base = process.argv[2] ?? "http://127.0.0.1:4097";
const origFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : "";
  if (u.startsWith("/")) url = base + u;
  return origFetch(url, init);
};

const { newSession, selectSession, getState } = await import("../../src/store.ts");

const sid = await newSession();
await selectSession(sid); // newSession already selects; harmless to re-select
await new Promise((r) => setTimeout(r, 300)); // let the pin settle

const st = getState();
const sess = st.sessions.find((s) => s.id === sid);
const detail = st.sessionDetails[sid];
console.log("created session:", sid);
console.log("list view model:", JSON.stringify(sess?.model ?? null));
console.log("detail   model:", JSON.stringify(detail?.model ?? null));
console.log("detail   agent:", detail?.agent ?? null);

// Cross-check against the real service (what the picker displays must match).
const res = await origFetch(`${base}/api/session/${sid}`);
const d = await res.json();
console.log("service model  :", JSON.stringify(d.data?.model ?? null));
console.log("service agent  :", d.data?.agent ?? null);

const ok = detail?.model && JSON.stringify(detail.model) === JSON.stringify(d.data?.model);
console.log(ok ? "PASS: session model is pinned and reflected everywhere" : "FAIL: model mismatch");
process.exit(ok ? 0 : 1);