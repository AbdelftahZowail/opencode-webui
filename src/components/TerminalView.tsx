import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Square } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { api } from "../api/client";
import { Button } from "./ui/button";

const THEME = {
  background: "#101010",
  foreground: "#e6e6e6",
  cursor: "#9dbefe",
  cursorAccent: "#101010",
  selectionBackground: "rgba(157, 190, 254, 0.25)",
  black: "#101010",
  red: "#fc533a",
  green: "#12c905",
  yellow: "#fcd53a",
  blue: "#9dbefe",
  magenta: "#edb2f1",
  cyan: "#94e2d5",
  white: "#e6e6e6",
  brightBlack: "#555555",
  brightRed: "#ff8a77",
  brightGreen: "#6bff5c",
  brightYellow: "#ffe57a",
  brightBlue: "#c6dcff",
  brightMagenta: "#ffd3f8",
  brightCyan: "#b9fff2",
  brightWhite: "#ffffff",
};

export function TerminalView({
  ptyID,
  onClose,
  onError,
}: {
  ptyID: string;
  onClose: () => void;
  onError?: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIDRef = useRef(ptyID);
  ptyIDRef.current = ptyID;
  // Brief in-flight flag so the kill button can't double-fire while the
  // DELETE request is round-tripping.
  const [killing, setKilling] = useState(false);

  /**
   * Kill the PTY process behind this view (DELETE /api/pty/{id}). TUI
   * parity: immediate, no confirm — the only thing lost is the running
   * command. Post-kill behavior: closing the websocket fires ws.onclose,
   * which already routes to onClose(), so the view closes itself exactly
   * like a process that died on its own and the parent list refreshes to
   * show the record gone. Failures surface through onError (same channel
   * as connection loss); a 404 for an already-dead pty is still an error
   * worth showing rather than silently pretending success.
   */
  const kill = async () => {
    if (killing) return;
    setKilling(true);
    try {
      await api.ptyDelete(ptyID);
      wsRef.current?.close();
    } catch (err) {
      setKilling(false);
      onError?.(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: '"JetBrainsMono Nerd Font Mono", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      theme: THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // container not measurable yet; fit on first resize
    }
    termRef.current = term;
    fitRef.current = fit;
    term.focus();

    const onResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const dims = term.cols > 0 && term.rows > 0 ? { cols: term.cols, rows: term.rows } : null;
      if (dims) void api.ptyUpdate(ptyIDRef.current, { size: dims }).catch(() => {});
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    let ws: WebSocket | null = null;
    let closed = false;
    let started = false;

    const start = async () => {
      try {
        const token = await api.ptyConnectToken(ptyIDRef.current);
        const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/pty/${ptyIDRef.current}/connect?ticket=${token.data.ticket}`;
        if (closed) return;
        ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => onResize();
        ws.onmessage = (e) => {
          if (typeof e.data === "string") {
            term.write(e.data);
          } else if (e.data instanceof Blob) {
            void e.data.arrayBuffer().then((buf) => handleControl(new Uint8Array(buf), term));
          } else {
            handleControl(new Uint8Array(e.data as ArrayBuffer), term);
          }
        };
        ws.onclose = () => {
          if (!closed) onClose();
        };
        ws.onerror = () => {
          onError?.("Terminal connection lost");
        };
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err));
      }
    };

    const handleControl = (data: Uint8Array, t: Terminal) => {
      if (data[0] === 0) {
        const text = new TextDecoder().decode(data.subarray(1));
        try {
          const meta = JSON.parse(text) as { cursor?: number };
          if (typeof meta.cursor === "number" && !started) {
            started = true;
            onResize();
          }
        } catch {
          // ignore malformed control frames
        }
        return;
      }
      t.write(new Uint8Array(data));
    };

    const dataDisposable = term.onData((input) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(input);
    });

    void start();

    return () => {
      closed = true;
      dataDisposable.dispose();
      ro.disconnect();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyID]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="truncate font-mono text-xs text-[var(--text-weak)]">{ptyID}</span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void kill()}
            disabled={killing}
            title="Kill process"
            aria-label="Kill terminal"
            className="text-[color:var(--surface-critical-strong)]"
          >
            <Square />
            Kill
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 bg-[var(--background-base)] p-2" />
    </div>
  );
}
