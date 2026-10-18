/**
 * testkit TUI driver — the REAL opencode interactive client in a REAL terminal.
 *
 *   const tui = createTui({ root, env, artifactsDir });
 *   await tui.start();
 *   await tui.type("Reply with exactly: HELLO");
 *   await tui.key("Enter");
 *   const screen = await tui.waitForText("HELLO");
 *   await tui.saveScreen();      // the rendered terminal buffer = evidence
 *
 * Mechanism: an ISOLATED tmux server (`tmux -L <unique-socket> -f /dev/null`),
 * one wide pane running the interactive client with the harness's isolated XDG
 * env (so it discovers the harness engine, never the live one). Input goes in
 * with `send-keys`; the screen is read with `capture-pane -p` — that buffer IS
 * "what the user sees".
 *
 * TWO REPRESENTATIONS: the text grid (`capture-pane -p`, no color) is the
 * ASSERTION SUBSTRATE — deterministic, agent-optimized; colors carry no layout
 * meaning. `renderPng()` adds an additive HUMAN-FACING render (xterm.js in
 * headless Chromium) that is illustrative only, never a pixel contract — and it
 * needs a browser, which is optional and not bundled (it fails soft without one;
 * the text grid is unaffected).
 *
 * Lazy: constructing the driver spawns nothing; the first call starts the tmux
 * server + client once. `close()` kills only this socket's server.
 *
 * Test-only module: modifies neither src/ nor server/.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserPlan } from "./browser";

export interface TuiOptions {
  /** Working directory for the client. */
  root: string;
  /** Environment for the client (must carry the isolated XDG_* vars). */
  env: Record<string, string>;
  /** Directory the rendered buffers are written into. */
  artifactsDir: string;
  /** The resolved browser plan (see ./browser). Only `renderPng()` needs it. */
  browser?: BrowserPlan;
  /** Interactive client argv (default: the real TUI `opencode`). */
  command?: string[];
  cols?: number;
  rows?: number;
  /** Explicit tmux socket name (default: unique per instance). */
  socket?: string;
  log?: (msg: string) => void;
}

