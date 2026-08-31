#!/usr/bin/env bun
/**
 * Regression: steering-strip lifecycle, run-state authority (active-map lag),
 * background live-entry retirement, and the staged-revert edit flow.
 * Drives the REAL store reducer/actions with a fully stubbed /api layer.
 */
import {
  applyRevertView,
  commitPendingEdit,
  getState,
  handleEvent,
  loadMessages,
  loadSessionDetail,
  reconcileInbox,
  refreshSessions,
  selectSession,
  sendPromptTo,
  startEditAtMessage,
} from "../../src/store";
import type { MessageInfo, SessionInfo } from "../../src/api/types";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !extra ? "" : ` — ${extra}`}`);
  if (!ok) failures++;
}
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(label, g === w, `got ${g}, want ${w}`);
}

// ---- stubbed /api layer ---------------------------------------------------

type Handler = (url: URL, init?: RequestInit) => unknown | Promise<unknown>;
const routes = new Map<RegExp, Handler>();
// Raw-stream escape hatch for the SSE endpoint (tests feed their own frames).
let eventStreamBody: ReadableStream<Uint8Array> | null = null;
let unmatched: string[] = [];

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const raw = typeof url === "string" ? url : url.toString();
  const u = new URL(raw, "http://test.local");
  if (u.pathname === "/api/event" && eventStreamBody) {
    return new Response(eventStreamBody, { status: 200 });
  }
  for (const [re, handler] of routes) {
    if (re.test(u.pathname)) {
      const body = await handler(u, init);
      return new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
  }
  // The store's debug logger posts here; silence it.
  if (u.pathname === "/api/debug") return new Response("{}", { status: 200 });
  unmatched.push(`${init?.method ?? "GET"} ${u.pathname}`);
  return new Response("{}", { status: 200 });
}) as typeof fetch;

function inboxItem(id: string, sessionID: string, text: string, delivery = "steer") {
  return { id, sessionID, timeCreated: Date.now(), type: "user", payload: { text }, delivery };
}
function userMsg(id: string, text: string, created = Date.now()): MessageInfo {
  return { id, type: "user", text, time: { created } } as MessageInfo;
}
function asstMsg(id: string, created: number, text = ""): MessageInfo {
  return {
    id, type: "assistant", content: text ? [{ type: "text", text }] : [], finish: "stop",
    time: { created, completed: created + 100 },
  } as unknown as MessageInfo;
}
function sessionInfo(id: string): SessionInfo {
  return {
    id, projectID: "p", cost: 0, tokens: {},
    time: { created: 1, updated: 2 },
    location: { directory: "/tmp" },
    model: { id: "m", providerID: "prov" },
  } as unknown as SessionInfo;
}
function messagesResponse(list: MessageInfo[]) {
  return { data: list, cursor: { previous: null, next: null } };
}
function ev(type: string, data: Record<string, unknown>, i = 0) {
  return { id: `evt_${type}_${i}`, created: Date.now(), type, data } as never;
}

// ===========================================================================
// 1) Steering strip: admit → tracked (the .data unwrap) → transcript drop
//    even while the engine's laggy inbox listing still returns the item.
// ===========================================================================
{
  const sid = "ses_t1";
  routes.set(/\/api\/session\/ses_t1\/message/, () => messagesResponse([userMsg("msg_u1", "hello", 1000)]));
  routes.set(/\/api\/session\/ses_t1\/prompt$/, () =>
    ({ data: inboxItem("msg_inb1", sid, "steer me") }));
  routes.set(/\/api\/session\/ses_t1\/inbox$/, () =>
    ({ data: [inboxItem("msg_inb1", sid, "steer me")] })); // laggy listing
  routes.set(/\/api\/session\/ses_t1$/, () => ({ data: sessionInfo(sid) }));
  routes.set(/\/api\/session$/, () => ({ data: [sessionInfo(sid)], cursor: { previous: null, next: null } }));
  routes.set(/\/api\/session\/active$/, () => ({ data: {} }));

  await selectSession(sid);
  // selectSession's own reconcileInbox sees the (stubbed, always-laggy)
  // listing and hydrates a row; the POST response then tracks a second row —
  // both carry inboxID msg_inb1 and BOTH must go once delivery is proven.
  handleEvent(ev("session.execution.started", { sessionID: sid }, 1));
  await sendPromptTo(sid, "steer me");

  const rows = getState().pending[sid] ?? [];
  check("steer row became tracked with an inboxID (the {data} unwrap)",
    rows.length >= 1 && rows.every((r) => r.state === "tracked" && r.inboxID === "msg_inb1"),
    JSON.stringify(rows.map((r) => ({ state: r.state, inboxID: r.inboxID }))));

  // Delivery persisted the turn with the SAME id as the inbox item (probe-
  // verified) while the listing still returns the item → transcript drop.
  const withDelivery = [
    userMsg("msg_u1", "hello", 1000),
    userMsg("msg_inb1", "steer me", 2000),
    asstMsg("msg_a1", 2500, "ok"),
  ];
  await reconcileInbox(sid, withDelivery);
  eq("steer row(s) dropped via transcript although the listing still has it",
    (getState().pending[sid] ?? []).length, 0);
}

// ===========================================================================
// 2) Run-state authority: the laggy /session/active map must not resurrect a
//    locally-ended run (the stuck "Working…" after the agent finished).
// ===========================================================================
{
  const sid = "ses_t2";
  routes.set(/\/api\/session\/active$/, () => ({ data: { [sid]: { type: "running" } } })); // laggy map
  routes.set(/\/api\/session$/, () => ({ data: [sessionInfo(sid)], cursor: { previous: null, next: null } }));
  routes.set(/\/api\/session\/ses_t2\/message/, () => messagesResponse([]));
  routes.set(/\/api\/session\/ses_t2\/inbox$/, () => ({ data: [] }));

  handleEvent(ev("session.execution.started", { sessionID: sid }, 2));
  eq("running set by execution.started", getState().running[sid], true);
  handleEvent(ev("session.execution.succeeded", { sessionID: sid }, 2));
  eq("running cleared by execution.succeeded", getState().running[sid] ?? false, false);

  await refreshSessions();
  eq("laggy active map did NOT re-add running for the just-ended run", getState().running[sid] ?? false, false);

  // And the strip's activeIDs-only liveness stays fresh-window gated.
  routes.set(/\/api\/session\/active$/, () => ({ data: {} }));
}

// ===========================================================================
// 3) Background (non-pane) sessions: finished live entries must retire, not
//    haunt the ActivityStrip ("active" while actually stopped).
// ===========================================================================
{
  const sid = "ses_t3"; // never selected → never a pane session
  routes.set(/\/api\/session\/ses_t3\/message/, () =>
    messagesResponse([userMsg("msg_u3", "hi", 1000), asstMsg("asst_t3", 2000, "done")]));
  routes.set(/\/api\/session\/ses_t3\/inbox$/, () => ({ data: [] }));
  handleEvent(ev("session.execution.started", { sessionID: sid }, 3));
  handleEvent(ev("session.step.started", { sessionID: sid, assistantMessageID: "asst_t3", agent: "build", model: { id: "m", providerID: "p" } }, 3));
  handleEvent(ev("session.execution.succeeded", { sessionID: sid }, 3));

  const liveBefore = getState().live.filter((a) => a.sessionID === sid);
  check("background live entry exists mid-test", liveBefore.length === 1 && liveBefore[0]!.finish !== undefined,
    JSON.stringify(liveBefore.map((a) => ({ id: a.id, finish: a.finish }))));

  await loadMessages(sid);
  eq("finished background live entry retired from state.live",
    getState().live.filter((a) => a.sessionID === sid).length, 0);
  eq("background transcript reconciled", (getState().messages[sid] ?? []).length, 2);
}

// ===========================================================================
// 4) Edit flow: commitPendingEdit cuts LOCALLY at the edited message and
//    owns the marker; a lagging staged-state fetch can't resurrect the old
//    turns; the committed event survives the optimistic new turn.
// ===========================================================================
{
  const sid = "ses_t4";
  const base = [
    userMsg("msg_u1", "first", 1000),
    asstMsg("msg_a1", 1100, "one"),
    userMsg("msg_u2", "old text", 2000),
    asstMsg("msg_a2", 2100, "two"),
  ];
  let committed = false;
  routes.set(/\/api\/session\/ses_t4\/message/, () =>
    messagesResponse(committed ? [base[0]!, base[1]!, userMsg("msg_u5", "edited text", 3000), asstMsg("msg_a5", 3100, "edited reply")] : [...base]));
  routes.set(/\/api\/session\/ses_t4$/, () => ({ data: { ...sessionInfo(sid), revert: { messageID: "msg_u2" } } }));
  routes.set(/\/api\/session\/ses_t4\/revert\/stage$/, () => ({ data: { messageID: "msg_u2", files: [] } }));
  routes.set(/\/api\/session\/ses_t4\/prompt$/, () =>
    ({ data: inboxItem("msg_inb4", sid, "edited text") }));
  routes.set(/\/api\/session\/ses_t4\/inbox$/, () => ({ data: committed ? [] : [inboxItem("msg_inb4", sid, "edited text")] }));
  routes.set(/\/api\/session\/active$/, () => ({ data: {} }));
  routes.set(/\/api\/session$/, () => ({ data: [sessionInfo(sid)], cursor: { previous: null, next: null } }));

  await selectSession(sid);
  eq("history seeded", (getState().messages[sid] ?? []).length, 4);

  startEditAtMessage(sid, "msg_u2", "old text");
  await commitPendingEdit(sid);

  eq("transcript cut at the edited message (old + its response gone)",
    (getState().messages[sid] ?? []).map((m) => m.id), ["msg_u1", "msg_a1"]);
  eq("revert marker points at the edited message", getState().revertMarkers[sid], "msg_u2");
  eq("pendingEdit consumed", getState().pendingEdit, null);

  // The engine's own staged event lands late — must be a no-op on the
  // marker, and its transcript refetch (full pre-commit history) must stay
  // hidden behind the marker's view cut.
  handleEvent(ev("session.revert.staged", { sessionID: sid, revert: { messageID: "msg_u2" } }, 4));
  eq("staged event kept the marker", getState().revertMarkers[sid], "msg_u2");
  await new Promise((r) => setTimeout(r, 30)); // let the staged refetch land
  eq("view cut still hides the old turns after the pre-commit refetch",
    applyRevertView(getState().messages[sid] ?? [], getState().revertMarkers[sid] ?? undefined).map((m) => m.id),
    ["msg_u1", "msg_a1"]);

  // The send: optimistic turn appended on top of the cut transcript.
  await sendPromptTo(sid, "edited text");
  const visibleAfterSend = applyRevertView(getState().messages[sid] ?? [], getState().revertMarkers[sid] ?? undefined);
  check("edited turn is the only visible addition after the cut",
    visibleAfterSend.filter((m) => m.id.startsWith("msg_local_")).length === 1 &&
      !visibleAfterSend.some((m) => m.id === "msg_u2" || m.id === "msg_a2"),
    JSON.stringify(visibleAfterSend.map((m) => m.id)));

  // Engine commits the staged revert when the prompt arrives.
  committed = true;
  handleEvent(ev("session.revert.committed", { sessionID: sid, to: "msg_u2" }, 4));
  eq("committed event cleared the marker", getState().revertMarkers[sid] ?? null, null);
  eq("optimistic new turn survived the commit cut",
    (getState().messages[sid] ?? []).some((m) => m.id.startsWith("msg_local_")), true);

  // Post-commit history converges and the optimistic copy dedupes away.
  await loadMessages(sid);
  await new Promise((r) => setTimeout(r, 30)); // let event-triggered refetches land
  await loadMessages(sid);
  eq("post-commit history merged, optimistic copy deduped",
    (getState().messages[sid] ?? []).map((m) => m.id), ["msg_u1", "msg_a1", "msg_u5", "msg_a5"]);
}

// ===========================================================================
// 5) loadSessionDetail adopts the engine's staged revert ONLY on first sight;
//    a late fetch can't resurrect a marker an event already cleared.
// ===========================================================================
{
  const sid = "ses_t5";
  routes.set(/\/api\/session\/ses_t5$/, () => ({ data: { ...sessionInfo(sid), revert: { messageID: "msg_x" } } }));
  routes.set(/\/api\/session\/ses_t5\/message$/, () => messagesResponse([]));

  await loadSessionDetail(sid);
  eq("first sight adopts the engine-staged marker", getState().revertMarkers[sid], "msg_x");

  handleEvent(ev("session.revert.committed", { sessionID: sid, to: "msg_x" }, 5));
  eq("committed cleared the marker", getState().revertMarkers[sid] ?? null, null);

  await loadSessionDetail(sid); // stale staged snapshot
  eq("late staged-state fetch did NOT resurrect the cleared marker", getState().revertMarkers[sid] ?? null, null);
}

// ===========================================================================
// 6) Streaming hardening: running promotion from stream starts, and terminal
//    tool events must not erase what the streaming events accumulated.
// ===========================================================================
{
  const sid = "ses_t6";
  routes.set(/\/api\/session\/ses_t6\/message/, () => messagesResponse([]));
  routes.set(/\/api\/session\/ses_t6\/inbox$/, () => ({ data: [] }));
  routes.set(/\/api\/session\/ses_t6$/, () => ({ data: sessionInfo(sid) }));
  await selectSession(sid);
  eq("idle before the run", getState().running[sid] ?? false, false);

  // Missed step.started/execution.started — reasoning/text starts alone must
  // promote the run so the composer never shows "idle" over a live stream.
  handleEvent(ev("session.reasoning.started", { sessionID: sid, assistantMessageID: "asst_t6", ordinal: 0 }, 6));
  eq("reasoning.started promoted running", getState().running[sid], true);

  // Tool built only from terminal events (input.started was missed): the
  // name arrives late, and a content-less success must not wipe content.
  handleEvent(ev("session.tool.called", { sessionID: sid, assistantMessageID: "asst_t6", id: "tool_1" }, 6));
  handleEvent(ev(
    "session.tool.success",
    { sessionID: sid, assistantMessageID: "asst_t6", id: "tool_1", name: "bash", content: [{ type: "text", text: "out" }] },
    6,
  ));
  handleEvent(ev("session.tool.failed", { sessionID: sid, assistantMessageID: "asst_t6", id: "tool_1" }, 6));
  const tool = getState().live.find((a) => a.id === "asst_t6")?.tools.get("tool_1");
  check("terminal tool events kept name+content, undefined keys did not erase",
    !!tool && tool.name === "bash" && (tool.content?.length ?? 0) === 1 && tool.status === "error",
    JSON.stringify(tool && { name: tool.name, content: tool.content, status: tool.status }));
}

// ===========================================================================
// 7) SSE parse hardening: normal one-line events dispatch exactly as before;
//    a payload split across two data: lines heals instead of dropping.
// ===========================================================================
{
  const { connectEvents } = await import("../../src/api/events");
  const seen: string[] = [];
  const ac = new AbortController();
  const wire =
    'data: {"type":"evt.a","data":{"n":1}}\n' +
    '\n' +
    ': heartbeat\n' +
    'data: {"type":"evt.b","dat\n' +
    'data: a":{"n":2}}\n' +
    '\n';
  eventStreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(wire));
      setTimeout(() => controller.close(), 80);
    },
  });
  const done = connectEvents(
    (env) => seen.push(`${env.data.type}:${JSON.stringify(env.data.data)}`),
    { signal: ac.signal },
  );
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();
  await done.catch(() => undefined);
  eventStreamBody = null;
  eq("normal event dispatched, heartbeat ignored",
    seen[0], 'evt.a:{"n":1}');
  eq("split payload joined and dispatched", seen[1], 'evt.b:{"n":2}');
  eq("no phantom events", seen.length, 2);
}

if (unmatched.length > 0) console.log("\n(unmatched api calls — informational):", [...new Set(unmatched)].join(", "));
console.log(failures === 0 ? "\nALL GREEN" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
