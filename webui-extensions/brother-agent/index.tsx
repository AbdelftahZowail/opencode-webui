// brother-agent — browser stratum (thin half).
//
// Sidebar brother badge + session-origin ribbon, both flow-through wraps
// (stale-proof: core updates render through them). Data comes from the
// proxy half (GET /api/webui/ext/brother-agent/brothers — the known-brother
// id set) plus each adopted session's own native metadata (authoritative
// per-session origin). No core edits.

import { useSyncExternalStore } from "react";
import { register } from "../../src/extensions/registry";
import { api } from "../../src/api/client";

export const id = "brother-agent";

// --- tiny version store so async fetches repaint ---------------------------

let version = 0;
const listeners = new Set<() => void>();

function bump() {
  version++;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useBrotherVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

// --- data ------------------------------------------------------------------

const brotherIDs = new Set<string>();
const adoptedOrigins = new Map<string, string>();

async function refreshBrothers(): Promise<void> {
  try {
    const res = await fetch("/api/webui/ext/brother-agent/brothers");
    if (!res.ok) return;
    const body = (await res.json()) as { brothers?: unknown };
    if (!Array.isArray(body.brothers)) return;
    const next = new Set(body.brothers.filter((x): x is string => typeof x === "string"));
    let same = next.size === brotherIDs.size;
    if (same) {
      for (const x of next) {
        if (!brotherIDs.has(x)) {
          same = false;
          break;
        }
      }
    }
    if (!same) {
      brotherIDs.clear();
      for (const x of next) brotherIDs.add(x);
      bump();
    }
  } catch {
    /* proxy half absent/unreachable — no badges, core UI untouched */
  }
}

function isBrother(sessionID: string): boolean {
  return adoptedOrigins.get(sessionID) === "brother-agent" || brotherIDs.has(sessionID);
}

// One module-level poller, guarded across HMR re-runs. (The browser stratum
// has no dispose hook, so this intentionally lives as long as the page.)
const w = window as unknown as { __brotherAgentStarted?: boolean };
if (!w.__brotherAgentStarted) {
  w.__brotherAgentStarted = true;
  void refreshBrothers();
  window.setInterval(() => {
    void refreshBrothers();
  }, 30000);
}

register({
  kind: "hook",
  id: "brother-agent",
  event: "session.adopted",
  handler: (ctx, next) => {
    next();
    const sessionID = ctx["sessionID"];
    if (typeof sessionID !== "string" || sessionID === "") {
      void refreshBrothers();
      return;
    }
    void refreshBrothers();
    void api
      .getSession(sessionID)
      .then((res) => {
        // NOTE: SessionInfo in src/api/types.ts omits the engine's native
        // `metadata` field (openapi.json Session.Info has it) — read it via
        // a local cast rather than touching the contract layer.
        const origin = (res.data as unknown as { metadata?: Record<string, unknown> }).metadata?.["origin"];
        if (typeof origin === "string" && origin !== "") {
          if (adoptedOrigins.get(sessionID) !== origin) {
            adoptedOrigins.set(sessionID, origin);
            bump();
          }
        } else if (adoptedOrigins.delete(sessionID)) {
          bump();
        }
      })
      .catch(() => {
        /* session gone — leave the last-known state */
      });
  },
});

register({
  kind: "wrap",
  id: "brother-agent-row",
  target: "sidebar.sessionRow",
  render: (props, next) => {
    useBrotherVersion();
    const node = next();
    const sessionID = props["sessionID"];
    if (typeof sessionID !== "string" || !isBrother(sessionID)) return node;
    return (
      <span className="relative block min-w-0">
        {node}
        <span
          title="Brother agent session"
          className="pointer-events-none absolute top-1.5 right-2 rounded border border-[var(--border-weak-base)] px-1 text-[10px] leading-4 text-[var(--text-weaker)]"
        >
          brother
        </span>
      </span>
    );
  },
});

register({
  kind: "wrap",
  id: "brother-agent-header",
  target: "conversation.header",
  render: (props, next) => {
    useBrotherVersion();
    const node = next();
    const sessionID = props["sessionID"];
    if (typeof sessionID !== "string" || !isBrother(sessionID)) return node;
    return (
      <>
        {node}
        <div className="border-b border-[var(--border-base)] px-4 py-1 text-xs text-[var(--text-weaker)]">
          brother agent session — launched via brother_agent · finish notices arrive here automatically
        </div>
      </>
    );
  },
});