export interface TuiDriver {
  readonly started: boolean;
  /** The tmux socket name (for external `tmux -L <socket>` inspection). */
  readonly socket: string;
  start(): Promise<void>;
  /** Type literal text (no key-name interpretation). */
  type(text: string): Promise<void>;
  /** Send a named key: "Enter", "Escape", "Tab", "C-c", "Up", … */
  key(name: string): Promise<void>;
  /** Type text then Enter. */
  send(text: string): Promise<void>;
  /** The visible pane buffer (exactly what the user sees). */
  screen(): Promise<string>;
  /** The pane buffer including scrollback (everything rendered, even offscreen). */
  history(): Promise<string>;
  /** Wait until the visible screen satisfies `pred`. Resolves with a buffer. */
  waitForScreen(pred: (screen: string) => boolean, opts?: { timeoutMs?: number; intervalMs?: number; label?: string }): Promise<string>;
  /** Wait until the visible screen contains `text`. */
  waitForText(text: string, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<string>;
  /** Resize the pane (wide layouts). */
  resize(cols: number, rows: number): Promise<void>;
  /** Write the visible screen to artifactsDir/<name> and return the path. */
  saveScreen(name?: string): Promise<string>;
  /** The pane buffer WITH ANSI (SGR) escapes — the human-render input. */
  ansi(): Promise<string>;
  /** Write the ANSI capture to artifactsDir/<name> and return the path. */
  saveAnsi(name?: string): Promise<string>;
  /**
   * Render the ANSI capture to a PNG via xterm.js in headless Chromium
   * (illustrative human view; never a pixel contract). Returns the path plus
   * the emulator's own rendered text (a self-check that it ingested the buffer).
   */
  renderPng(name?: string, opts?: { fontSize?: number; chrome?: string }): Promise<{ path: string; text: string }>;
  /** Kill this socket's tmux server (idempotent). */
  close(): Promise<void>;
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(argv, { stdio: ["ignore", "pipe", "pipe"] });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out, err };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A hard process exit can't await close(); kill every isolated tmux server we
// started, synchronously. ONE listener for all drivers (no listener pile-up).
const liveTuiSockets = new Set<string>();
let tuiExitHookInstalled = false;
function ensureTuiExitHook(): void {
  if (tuiExitHookInstalled) return;
  tuiExitHookInstalled = true;
  process.on("exit", () => {
    for (const s of liveTuiSockets) {
      try {
        Bun.spawnSync(["tmux", "-L", s, "-f", "/dev/null", "kill-server"]);
      } catch {
        /* already gone */
      }
    }
  });
}

export function createTui(opts: TuiOptions): TuiDriver {
  const log = opts.log ?? (() => {});
  const socket = opts.socket ?? `testkit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const session = "testkit";
  const cols = opts.cols ?? 220;
  const rows = opts.rows ?? 50;
  const command = opts.command ?? ["opencode"];
  let up = false;
  let starting: Promise<void> | null = null;

  ensureTuiExitHook();
  liveTuiSockets.add(socket);

  const tmux = (args: string[]): Promise<{ code: number; out: string; err: string }> =>
    run(["tmux", "-L", socket, "-f", "/dev/null", ...args]);

  /** capture-pane without the ensure() guard (used during start itself). */
  async function captureNow(): Promise<string> {
    const res = await tmux(["capture-pane", "-p", "-t", session]);
    return res.code === 0 ? res.out : "";
  }

  async function doStart(): Promise<void> {
    if (up) return;
    const which = Bun.spawnSync(["which", "tmux"]);
    if (which.exitCode !== 0) throw new Error("[testkit-tui] tmux not found on PATH");
    mkdirSync(opts.artifactsDir, { recursive: true, mode: 0o700 });

    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(opts.env)) envArgs.push("-e", `${k}=${v}`);

    log(`starting tmux socket ${socket} → ${command.join(" ")}`);
    const res = await tmux([
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      String(cols),
      "-y",
      String(rows),
      "-c",
      opts.root,
      ...envArgs,
      ...command,
    ]);
    if (res.code !== 0) throw new Error(`[testkit-tui] tmux new-session failed (${res.code}): ${res.err || res.out}`);
    up = true;
    // Wait for the client to PAINT its composer before we type — keys sent to a
    // not-yet-ready TUI are swallowed. The placeholder / footer is the signal.
    // `TESTKIT_TUI_NO_READY=1` skips this guard on purpose: it exists so the
    // guard can be proven BOTH WAYS (skip → the TUI check goes red; here → green).
    if (process.env.TESTKIT_TUI_NO_READY === "1") {
      await sleep(300);
      return;
    }
    const deadline = Date.now() + 30_000;
    let last = "";
    for (;;) {
      last = await captureNow();
      if (/Ask anything|ctrl\+p commands|OpenCode/.test(last)) break;
      if (Date.now() >= deadline) {
        throw new Error(`[testkit-tui] client did not render within 30s\n--- screen ---\n${last.split("\n").filter((l) => l.trim()).join("\n").slice(0, 800)}`);
      }
      await sleep(400);
    }
  }

  async function ensure(): Promise<void> {
    if (!up) {
      starting ??= doStart().catch((err) => {
        starting = null;
        throw err;
      });
      await starting;
    }
  }

  async function capture(history: boolean): Promise<string> {
    await ensure();
    const args = ["capture-pane", "-p", "-t", session];
    if (history) args.push("-S", "-10000");
    const res = await tmux(args);
    if (res.code !== 0) throw new Error(`[testkit-tui] capture-pane failed (${res.code}): ${res.err}`);
    return res.out;
  }

  /** capture-pane WITH ANSI (SGR color) escapes — the human-render input. */
  async function captureAnsi(): Promise<string> {
    await ensure();
    const res = await tmux(["capture-pane", "-p", "-e", "-t", session]);
    if (res.code !== 0) throw new Error(`[testkit-tui] capture-pane -e failed (${res.code}): ${res.err}`);
    return res.out;
  }

  return {
    get started() {
      return up;
    },
    get socket() {
      return socket;
    },
    start: async () => {
      await ensure();
    },

    async type(text: string) {
      await ensure();
      // `--` so text starting with "-" is never parsed as an option.
      const res = await tmux(["send-keys", "-t", session, "-l", "--", text]);
      if (res.code !== 0) throw new Error(`[testkit-tui] send-keys -l failed: ${res.err}`);
    },

    async key(name: string) {
      await ensure();
      const res = await tmux(["send-keys", "-t", session, "--", name]);
      if (res.code !== 0) throw new Error(`[testkit-tui] send-keys ${name} failed: ${res.err}`);
    },

    async send(text: string) {
      await this.type(text);
      await sleep(120);
      await this.key("Enter");
    },

    screen: () => capture(false),
    history: () => capture(true),

    async waitForScreen(pred, o = {}) {
      const timeoutMs = o.timeoutMs ?? 30_000;
      const intervalMs = o.intervalMs ?? 500;
      const deadline = Date.now() + timeoutMs;
      let last = "";
      for (;;) {
        last = await capture(false);
        if (pred(last)) return last;
        if (Date.now() >= deadline) {
          throw new Error(`[testkit-tui] ${o.label ?? "waitForScreen"}: not satisfied within ${timeoutMs}ms\n--- screen (tail) ---\n${last.split("\n").slice(-20).join("\n")}`);
        }
        await sleep(intervalMs);
      }
    },

    waitForText(text, o = {}) {
      return this.waitForScreen((s) => s.includes(text), { ...o, label: `waitForText(${JSON.stringify(text.slice(0, 40))})` });
    },

    async resize(c: number, r: number) {
      await ensure();
      await tmux(["resize-window", "-t", session, "-x", String(c), "-y", String(r)]);
    },

    async saveScreen(name = `tui-screen-${Date.now()}.txt`) {
      const s = await capture(false);
      mkdirSync(opts.artifactsDir, { recursive: true, mode: 0o700 });
      const p = join(opts.artifactsDir, name);
      await Bun.write(p, s);
      return p;
    },

    ansi: () => captureAnsi(),

    async saveAnsi(name = `tui-ansi-${Date.now()}.ansi`) {
      const s = await captureAnsi();
      mkdirSync(opts.artifactsDir, { recursive: true, mode: 0o700 });
      const p = join(opts.artifactsDir, name);
      await Bun.write(p, s);
      return p;
    },

    async renderPng(name = `tui-render-${Date.now()}.png`, o = {}) {
      const a = await captureAnsi();
      mkdirSync(opts.artifactsDir, { recursive: true, mode: 0o700 });
      const { renderAnsiToPng } = await import("./tuiRender");
      const res = await renderAnsiToPng(a, {
        outPath: join(opts.artifactsDir, name),
        cols,
        rows,
        fontSize: o.fontSize,
        browser: opts.browser,
        chrome: o.chrome,
        log,
      });
      return { path: res.path, text: res.text };
    },

    async close() {
      if (!up && !liveTuiSockets.has(socket)) return;
      up = false;
      starting = null;
      liveTuiSockets.delete(socket);
      try {
        await tmux(["kill-server"]);
      } catch {
        /* already gone */
      }
    },
  };
}
