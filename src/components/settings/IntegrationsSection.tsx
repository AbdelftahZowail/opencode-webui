import { useEffect, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronRight, ExternalLink, Loader2, Search, XIcon } from "lucide-react";
import type { IntegrationInfo, IntegrationMethod } from "../../api/client";
import { api } from "../../api/client";
import { Badge } from "../ui";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "../ui/dialog";
import { CopyButton, Empty, ErrorNote, SectionHeader, inputCls, useAsync } from "./shared";
import { registerPoller } from "../../lib/scheduler";
import { notify } from "../../lib/notify";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const dialogCls =
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border border-[var(--border-weak-base)] bg-[var(--surface-float-base)] p-4 text-sm text-popover-foreground duration-100 outline-none sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";

interface AttemptTarget {
  integrationID: string;
  methodID: string;
}

type AttemptState =
  | { kind: "idle" }
  | { kind: "starting"; error?: string }
  | {
      kind: "active";
      attemptID: string;
      url?: string;
      instructions?: string;
      status: "pending" | "complete" | "failed" | "expired";
      message?: string;
    };

function useAttempt(
  target: AttemptTarget | null,
  start: (t: AttemptTarget) => Promise<{ attemptID: string; url?: string; instructions?: string }>,
  poll: (t: AttemptTarget, attemptID: string) => Promise<{ status: "pending" | "complete" | "failed" | "expired"; message?: string }>,
  onDone: () => void,
) {
  const [state, setState] = useState<AttemptState>({ kind: "idle" });
  const activeAttemptID = state.kind === "active" ? state.attemptID : null;
  const activeStatus = state.kind === "active" ? state.status : null;

  useEffect(() => {
    if (!target) {
      setState({ kind: "idle" });
      return;
    }
    let stopped = false;
    setState({ kind: "starting" });
    start(target)
      .then((a) => {
        if (stopped) return;
        setState({
          kind: "active",
          attemptID: a.attemptID,
          url: a.url,
          instructions: a.instructions,
          status: "pending",
        });
      })
      .catch((e: unknown) =>
        setState({ kind: "starting", error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.integrationID, target?.methodID]);

  useEffect(() => {
    if (!target || !activeAttemptID || activeStatus !== "pending") return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await poll(target, activeAttemptID);
        if (stopped) return;
        setState((prev) =>
          prev.kind === "active" ? { ...prev, status: s.status, message: s.message } : prev,
        );
        if (s.status === "complete") onDone();
      } catch {
        /* keep polling */
      }
    };
    // OAuth attempt status: short-lived (only while an attempt pends) and
    // genuinely wants its snappy 2s cadence — still scheduler-owned.
    return registerPoller({
      name: "integration-attempt",
      minInterval: 2_000,
      run: () => tick(),
    });
  }, [target?.integrationID, target?.methodID, activeAttemptID, activeStatus]);

  return state;
}

function AttemptPanel({
  state,
  onCancel,
  label,
}: {
  state: AttemptState;
  onCancel: () => void;
  label: string;
}) {
  if (state.kind === "idle") return null;
  if (state.kind === "starting")
    return (
      <div className="space-y-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-2.5">
        {state.error ? (
          <ErrorNote message={state.error} />
        ) : (
          <div className="flex items-center gap-2 text-xs text-[var(--text-base)]">
            <Loader2 className="size-3.5 animate-spin" /> starting {label}…
          </div>
        )}
        <Button variant="ghost" size="xs" onClick={onCancel}>
          cancel
        </Button>
      </div>
    );
  return (
    <div className="space-y-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--text-base)]">{label} attempt</span>
        <Badge tone={state.status === "complete" ? "green" : state.status === "pending" ? "amber" : "red"}>
          {state.status}
        </Badge>
      </div>
      {state.url && (
        <div className="flex items-center gap-2">
          <a
            className="min-w-0 truncate text-xs text-[var(--text-interactive-base)] underline underline-offset-2"
            href={state.url}
            target="_blank"
            rel="noreferrer"
          >
            {state.url}
          </a>
          <ExternalLink className="size-3 shrink-0 text-[var(--text-weaker)]" />
          <CopyButton text={state.url} />
        </div>
      )}
      {state.instructions && <p className="text-xs text-[var(--text-weak)]">{state.instructions}</p>}
      {state.message && <p className="text-xs text-[var(--text-weak)]">{state.message}</p>}
      {state.status === "pending" && (
        <Button variant="ghost" size="xs" onClick={onCancel}>
          cancel
        </Button>
      )}
    </div>
  );
}

function KeyDialog({
  integration,
  method,
  open,
  onClose,
  onDone,
}: {
  integration: IntegrationInfo;
  method: Extract<IntegrationMethod, { type: "key" }>;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogOverlay className="bg-black/60" />
        <DialogPrimitive.Content data-slot="dialog-content" className={dialogCls}>
          <DialogHeader>
            <DialogTitle>
              {integration.name} · API key
            </DialogTitle>
            <p className="text-xs text-[var(--text-weaker)]">
              {method.label ?? `Connect with an API key for ${integration.id}`}
            </p>
          </DialogHeader>
          <div className="space-y-2">
            <input
              className={inputCls}
              placeholder="API key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="Label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            {error && <ErrorNote message={error} />}
          </div>
          <DialogFooter className="rounded-b-lg">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={key.trim().length === 0 || busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                api
                  .integrationConnectKey(integration.id, {
                    key: key.trim(),
                    label: label.trim() || null,
                  })
                  .then(() => {
                    onClose();
                    onDone();
                  })
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Connecting…" : "Connect"}
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
  );
}

export function IntegrationsSection() {
  const { data, error, loading, refresh } = useAsync(() =>
    api.integrationList().then((r) => r.data),
  );
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Model counts per provider come from two one-shot catalogs; a failure is
  // not an integration-list failure, so it degrades to "no counts shown".
  const models = useAsync(() => api.models());
  const providers = useAsync(() => api.providerList().then((r) => r.data));
  const [keyDialog, setKeyDialog] = useState<{
    integration: IntegrationInfo;
    method: Extract<IntegrationMethod, { type: "key" }>;
  } | null>(null);
  const [oauthTarget, setOauthTarget] = useState<AttemptTarget | null>(null);
  const [commandTarget, setCommandTarget] = useState<AttemptTarget | null>(null);

  const oauthState = useAttempt(
    oauthTarget,
    (t) =>
      api.integrationConnectOauth(t.integrationID, { methodID: t.methodID }).then((r) => ({
        attemptID: r.data.attemptID,
        url: r.data.url,
        instructions: r.data.instructions,
      })),
    (t, attemptID) => api.integrationOauthAttempt(t.integrationID, attemptID).then((r) => r.data),
    refresh,
  );

  const commandState = useAttempt(
    commandTarget,
    (t) =>
      api.integrationConnectCommand(t.integrationID, { methodID: t.methodID }).then((r) => ({
        attemptID: r.data.attemptID,
      })),
    (t, attemptID) => api.integrationCommandAttempt(t.integrationID, attemptID).then((r) => r.data),
    refresh,
  );

  // integration → provider(s) via ProviderInfo.integrationID; models per
  // integration = models whose providerID belongs to those providers.
  const modelCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!models.data || !providers.data) return counts;
    const byIntegration = new Map<string, Set<string>>();
    for (const p of providers.data) {
      if (!p.integrationID) continue;
      const set = byIntegration.get(p.integrationID) ?? new Set<string>();
      set.add(p.id);
      byIntegration.set(p.integrationID, set);
    }
    for (const m of models.data) {
      for (const [integrationID, providerIDs] of byIntegration) {
        if (providerIDs.has(m.providerID))
          counts.set(integrationID, (counts.get(integrationID) ?? 0) + 1);
      }
    }
    return counts;
  }, [models.data, providers.data]);

  // Connected first, then alphabetical — stable within each group.
  const integrations = useMemo(() => {
    if (!data) return [];
    return [...data].sort((a, b) => {
      const ac = a.connections.length > 0 ? 1 : 0;
      const bc = b.connections.length > 0 ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
  }, [data]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? integrations.filter(
            (it) => it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q),
          )
        : integrations,
    [integrations, q],
  );

  return (
    <div>
      <SectionHeader
        title="Integrations"
        note="Connect providers — API keys, OAuth, CLI commands"
        onRefresh={refresh}
        loading={loading}
      />
      <p className="-mt-1 mb-2 text-xs text-[var(--text-weaker)]">
        An integration is how the engine authenticates to a model provider. Connect one to enable its models.
      </p>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          className={`${inputCls} h-7 pl-7`}
          placeholder="Search integrations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {q && (
        <p className="mb-1 px-1 text-[11px] text-[var(--text-weaker)]" aria-live="polite">
          {filtered.length} of {integrations.length}
        </p>
      )}
      {error && <ErrorNote message={error} />}
      {!error && data && data.length === 0 && <Empty>No integrations available.</Empty>}
      {!error && data && data.length > 0 && filtered.length === 0 && (
        <Empty>No integrations match “{query.trim()}”.</Empty>
      )}
      <div className="space-y-1">
        {filtered.map((it) => (
          <div key={it.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-raised-base)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-raised-base-hover)]"
              onClick={() => setOpen(open === it.id ? null : it.id)}
            >
              <div className="flex min-w-0 items-center gap-2">
                <ChevronRight
                  className={`size-3.5 shrink-0 text-[var(--text-weaker)] transition-transform ${open === it.id ? "rotate-90" : ""}`}
                />
                <span className="truncate text-[13px] text-[var(--text-strong)]">{it.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--text-weaker)]">
                  {it.id}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {(modelCounts.get(it.id) ?? 0) > 0 && (
                  <span className="text-[11px] text-[var(--text-weaker)]">
                    · {modelCounts.get(it.id)} models
                  </span>
                )}
                {it.connections.length > 0 ? (
                  <Badge tone="green">
                    connected{it.connections.length > 1 ? ` · ${it.connections.length}` : ""}
                  </Badge>
                ) : (
                  <Badge>not connected</Badge>
                )}
                {it.connections.map((c, i) => (
                  <Badge key={i} tone="blue">
                    {c.type === "credential" ? c.label : c.name}
                  </Badge>
                ))}
              </div>
            </button>
            {open === it.id && (
              <div className="mt-1 ml-4 space-y-1.5 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] p-2.5">
                {it.connections.length === 0 && (
                  <p className="text-xs text-[var(--text-weaker)]">No connections yet.</p>
                )}
                {it.connections.length > 0 && (
                  <div className="space-y-1">
                    {it.connections.map((c, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <Badge tone={c.type === "credential" ? "blue" : "neutral"}>
                          {c.type === "credential" ? "credential" : "env"}
                        </Badge>
                        <span className="font-mono text-[var(--text-base)]">
                          {c.type === "credential" ? c.label : c.name}
                        </span>
                        {c.type === "credential" && (
                          <span className="font-mono text-[10px] text-[var(--text-weaker)]">
                            {c.id}
                          </span>
                        )}
                        {c.type === "credential" && (
                          <button
                            type="button"
                            className="rounded border border-[var(--border-weak-base)] px-1.5 py-0.5 text-[10px] text-[var(--text-weak)] transition-colors hover:bg-[var(--surface-raised-base-hover)] hover:text-[var(--text-strong)]"
                            onClick={() => {
                              void api
                                .credentialActivate(c.id)
                                .then(refresh)
                                .catch((e: unknown) =>
                                  notify({ title: "Activate failed", description: errMsg(e), variant: "destructive" }),
                                );
                            }}
                          >
                            activate
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {it.methods.map((m, i) => (
                    <MethodButton
                      key={i}
                      method={m}
                      onKey={() =>
                        setKeyDialog({
                          integration: it,
                          method: m as Extract<IntegrationMethod, { type: "key" }>,
                        })
                      }
                      onOauth={() =>
                        setOauthTarget({
                          integrationID: it.id,
                          methodID: (m as Extract<IntegrationMethod, { type: "oauth" }>).id,
                        })
                      }
                      onCommand={() =>
                        setCommandTarget({
                          integrationID: it.id,
                          methodID: (m as Extract<IntegrationMethod, { type: "command" }>).id,
                        })
                      }
                    />
                  ))}
                </div>
                {oauthTarget?.integrationID === it.id && (
                  <AttemptPanel
                    state={oauthState}
                    onCancel={() => setOauthTarget(null)}
                    label="OAuth"
                  />
                )}
                {commandTarget?.integrationID === it.id && (
                  <AttemptPanel
                    state={commandState}
                    onCancel={() => setCommandTarget(null)}
                    label="Command"
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {keyDialog && (
        <KeyDialog
          integration={keyDialog.integration}
          method={keyDialog.method}
          open
          onClose={() => setKeyDialog(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

function MethodButton({
  method,
  onKey,
  onOauth,
  onCommand,
}: {
  method: IntegrationMethod;
  onKey: () => void;
  onOauth: () => void;
  onCommand: () => void;
}) {
  const label =
    method.type === "env" ? `env: ${method.names.join(", ")}` : method.label ?? method.type;
  if (method.type === "env") {
    return (
      <Button size="xs" variant="outline" disabled title="Configured via environment variables">
        {label}
      </Button>
    );
  }
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={method.type === "key" ? onKey : method.type === "oauth" ? onOauth : onCommand}
    >
      {label}
    </Button>
  );
}
