import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type {
  WorktreeCreateInput,
  WorktreeDirectory,
  WorktreeRemoveInput,
} from "../api/client";
import { cn } from "../lib/utils";
import { autoRegister } from "../extensions/registry";
import { Button, Spinner } from "./ui";
import { Input } from "./ui/input";

/**
 * Worktree panel (P3). Presentational: it receives the worktree slice and
 * emits store actions — it never calls `api.*` (the store owns side effects).
 *
 * Lists the managed worktrees for one location, creates new ones (the engine
 * runs the project's setup script, so this can take minutes) and removes them
 * behind an explicit two-step confirm (`force` skips the safety checks).
 */
export interface WorktreePanelProps {
  /** The directory these worktrees belong to (shown in the UI). */
  location?: string | null;
  worktrees: WorktreeDirectory[];
  busy: boolean;
  error: string | null;
  onCreate: (input: WorktreeCreateInput) => void;
  onRemove: (input: WorktreeRemoveInput) => void;
  onRefresh: () => void;
  /** Optional: use this worktree's directory (e.g. move the session there). */
  onUse?: (directory: string) => void;
}

/** Which action is in flight — drives the single spinner we are allowed. */
type Pending =
  | { kind: "create" }
  | { kind: "refresh" }
  | { kind: "remove"; directory: string; force: boolean }
  | null;

