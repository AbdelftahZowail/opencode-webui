/**
 * Tool-output helpers (parity R10) — pure transforms plus the background-shell
 * output registry.
 *
 * Two concerns live here, deliberately, because they are the same concern
 * ("what a tool's output is, and how much of it we show"):
 *
 *  1. DISPLAY BUDGETS — the TUI caps tool output before it reaches the row
 *     (`util/collapse-tool-output.ts`): a `shell` result collapses past 10
 *     lines, an `execute` result past 4, and both past a character budget.
 *     `collapseText` is the one implementation all of those read.
 *  2. BACKGROUND SHELLS — v2 (`routes/session/index.tsx:2857-3007`) polls
 *     `GET /api/shell/{id}/output?cursor&limit` while a backgrounded shell is
 *     running, strips ANSI, and caps the accumulated buffer. The engine only
 *     emits cursor deltas, so the accumulated text has to live SOMEWHERE; per
 *     the scheduler rule (AGENTS rule 2) that somewhere is this lib, driven by
 *     a `registerPoller` — never a component-owned interval.
 *
 * No store import: the shell id comes from the tool part, not from session
 * state, so the poller stays storeless.
 */

import { api } from "../api/client";
import { registerPoller } from "./scheduler";

// ---- display budgets ------------------------------------------------------

/** A `shell` result collapses past this many lines (TUI parity). */
export const SHELL_COLLAPSE_LINES = 10;
/** An `execute` result collapses past this many lines (TUI parity). */
export const EXECUTE_COLLAPSE_LINES = 4;
/** Secondary budget: past this many characters the output collapses too. */
export const COLLAPSE_CHAR_BUDGET = 2_000;

export interface CollapseOptions {
  maxLines: number;
  maxChars: number;
}

export interface CollapseResult {
  /** The text to show when collapsed. */
  text: string;
  collapsed: boolean;
  /** Lines dropped from the tail (0 when only the char budget tripped). */
  hiddenLines: number;
}

/**
 * Apply a line + character budget to tool output. Returns the head (the part
 * the TUI keeps) plus whether anything was hidden, so callers can render a
 * disclosure affordance without duplicating the maths.
 */
export function collapseText(text: string, opts: CollapseOptions): CollapseResult {
  const lines = text.split("\n");
  const tooManyLines = lines.length > opts.maxLines;
  const tooManyChars = text.length > opts.maxChars;
  if (!tooManyLines && !tooManyChars) return { text, collapsed: false, hiddenLines: 0 };
  let out = tooManyLines ? lines.slice(0, opts.maxLines).join("\n") : text;
  if (out.length > opts.maxChars) out = out.slice(0, opts.maxChars);
  return {
    text: out,
    collapsed: true,
    hiddenLines: Math.max(0, lines.length - opts.maxLines),
  };
}

/** Would a shell result collapse under the shell budget? */
export function shouldCollapseShell(text: string | undefined): boolean {
  if (!text) return false;
  return collapseText(text, { maxLines: SHELL_COLLAPSE_LINES, maxChars: COLLAPSE_CHAR_BUDGET }).collapsed;
}

/** Would an execute result collapse under the execute budget? */
export function shouldCollapseExecute(text: string | undefined): boolean {
  if (!text) return false;
  return collapseText(text, { maxLines: EXECUTE_COLLAPSE_LINES, maxChars: COLLAPSE_CHAR_BUDGET }).collapsed;
}

// ---- ANSI + size ----------------------------------------------------------

/** 1 MiB — the accumulated background-shell buffer cap (TUI parity). */
export const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Bytes requested per poll (`limit`); the buffer cap is enforced above this. */
export const SHELL_OUTPUT_LIMIT = 256 * 1024;

// CSI ("ESC [ … final"), OSC ("ESC ] … BEL|ST"), and lone two-char escapes.
const ANSI_ESCAPE =
  /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/** Strip ANSI/terminal control sequences from tool output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/**
 * Cap UTF-8 bytes, keeping the TAIL (a running shell's newest lines matter
 * most) and prepending a marker when anything was dropped.
 */
export function capOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  const kept = new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes));
  return `…[output truncated to ${Math.round(maxBytes / 1024)} KiB]…\n${kept}`;
}

// ---- background shell output registry -------------------------------------

