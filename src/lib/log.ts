/**
 * Lightweight frontend debug logger.
 *
 * Every call is batched and POSTed to the proxy's `/api/debug` endpoint,
 * which appends it to a file (default `/tmp/webui-debug.log`). High-frequency
 * messages (e.g. delta events) are collapsed to ~one line per second so the
 * file stays readable. Console output only when `webui.debug` is set in
 * localStorage — the file has everything, the console is opt-in.
 */

const lines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const counts = new Map<string, number>();
const shownAt = new Map<string, number>();

export type LogArea =
  | "boot"
  | "sse"
  | "evt"
  | "gate"
  | "run"
  | "session"
  | "send"
  | "model"
  | "load"
  | "poll"
  | "render"
  | "debug";

function fmt(rest: unknown[]): string {
  if (rest.length === 0) return "";
  return " " + rest.map((r) => (typeof r === "string" ? r : safeJson(r))).join(" ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function push(line: string) {
  lines.push(line);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 400);
  }
}

async function flush() {
  if (lines.length === 0) return;
  const payload = lines.splice(0);
  try {
    await fetch("/api/debug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    /* server restarting/offline — drop rather than retry-loop */
  }
}

const COLLAPSE_MS = 1000;

export function log(area: LogArea, msg: string, ...rest: unknown[]): void {
  const key = area + "|" + msg;
  const now = Date.now();
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  const lastShown = shownAt.get(key) ?? 0;
  if (n === 1 || now - lastShown >= COLLAPSE_MS) {
    shownAt.set(key, now);
    const line = `[${new Date().toISOString().slice(11, 23)}] [${area}] ${msg}${n > 1 ? ` (x${n})` : ""}${fmt(rest)}`;
    if (typeof window !== "undefined" && (window as unknown as { __WEBUI_DEBUG_CONSOLE__?: boolean }).__WEBUI_DEBUG_CONSOLE__) {
      console.debug(line);
    }
    push(line);
  }
}