export function WorktreePanel(props: WorktreePanelProps) {
  const { location, worktrees, busy, error, onCreate, onRemove, onRefresh, onUse } =
    props;

  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [from, setFrom] = useState("");
  const [directory, setDirectory] = useState("");
  const [strategy, setStrategy] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // The action is fire-and-forget: `busy` tells us when it settled, so the
  // spinner and the confirm step clear together on the falling edge.
  useEffect(() => {
    if (!busy) {
      setPending(null);
      setConfirming(null);
    }
  }, [busy]);

  const creating = busy && pending?.kind === "create";
  const refreshing = busy && pending?.kind === "refresh";
  const loading = busy && worktrees.length === 0;

  const submit = () => {
    const trimmed = {
      name: name.trim(),
      branch: branch.trim(),
      from: from.trim(),
      directory: directory.trim(),
      strategy: strategy.trim(),
    };
    // Every field is optional — omit empties entirely so the engine fills them
    // from the location's registered strategy and its directory defaults.
    const input: WorktreeCreateInput = {};
    if (trimmed.name) input.name = trimmed.name;
    if (trimmed.branch) input.branch = trimmed.branch;
    if (trimmed.from) input.from = trimmed.from;
    if (trimmed.directory) input.directory = trimmed.directory;
    if (trimmed.strategy) input.strategy = trimmed.strategy;

    setPending({ kind: "create" });
    setName("");
    setBranch("");
    setFrom("");
    setDirectory("");
    setStrategy("");
    onCreate(input);
  };

  const remove = (target: string, force: boolean) => {
    setPending({ kind: "remove", directory: target, force });
    onRemove({ directory: target, force });
  };

  return (
    <div data-oc-worktree-panel className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2 border-b border-[var(--border-weak-base)] px-3 py-2">
        <FolderGit2 className="size-4 shrink-0 text-[var(--text-weak)]" />
        <span className="shrink-0 text-sm font-medium text-[var(--text-strong)]">
          Worktrees
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-weaker)]"
          title={location ?? undefined}
        >
          {location ?? "no location"}
        </span>
        <Button
          variant="ghost"
          className="h-6 shrink-0 px-1.5 text-[11px]"
          disabled={busy}
          title="Rediscover worktrees and reconcile the project inventory"
          onClick={() => {
            setPending({ kind: "refresh" });
            onRefresh();
          }}
        >
          {refreshing ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
          Refresh
        </Button>
      </div>

      {error && (
        <p
          role="alert"
          className="mx-3 flex items-start gap-1.5 rounded-md border border-[color-mix(in_oklch,var(--surface-critical-strong)_30%,transparent)] bg-[var(--surface-critical-weak)] px-2 py-1.5 text-[11px] text-[color:var(--surface-critical-strong)]"
        >
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {loading ? (
        <div
          className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-weak)]"
          data-oc-worktree-loading
        >
          <Spinner className="size-3.5" />
          Loading worktrees…
        </div>
      ) : worktrees.length === 0 ? (
        <p
          className="px-3 py-2 text-xs text-[var(--text-weaker)]"
          data-oc-worktree-empty
        >
          No managed worktrees.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1 px-3">
          {worktrees.map((worktree) => (
            <WorktreeRow
              key={worktree.directory}
              worktree={worktree}
              busy={busy}
              confirming={confirming === worktree.directory}
              pendingForce={
                pending?.kind === "remove" &&
                pending.directory === worktree.directory
                  ? pending.force
                  : null
              }
              onUse={onUse}
              onAskRemove={() => setConfirming(worktree.directory)}
              onCancelRemove={() => setConfirming(null)}
              onRemove={(force) => remove(worktree.directory, force)}
            />
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-1.5 border-t border-[var(--border-weak-base)] px-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (optional)"
            disabled={busy}
            className="h-7 text-[11px]"
            aria-label="Worktree name"
          />
          <Button
            type="submit"
            variant="primary"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={busy}
          >
            {creating ? <Spinner className="size-3" /> : <Plus className="size-3" />}
            Create
          </Button>
          <button
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((prev) => !prev)}
            className="flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] text-[var(--text-weak)] transition-colors hover:text-[var(--text-strong)]"
          >
            <ChevronRight
              className={cn("size-3 transition-transform", advanced && "rotate-90")}
            />
            Advanced
          </button>
        </div>

        {advanced && (
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            <Field label="branch" value={branch} onChange={setBranch} disabled={busy} />
            <Field label="from" value={from} onChange={setFrom} disabled={busy} />
            <Field
              label="directory"
              value={directory}
              onChange={setDirectory}
              disabled={busy}
            />
            <Field
              label="strategy"
              value={strategy}
              onChange={setStrategy}
              disabled={busy}
            />
          </div>
        )}

        <p className="text-[10px] leading-snug text-[var(--text-weaker)]">
          Creating runs the project's setup script — it can take a while.
        </p>
      </form>
    </div>
  );
}

function WorktreeRow({
  worktree,
  busy,
  confirming,
  pendingForce,
  onUse,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  worktree: WorktreeDirectory;
  busy: boolean;
  confirming: boolean;
  /** Which force button is spinning, when a remove is in flight. */
  pendingForce: boolean | null;
  onUse?: (directory: string) => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: (force: boolean) => void;
}) {
  return (
    <li
      data-oc-worktree-row={worktree.directory}
      className="flex items-center gap-2 rounded-md border border-[var(--border-weak-base)] bg-[var(--surface-base)] px-2 py-1.5"
    >
      <FolderGit2 className="size-3.5 shrink-0 text-[var(--text-weaker)]" />
      <div className="min-w-0 flex-1">
        <div
          className="truncate font-mono text-[11px] text-[var(--text-base)]"
          title={worktree.directory}
        >
          {worktree.directory}
        </div>
        {worktree.strategy && (
          <div className="flex items-center gap-1 text-[10px] text-[var(--text-weaker)]">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate" title={worktree.strategy}>
              {worktree.strategy}
            </span>
          </div>
        )}
      </div>

      {confirming ? (
        <div className="flex shrink-0 flex-col items-end gap-0.5" data-oc-worktree-confirm>
          <div className="flex items-center gap-1">
            <Button
              variant="danger"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              title="Remove this worktree"
              onClick={() => onRemove(false)}
            >
              {pendingForce === false && <Spinner className="size-3" />}
              Remove
            </Button>
            <Button
              variant="danger"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              title="Force removes even with uncommitted changes or a lock"
              onClick={() => onRemove(true)}
            >
              {pendingForce === true && <Spinner className="size-3" />}
              Force remove
            </Button>
            <Button
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={onCancelRemove}
            >
              Cancel
            </Button>
          </div>
          <p className="text-[10px] text-[var(--text-weaker)]">
            Force skips safety checks (uncommitted changes, locks).
          </p>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          {onUse && (
            <Button
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              title="Use this worktree's directory"
              onClick={() => onUse(worktree.directory)}
            >
              <ArrowRight className="size-3" />
              Use
            </Button>
          )}
          <Button
            variant="ghost"
            className="h-6 px-2 text-[11px] text-[color:var(--surface-critical-strong)]"
            disabled={busy}
            title="Remove this worktree"
            onClick={onAskRemove}
          >
            <Trash2 className="size-3" />
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-[10px] text-[var(--text-weaker)]">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-7 text-[11px]"
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Self-registration (spec §5.3)
// ---------------------------------------------------------------------------

autoRegister({
  "worktree.panel": (p) => <WorktreePanel {...(p as unknown as WorktreePanelProps)} />,
});
