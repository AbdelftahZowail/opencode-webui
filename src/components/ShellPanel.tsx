import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Plug,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
  Terminal,
  Timer,
  Trash2,
} from "lucide-react";
import { api, type PtyInfo, type ShellInfo } from "../api/client";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import { Badge, Spinner, formatTime } from "./ui";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";
import { TerminalView } from "./TerminalView";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

const SHELL_DEFAULT_TIMEOUT = 120000;

const shellTone: Record<ShellInfo["status"], "blue" | "green" | "amber" | "red"> = {
  running: "blue",
  exited: "green",
  timeout: "amber",
  killed: "red",
};

function shellElapsed(s: ShellInfo): string {
  const end = s.time.completed ?? Date.now();
  const sec = Math.max(0, Math.floor((end - s.time.started) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function ShellPanel({ trigger }: { trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("shell");
  // Distant surfaces (composer run chips) can ask the panel to open via
  // store.requestShellPanel(); the tick is an additive open signal.
  const shellPanelTick = useStore((s) => s.shellPanelTick);

  useEffect(() => {
    if (shellPanelTick > 0) setOpen(true);
  }, [shellPanelTick]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== undefined ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">
            <Terminal />
            Shell
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl md:max-w-3xl">
        <DialogHeader className="border-b border-(--border-weak-base) px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="size-4 text-(color:--text-interactive-base)" />
            Shell &amp; Terminals
          </DialogTitle>
          <DialogDescription>Run shell commands and manage PTY sessions.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList variant="line" className="mx-4 mt-3">
            <TabsTrigger value="shell">Shell</TabsTrigger>
            <TabsTrigger value="terminals">Terminals</TabsTrigger>
          </TabsList>
          <TabsContent
            value="shell"
            forceMount
            className={cn("min-h-0", tab !== "shell" && "hidden")}
          >
            <ShellTab active={tab === "shell"} />
          </TabsContent>
          <TabsContent
            value="terminals"
            forceMount
            className={cn("min-h-0", tab !== "terminals" && "hidden")}
          >
            <TerminalsTab active={tab === "terminals"} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ShellTab({ active }: { active: boolean }) {
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(String(SHELL_DEFAULT_TIMEOUT));
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const cursors = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.shellList();
      setShells(res.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [active, load]);

  const appendOutput = useCallback(async (id: string) => {
    try {
      const res = await api.shellOutput(id, { cursor: cursors.current[id] });
      const data = res.data;
      const fromScratch = data.truncated || cursors.current[id] === undefined;
      setOutputs((prev) => ({ ...prev, [id]: (fromScratch ? "" : prev[id] ?? "") + data.output }));
      cursors.current[id] = data.cursor;
    } catch {
      setOutputs((prev) => ({ ...prev, [id]: (prev[id] ?? "") + "\n[output stream unavailable]" }));
    }
  }, []);

  useEffect(() => {
    if (!active || !expandedId) return;
    const shell = shells.find((s) => s.id === expandedId);
    if (!shell || shell.status !== "running") return;
    const t = window.setInterval(() => void appendOutput(expandedId), 1200);
    return () => window.clearInterval(t);
  }, [active, expandedId, shells, appendOutput]);

  const create = async () => {
    if (!command.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const parsed = Number(timeoutMs);
      const res = await api.shellCreate({
        command: command.trim(),
        timeout: Number.isFinite(parsed) && parsed > 0 ? parsed : SHELL_DEFAULT_TIMEOUT,
      });
      setCommand("");
      await load();
      setExpandedId(res.data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const kill = async (id: string) => {
    try {
      await api.shellDelete(id);
      setOutputs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete cursors.current[id];
      if (expandedId === id) setExpandedId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setShellTimeout = async (id: string, ms: string) => {
    const parsed = Number(ms);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    try {
      await api.shellTimeout(id, parsed);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex gap-2">
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="command to run"
          className="flex-1 font-mono text-xs"
        />
        <Input
          value={timeoutMs}
          onChange={(e) => setTimeoutMs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="timeout ms"
          title="Timeout in milliseconds"
          className="w-24 font-mono text-xs"
        />
        <Button onClick={() => void create()} disabled={!command.trim() || creating}>
          <Play />
          Run
        </Button>
        <Button variant="ghost" size="icon" title="Refresh" onClick={() => void load()}>
          <RotateCw />
        </Button>
      </div>
      {error && <p className="text-xs text-(color:--surface-critical-strong)">{error}</p>}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-(color:--text-weaker)">
            <Spinner /> Loading shells…
          </div>
        ) : shells.length === 0 ? (
          <p className="px-1 py-2 text-xs text-(color:--text-weaker)">
            No shell sessions yet — run a command above.
          </p>
        ) : (
          shells.map((shell) => (
            <ShellRow
              key={shell.id}
              shell={shell}
              expanded={expandedId === shell.id}
              output={outputs[shell.id] ?? ""}
              onToggle={() => {
                setExpandedId((cur) => (cur === shell.id ? null : shell.id));
                if (!cursors.current[shell.id]) void appendOutput(shell.id);
              }}
              onKill={() => void kill(shell.id)}
              onSetTimeout={(ms) => void setShellTimeout(shell.id, ms)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ShellRow({
  shell,
  expanded,
  output,
  onToggle,
  onKill,
  onSetTimeout,
}: {
  shell: ShellInfo;
  expanded: boolean;
  output: string;
  onToggle: () => void;
  onKill: () => void;
  onSetTimeout: (ms: string) => void;
}) {
  const [timeoutValue, setTimeoutValue] = useState("");
  const outRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  return (
    <div className="rounded-md border border-(--border-weak-base) bg-(--surface-base)">
      <div
        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-(--surface-base-hover)"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-(color:--text-weaker)" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-(color:--text-weaker)" />
        )}
        <Badge tone={shellTone[shell.status]}>{shell.status}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-(color:--text-strong)">
          {shell.command}
        </span>
        <span className="hidden max-w-40 truncate font-mono text-xs text-(color:--text-weaker) sm:inline">
          {shell.cwd}
        </span>
        <span className="shrink-0 text-xs text-(color:--text-weak)">
          {formatTime(shell.time.started)} · {shellElapsed(shell)}
        </span>
        {shell.status === "running" && (
          <Button
            variant="ghost"
            size="icon-xs"
            title="Kill"
            aria-label="Kill"
            onClick={(e) => {
              e.stopPropagation();
              onKill();
            }}
            className="text-(color:--surface-critical-strong)"
          >
            <Square />
          </Button>
        )}
      </div>
      {expanded && (
        <div className="flex flex-col gap-2 border-t border-(--border-weak-base) p-2.5">
          <pre
            ref={outRef}
            className={cn(
              "max-h-56 min-h-10 overflow-auto rounded-md border border-(--border-weak-base) bg-(--surface-inset-base) p-2 font-mono text-xs whitespace-pre-wrap text-(color:--text-base)",
              !output && "text-(color:--text-weaker)",
            )}
          >
            {output || "No output yet…"}
          </pre>
          <div className="flex items-center gap-2">
            <Timer className="size-3.5 text-(color:--text-weaker)" />
            <Input
              value={timeoutValue}
              onChange={(e) => setTimeoutValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onSetTimeout(timeoutValue);
                  setTimeoutValue("");
                }
              }}
              placeholder="set timeout (ms)"
              className="h-6 w-36 font-mono text-xs"
            />
            <Button
              variant="ghost"
              size="xs"
              disabled={!timeoutValue.trim()}
              onClick={() => {
                onSetTimeout(timeoutValue);
                setTimeoutValue("");
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type PtyConnection =
  | { kind: "connected"; ticket: string; expiresAt: number }
  | { kind: "error"; message: string };

function TerminalsTab({ active }: { active: boolean }) {
  const [ptys, setPtys] = useState<PtyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [creating, setCreating] = useState(false);
  const [connections, setConnections] = useState<Record<string, PtyConnection>>({});
  const [now, setNow] = useState(Date.now());
  const [activePty, setActivePty] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.ptyList();
      setPtys(res.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const t = window.setInterval(() => {
      void load();
      setNow(Date.now());
    }, 5000);
    return () => window.clearInterval(t);
  }, [active, load]);

  const create = async () => {
    if (!command.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      await api.ptyCreate({
        command: command.trim(),
        cwd: cwd.trim() || undefined,
        title: title.trim() || undefined,
      });
      setTitle("");
      setCommand("");
      setCwd("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (ptyID: string) => {
    try {
      await api.ptyDelete(ptyID);
      setConnections((prev) => {
        const next = { ...prev };
        delete next[ptyID];
        return next;
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const connect = async (ptyID: string) => {
    try {
      const res = await api.ptyConnectToken(ptyID);
      setConnections((prev) => ({
        ...prev,
        [ptyID]: {
          kind: "connected",
          ticket: res.data.ticket,
          expiresAt: Date.now() + res.data.expires_in * 1000,
        },
      }));
      setError(null);
    } catch (e) {
      setConnections((prev) => ({
        ...prev,
        [ptyID]: { kind: "error", message: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {activePty ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <TerminalView
            ptyID={activePty}
            onClose={() => setActivePty(null)}
            onError={(m) => setError(m)}
          />
        </div>
      ) : (
      <>
      <div className="flex gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="title"
          className="w-28 text-xs"
        />
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="command (e.g. bash)"
          className="flex-1 font-mono text-xs"
        />
        <Input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="cwd (optional)"
          className="w-36 font-mono text-xs"
        />
        <Button onClick={() => void create()} disabled={!command.trim() || creating}>
          <Terminal />
          Create
        </Button>
        <Button variant="ghost" size="icon" title="Refresh" onClick={() => void load()}>
          <RotateCw />
        </Button>
      </div>
      {error && <p className="text-xs text-(color:--surface-critical-strong)">{error}</p>}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-(color:--text-weaker)">
            <Spinner /> Loading terminals…
          </div>
        ) : ptys.length === 0 ? (
          <p className="px-1 py-2 text-xs text-(color:--text-weaker)">
            No PTY sessions yet — create one above.
          </p>
        ) : (
          ptys.map((pty) => (
            <PtyRow
              key={pty.id}
              pty={pty}
              connection={connections[pty.id]}
              now={now}
              onConnect={() => void connect(pty.id)}
              onOpen={() => setActivePty(pty.id)}
              onDelete={() => void remove(pty.id)}
            />
          ))
        )}
      </div>
      <Separator className="bg-(--border-weak-base)" />
      <p className="text-xs text-(color:--text-weaker)">
        Live terminals stream over a websocket — open one to interact.
      </p>
      </>
      )}
    </div>
  );
}

function PtyRow({
  pty,
  connection,
  now,
  onConnect,
  onOpen,
  onDelete,
}: {
  pty: PtyInfo;
  connection?: PtyConnection;
  now: number;
  onConnect: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const args = pty.args.length > 0 ? ` ${pty.args.join(" ")}` : "";
  const remaining = connection?.kind === "connected"
    ? Math.max(0, Math.ceil((connection.expiresAt - now) / 1000))
    : 0;

  return (
    <div className="rounded-md border border-(--border-weak-base) bg-(--surface-base) px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Badge tone={pty.status === "running" ? "blue" : "neutral"}>{pty.status}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-(color:--text-strong)">
          {pty.title || pty.command}
        </span>
        <span className="hidden shrink-0 text-xs text-(color:--text-weaker) md:inline">
          pid {pty.pid}
          {pty.exitCode !== undefined ? ` · exit ${pty.exitCode}` : ""}
        </span>
        <Button variant="ghost" size="xs" onClick={onOpen} disabled={pty.status !== "running"}>
          <SquareTerminal />
          Open
        </Button>
        <Button variant="ghost" size="xs" onClick={onConnect} disabled={pty.status !== "running"}>
          <Cable />
          Connect
        </Button>
        {/* Single destructive slot: DELETE /api/pty/{id} both kills a live
            process and removes the record, so while RUNNING the affordance
            reads Kill (Square) and is the kill control; once finished the
            kill affordance is gone and the same slot degrades to record
            cleanup (Trash2). */}
        <Button
          variant="ghost"
          size="icon-xs"
          title={pty.status === "running" ? "Kill" : "Delete"}
          aria-label={pty.status === "running" ? "Kill terminal" : "Delete terminal record"}
          onClick={onDelete}
          className="text-(color:--surface-critical-strong)"
        >
          {pty.status === "running" ? <Square /> : <Trash2 />}
        </Button>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-(color:--text-weak)">
          {pty.command}
          {args}
          {pty.cwd ? ` — ${pty.cwd}` : ""}
        </span>
        {connection?.kind === "connected" ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs">
            <Plug className="size-3 text-(color:--surface-success-strong)" />
            <Badge tone="green">connected</Badge>
            <span className="hidden font-mono text-(color:--text-weaker) sm:inline">
              {connection.ticket.slice(0, 10)}… · {remaining}s
            </span>
          </span>
        ) : connection?.kind === "error" ? (
          <span className="max-w-56 shrink-0 truncate" title={connection.message}>
            <Badge tone="red">{connection.message}</Badge>
          </span>
        ) : (
          <span className="shrink-0 text-xs text-(color:--text-weaker)">disconnected</span>
        )}
      </div>
    </div>
  );
}