export interface ShellOutputState {
  /** Accumulated (ANSI-stripped, byte-capped) output so far. */
  output: string;
  /** The engine's delta cursor for the next poll. */
  cursor: number;
  /** True when the engine itself truncated a read (whole buffer changed). */
  truncated: boolean;
  status: "loading" | "streaming" | "error";
  error?: string;
}

const shellStates = new Map<string, ShellOutputState>();
const shellListeners = new Map<string, Set<() => void>>();
const shellCursors = new Map<string, number>();
const shellPollers = new Map<string, () => void>();
const shellRefs = new Map<string, number>();

function emitShell(id: string): void {
  const listeners = shellListeners.get(id);
  if (!listeners) return;
  for (const fn of listeners) fn();
}

/** Current accumulated state for a shell id (undefined before first poll). */
export function getShellOutput(id: string): ShellOutputState | undefined {
  return shellStates.get(id);
}

/** Subscribe to repaints for one shell id. Returns an unsubscribe fn. */
export function subscribeShellOutput(id: string, listener: () => void): () => void {
  let listeners = shellListeners.get(id);
  if (!listeners) {
    listeners = new Set();
    shellListeners.set(id, listeners);
  }
  listeners.add(listener);
  const set = listeners;
  return () => {
    set.delete(listener);
    if (set.size === 0) shellListeners.delete(id);
  };
}

async function pollShellOutput(id: string): Promise<void> {
  const prev = shellStates.get(id);
  if (prev?.status === "error") return;
  try {
    const res = await api.shellOutput(id, {
      cursor: shellCursors.get(id),
      limit: SHELL_OUTPUT_LIMIT,
    });
    const data = res.data;
    const fromScratch = data.truncated || shellCursors.get(id) === undefined;
    const combined = (fromScratch ? "" : prev?.output ?? "") + data.output;
    const output = capOutput(stripAnsi(combined));
    shellCursors.set(id, data.cursor);
    shellStates.set(id, {
      output,
      cursor: data.cursor,
      truncated: data.truncated,
      status: "streaming",
    });
    emitShell(id);
  } catch (err) {
    shellStates.set(id, {
      output: prev?.output ?? "",
      cursor: prev?.cursor ?? 0,
      truncated: prev?.truncated ?? false,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    emitShell(id);
  }
}

/**
 * Reference-counted polling for one background shell. The first caller starts
 * the shared scheduler poller; every caller gets a release fn, and the poller
 * stops when the last one releases (component unmount / shell no longer
 * running). The accumulated state is kept so a late render still shows the
 * last read.
 */
export function acquireShellOutput(id: string): () => void {
  shellRefs.set(id, (shellRefs.get(id) ?? 0) + 1);
  if (!shellPollers.has(id)) {
    if (!shellStates.has(id)) {
      shellStates.set(id, { output: "", cursor: 0, truncated: false, status: "loading" });
    }
    const stop = registerPoller({
      name: `shell-output:${id}`,
      minInterval: 1_500,
      intervals: { idle: 5_000 },
      run: () => pollShellOutput(id),
    });
    shellPollers.set(id, stop);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (shellRefs.get(id) ?? 1) - 1;
    if (remaining <= 0) {
      shellRefs.delete(id);
      const stop = shellPollers.get(id);
      if (stop) {
        stop();
        shellPollers.delete(id);
      }
    } else {
      shellRefs.set(id, remaining);
    }
  };
}

/** Drop accumulated output + cursor for an id (tests / explicit reset). */
export function resetShellOutput(id: string): void {
  shellCursors.delete(id);
  shellStates.delete(id);
  emitShell(id);
}

/**
 * Detect the background-shell signal on a tool part. The engine's tool
 * `metadata` is free-form (not in the OpenAPI snapshot), so this reads the
 * shapes the shell tool has been observed to send and stays silent when none
 * are present. Returns the shell id only when the call was backgrounded —
 * a synchronous shell result carries no shell to poll.
 */
export function extractShellRef(
  input: Record<string, unknown>,
  meta: Record<string, unknown>,
): { id?: string; background: boolean } {
  const id =
    str(meta.shellID) ??
    str(meta.shellId) ??
    str(meta.shell) ??
    str(input.shellID) ??
    str(input.shellId);
  const background =
    meta.background === true ||
    meta.run_in_background === true ||
    input.run_in_background === true ||
    input.runInBackground === true;
  return { id, background };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
