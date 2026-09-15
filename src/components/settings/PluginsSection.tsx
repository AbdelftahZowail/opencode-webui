import { useEffect, useState } from "react";
import { AlertTriangle, CircleCheck, Puzzle, RefreshCw, ArrowUpCircle } from "lucide-react";
import type { PluginInfo, PluginSource } from "../../api/client";
import { autoRegister } from "../../extensions/registry";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui";
import { Empty, ErrorNote, SectionHeader } from "./shared";

/**
 * Settings › Plugins (P4). The deliberately de-surfaced informational tab is
 * replaced by an ACTION surface: list the engine's plugins, show where each
 * came from and whether it is active, and drive the only two mutations the
 * engine supports — `check` and `update` (see OpenAPI: `POST /api/plugin/check`
 * and `POST /api/plugin/update`). There is no enable/disable route, so no
 * toggle is offered.
 *
 * Presentational: side effects live in the store. The coordinator wires
 * `onCheck` / `onUpdate` (and `busy` / `error`) from the P4 store slice.
 */
export interface PluginsSectionProps {
  plugins: PluginInfo[];
  /** Non-null while an action is in flight; the value names it ("load" | "check" | "update"). */
  busy: string | null;
  error: string | null;
  onCheck: (target?: string | null) => void;
  onUpdate: (targets: string[]) => void;
}

