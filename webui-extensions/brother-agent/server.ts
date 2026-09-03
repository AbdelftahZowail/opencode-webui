// brother-agent — proxy stratum: headless watch/notify loop + browser data route.
//
// Owns finish-notice delivery for brother sessions: a poller watches the
// durable seam file the engine half appends to
// ($XDG_STATE_HOME/opencode-webui/brother-watches.json — written by
// engine/definitions.cjs via brother_agent / brother_agent_watch), and when
// a watched child leaves the engine's active set it queues a notice into
// the parent session (delivery "queue" — same next-turn semantics as native
// subagent notices). The proxy process is always on, so notices land with
// all browser tabs closed.
//
// Single-writer discipline per file: the engine owns the seam file's watch
// entries (this half only deletes entries it has already delivered, and the
// per-child KV record below is the dedupe authority, so a raced delete can
// at worst park an entry the KV already suppresses). Delivery state
// (notifiedAt per child) lives in this extension's KV.
//
// Engine access: the registration-file discovery contract
// ($XDG_STATE_HOME/opencode/service.json → {url, password}, Basic
// opencode:password). Read-only; never spawns. No bare imports and no core
// imports — node: builtins only, so this loads from any extension dir
// (shipped or scratch) with zero type/runtime coupling to core.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const EXT_ID = "brother-agent";
const POLL_MS = 3000;
const PRUNE_NOTIFIED_MS = 86400000; // drop delivered records after a day

// --- minimal structural types (mirrors server/ext/types.ts; self-contained
// so this file stays loadable from external extension dirs) ---

interface ExtKV {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
}

interface ExtCtx {
  extID: string;
  kv: ExtKV;
}

interface WatchEntry {
  parent: string;
  task?: string;
  launchedAt?: number;
  [key: string]: unknown;
}

type WatchMap = Record<string, WatchEntry>;

interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

function stateDir(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-webui");
}

function watchesFile(): string {
  return join(stateDir(), "brother-watches.json");
}

function isWatchEntry(v: unknown): v is WatchEntry {
  return typeof v === "object" && v !== null && typeof (v as WatchEntry).parent === "string";
}

