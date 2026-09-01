/**
 * /report — built-in bug reporter for the webui itself.
 *
 * Collects a scrub-by-construction diag bundle (no message content, no
 * session file paths, no cookies), prefills a GitHub issue on
 * AbdelftahZowail/opencode-webui, and opens it in a browser tab. With the
 * `--agent` flag the prompt is handed to the session agent instead, which
 * files the issue via the gh CLI.
 */
import { register } from "../../src/extensions/registry";
import { notify } from "../../src/lib/notify";
import { enabled as builtinIds } from "../config";
import { getState, isDraftSession, materializeDraft, sendPromptTo } from "../../src/store";

export const id = "report";

const FALLBACK_REPO = "AbdelftahZowail/opencode-webui";
const RING_CAP = 10;

interface ErrEntry {
  message: string;
  source: string;
  line: number;
  stack?: string;
}

/** Shared across HMR re-runs: the flag guards double-install, the ring survives module re-execution. */
const w = window as unknown as { __reportErrors?: ErrEntry[]; __reportErrorsInstalled?: boolean };

function record(entry: ErrEntry) {
  const ring = (w.__reportErrors ??= []);
  ring.push(entry);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
}

if (!w.__reportErrorsInstalled) {
  w.__reportErrorsInstalled = true;
  window.onerror = (message, source, line, _colno, error) => {
    record({
      message: String(message).slice(0, 500),
      source: source ?? "",
      line: line ?? 0,
      stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
    });
  };
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason;
    record({
      message: (reason instanceof Error ? reason.message : String(reason)).slice(0, 500),
      source: "unhandledrejection",
      line: 0,
      stack: reason instanceof Error ? reason.stack?.slice(0, 500) : undefined,
    });
  });
}

async function fetchJSON<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Diagnostics only — anything private is excluded here, not filtered later. */
async function collectDiag(sessionID: string | null) {
  const [config, exts] = await Promise.all([
    fetchJSON<{ version?: string; reportRepo?: string }>("/api/webui/config"),
    fetchJSON<{ data?: { id?: string }[] }>("/api/webui/extensions"),
  ]);
  return {
    url: location.href,
    userAgent: navigator.userAgent,
    language: navigator.language,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    version: config?.version ?? "unknown",
    reportRepo: config?.reportRepo ?? FALLBACK_REPO,
    builtins: [...builtinIds],
    runtimeExtensions: (exts?.data ?? []).map((e) => e.id ?? "").filter(Boolean),
    errors: w.__reportErrors ?? [],
    sessionID,
    timestamp: new Date().toISOString(),
  };
}

function buildIssue(args: string, diag: Awaited<ReturnType<typeof collectDiag>>) {
  const title = `WebUI bug: ${args ? args.slice(0, 80) : "user report"}`;
  const body = [
    "### What happened",
    args || "",
    "",
    "### Steps to reproduce",
    "1. ",
    "",
    "### Expected",
    "",
    "### Actual",
    "",
    "<details><summary>Diagnostics</summary>",
    "",
    "```json",
    JSON.stringify(diag, null, 2),
    "```",
    "</details>",
  ].join("\n");
  return {
    title,
    body,
    url: `https://github.com/${diag.reportRepo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`,
  };
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function run(rawArgs: string, ctx: { sessionID?: string }) {
  const args = rawArgs.trim();
  const agentMode = args.startsWith("--agent");
  const titleArgs = agentMode ? args.replace(/^--agent\b/, "").trim() : args;
  const diag = await collectDiag(ctx.sessionID ?? getState().currentSessionID ?? null);
  const { title, body, url } = buildIssue(titleArgs, diag);

  if (agentMode) {
    const prompt =
      `File a bug against ${diag.reportRepo} using the gh CLI: create an issue with the title and ` +
      `body below, then reply with the issue URL. Do not include any private session content beyond ` +
      `the diagnostics JSON.\n\nTitle: ${title}\n\n${body}`;
    let sid = ctx.sessionID ?? getState().currentSessionID ?? null;
    if (sid && isDraftSession(sid)) {
      try {
        sid = await materializeDraft("");
      } catch {
        sid = null;
      }
    }
    if (!sid) {
      const ok = await copy(prompt);
      notify({
        title: ok ? "No active session — report prompt copied" : "No active session",
        description: ok ? "Paste it into a session to have the agent file the issue." : "Could not copy the report prompt either.",
        variant: ok ? "default" : "destructive",
      });
      return;
    }
    notify({ title: "Report handed to the agent", description: "It will file the issue and reply with the URL." });
    await sendPromptTo(sid, prompt);
    return;
  }

  const opened = window.open(url, "_blank");
  if (opened) {
    notify({ title: "Opening GitHub issue…" });
  } else {
    const ok = await copy(url);
    notify({
      title: ok ? "Report ready — link copied" : "Report link",
      description: ok ? "Popup blocked; paste the link in a browser." : "Popup blocked and the clipboard is unavailable.",
      variant: ok ? "default" : "destructive",
    });
  }
}

register({
  kind: "slash",
  id: "report",
  name: "report",
  aliases: ["bug"],
  description: "Report a webui bug on GitHub — diag bundle prefilled",
  run,
});

// Self-accept so edits hot-swap: same-id registry swap, no reload.
if (import.meta.hot) import.meta.hot.accept();