export function PluginsSection(props: PluginsSectionProps) {
  const { plugins, busy, error, onCheck, onUpdate } = props;

  // The store reports a bare action ("check" | "update"); remember which row
  // started it so the spinner lands on the action that is actually in flight.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (busy === null) setPending(null);
  }, [busy]);

  const action = busyAction(busy);
  const detail = busyDetail(busy);
  const checkingAll = action === "check" && detail === null && pending === null;
  const updatingAll = action === "update" && detail === null && pending === null;

  // `source` is the key (not `id`, which is optional); a package is the only
  // updatable kind, and only when the engine flagged it.
  const outdated = plugins
    .map((p) => p.source)
    .filter(
      (s): s is Extract<PluginSource, { type: "package" }> =>
        s.type === "package" && s.outdated === true,
    )
    .map((s) => s.target);

  return (
    <div data-oc-plugins-section className="space-y-4">
      <SectionHeader
        title="Plugins"
        note="engine plugins — check for updates and install them"
      />

      {error && <ErrorNote message={error} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy !== null}
          onClick={() => onCheck()}
        >
          {checkingAll ? <Spinner className="size-3.5" /> : <RefreshCw />}
          {checkingAll ? "Checking…" : "Check for updates"}
        </Button>
        {outdated.length > 0 && (
          <Button size="sm" disabled={busy !== null} onClick={() => onUpdate(outdated)}>
            {updatingAll ? <Spinner className="size-3.5" /> : <ArrowUpCircle />}
            {updatingAll ? "Updating…" : `Update all (${outdated.length})`}
          </Button>
        )}
      </div>

      {plugins.length === 0 ? (
        <Empty>No engine plugins.</Empty>
      ) : (
        <div className="space-y-2">
          {plugins.map((plugin, index) => {
            const source = plugin.source;
            const state = plugin.state;
            const key = `${sourceKey(source)}#${index}`;
            const failed = state.status === "failed";
            const isPackage = source.type === "package";
            const target = isPackage ? source.target : null;
            const rowChecking =
              (action === "check" && detail === target) || pending === `check:${target}`;
            const rowUpdating =
              (action === "update" && detail === target) || pending === `update:${target}`;
            const engineUpdating = isPackage && source.updating === true;

            return (
              <div
                key={key}
                data-oc-plugin={sourceKey(source)}
                className={cn(
                  "rounded-md border p-2.5",
                  failed
                    ? "border-[var(--surface-critical-base)] bg-[var(--surface-critical-weak)]"
                    : "border-[var(--border-weak-base)] bg-[var(--surface-raised-base)]",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-[var(--border-weak-base)] px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--text-weak)]">
                        <Puzzle className="size-2.5" />
                        {source.type}
                      </span>
                      {plugin.id && (
                        <span className="truncate font-mono text-[10px] text-[var(--text-weaker)]">
                          {plugin.id}
                        </span>
                      )}
                      {FEATURE_KEYS.map((feature) =>
                        plugin.features[feature] ? (
                          <span
                            key={feature}
                            className="rounded-sm bg-[var(--surface-raised-base)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--text-weak)]"
                            title={`Provides a ${feature} surface`}
                          >
                            {feature}
                          </span>
                        ) : null,
                      )}
                      {failed ? (
                        <span className="rounded-sm bg-[var(--surface-critical-weak)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--surface-critical-strong)]">
                          failed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 rounded-sm bg-[var(--surface-success-weak)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--surface-success-strong)]">
                          <CircleCheck className="size-2.5" />
                          active
                        </span>
                      )}
                    </div>

                    <SourceDetail source={source} />

                    {state.status === "failed" && (
                      <div className="flex items-start gap-1.5 text-[11px] text-[var(--surface-critical-strong)]">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                        <span className="min-w-0 break-words">
                          {state.error}
                          {state.ref && (
                            <span className="ml-1 font-mono text-[10px] opacity-80">
                              ({state.ref})
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>

                  {isPackage && target !== null && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={busy !== null}
                        title={`Check ${target} for updates`}
                        onClick={() => {
                          setPending(`check:${target}`);
                          onCheck(target);
                        }}
                      >
                        {rowChecking && <Spinner className="size-3" />}
                        {rowChecking ? "Checking…" : "Check"}
                      </Button>
                      {source.outdated === true && (
                        <Button
                          size="xs"
                          disabled={busy !== null || engineUpdating}
                          title={`Update ${target}`}
                          onClick={() => {
                            setPending(`update:${target}`);
                            onUpdate([target]);
                          }}
                        >
                          {(rowUpdating || engineUpdating) && <Spinner className="size-3" />}
                          {engineUpdating ? "Updating…" : "Update"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module-private helpers (a non-component export would disable Fast Refresh).
// ---------------------------------------------------------------------------

const FEATURE_KEYS = ["server", "tui", "rpc"] as const;

/** Stable identity for a plugin: `source` is the key, `id` is optional. */
function sourceKey(source: PluginSource): string {
  switch (source.type) {
    case "package":
      return `package:${source.target}`;
    case "local":
      return `local:${source.path}`;
    case "builtin":
      return "builtin";
    case "sdk":
      return "sdk";
  }
}

/**
 * The action a `busy` value names. The store passes "load" | "check" |
 * "update"; a per-target action may suffix the target ("check:<target>"),
 * which is how a row spinner knows which action is in flight.
 */
function busyAction(busy: string | null): string | null {
  if (!busy) return null;
  const sep = busy.indexOf(":");
  return sep === -1 ? busy : busy.slice(0, sep);
}

function busyDetail(busy: string | null): string | null {
  if (!busy) return null;
  const sep = busy.indexOf(":");
  return sep === -1 ? null : busy.slice(sep + 1);
}

function SourceDetail({ source }: { source: PluginSource }) {
  switch (source.type) {
    case "package":
      return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate font-mono text-[11px] text-[var(--text-base)]">
            {source.target}
          </span>
          {source.version && (
            <span className="shrink-0 font-mono text-[11px] text-[var(--text-weaker)]">
              v{source.version}
            </span>
          )}
          {source.outdated === true && (
            <span className="shrink-0 rounded-sm bg-[var(--surface-warning-weak)] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--surface-warning-strong)]">
              update available
            </span>
          )}
          {source.updating === true && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--text-weaker)]">
              <Spinner className="size-2.5" />
              updating
            </span>
          )}
        </span>
      );
    case "local":
      return (
        <span className="block truncate font-mono text-[11px] text-[var(--text-base)]" title={source.path}>
          {source.path}
        </span>
      );
    case "builtin":
      return (
        <span className="block text-[11px] text-[var(--text-weaker)]">
          Bundled with OpenCode.
        </span>
      );
    case "sdk":
      return (
        <span className="block text-[11px] text-[var(--text-weaker)]">
          Provided by the SDK.
        </span>
      );
  }
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "settings.plugins": (p) => (
    <PluginsSection {...(p as unknown as PluginsSectionProps)} />
  ),
});
