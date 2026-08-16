import { useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Link2, XIcon } from "lucide-react";
import type { McpResource, McpResourceTemplate, McpServer, McpStatus } from "../../api/client";
import { api } from "../../api/client";
import { Badge } from "../ui";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "../ui/dialog";
import { Empty, ErrorNote, SectionHeader, useAsync } from "./shared";

const dialogCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

function statusTone(status: McpStatus): "green" | "amber" | "red" | "neutral" | "blue" {
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

export function McpSection() {
  const servers = useAsync(() => api.mcpList().then((r) => r.data));
  const resources = useAsync(() => api.mcpResource().then((r) => r.data));
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<McpServer | null>(null);

  const refreshAll = () => {
    servers.refresh();
    resources.refresh();
  };

  const runAction = (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setActionError(null);
    action()
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(null);
        refreshAll();
      });
  };

  return (
    <div className="space-y-4">
      <div>
        <SectionHeader
          title="MCP servers"
          note="Model Context Protocol endpoints"
          onRefresh={refreshAll}
          loading={servers.loading}
        />
        {servers.error && <ErrorNote message={servers.error} />}
        {actionError && <ErrorNote message={actionError} />}
        {!servers.error && servers.data && servers.data.length === 0 && (
          <Empty>No MCP servers configured.</Empty>
        )}
        <div className="space-y-1">
          {servers.data?.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[13px] text-[var(--text-strong)]">
                  {s.name}
                </span>
                <Badge tone={statusTone(s.status)}>{statusLabel(s.status)}</Badge>
                {s.status.status === "failed" && (
                  <span className="max-w-40 truncate text-[10px] text-[var(--text-on-critical-base)]">
                    {s.status.error}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {s.status.status !== "connected" && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      runAction(`connect:${s.name}`, () => api.mcpConnect(s.name))
                    }
                  >
                    {busy === `connect:${s.name}` ? "Connecting…" : "Connect"}
                  </Button>
                )}
                {s.status.status === "connected" && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      runAction(`disconnect:${s.name}`, () => api.mcpDisconnect(s.name))
                    }
                  >
                    {busy === `disconnect:${s.name}` ? "Disconnecting…" : "Disconnect"}
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  className="text-[var(--surface-critical-strong)]"
                  onClick={() => setRemoveTarget(s)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <SectionHeader
          title="Resources"
          note="Read-only catalog"
          onRefresh={resources.refresh}
          loading={resources.loading}
        />
        {resources.error && <ErrorNote message={resources.error} />}
        {!resources.error && resources.data && resources.data.resources.length === 0 && (
          <Empty>No resources exposed.</Empty>
        )}
        <div className="space-y-1">
          {resources.data?.resources.map((r) => (
            <ResourceRow key={`${r.server}:${r.name}`} resource={r} />
          ))}
          {resources.data?.templates.map((t) => (
            <TemplateRow key={`${t.server}:${t.name}`} template={t} />
          ))}
        </div>
      </div>

      {removeTarget && (
        <Dialog open onOpenChange={(o) => !o && setRemoveTarget(null)}>
          <DialogPortal>
            <DialogOverlay className="bg-black/60" />
            <DialogPrimitive.Content data-slot="dialog-content" className={dialogCls}>
              <DialogHeader>
                <DialogTitle>Remove MCP server</DialogTitle>
                <p className="text-xs text-[var(--text-weaker)]">
                  Remove{" "}
                  <span className="font-mono text-[var(--text-base)]">{removeTarget.name}</span>{" "}
                  from the config? This affects the server-side configuration.
                </p>
              </DialogHeader>
              <DialogFooter className="rounded-b-lg">
                <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    runAction(`remove:${removeTarget.name}`, () => api.mcpDelete(removeTarget.name));
                    setRemoveTarget(null);
                  }}
                >
                  Remove
                </Button>
              </DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2">
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Button>
              </DialogClose>
            </DialogPrimitive.Content>
          </DialogPortal>
        </Dialog>
      )}
    </div>
  );
}

function ResourceRow({ resource }: { resource: McpResource }) {
  return (
    <div className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-[var(--text-strong)]">{resource.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">
          {resource.server}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <Link2 className="size-3 shrink-0 text-[var(--text-weaker)]" />
        <span className="truncate font-mono text-[11px] text-[var(--text-weak)]">
          {resource.uri}
        </span>
      </div>
      {resource.description && (
        <p className="mt-0.5 truncate text-[11px] text-[var(--text-weaker)]">
          {resource.description}
        </p>
      )}
    </div>
  );
}

function TemplateRow({ template }: { template: McpResourceTemplate }) {
  return (
    <div className="rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2.5 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-[var(--text-strong)]">{template.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--text-weaker)]">
          {template.server}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <Link2 className="size-3 shrink-0 text-[var(--text-weaker)]" />
        <span className="truncate font-mono text-[11px] text-[var(--text-weak)]">
          {template.uriTemplate}
        </span>
      </div>
    </div>
  );
}
