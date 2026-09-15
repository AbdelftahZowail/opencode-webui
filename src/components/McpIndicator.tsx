import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Boxes, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { McpServer, McpServerConfig, McpStatus } from "../api/client";
import { api } from "../api/client";
import { Badge } from "./ui";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  deleteMcpServer,
  ensureMcpStatus,
  ensureMcpStatusFresh,
  getMcpStatus,
  putMcpServer,
  refreshMcpStatus,
  subscribeMcpStatus,
} from "../lib/mcpStatus";

/**
 * MCP status as a header indicator.
 *
 * Data comes from the global `mcpStatus` cache (one poller app-wide), NOT a
 * per-component fetch — so switching sessions or splitting panes paints
 * instantly and never fires a redundant request. The dot reads at a glance:
 * green = all connected, amber = pending/needs auth, red = failed, muted =
 * none configured.
 */
function statusTone(status: McpStatus): "green" | "amber" | "red" | "neutral" {
  switch (status.status) {
    case "connected":
      return "green";
    case "pending":
    case "needs_auth":
      return "amber";
    case "failed":
      return "red";
    default:
      return "neutral";
  }
}

function statusLabel(status: McpStatus): string {
  return status.status === "needs_auth" ? "needs auth" : status.status;
}

export function McpIndicator() {
  const { servers, error } = useSyncExternalStore(subscribeMcpStatus, getMcpStatus);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Idempotent: the first mount anywhere starts the one global poller; later
    // mounts just render the cache (refreshing only if it has gone stale).
    ensureMcpStatus();
    ensureMcpStatusFresh();
  }, []);

  const total = servers?.length ?? 0;
  const connected = servers?.filter((s) => s.status.status === "connected").length ?? 0;
  const failed = servers?.some((s) => s.status.status === "failed") ?? false;
  const pending =
    servers?.some((s) => s.status.status === "pending" || s.status.status === "needs_auth") ?? false;
  const tone = total === 0 ? "neutral" : failed ? "red" : pending ? "amber" : connected === total ? "green" : "neutral";
  const dot =
    tone === "green"
      ? "bg-[var(--surface-success-strong)]"
      : tone === "amber"
        ? "bg-[var(--surface-warning-strong)]"
        : tone === "red"
          ? "bg-[var(--surface-critical-strong)]"
          : "bg-[var(--text-weaker)]";
  // Tint the icon itself so a failing/partial MCP set is obvious at a glance —
  // a 6px dot on a muted icon was too easy to miss.
  const iconTone =
    tone === "red"
      ? "text-[var(--surface-critical-strong)]"
      : tone === "amber"
        ? "text-[var(--surface-warning-strong)]"
        : tone === "green"
          ? "text-[var(--surface-success-strong)]"
          : "text-[var(--text-weaker)]";

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  useEffect(() => cancelClose, []);

  const runAction = (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    action()
      .catch(() => undefined)
      .finally(() => {
        setBusy(null);
        void refreshMcpStatus();
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          title={
            total === 0
              ? "MCP — no servers configured"
              : `MCP — ${connected}/${total} connected${failed ? " (failed)" : ""}`
          }
          aria-label="MCP servers"
          className={`flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-[color:var(--surface-base-hover)] ${iconTone}`}
        >
          <span className="relative flex items-center">
            <Boxes className="size-4" />
            <span
              className={`absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-[var(--background-base)] ${dot}`}
              aria-hidden
            />
          </span>
          <span className="hidden font-mono text-[10px] sm:inline">
            {total === 0 ? "MCP" : `${connected}/${total}`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        className="w-80"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-[var(--text-strong)]">MCP servers</span>
          <div className="flex items-center gap-1">
            <span className="font-mono text-[10px] text-[var(--text-weaker)]">
              {connected}/{total}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Add a server"
              onClick={() => setAdding((v) => !v)}
            >
              <Plus className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" title="Refresh" onClick={() => void refreshMcpStatus()}>
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>

        {error && <p className="text-[11px] text-[var(--surface-critical-strong)]">{error}</p>}

        {adding && (
          <McpServerForm
            onCancel={() => setAdding(false)}
            onSubmit={(name, config) => {
              setBusy(`put:${name}`);
              void putMcpServer(name, config)
                .then(() => setAdding(false))
                .catch(() => undefined)
                .finally(() => setBusy(null));
            }}
            busy={busy !== null}
          />
        )}

        {total === 0 && !adding ? (
          <div className="flex flex-col items-center gap-2 py-2">
            <p className="text-center text-xs text-[var(--text-weaker)]">
              No MCP servers configured. Add one here, or in your opencode config.
            </p>
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-3" /> Add server
            </Button>
          </div>
        ) : (
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {servers?.map((s) => (
              <ServerRow key={s.name} server={s} busy={busy} runAction={runAction} />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ServerRow({
  server,
  busy,
  runAction,
}: {
  server: McpServer;
  busy: string | null;
  runAction: (key: string, action: () => Promise<unknown>) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      data-oc-mcp-server={server.name}
      className="flex flex-col gap-1 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[12px] text-[var(--text-strong)]" title={server.name}>
            {server.name}
          </span>
          <Badge tone={statusTone(server.status)}>{statusLabel(server.status)}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {server.status.status === "connected" ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => runAction(`disconnect:${server.name}`, () => api.mcpDisconnect(server.name))}
            >
              {busy === `disconnect:${server.name}` ? "…" : "Disconnect"}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => runAction(`connect:${server.name}`, () => api.mcpConnect(server.name))}
            >
              {busy === `connect:${server.name}` ? "…" : "Connect"}
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            title={confirming ? "Confirm remove" : "Remove server"}
            disabled={busy !== null}
            onClick={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              setConfirming(false);
              runAction(`delete:${server.name}`, () => deleteMcpServer(server.name));
            }}
            className={confirming ? "text-[var(--surface-critical-strong)]" : ""}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      {confirming && (
        <p className="text-[11px] text-[var(--surface-warning-strong)]">
          Remove “{server.name}”? Click the bin again to confirm.
        </p>
      )}
      {server.status.status === "failed" && (
        <p className="text-[11px] text-[var(--surface-critical-strong)]">{server.status.error}</p>
      )}
    </div>
  );
}

/**
 * Add a server. There is no read route for a single server's config, so this
 * is deliberately ADD-only: an "edit" without the current config would
 * silently clobber it (PUT replaces).
 */
function McpServerForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (name: string, config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "remote">("local");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");

  const canSave =
    name.trim() !== "" && (type === "local" ? command.trim() !== "" : url.trim() !== "");

  const submit = () => {
    if (!canSave || busy) return;
    const config: McpServerConfig =
      type === "local"
        ? { type: "local", command: command.trim().split(/\s+/) }
        : { type: "remote", url: url.trim() };
    onSubmit(name.trim(), config);
  };

  return (
    <div
      data-oc-mcp-add
      className="flex flex-col gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-2"
    >
      <div className="flex items-center gap-1">
        {(["local", "remote"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setType(kind)}
            className={`cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors ${
              type === kind
                ? "bg-[var(--surface-raised-base)] text-[var(--text-strong)]"
                : "text-[var(--text-weak)] hover:text-[var(--text-strong)]"
            }`}
          >
            {kind}
          </button>
        ))}
      </div>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="server name"
        className="h-7 text-xs"
        autoFocus
      />
      {type === "local" ? (
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="command (e.g. npx -y some-mcp-server)"
          className="h-7 font-mono text-xs"
        />
      ) : (
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/mcp"
          className="h-7 font-mono text-xs"
        />
      )}
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="outline" disabled={!canSave || busy} onClick={submit}>
          {busy ? "…" : "Add"}
        </Button>
      </div>
    </div>
  );
}