function readWatches(): WatchMap {
  try {
    const raw = JSON.parse(readFileSync(watchesFile(), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return {};
    const out: WatchMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (isWatchEntry(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Best-effort delete of delivered children from the seam file. */
function dropDelivered(childIds: string[]): void {
  if (childIds.length === 0) return;
  try {
    if (!existsSync(watchesFile())) return;
    const raw = JSON.parse(readFileSync(watchesFile(), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return;
    let changed = false;
    for (const id of childIds) {
      if (id in raw) {
        delete raw[id];
        changed = true;
      }
    }
    if (!changed) return;
    mkdirSync(dirname(watchesFile()), { recursive: true });
    writeFileSync(watchesFile() + ".tmp", JSON.stringify(raw, null, 2));
    renameSync(watchesFile() + ".tmp", watchesFile());
  } catch {
    /* seam write races resolve on the next engine write; KV stays authoritative */
  }
}

function serviceEndpoint(): Endpoint | null {
  try {
    const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const info = JSON.parse(readFileSync(join(state, "opencode", "service.json"), "utf8")) as {
      url?: unknown;
      password?: unknown;
    };
    if (!info || typeof info.url !== "string") return null;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (typeof info.password === "string" && info.password !== "") {
      headers["authorization"] = "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64");
    }
    return { url: info.url.replace(/\/+$/, ""), headers };
  } catch {
    return null;
  }
}

async function engineFetch(ep: Endpoint, method: string, p: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${ep.url}${p}`, {
    method,
    headers: ep.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`engine ${method} ${p} → ${res.status}`);
  return res.json();
}

interface SessionRow {
  id: string;
  title?: string;
  cost?: number;
  time?: { updated?: number };
}

function ageMin(updatedAt: number | undefined): number {
  return Math.max(1, Math.round((Date.now() - (updatedAt ?? Date.now())) / 60000));
}

async function tick(ctx: ExtCtx): Promise<void> {
  const kv = ctx.kv;
  const seam = readWatches();
  const notified = (await kv.get<Record<string, number>>("notified")) ?? {};
  const pending = Object.entries(seam).filter(
    ([childId, w]) => w.parent !== "" && !(childId in notified),
  );
  if (pending.length === 0) return;

  const ep = serviceEndpoint();
  if (!ep) return; // engine undiscoverable — retry next tick

  let active: Record<string, unknown>;
  try {
    const res = (await engineFetch(ep, "GET", "/api/session/active")) as { data?: Record<string, unknown> };
    active = res.data ?? {};
  } catch {
    return; // engine momentarily unreachable — retry next tick
  }
  const rows = new Map<string, SessionRow>();
  try {
    const res = (await engineFetch(ep, "GET", "/api/session?limit=50&order=desc")) as { data?: SessionRow[] };
    for (const s of res.data ?? []) {
      if (s && typeof s.id === "string") rows.set(s.id, s);
    }
  } catch {
    /* list is best-effort (titles/cost); the active map is authoritative */
  }

  // Children settled this tick, grouped by parent (seam order).
  const finishing: Array<[string, WatchEntry]> = [];
  for (const [childId, w] of pending) {
    if (childId in active) continue; // still working
    finishing.push([childId, w]);
  }
  if (finishing.length === 0) return;

  const byParent = new Map<string, Array<[string, WatchEntry]>>();
  for (const [childId, w] of finishing) {
    const list = byParent.get(w.parent) ?? [];
    list.push([childId, w]);
    byParent.set(w.parent, list);
  }
  const finisherIds = new Set(finishing.map(([c]) => c));
  const totalFor = (parentId: string): number =>
    Object.values(seam).filter((w) => w.parent === parentId).length;

  let changed = false;
  const delivered: string[] = [];
  for (const [parentId, finishers] of byParent) {
    const total = totalFor(parentId);
    const stillOut = Object.entries(seam).filter(
      ([childId, w]) =>
        w.parent === parentId && !(childId in notified) && !finisherIds.has(childId) && (childId in active || !rows.has(childId)),
    ).length;
    for (let i = 0; i < finishers.length; i++) {
      const entry = finishers[i];
      if (!entry) continue;
      const [childId] = entry;
      const row = rows.get(childId);
      const title = row?.title ?? "";
      const cost = typeof row?.cost === "number" ? ` · $${row.cost.toFixed(4)}` : "";
      const head = `[brother-agent] Your brother agent ${childId} finished${title ? ` — "${title}"` : ""}${cost} · ${ageMin(row?.time?.updated)}m ago`;
      const isLast = i === finishers.length - 1 && stillOut === 0;
      const notice = isLast
        ? `${head} — and that was the last one: all ${total} of your brother agents have finished.`
        : `${head}. Read the transcript with brother_agent_read if you need details.`;
      try {
        await engineFetch(ep, "POST", `/api/session/${encodeURIComponent(parentId)}/prompt`, {
          text: notice,
          delivery: "queue",
        });
        notified[childId] = Date.now();
        delivered.push(childId);
        changed = true;
      } catch {
        /* parent gone or engine busy — retry next tick */
      }
    }
  }

  if (changed) {
    const now = Date.now();
    for (const [childId, at] of Object.entries(notified)) {
      if (typeof at === "number" && now - at > PRUNE_NOTIFIED_MS) delete notified[childId];
    }
    // Drop records for entries the engine already pruned.
    for (const childId of Object.keys(notified)) {
      if (!(childId in seam)) delete notified[childId];
    }
    await kv.set("notified", notified);
    dropDelivered(delivered);
  }
}

let busy = false;

async function guardedTick(ctx: ExtCtx): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await tick(ctx);
  } catch (err) {
    console.error(`[webui] ext "${EXT_ID}" tick failed:`, err);
  } finally {
    busy = false;
  }
}

export default {
  routes: [
    {
      method: "GET",
      path: "brothers",
      handler: async (_req: Request, ctx: ExtCtx): Promise<Response> => {
        const seam = readWatches();
        const notified = (await ctx.kv.get<Record<string, number>>("notified")) ?? {};
        return Response.json({
          brothers: Object.keys(seam),
          watches: seam,
          notified,
        });
      },
    },
  ],
  onEvent: async (evt: { id: string; type: string; data: unknown }, ctx: ExtCtx): Promise<void> => {
    // Any session-scoped engine event hints activity changed — kick an
    // early tick. The active map re-verifies, so spurious kicks are
    // harmless. Delivery itself stays poller-owned (single path).
    if (typeof evt?.type === "string" && evt.type.includes("session")) {
      await guardedTick(ctx);
    }
  },
  pollers: [
    {
      id: "watch",
      intervalMs: POLL_MS,
      run: async (ctx: ExtCtx): Promise<void> => {
        await guardedTick(ctx);
      },
    },
  ],
};
